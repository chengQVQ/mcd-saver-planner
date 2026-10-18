/**
 * 模块 2：最优优惠组合计算引擎
 *
 * 功能：针对指定门店 + 渠道 + 餐品列表，遍历所有可用优惠券，输出最低到手价方案
 *
 * 核心算法（§9.1）：
 *  1. 并行拉取门店券、麦麦省券、用户已持券
 *  2. 优惠券分类打标
 *  3. 生成可行组合（遵守互斥规则）
 *  4. 遍历组合逐个调用 calculate-price
 *  5. 加入随单购卡方案
 *  6. 按最终价格升序取Top3
 */

import config, { BE_TYPE, BE_TYPE_RULE } from '../config.js';
import logger from '../utils/logger.js';
import { extractPrice, saveRate, formatYuan } from '../utils/money.js';
import { sleep } from '../utils/retry.js';
import {
  parseStoreCoupons,
  parseMyCoupons,
  buildCombinations,
  bindCouponsToItems,
  COUPON_TYPE
} from './couponRules.js';

/** 渠道 → 可读名称 */
const CHANNEL_LABEL = {
  [BE_TYPE.IN_STORE]: '到店自取',
  [BE_TYPE.DELIVERY]: '麦乐送',
  [BE_TYPE.DRIVE_THRU]: '得来速',
  [BE_TYPE.GROUP_MEAL]: '企业团餐'
};

/**
 * 计算指定门店渠道下的最优优惠方案
 *
 * @param {Object} p
 * @param {import('../mcp/tools.js').default} p.tools MCP 工具封装
 * @param {string} p.storeCode 门店编码
 * @param {number} p.beType 业务类型 1|2|5|6
 * @param {Array} p.items 商品列表 [{productCode, quantity}]
 * @param {string} [p.beCode] 业务编码
 * @param {Object} [p.store] 门店信息 {storeName, distance}
 * @param {string} [p.reservationDate]
 * @returns {Promise<Plan[]>} Top3 优惠方案数组（按最终价格升序）
 */
