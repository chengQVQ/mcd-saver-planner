/**
 * 模块 4：智能凑单推荐
 *
 * 功能：未达满减门槛时，推荐最低价凑单品，用最少加购满足用券条件
 *
 * 算法（§9.3）：
 *  1. gap = coupon.threshold - currentTotal，gap <= 0 则无需凑单
 *  2. 候选商品：价格 ≥ gap 的低价小食 / 饮品
 *  3. 选价格最低的候选
 *  4. 收益校验：凑单后总价 < 不凑单总价才推荐
 */

import config, { BE_TYPE } from '../config.js';
import { extractPrice } from '../utils/money.js';
import logger from '../utils/logger.js';
import { bindCouponsToItems } from './couponRules.js';

/**
 * 智能凑单推荐
 *
 * @param {Object} p
 * @param {import('../mcp/tools.js').default} p.tools
 * @param {Array} p.items 当前商品列表
 * @param {string} p.storeCode 门店编码
 * @param {number} p.beType 业务类型
 * @param {string} [p.beCode]
 * @param {import('./couponRules.js').Coupon} p.targetCoupon 目标满减券
 * @returns {Promise<Object>} 凑单推荐结果
 */
export async function recommendCombo({ tools, items, storeCode, beType, beCode, targetCoupon }) {
  const base = {
    needExtra: false,
    gapAmount: 0,
    bestItem: null,
    finalPrice: null,
    isWorth: false,
    desc: '无需凑单'
  };

  if (!targetCoupon || !targetCoupon.threshold) return base;

  // ── 步骤 1：计算当前总价与门槛差额（失败即抛）──
  const basePricePayload = await tools.calculatePrice({ storeCode, beType, items, beCode });
  const basePrice = extractPrice(basePricePayload);
  if (!basePrice) throw new Error('凑单评估失败：服务端未返回有效价格');

  const gap = targetCoupon.threshold - basePrice.originalPrice;
  if (gap <= 0) {
    return {
      ...base,
      desc: `当前订单已满足${(targetCoupon.threshold / 100).toFixed(0)}元门槛，可直接使用「${targetCoupon.title}」`
    };
  }

  // ── 步骤 2：拉取门店低价小食 / 饮品（失败即抛）──
  const menu = await tools.queryMeals({ storeCode, beType, beCode });
  const candidates = pickComboCandidates(menu, gap);
  if (!candidates.length) {
    return { ...base, gapAmount: gap, desc: `还差${(gap / 100).toFixed(2)}元，但门店暂无合适凑单品` };
  }

  // ── 步骤 3/4：逐个候选验证真实到手价 ──
  let best = null;
  for (const cand of candidates.slice(0, 3)) {
    const comboItems = [
      ...items.map((i) => ({ productCode: i.productCode, quantity: i.quantity })),
      { productCode: cand.code, quantity: 1 }
    ];
    const boundItems = bindCouponsToItems(comboItems, [targetCoupon]);

    let price = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const payload = await tools.calculatePrice({ storeCode, beType, items: boundItems, beCode });
      price = extractPrice(payload);
    } catch (err) {
      // 单个凑单品验证失败 → 跳过，继续试下一个
      logger.warn('COMBO', `凑单品 ${cand.name} 验证失败，跳过`, err.message);
    }
    if (!price) continue;

    const candidate = {
      item: { productCode: cand.code, name: cand.name, price: cand.price },
      finalPrice: price.finalPrice,
      saveCompare: basePrice.finalPrice - price.finalPrice
    };

    // 凑单后总价更低才成立
    if (price.finalPrice < basePrice.finalPrice && (!best || price.finalPrice < best.finalPrice)) {
      best = candidate;
    }
  }

  if (!best) {
    return {
      ...base,
      gapAmount: gap,
      desc: `还差${(gap / 100).toFixed(2)}元可达门槛，但凑单后总价不划算，不建议凑单`
    };
  }

  return {
    needExtra: true,
    gapAmount: gap,
    bestItem: best.item,
    finalPrice: best.finalPrice,
    isWorth: true,
    desc: `加购「${best.item.name}」（${(best.item.price / 100).toFixed(2)}元）即可用「${targetCoupon.title}」，` +
         `比不用券省${(best.saveCompare / 100).toFixed(2)}元`
  };
}

/**
 * 筛选凑单候选商品
 * 规则：单价在 [5元, 15元] 区间、价格 ≥ 差额、优先低价
 */
function pickComboCandidates(menu, gap) {
  const meals = menu?.data?.meals;
  if (!meals || typeof meals !== 'object') return [];

  return Object.entries(meals)
    .map(([code, m]) => ({
      code,
      name: m.name ?? code,
      price: Math.round(Number(m.currentPrice ?? 0) * 100) // 元 → 分
    }))
    .filter((m) => m.price >= config.combo.minPrice && m.price <= config.combo.maxPrice)
    .filter((m) => m.price >= gap)
    .filter((m) => !/套餐|礼盒|周边|帽|徽章|贴|玩具/.test(m.name)) // 排除套餐与周边
    .sort((a, b) => a.price - b.price);
}

export default { recommendCombo };
