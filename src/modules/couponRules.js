/**
 * 优惠券数据模型与叠加规则引擎
 *
 * Coupon 结构（§8.2）：
 *  {
 *    couponId, couponCode, title,
 *    type: 'store' | 'mms' | 'activity' | 'point',
 *    threshold,            // 满减门槛，单位分
 *    discount,             // 优惠金额，单位分
 *    applicableProducts,   // 适用商品编码列表，null 为全场通用
 *    mutuallyExclusive,    // 互斥券类型
 *    channel,              // 适用渠道：1 到店 2 外送 5 得来速 6 团餐
 *    startTime, endTime
 *  }
 */

/** 券类型枚举 */
export const COUPON_TYPE = {
  STORE: 'store',       // 门店券
  MMS: 'mms',           // 麦麦省券
  ACTIVITY: 'activity', // 活动券
  POINT: 'point'        // 积分券
};

/** 同类型互斥组：组内任意两张券不可同时使用 */
const MUTEX_GROUPS = [[COUPON_TYPE.STORE], [COUPON_TYPE.MMS], [COUPON_TYPE.ACTIVITY]];

/**
 * 从 query-store-coupons 返回中解析券列表
 * 官方返回结构：data[] 中每项含 couponId / couponCode / title / tradeDateTime / products[]
 * 同一券 ID 可能对应多个券码，需按券 ID 分组。
 *
 * @param {*} payload MCP 返回
 * @returns {Coupon[]}
 */
export function parseStoreCoupons(payload) {
  const raw = payload?.data;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const byId = new Map();
  for (const item of raw) {
    const id = String(item.couponId ?? '');
    if (!id) continue;

    const products = (item.products ?? [])
      .map((p) => ({
        productCode: String(p.productCode ?? ''),
        productName: String(p.productName ?? '')
      }))
      .filter((p) => p.productCode);

    const codes = Array.isArray(item.couponCodes) ? item.couponCodes : [item.couponCode].filter(Boolean);
    const title = String(item.title ?? '门店优惠券');
    const parsed = parseCouponTitle(title);

    if (!byId.has(id)) {
      byId.set(id, {
        couponId: id,
        couponCodes: codes.map(String),
        couponCode: codes[0] ? String(codes[0]) : '',
        title,
        type: COUPON_TYPE.STORE,
        // ⚠️ 实测：官方 query-store-coupons 不返回 threshold / discount 字段，
        //    满减信息仅体现在 title 文案中（如「满40减8」「满30减5」），
        //    此处从标题解析，解析失败时回落到服务端 calculate-price 的真实返回。
        threshold: Number(item.threshold ?? item.minAmount ?? parsed.threshold),
        discount: Number(item.discount ?? item.amount ?? item.discountAmount ?? parsed.discount),
        applicableProducts: products.length ? products.map((p) => p.productCode) : null,
        applicableProductNames: products.map((p) => p.productName),
        mutuallyExclusive: [],
        channel: [],
        tradeDateTime: item.tradeDateTime ?? ''
      });
    }
  }

  return [...byId.values()];
}

/**
 * 从券标题解析满减信息
 *
 * 支持文案：
 *  - 「满40减8」        → threshold 4000, discount 800
 *  - 「满30元减5元」→ threshold 3000, discount 500
 *  - 「满50减10」      → threshold 5000, discount 1000
 *  - 「第二份半价」    → threshold 0, discount按单品价估算（此处留0）
 *  - 「买一送一」      → threshold 0
 *
 * @param {string} title 券标题
 * @returns {{threshold:number, discount:number}} 单位：分
 */
export function parseCouponTitle(title) {
  const text = String(title ?? '');
  const toCent = (n) => Math.round(Number(n) * 100);

  // 满 X 减 Y（支持可选的「元」字与小数）
  const manjian = text.match(/满\s*(\d+(?:\.\d+)?)\s*(?:元)?\s*减\s*(\d+(?:\.\d+)?)\s*(?:元)?/);
  if (manjian) {
    return { threshold: toCent(manjian[1]), discount: toCent(manjian[2]) };
  }

  // 立减 X 元 / 减 X 元（无门槛）
  const lijian = text.match(/(?:立减|直减|减)\s*(\d+(?:\.\d+)?)\s*元/);
  if (lijian) {
    return { threshold: 0, discount: toCent(lijian[1]) };
  }

  // X 折
  const zhe = text.match(/(\d+(?:\.\d+)?)\s*折/);
  if (zhe) {
    const d = Number(zhe[1]);
    if (d > 0 && d < 10) return { threshold: 0, discount: Math.round(3500 * (1 - d / 10)) };
  }

  return { threshold: 0, discount: 0 };
}

