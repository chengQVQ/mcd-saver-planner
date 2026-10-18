/**
 * 模块 3：多渠道价格对比
 *
 * 功能：同款餐品对比 3 种取餐渠道的最终价格，输出综合推荐
 * 综合评分（§9.2）：价格 60% + 时间 25% + 距离 15%
 */

import config, { BE_TYPE } from '../config.js';
import logger from '../utils/logger.js';
import { calcBestPlans } from './priceEngine.js';

/** 待比价的三个渠道 */
const CHANNELS = [
  { beType: BE_TYPE.IN_STORE,   label: '到店自取', needAddress: false },
  { beType: BE_TYPE.DELIVERY,   label: '麦乐送',   needAddress: true },
  { beType: BE_TYPE.DRIVE_THRU, label: '得来速',   needAddress: false }
];

/**
 * 多渠道价格对比与推荐
 *
 * @param {Object} p
 * @param {import('../mcp/tools.js').default} p.tools
 * @param {Array} p.items 商品列表
 * @param {string} [p.city] 城市（到店 / 得来速渠道需要）
 * @param {string} [p.keyword] 位置关键词
 * @param {string} [p.addressId] 配送地址 ID（外送渠道用）
 * @returns {Promise<Array>} 渠道方案列表，按推荐分排序
 */
export async function compareChannels({ tools, items, city, keyword, addressId }) {
  const channelPlans = [];

  // ── 步骤 1：匹配各渠道门店（缺位置的渠道跳过，不降级）──
  const storeQueries = [];
  if (city || keyword) {
    storeQueries.push(
      tools.queryNearbyStores({ beType: BE_TYPE.IN_STORE, searchType: 2, city, keyword }).catch(() => null),
      tools.queryNearbyStores({ beType: BE_TYPE.DRIVE_THRU, searchType: 2, city, keyword }).catch(() => null)
    );
  } else {
    storeQueries.push(Promise.resolve(null), Promise.resolve(null));
  }

  // 外送：有 addressId 直接查，没有就先取地址列表
  let deliveryStorePromise;
  if (addressId) {
    deliveryStorePromise = tools.queryDeliveryStores({ addressId, beType: BE_TYPE.DELIVERY }).catch(() => null);
  } else {
    deliveryStorePromise = tools.queryDeliveryAddresses()
      .then((addrRes) => {
        const first = Array.isArray(addrRes?.data) ? addrRes.data[0] : null;
        if (!first) return null;
        return tools.queryDeliveryStores({
          addressId: String(first.addressId ?? first.id ?? ''),
          beType: BE_TYPE.DELIVERY
        });
      })
      .catch(() => null);
  }
  storeQueries.push(deliveryStorePromise);

  const [inStoreStores, driveThruStores, deliveryStores] = await Promise.all(storeQueries);

  // ── 步骤 2：取每个渠道距离最近的 1 家营业门店 ──
  const candidates = [
    { beType: BE_TYPE.IN_STORE,   store: pickNearest(inStoreStores) },
    { beType: BE_TYPE.DRIVE_THRU, store: pickNearest(driveThruStores) },
    { beType: BE_TYPE.DELIVERY,   store: pickNearest(deliveryStores) }
  ].filter((c) => c.store);

  if (!candidates.length) {
    return [];
  }

  // ── 步骤 3：对每家门店分别计算该渠道最低到手价 ──
  for (const { beType, store } of candidates) {
    const channelMeta = CHANNELS.find((c) => c.beType === beType);
    logger.info('CHANNEL', `计算 ${channelMeta.label} 渠道最优价：${store.storeName}`);

    // eslint-disable-next-line no-await-in-loop
    const plans = await calcBestPlans({
      tools,
      storeCode: store.storeCode,
      beType,
      items,
      beCode: store.beCode,
      store
    });

    if (!plans.length) continue;

    const best = plans[0];
    channelPlans.push({
      ...best,
      beType,
      beCode: store.beCode,
      storeName: store.storeName,
      storeAddress: store.address ?? '',
      distance: store.distance ?? null,
      /** 预计等待时间：到店/得来速按门店出餐估算，外送按门店距离估算 */
      waitTime: estimateWait(beType, store),
      businessStatus: store.businessStatus ?? null,
      businessHours: store.businessStartTime && store.businessEndTime
        ? `${store.businessStartTime}-${store.businessEndTime}`
        : null,
      availablePlans: plans
    });
  }

  if (!channelPlans.length) return [];

  // ── 步骤 4/5：归一化 + 综合评分 + 排序 ──
  scoreChannels(channelPlans);

  return channelPlans.sort((a, b) => b.recommendScore - a.recommendScore);
}

/** 取距离最近门店 */
function pickNearest(payload) {
  const list = payload?.data;
  if (!Array.isArray(list) || !list.length) return null;
  return [...list].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
}

/**
 * 估算等待时间（分钟）
 * 优先使用门店营业状态，无实时数据时按渠道经验值估算
 */
function estimateWait(beType, store) {
  if (store.businessStatus === false) return null; // 当前不营业
  if (beType === BE_TYPE.DELIVERY) {
    const km = (store.distance ?? 0) / 1000;
    return Math.round(25 + km * 3);
  }
  if (beType === BE_TYPE.DRIVE_THRU) return 8;
  return 12;
}

/**
 * 多渠道综合评分算法（§9.2）
 * 价格归一化：min-max，越低得分越高
 * 时间归一化：越短得分越高
 * 距离归一化：越近得分越高（外送渠道距离分记 0.5）
 */
function scoreChannels(plans) {
  const w = config.recommend.channelWeight;

  const prices = plans.map((p) => p.finalPrice).filter((v) => typeof v === 'number');
  const times = plans.map((p) => p.waitTime).filter((v) => typeof v === 'number' && v > 0);
  const distances = plans.map((p) => p.distance).filter((v) => typeof v === 'number');

  const priceRange = minMax(prices);
  const timeRange = minMax(times);
  const distRange = minMax(distances);

  for (const p of plans) {
    const priceNorm = inverseNorm(p.finalPrice, priceRange);
    const timeNorm = inverseNorm(p.waitTime, timeRange);
    // 外送渠道距离分固定 0.5（距离已体现在配送时效与费用中）
    const distanceNorm = p.beType === BE_TYPE.DELIVERY ? 0.5 : inverseNorm(p.distance, distRange);

    p.scoreDetail = {
      price: Number(priceNorm.toFixed(3)),
      time: Number(timeNorm.toFixed(3)),
      distance: Number(distanceNorm.toFixed(3))
    };
    p.recommendScore = Number(
      (priceNorm * w.price + timeNorm * w.time + distanceNorm * w.distance).toFixed(4)
    );
  }
}

/** min-max 归一化边界 */
function minMax(arr) {
  if (!arr.length) return { min: 0, max: 0 };
  return { min: Math.min(...arr), max: Math.max(...arr) };
}

/**
 * 反向归一化：值越小得分越高（0-1）
 * 无效值（null / undefined）按 0.5 中性分处理
 */
function inverseNorm(value, { min, max }) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  if (max === min) return 1;
  return (max - value) / (max - min);
}

export default { compareChannels };
