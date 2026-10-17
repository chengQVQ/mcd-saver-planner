/**
 * 模块 6：积分最优兑换
 *
 * 功能：匹配积分兑换最优路径，将积分折算为点餐优惠
 *
 * 核心：积分价值比 = 优惠券面值 / 所需积分（元 / 积分）
 * 价值比越高越划算，优先消耗临期积分
 */

import logger from '../utils/logger.js';
import { degrade } from '../utils/retry.js';
import { formatYuan } from '../utils/money.js';

/** 点餐类可兑换券分类（catRuleIds），点餐相关分类 */
const FOOD_CATEGORIES = ['1', '2', '3', '4'];

/**
 * 积分最优兑换
 *
 * @param {Object} p
 * @param {import('../mcp/tools.js').default} p.tools
 * @param {number} [p.currentPrice] 当前订单金额（分），用于估算抵扣价值
 * @returns {Promise<Object>} 积分兑换方案
 */
export async function optimizePoints({ tools, currentPrice = null }) {
  // ── 步骤 1：获取用户积分详情 ──
  const account = await degrade(() => tools.queryMyAccount(), null, 'POINTS');
  if (!account?.data) {
    return {
      availablePoints: 0,
      expiringPoints: 0,
      bestCoupon: null,
      pointValueRatio: 0,
      finalPriceAfterExchange: currentPrice,
      cashSave: 0,
      desc: '积分账户查询失败，暂时无法给出兑换方案'
    };
  }

  const availablePoints = Math.floor(Number(account.data.availablePoint ?? 0));
  const expiringPoints = Math.floor(Number(account.data.currentMouthExpirePoint ?? 0));

  if (availablePoints <= 0) {
    return {
      availablePoints: 0,
      expiringPoints,
      bestCoupon: null,
      pointValueRatio: 0,
      finalPriceAfterExchange: currentPrice,
      cashSave: 0,
      desc: '当前无可用积分'
    };
  }

  // ── 步骤 2：筛选点餐类可兑换券 ──
  const goodsRaw = await degrade(() => tools.mallPointsProducts({ catRuleIds: '1' }), null, 'POINTS');
  const goods = normalizeGoods(goodsRaw);

  if (!goods.length) {
    return {
      availablePoints,
      expiringPoints,
      bestCoupon: null,
      pointValueRatio: 0,
      finalPriceAfterExchange: currentPrice,
      cashSave: 0,
      desc: `你有 ${availablePoints} 积分，但暂无可兑换的点餐类优惠券`
    };
  }

  // ── 步骤 3/4：计算积分价值比并排序 ──
  const scored = goods
    .filter((g) => g.points > 0)
    .map((g) => ({
      ...g,
      pointValueRatio: g.points > 0 ? g.value / g.points : 0, // 元 / 积分
      affordable: g.points <= availablePoints
    }))
    .filter((g) => g.affordable)
    .sort((a, b) => b.pointValueRatio - a.pointValueRatio);

  if (!scored.length) {
    return {
      availablePoints,
      expiringPoints,
      bestCoupon: null,
      pointValueRatio: 0,
      finalPriceAfterExchange: currentPrice,
      cashSave: 0,
      desc: `可用积分 ${availablePoints}，暂无积分额度足够的兑换项（最低需要 ${Math.min(...goods.map((g) => g.points))} 积分）`
    };
  }

  const best = scored[0];
  logger.info('POINTS', `最优兑换：${best.name}，价值比 ${best.pointValueRatio.toFixed(4)} 元/积分`);

  // ── 步骤 5：生成兑换 + 点餐组合方案 ──
  const isExpiringUsed = expiringPoints >= best.points;
  const finalPrice = currentPrice !== null ? Math.max(0, currentPrice - best.value * 100) : null;

  return {
    availablePoints,
    expiringPoints,
    bestCoupon: {
      spuId: best.spuId,
      skuId: best.skuId,
      name: best.name,
      points: best.points,
      value: best.value
    },
    pointValueRatio: Number(best.pointValueRatio.toFixed(4)),
    finalPriceAfterExchange: finalPrice,
    cashSave: currentPrice !== null ? Math.min(currentPrice, best.value * 100) : 0,
    desc:
      `推荐兑换「${best.name}」：${best.points} 积分换${formatYuan(best.value * 100)}券，` +
      `价值比${best.pointValueRatio.toFixed(4)} 元/积分（全站最优）` +
      (isExpiringUsed ? `，且可消耗本月即将过期的 ${expiringPoints} 积分` : '') +
      `。兑换后剩余 ${availablePoints - best.points} 积分`
  };
}

/** 归一化商城商品数据 */
function normalizeGoods(payload) {
  const data = payload?.data;
  const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : Array.isArray(data?.spuList) ? data.spuList : [];
  if (!list.length) return [];

  return list
    .map((g) => {
      const points = Math.floor(Number(g.points ?? g.point ?? g.pointPrice ?? 0));
      const value = Number(g.value ?? g.amount ?? g.couponAmount ?? 0); // 券面值（元）
      if (points <= 0 || value <= 0) return null;
      return {
        spuId: String(g.spuId ?? g.id ?? ''),
        skuId: String(g.skuId ?? g.sku ?? ''),
        spuCategory: g.spuCategory ?? '',
        name: g.name ?? g.spuName ?? '积分兑换券',
        points,
        value,
        category: String(g.categoryName ?? g.catName ?? g.category ?? ''),
        categoryId: String(g.catRuleId ?? g.categoryId ?? '')
      };
    })
    .filter(Boolean)
    .filter((g) => isFoodCategory(g));
}

/**
 * 判断是否为点餐类可兑换券
 *
 * 官方接口的分类字段命名不统一（可能是 categoryName / catRuleId 等），
 * 这里同时按 ID 与中文名判定，避免把有效券误过滤掉。
 */
function isFoodCategory(g) {
  // 未提供分类信息时不拦截，交由后续按名称与积分价值比排序
  if (!g.category && !g.categoryId) return true;
  if (FOOD_CATEGORIES.includes(g.categoryId)) return true;
  if (FOOD_CATEGORIES.includes(g.category)) return true;
  return /点餐|餐品|优惠券|堂食|外送|到店/.test(g.category);
}

export default { optimizePoints };