/**
 * 从 query-my-coupons 返回中解析用户已持券
 * ⚠️ 官方说明：该接口不校验门店/渠道可用性，实际可用性以 query-store-coupons 为准
 */
export function parseMyCoupons(payload) {
  const raw = payload?.data;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  return raw
    .map((item) => {
      const id = String(item.couponId ?? item.id ?? '');
      if (!id) return null;
      const title = String(item.title ?? item.name ?? '用户优惠券');
      const parsed = parseCouponTitle(title);
      // 用户券接口同样可能不返回 threshold / discount，优先取字段，缺失时解析标题
      const rawThreshold = item.threshold ?? item.minAmount;
      const rawDiscount = item.discount ?? item.amount;
      return {
        couponId: id,
        couponCodes: [String(item.couponCode ?? '')].filter(Boolean),
        couponCode: String(item.couponCode ?? ''),
        title,
        type: inferType(item),
        // 字段单位为「元」时需 ×100；已是「分」且数值较大时按分处理
        threshold: normalizeAmount(rawThreshold, parsed.threshold),
        discount: normalizeAmount(rawDiscount, parsed.discount),
        applicableProducts: item.products?.length ? item.products.map((p) => String(p.productCode ?? p)) : null,
        mutuallyExclusive: [],
        channel: Array.isArray(item.channel) ? item.channel : [],
        tradeDateTime: item.tradeDateTime ?? ''
      };
    })
    .filter(Boolean);
}

/**
 * 金额单位归一化：内部统一使用「分」
 *
 * MCP 各接口金额口径不完全一致：
 *  - 券类字段（threshold / discount / minAmount）通常为「元」
 *  - 价格计算类字段（price / finalPrice）为「分」
 * 判据：数值 ≥ 1000 视为已是「分」，否则按「元」换算。
 *
 * @param {*} value 原始值
 * @param {number} fallback 兜底值（单位：分）
 * @returns {number} 单位：分
 */
function normalizeAmount(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n >= 1000 ? Math.round(n) : Math.round(n * 100);
}

/** 推断券类型 */
function inferType(item) {
  const t = String(item.type ?? '').toLowerCase();
  if (t.includes('store') || t.includes('门店')) return COUPON_TYPE.STORE;
  if (t.includes('point') || t.includes('积分')) return COUPON_TYPE.POINT;
  if (t.includes('activity') || t.includes('campaign') || t.includes('活动')) return COUPON_TYPE.ACTIVITY;
  return COUPON_TYPE.MMS;
}

/**
 * 判断券是否适用于当前订单
 * @param {Coupon} coupon
 * @param {Object} ctx { productCodes:Set<string>, beType:number, total:number }
 * @returns {{ok:boolean, reason?:string}}
 */
export function isApplicable(coupon, ctx) {
  const { productCodes, beType, total } = ctx;

  // 渠道限制
  if (Array.isArray(coupon.channel) && coupon.channel.length && beType && !coupon.channel.includes(beType)) {
    return { ok: false, reason: '渠道不适用' };
  }

  // 商品范围：券限定商品时，需与订单商品有交集
  if (Array.isArray(coupon.applicableProducts) && coupon.applicableProducts.length) {
    const hit = coupon.applicableProducts.some((code) => productCodes.has(code));
    if (!hit) return { ok: false, reason: '不含订单内商品' };
  }

  // 满减门槛
  if (coupon.threshold > 0 && total < coupon.threshold) {
    return { ok: false, reason: `未达${(coupon.threshold / 100).toFixed(0)}元门槛` };
  }

  // 有效期
  const now = Date.now();
  if (coupon.startTime && new Date(coupon.startTime).getTime() > now) return { ok: false, reason: '未生效' };
  if (coupon.endTime && new Date(coupon.endTime).getTime() < now) return { ok: false, reason: '已过期' };

  return { ok: true };
}

/**
 * 生成可行优惠券组合
 *
 * 规则：
 *  - 规则 1：同类型优惠券互斥（麦麦省券之间、门店券之间不可叠加）
 *  - 规则 2：活动券默认不与其他优惠同享
 *  - 规则 3：不同类型的券（门店券 + 麦麦省券）可叠加
 *  - 规则 4：积分券单独成组（需先兑换，不与现金券叠加）
 *
 * @param {Coupon[]} coupons 候选券
 * @param {Object} ctx
 * @returns {Coupon[][]} 组合列表，元素为券数组
 */