export async function calcBestPlans({ tools, storeCode, beType, items, beCode, store = {}, reservationDate }) {
  const normalizedItems = items.map((i) => ({
    productCode: String(i.productCode),
    quantity: Number(i.quantity) || 1
  }));

  // ── 步骤 1：并行拉取数据（失败即抛，不降级）──
  const [storeCouponsRaw, mmsCouponsRaw, myCouponsRaw] = await Promise.all([
    tools.queryStoreCoupons({ storeCode, beType, beCode, reservationDate }),
    tools.availableCoupons(),
    tools.queryMyCoupons()
  ]);

  const storeCoupons = parseStoreCoupons(storeCouponsRaw);
  const myCoupons = parseMyCoupons(myCouponsRaw);
  // 麦麦省券需先领取才可使用，此处仅作为「待领取可省金额」提示
  const mmsAvailable = Array.isArray(mmsCouponsRaw?.data) ? mmsCouponsRaw.data.length : 0;

  // 按券 ID 去重合并（门店券优先）
  const allCoupons = dedupeCoupons([...storeCoupons, ...myCoupons]);

  logger.info('PRICE', `券池就绪：门店券 ${storeCoupons.length} 张，用户券 ${myCoupons.length} 张` +
    (mmsAvailable ? `，麦麦省待领 ${mmsAvailable} 张（需先一键领取）` : ''));

  // ── 步骤 2/3：生成可行组合 ──
  const productCodes = new Set(normalizedItems.map((i) => i.productCode));
  const approximateTotal = 0; // 门槛校验以calculate-price 实际返回为准，此处放宽避免误杀
  const ctx = { productCodes, beType, total: approximateTotal };

  let combinations = buildCombinations(allCoupons, ctx);

  // 控制组合数量，防止组合爆炸导致调用次数超限（§5.1 单轮 ≤15 次）
  if (combinations.length > config.limits.maxCombinations) {
    logger.warn('PRICE', `组合数 ${combinations.length} 超过上限，裁剪至 ${config.limits.maxCombinations}`);
    combinations = prioritizeCombinations(combinations, config.limits.maxCombinations);
  }

  // ── 步骤 4：遍历组合调用 calculate-price（失败即抛）──
  const plans = [];

  // 4.1 基线：不用券（必须计算，作为优惠对比基准）
  const baseline = await priceOnce({
    tools, storeCode, beType, items: normalizedItems, beCode, combination: [], reservationDate
  });
  if (!baseline) {
    throw new Error('价格计算失败：服务端未返回有效价格，请检查门店是否营业或商品是否在售');
  }
  plans.push(assemblePlan({
    baseline, combination: [], storeCode, store, beType, beCode, items: normalizedItems
  }));

  // 4.2 逐个组合计算
  for (const combo of combinations) {
    if (combo.length === 0) continue;
    if (logger.getCallCount() >= config.limits.maxCallsPerRound) {
      logger.warn('PRICE', `已达单轮调用上限 ${config.limits.maxCallsPerRound}，停止枚举（已生成 ${plans.length} 个方案）`);
      break;
    }

    const boundItems = bindCouponsToItems(normalizedItems, combo);
    let result = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await priceOnce({
        tools, storeCode, beType, items: boundItems, beCode, combination: combo, reservationDate
      });
    } catch (err) {
      // 单个券组合计算失败（券过期/不适用）→ 跳过该组合，继续试下一个
      logger.warn('PRICE', `组合 ${combo.map((c) => c.title).join('+')} 计算失败，跳过`, err.message);
    }
    if (result) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(config.limits.batchInterval);
      plans.push(assemblePlan({
        baseline: result, combination: combo, storeCode, store, beType, beCode, items: boundItems
      }));
    }
  }

  // ── 步骤 6：排序与截断 ──
  const sorted = plans
    .filter((p) => p.finalPrice !== null)
    .sort((a, b) => a.finalPrice - b.finalPrice);

  const top = sorted.slice(0, config.recommend.topPlanCount);
  annotateRanks(top);
  return top;
}

/**
 * 调用 calculate-price（带降级）
 */
async function priceOnce({ tools, storeCode, beType, items, beCode, combination, reservationDate }) {
  const payload = await tools.calculatePrice({ storeCode, beType, items, beCode, reservationDate });
  const price = extractPrice(payload);
  if (!price) return null;
  return { ...price, payload };
}

/**
 * 组装方案数据（§8.3 Plan 结构）
 */
function assemblePlan({ baseline, combination, storeCode, store, beType, beCode, items }) {
  const withCard = detectWithOrder(baseline.payload);
  const originalPrice = baseline.originalPrice;
  const finalPrice = baseline.finalPrice;

  return {
    id: planId(combination),
    planName: combination.length
      ? combination.map((c) => c.title).join(' + ')
      : '原价方案（无可用优惠）',
    channel: channelKey(beType),
    channelLabel: CHANNEL_LABEL[beType] ?? '未知渠道',
    // 完整渠道信息：下游下单模块依赖 beType / orderType 做参数校验
    beType,
    orderType: BE_TYPE_RULE[beType]?.orderType ?? (beType === BE_TYPE.DELIVERY || beType === BE_TYPE.GROUP_MEAL ? 2 : 1),
    beCode: beCode ?? null,
    storeCode,
    storeName: store.storeName ?? '',
    items,
    usedCoupons: combination,
    withCard,
    originalPrice,
    discountAmount: baseline.discountAmount,
    deliveryFee: baseline.deliveryFee,
    finalPrice,
    saveRate: saveRate(originalPrice, finalPrice),
    recommendReason: buildReason(combination, baseline, store),
    tags: buildTags(combination, baseline)
  };
}

