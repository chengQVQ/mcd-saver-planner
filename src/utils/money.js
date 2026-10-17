/**
 * 金额与单位转换工具
 *
 * ⚠️ 单位约定（对齐官方 MCP 返回）：
 *  - calculate-price / create-order 返回的价格字段单位为「分」
 *  - query-meals 返回的 currentPrice / originalPrice 单位为「元」（字符串）
 *  本模块统一以「分」为内部计算单位，对外展示时转为「元」。
 */

/** 元 → 分 */
export function yuanToCent(yuan) {
  const n = Number(yuan);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 分 → 元（保留 2 位） */
export function centToYuan(cent) {
  return (Number(cent || 0) / 100).toFixed(2);
}

/** 分 → 展示用「¥12.50」 */
export function formatYuan(cent) {
  return `¥${centToYuan(cent)}`;
}

/**
 * 安全提取价格字段，自动兼容「分 / 元」两种口径
 * @param {*} raw 原始值
 * @param {number} defaultUnit 默认单位：'cent' | 'yuan'
 * @returns {number} 统一为分
 */
export function normalizePrice(raw, defaultUnit = 'cent') {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return defaultUnit === 'yuan' ? yuanToCent(n) : Math.round(n);
}

/**
 * 从 calculate-price 响应中解析价格（单位：分）
 * 官方返回结构中价格字段名可能随版本变化，此处做多字段兜底。
 */
export function extractPrice(payload) {
  if (!payload) return null;
  const d = payload.data ?? payload;
  const pick = (...keys) => {
    for (const k of keys) {
      if (d?.[k] !== undefined && d?.[k] !== null && d?.[k] !== '') {
        const n = Number(d[k]);
        if (Number.isFinite(n)) return Math.round(n);
      }
    }
    return null;
  };

  const finalPrice   = pick('finalPrice', 'totalPrice', 'payPrice', 'actualPrice', 'shouldPayAmount');
  const originalPrice= pick('originalPrice', 'totalOriginalPrice', 'goodsAmount', 'totalAmount');
  const discount     = pick('discountAmount', 'discountPrice', 'reduceAmount', 'preferentialAmount');
  const deliveryFee  = pick('deliveryFee', 'shippingFee', 'freight');

  if (finalPrice === null && originalPrice === null) return null;

  const resolvedDiscount = discount ?? Math.max(0, (originalPrice ?? 0) - (finalPrice ?? 0));

  return {
    finalPrice:    finalPrice ?? (originalPrice ?? 0) - resolvedDiscount,
    originalPrice: originalPrice ?? (finalPrice ?? 0) + resolvedDiscount,
    discountAmount: resolvedDiscount,
    deliveryFee:   deliveryFee ?? 0
  };
}

/** 计算优惠比例（0-1） */
export function saveRate(originalPrice, finalPrice) {
  const o = Number(originalPrice || 0);
  if (o <= 0) return 0;
  return Math.max(0, Math.min(1, (o - Number(finalPrice || 0)) / o));
}

export default { yuanToCent, centToYuan, formatYuan, normalizePrice, extractPrice, saveRate };
