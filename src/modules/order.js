/**
 * 模块 7：下单执行引擎
 *
 * 功能：确认方案后，一键完成领券、创建订单、返回支付链接
 *
 * 流程：
 *  1. 调用 auto-bind-coupons 一键领取麦麦省所有可用券
 *  2. 二次调用 calculate-price 校验最终价格与方案一致
 *  3. 组装订单参数，调用 create-order 创建订单
 *  4. 提取订单 ID、支付链接、取餐信息
 */

import { BE_TYPE } from '../config.js';
import logger from '../utils/logger.js';
import { extractPrice, formatYuan } from '../utils/money.js';

/**
 * 执行下单全流程
 *
 * @param {Object} p
 * @param {import('../mcp/tools.js').default} p.tools
 * @param {import('./priceEngine.js').Plan} p.plan 用户选中的方案
 * @param {string} [p.addressId] 配送地址 ID（外送必填）
 * @param {string} [p.remark] 订单备注（≤50字）
 * @param {boolean} [p.skipCouponBind] 跳过一键领券（用户已手动领过）
 * @returns {Promise<Object>} 订单结果
 */
export async function executeOrder({ tools, plan, addressId, remark, skipCouponBind = false }) {
  const fail = (errorMsg) => ({
    success: false,
    orderId: null,
    payUrl: null,
    finalPrice: plan?.finalPrice ?? null,
    errorMsg,
    suggestion: '可返回上一步选择次优方案，或调整餐品后重试'
  });

  if (!plan) return fail('未提供有效方案');

  const beType = beTypeFromPlan(plan);

  // 外送场景必须有地址
  if (beType === BE_TYPE.DELIVERY && !addressId) {
    return fail('麦乐送场景需要配送地址，请先选择地址');
  }

  // ── 步骤 1：一键领取麦麦省券 ──
  // 领券失败不阻断下单（券可能已领过），但会如实记录
  if (!skipCouponBind) {
    try {
      const bindResult = await tools.autoBindCoupons();
      const bound = extractCount(bindResult);
      logger.info('ORDER', bound ? `一键领券成功，新增 ${bound} 张` : '一键领券完成');
    } catch (err) {
      logger.warn('ORDER', '一键领券失败，将按方案原样下单', err.message);
    }
  }

  // ── 步骤 2：二次校验价格（失败即抛）──
  const verifyPayload = await tools.calculatePrice({
    storeCode: plan.storeCode,
    beType,
    items: plan.items,
    beCode: plan.beCode,
    withOrder: plan.withCard?.enabled ? withOrderPayload(plan.withCard) : undefined
  });

  const verified = extractPrice(verifyPayload);
  const actualPrice = verified?.finalPrice ?? plan.finalPrice;

  if (verified && typeof plan.finalPrice === 'number' && Math.abs(verified.finalPrice - plan.finalPrice) > 1) {
    logger.warn(
      'ORDER',
      `价格校验不一致：方案 ${formatYuan(plan.finalPrice)} → 实际 ${formatYuan(verified.finalPrice)}`
    );
  }

  // ── 步骤 3：创建订单（失败即返回失败）──
  const takeWayCode = pickTakeWayCode(verifyPayload);
  if (plan.orderType === 1 && !takeWayCode) {
    return fail('未能获取取餐方式（takeWayCode），无法创建到店订单，请重试');
  }

  const orderPayload = await tools.createOrder({
    storeCode: plan.storeCode,
    beType,
    beCode: plan.beCode,
    items: plan.items,
    takeWayCode,
    addressId,
    remark,
    needTableware: false,
    withOrder: plan.withCard?.enabled ? withOrderPayload(plan.withCard) : undefined
  });

  // ── 步骤 4：提取订单信息 ──
  const d = orderPayload?.data ?? {};
  const orderId = d.orderId ?? d.orderNo ?? d.id ?? null;
  const payUrl = d.payUrl ?? d.payLink ?? d.paymentUrl ?? d.url ?? null;

  // ⚠️ 业务级失败：HTTP 200 但 success=false（如缺地址、券失效、门店停业）
  if (orderPayload?.success === false) {
    return fail(`订单创建被拒绝：${orderPayload.message ?? '原因未返回'}`);
  }

  if (!orderId) {
    return fail(`订单响应缺少订单号：${JSON.stringify(orderPayload).slice(0, 200)}`);
  }

  return {
    success: true,
    orderId: String(orderId),
    payUrl,
    finalPrice: actualPrice,
    pickupInfo: buildPickupInfo(plan, takeWayCode),
    remark: remark ?? '',
    priceChanged: typeof plan.finalPrice === 'number' && typeof actualPrice === 'number'
      ? actualPrice !== plan.finalPrice
      : false,
    nextStep: payUrl
      ? '请通过支付链接扫码或打开麦当劳 APP 完成支付，支付后回复「支付完成」可查询订单状态'
      : '请打开麦当劳 APP 完成支付'
  };
}

/** 从方案推导 beType */
function beTypeFromPlan(plan) {
  const map = { inStore: 1, delivery: 2, driveThru: 5, groupMeal: 6 };
  return map[plan.channel] ?? plan.beType ?? BE_TYPE.IN_STORE;
}

/** 组装随单购参数 */
function withOrderPayload(card) {
  return {
    cardId: card.cardId,
    cardType: card.cardType === 'mcGold' ? 1 : card.cardType === 'breakfast' ? 2 : card.cardType,
    membershipCode: card.membershipCode,
    membershipSpecId: card.membershipSpecId
  };
}

/** 从 calculate-price 返回中选取取餐方式 */
function pickTakeWayCode(payload) {
  const takeWayList = payload?.data?.takeWayList ?? payload?.takeWayList;
  if (!Array.isArray(takeWayList) || !takeWayList.length) return null;
  // 优先「到店取餐」，其次「车道取餐」
  const preferred = takeWayList.find((t) => /到店|取餐|自取/.test(t.name ?? t.code ?? ''));
  return (preferred ?? takeWayList[0]).code;
}

/** 生成取餐信息文案 */
function buildPickupInfo(plan, takeWayCode) {
  const parts = [`门店：${plan.storeName || plan.storeCode}`];
  if (takeWayCode) parts.push(`取餐方式：${takeWayCode}`);
  if (plan.channel === 'delivery') parts.push('配送上门');
  return parts.join('，');
}

/** 提取领券数量 */
function extractCount(payload) {
  const d = payload?.data;
  if (typeof d === 'number') return d;
  if (Array.isArray(d)) return d.length;
  return d?.count ?? d?.total ?? d?.successCount ?? null;
}

export default { executeOrder };