/** 检测随单购卡方案（§9.1 步骤 5） */
function detectWithOrder(payload) {
  const withOrder = payload?.data?.withOrder ?? payload?.withOrder;
  if (!withOrder) return { enabled: false, cardType: null, cardPrice: 0 };
  const cardTypeNum = Number(withOrder.cardType);
  const cardType = cardTypeNum === 1 ? 'mcGold' : cardTypeNum === 2 ? 'breakfast' : 'unknown';
  return {
    enabled: true,
    cardType,
    cardId: withOrder.cardId ?? '',
    membershipCode: withOrder.membershipCode ?? '',
    membershipSpecId: withOrder.membershipSpecId ?? withOrder.specId ?? '',
    cardPrice: Number(withOrder.cardPrice ?? 0),
    note: '随单购卡需在下单时通过 withOrder 字段传入，否则按原价购买'
  };
}

/** 生成推荐理由 */
function buildReason(combination, baseline, store) {
  const parts = [];
  if (combination.length) {
    parts.push(`叠加${combination.length}张券：${combination.map((c) => c.title).join('、')}`);
  } else {
    parts.push('当前无可叠加优惠券');
  }
  if (baseline.discountAmount > 0) {
    parts.push(`共省${formatYuan(baseline.discountAmount)}`);
  }
  if (store.distance) parts.push(`距离约${(store.distance / 1000).toFixed(1)}km`);
  if (baseline.deliveryFee > 0) parts.push(`含配送费${formatYuan(baseline.deliveryFee)}`);
  return parts.join('，');
}

/** 生成方案标签 */
function buildTags(combination, baseline) {
  const tags = [];
  if (combination.length >= 2) tags.push('多券叠加');
  if (combination.some((c) => c.type === COUPON_TYPE.MMS)) tags.push('麦麦省券');
  if (combination.some((c) => c.type === COUPON_TYPE.STORE)) tags.push('门店券');
  if (combination.some((c) => c.type === COUPON_TYPE.ACTIVITY)) tags.push('活动券');
  if (saveRate(baseline.originalPrice, baseline.finalPrice) >= 0.3) tags.push('高优惠');
  if (baseline.deliveryFee === 0) tags.push('免配送费');
  return tags;
}

/** 方案 ID */
function planId(combination) {
  const seed = combination.map((c) => c.couponId).sort().join('-') || 'base';
  return `plan_${Buffer.from(seed).toString('hex').slice(0, 12)}`;
}

/** beType → channel key */
function channelKey(beType) {
  return { 1: 'inStore', 2: 'delivery', 5: 'driveThru', 6: 'groupMeal' }[beType] ?? 'inStore';
}

/** 标注排名与最优标记 */
function annotateRanks(plans) {
  plans.forEach((p, i) => {
    p.rank = i + 1;
    p.isBest = i === 0;
  });
}

/**
 * 组合优先级排序：空组合 → 单券大额 → 多券叠加
 * 用于组合数超限时保留更有潜力的组合
 */
function prioritizeCombinations(combinations, limit) {
  const scored = combinations.map((combo, idx) => ({
    combo,
    idx,
    score: combo.length * 1000 + combo.reduce((s, c) => s + (c.discount || 0), 0) / 100
  }));
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  return scored.slice(0, limit).map((s) => s.combo);
}

/** 券去重合并 */
function dedupeCoupons(coupons) {
  const map = new Map();
  for (const c of coupons) {
    const key = c.couponId || c.couponCode;
    if (!key) continue;
    const exist = map.get(key);
    if (!exist) {
      map.set(key, { ...c });
    } else {
      // 合并适用商品范围与券码
      if (!exist.applicableProducts && c.applicableProducts) {
        exist.applicableProducts = c.applicableProducts;
      }
      exist.couponCodes = [...new Set([...(exist.couponCodes ?? []), ...(c.couponCodes ?? [])])];
    }
  }
  return [...map.values()];
}

/** 全部计算失败时的降级方案 */


export default { calcBestPlans };
