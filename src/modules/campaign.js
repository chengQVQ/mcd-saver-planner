/**
 * 模块 5：活动预判与购买决策
 *
 * 功能：结合近期活动，给出「现在买 / 等活动买」的决策建议
 *
 * 决策规则：
 *  - 活动优惠 ≥ 10% → 建议等活动，标注开售时间
 *  - 活动优惠 < 10% → 建议现在买
 */

import config from '../config.js';
import { degrade } from '../utils/retry.js';
import { formatYuan } from '../utils/money.js';

/**
 * 活动预判与购买决策
 *
 * @param {Object} p
 * @param {import('../mcp/tools.js').default} p.tools
 * @param {string[]} [p.foodKeywords] 目标餐品关键词
 * @param {number} [p.currentBestPrice] 当前最优到手价（分），用于对比
 * @returns {Promise<Object>} 活动决策建议
 */
export async function predictCampaign({ tools, foodKeywords = [], currentBestPrice = null }) {
  // ── 步骤 1：获取活动日历 ──
  const calendar = await degrade(() => tools.campaignCalendar({}), null, 'CAMPAIGN');

  const allActivities = normalizeCampaigns(calendar);

  if (!allActivities.length) {
    return {
      currentBestPrice,
      futureActivities: [],
      suggestion: '现在买',
      suggestReason: '近期无相关活动，推荐按当前最优方案购买',
      nextActivityTime: null
    };
  }

  // ── 步骤 2：筛选与目标餐品相关的活动 ──
  const related = foodKeywords.length
    ? allActivities.filter((a) =>
        foodKeywords.some((k) => JSON.stringify(a).includes(k)) ||
        /全场|通用|折|减|券/.test(a.title ?? '')
      )
    : allActivities;

  // 区分进行中与未来活动
  const now = Date.now();
  const future = related
    .filter((a) => {
      const start = new Date(a.startTime ?? a.startDate ?? 0).getTime();
      return !Number.isFinite(start) || start > now || a.status === '未开始' || a.status === '即将开始';
    })
    .sort((a, b) => new Date(a.startTime ?? a.startDate ?? 0) - new Date(b.startTime ?? b.startDate ?? 0));

  if (!future.length) {
    return {
      currentBestPrice,
      futureActivities: related.slice(0, 3),
      suggestion: '现在买',
      suggestReason: related.length
        ? `现有活动（${related[0].title}）已过期或正在进行，暂无更优的即将开始活动`
        : '近期无相关活动，推荐当前购买',
      nextActivityTime: null
    };
  }

  // ── 步骤 3/4：估算活动优惠并对比 ──
  // 为每个未来活动估算折扣率，取「预计优惠力度最大」的活动作为决策依据
  // （而非时间上最近的一个——最早开始的活动未必优惠力度最大）
  const scored = future.map((a) => ({ activity: a, rate: estimateDiscountRate(a) }));
  const best = scored.reduce(
    (acc, cur) => (cur.rate > acc.rate ? cur : acc),
    scored[0]
  );
  const bestActivity = best.activity;
  const estimatedDiscount = best.rate;

  let suggestion = '现在买';
  let suggestReason = `即将开始的活动「${bestActivity.title}」预计优惠约${(estimatedDiscount * 100).toFixed(0)}%，` +
    `低于${(config.campaign.waitThreshold * 100).toFixed(0)}%阈值，建议当前购买`;

  if (estimatedDiscount >= config.campaign.waitThreshold) {
    suggestion = '等活动买';
    suggestReason = `「${bestActivity.title}」预计优惠约${(estimatedDiscount * 100).toFixed(0)}%，` +
      `明显优于当前方案${currentBestPrice ? `（${formatYuan(currentBestPrice)}）` : ''}，建议等到活动开始再下单`;
  }

  return {
    currentBestPrice,
    futureActivities: future.slice(0, 3),
    suggestion,
    suggestReason,
    nextActivityTime: bestActivity.startTime ?? bestActivity.startDate ?? null
  };
}

/** 归一化活动日历数据 */
function normalizeCampaigns(payload) {
  const data = payload?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((a) => ({
      title: a.title ?? a.name ?? '未命名活动',
      status: a.status ?? a.activityStatus ?? '',
      startTime: a.startTime ?? a.startDate ?? null,
      endTime: a.endTime ?? a.endDate ?? null,
      description: a.description ?? a.desc ?? '',
      type: a.type ?? ''
    }))
    .filter((a) => a.title);
}

/**
 * 估算活动折扣率
 * 优先从活动描述中解析折扣数字（如「8折」「立减10元」），无法解析时按活动类型给经验值
 */
function estimateDiscountRate(activity) {
  const text = `${activity.title} ${activity.description}`;

  // 「X折」→ 折扣率 = 1 - X/10
  const zhe = text.match(/(\d+(?:\.\d+)?)\s*折/);
  if (zhe) {
    const d = Number(zhe[1]);
    if (d > 0 && d <= 10) return Math.max(0, (10 - d) / 10);
  }

  // 「立减 N 元」→ 按客单价 35 元估算
  const jian = text.match(/立减\s*(\d+(?:\.\d+)?)\s*元|减\s*(\d+(?:\.\d+)?)\s*元/);
  if (jian) {
    const amount = Number(jian[1] ?? jian[2]);
    if (amount > 0) return Math.min(0.6, amount / 3500);
  }

  // 满减「满 N 减 M」
  const man = text.match(/满\s*(\d+)\s*减\s*(\d+)/);
  if (man) {
    const [full, cut] = [Number(man[1]), Number(man[2])];
    if (full > 0) return Math.min(0.8, cut / full);
  }

  // 按活动类型给经验值
  if (/新品|首发|限时|秒杀/.test(text)) return 0.15;
  if (/会员日|免费/.test(text)) return 0.2;
  return 0.08;
}

export default { predictCampaign };