export function buildCombinations(coupons, ctx) {
  const valid = coupons.filter((c) => isApplicable(c, ctx).ok);

  // 空组合：不使用任何券，永远是可行基线
  const combinations = [[]];

  // 单券组合
  for (const c of valid) combinations.push([c]);

  // 按类型分组
  const byType = new Map();
  for (const c of valid) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type).push(c);
  }

  // 跨类型两两组合（跳过积分券，积分需单独兑换流程）
  const cashTypes = [...byType.keys()].filter((t) => t !== COUPON_TYPE.POINT);
  for (let i = 0; i < cashTypes.length; i++) {
    for (let j = i + 1; j < cashTypes.length; j++) {
      const a = byType.get(cashTypes[i]) ?? [];
      const b = byType.get(cashTypes[j]) ?? [];
      for (const ca of a) {
        for (const cb of b) {
          if (areMutuallyExclusive(ca, cb)) continue;
          // 规则 2：活动券不与其他券同享
          if (ca.type === COUPON_TYPE.ACTIVITY || cb.type === COUPON_TYPE.ACTIVITY) continue;
          combinations.push([ca, cb]);
        }
      }
    }
  }

  // 同类型互斥校验：过滤掉含同组重复类型的组合
  const filtered = combinations.filter((combo) => {
    if (combo.length <= 1) return true;
    for (const group of MUTEX_GROUPS) {
      const count = combo.filter((c) => group.includes(c.type)).length;
      if (count > 1) return false;
    }
    return true;
  });

  return filtered;
}

/**
 * 判断两张券是否互斥
 */
export function areMutuallyExclusive(a, b) {
  if (!a || !b) return false;
  if (a.couponId === b.couponId) return true;
  if (Array.isArray(a.mutuallyExclusive) && a.mutuallyExclusive.includes(b.type)) return true;
  if (Array.isArray(b.mutuallyExclusive) && b.mutuallyExclusive.includes(a.type)) return true;
  // 同类型默认互斥
  if (a.type === b.type && MUTEX_GROUPS.some((g) => g.includes(a.type))) return true;
  // 活动券不与其他券同享
  if (a.type === COUPON_TYPE.ACTIVITY || b.type === COUPON_TYPE.ACTIVITY) return true;
  return false;
}

/**
 * 将组合中的券绑定到商品项上
 *
 * ⚠️ 关键契约：官方 calculate-price / create-order 的 couponId / couponCode
 *    是商品项级别的字段，不是订单级。多张券叠加时需要把不同券挂到不同商品项，
 *    否则服务端只会识别其中一张。
 *
 * @param {Array} items 原始商品项
 * @param {Coupon[]} combo 券组合
 * @returns {Array} 绑定后的商品项
 */
export function bindCouponsToItems(items, combo) {
  const bound = items.map((i) => ({ productCode: i.productCode, quantity: i.quantity }));

  combo.forEach((coupon, idx) => {
    // 优先绑定到券适用范围内的商品，否则绑定到第一个商品
    let targetIndex = bound.findIndex((item) => {
      if (!coupon.applicableProducts) return false;
      return coupon.applicableProducts.includes(item.productCode);
    });
    if (targetIndex === -1) targetIndex = 0;
    if (!bound[targetIndex]) return;

    // 已有券则记录到 couponCodes（供多券叠加场景）
    if (bound[targetIndex].couponId) {
      bound[targetIndex].couponCodes = [
        ...(bound[targetIndex].couponCodes ?? [{ couponId: bound[targetIndex].couponId, couponCode: bound[targetIndex].couponCode }]),
        { couponId: coupon.couponId, couponCode: coupon.couponCode }
      ];
      return;
    }

    bound[targetIndex].couponId = coupon.couponId;
    bound[targetIndex].couponCode = coupon.couponCode;

    // 若该券只能作用于特定商品，拆出该商品为独立项，保证服务端正确匹配
    if (idx === 0 && coupon.applicableProducts?.length && bound.length > 1) {
      const hit = bound.findIndex((i) => coupon.applicableProducts.includes(i.productCode));
      if (hit > 0) {
        bound[0] = { productCode: bound[hit].productCode, quantity: bound[hit].quantity, couponId: coupon.couponId, couponCode: coupon.couponCode };
        bound[hit] = { productCode: bound[hit].productCode, quantity: bound[hit].quantity };
      }
    }
  });

  return bound;
}

export default { parseStoreCoupons, parseMyCoupons, parseCouponTitle, isApplicable, buildCombinations, areMutuallyExclusive, bindCouponsToItems, COUPON_TYPE };
