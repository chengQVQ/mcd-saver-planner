/**
 * 模块 1：需求解析与参数补全
 *
 * 功能：识别用户意图，提取业务参数，缺失参数时主动补全
 * 输入：用户原始对话文本
 * 输出：结构化请求对象
 */

import { BE_TYPE } from '../config.js';

/** 核心意图枚举 */
export const INTENT = {
  FOOD_OPTIMAL: '指定餐品最优',
  BUDGET_RECOMMEND: '按预算推荐',
  CAMPAIGN_QUERY: '活动查询',
  ORDER_REPEAT: '订单复购',
  POINTS_EXCHANGE: '积分兑换',
  GENERAL: '通用咨询'
};

/** 取餐方式关键词 → beType */
const TAKE_TYPE_KEYWORDS = [
  { beType: BE_TYPE.DELIVERY, orderType: 2, keywords: ['外送', '外卖', '送到家', '麦乐送', '送餐', '配送', '送到'] },
  { beType: BE_TYPE.DRIVE_THRU, orderType: 1, keywords: ['得来速', 'drive', '车道', '驾车', '开车去', '车取'] },
  { beType: BE_TYPE.IN_STORE,   orderType: 1, keywords: ['到店', '自取', '自提', '堂食', '到店取', '店里吃', '取餐'] }
];

/** 意图关键词规则（按优先级从高到低匹配） */
const INTENT_RULES = [
  { intent: INTENT.CAMPAIGN_QUERY, keywords: ['活动', '促销', '有没有活动', '要不要等', '什么时候有', '优惠活动', '预判', '新券', '上架'] },
  { intent: INTENT.ORDER_REPEAT,  keywords: ['再来一单', '重复上次', '上次那单', '和上次一样', '老样子', '复购', '再点一次'] },
  { intent: INTENT.POINTS_EXCHANGE, keywords: ['积分', '积分兑换', '用积分', '积分换', '麦享会', '积分抵', '积分价值'] },
  { intent: INTENT.FOOD_OPTIMAL,   keywords: ['怎么最省', '最便宜', '最划算', '最优惠', '最优', '划算', '省多少', '用什么券', '有没有券'] },
  { intent: INTENT.BUDGET_RECOMMEND, keywords: ['预算', '多少钱够', '左右吃', '以内', '不超过', '人均'] }
];

/**
 * 餐品关键词词典
 * 用于把自然语言映射到门店菜单中的真实商品（依赖 query-meals 返回的名称做模糊匹配）
 */
export const FOOD_LEXICON = [
  { key: '巨无霸', aliases: ['巨无霸', '巨无', 'bigmac'] },
  { key: '麦辣鸡腿堡', aliases: ['麦辣鸡腿堡', '麦辣鸡腿', '辣鸡腿堡', '麦辣'] },
  { key: '板烧鸡腿堡', aliases: ['板烧鸡腿堡', '板烧鸡腿', '板烧'] },
  { key: '双层吉士汉堡', aliases: ['双层吉士', '吉士汉堡', '双吉士'] },
  { key: '麦香鱼', aliases: ['麦香鱼', '鳕鱼堡', '鱼堡', '深海鳕鱼'] },
  { key: '麦乐鸡', aliases: ['麦乐鸡', '鸡块'] },
  { key: '麦辣鸡翅', aliases: ['麦辣鸡翅', '鸡翅', '辣鸡翅'] },
  { key: '薯条', aliases: ['薯条', '中薯', '大薯'] },
  { key: '可乐', aliases: ['可乐', '汽水', '雪碧', '饮料', '快乐水', '无糖可乐'] },
  { key: '咖啡', aliases: ['咖啡', '美式', '拿铁', '燕麦奶铁', '麦咖啡'] },
  { key: '派', aliases: ['苹果派', '派'] },
  { key: '圆筒冰淇淋', aliases: ['圆筒冰淇淋', '甜筒', '冰淇淋', '雪糕'] },
  { key: '麦旋风', aliases: ['麦旋风', '旋风'] },
  { key: '新地', aliases: ['新地', '圣代'] }
];

/** 中文数字 → 阿拉伯数字 */
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnToNumber(str) {
  if (/^\d+$/.test(str)) return Number(str);
  let total = 0;
  let current = 0;
  for (const ch of str) {
    if (ch === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (CN_NUM[ch] !== undefined) {
      current = CN_NUM[ch];
    }
  }
  return total + current;
}

/**
 * 解析用户输入，识别意图与提取参数
 * @param {string} input 用户原始文本
 * @returns {{intent:string, params:Object, missingFields:string[]}}
 */
export function parseIntent(input) {
  const text = String(input ?? '').trim();
  const lower = text.toLowerCase();

  if (!text) {
    return {
      intent: INTENT.GENERAL,
      params: { foodKeywords: [], budget: null, takeType: '未指定', beType: null, orderType: null, city: null, address: null, peopleCount: 1 },
      missingFields: ['需求']
    };
  }

  // 1. 意图分类
  let intent = INTENT.GENERAL;
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((k) => lower.includes(k.toLowerCase()))) {
      intent = rule.intent;
      break;
    }
  }

  // 2. 兜底升级：只要用户明确说了餐品或预算，就归为点餐意图，
  //    让引导问卷接管补全，而不是当成"通用咨询"直接返回通用话术
  if (intent === INTENT.GENERAL) {
    const foodHit = FOOD_LEXICON.some((f) => f.aliases.some((a) => text.includes(a)));
    const budgetHit = /\d+\s*(?:块|元|￥|¥)/.test(text);
    if (foodHit || budgetHit) intent = INTENT.FOOD_OPTIMAL;
  }

  // 2. 实体提取
  const params = {
    foodKeywords: extractFoodKeywords(text),
    budget: extractBudget(text),
    takeType: '未指定',
    beType: null,
    orderType: null,
    city: extractCity(text),
    address: extractAddress(text),
    peopleCount: extractPeopleCount(text)
  };

  const take = extractTakeType(lower);
  params.takeType = take.takeType;
  params.beType = take.beType;
  params.orderType = take.orderType;

  // 3. 参数校验（仅标记缺失，由引导问卷逐项补全）
  const missingFields = validate(intent, params);

  return { intent, params, missingFields };
}

/** 提取餐品关键词 */
function extractFoodKeywords(text) {
  const hits = [];
  for (const entry of FOOD_LEXICON) {
    if (entry.aliases.some((a) => text.includes(a))) hits.push(entry.key);
  }
  // 去重
  return [...new Set(hits)];
}

/** 提取预算金额（统一转为分） */
function extractBudget(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:块|元|rmb|¥|￥)?/i);
  const budgetMatch = text.match(/预算[^0-9]{0,4}(\d+(?:\.\d+)?)/);
  const raw = budgetMatch?.[1] ?? (/预算/.test(text) ? m?.[1] : null);
  if (raw === null || raw === undefined || raw === '') return null;
  const yuan = Number(raw);
  return Number.isFinite(yuan) ? Math.round(yuan * 100) : null;
}

/** 提取取餐方式 */
function extractTakeType(lower) {
  for (const k of TAKE_TYPE_KEYWORDS) {
    if (k.keywords.some((kw) => lower.includes(kw))) {
      return { takeType: k.beType === 1 ? '到店' : k.beType === 2 ? '外送' : '得来速', beType: k.beType, orderType: k.orderType };
    }
  }
  return { takeType: '未指定', beType: null, orderType: null };
}

/** 提取城市：优先匹配「XX市」，其次匹配已知城市列表 */
const KNOWN_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '武汉', '西安', '南京', '苏州', '天津', '长沙', '郑州', '青岛', '厦门', '福州', '济南', '合肥', '宁波', '无锡', '昆明', '大连', '沈阳', '哈尔滨', '长春', '石家庄', '太原', '南宁', '贵阳', '兰州', '乌鲁木齐', '呼和浩特', '南昌', '贵阳'];

function extractCity(text) {
  const withSuffix = text.match(/([一-龥]{2,6})(?:市|区|县)/);
  if (withSuffix) return withSuffix[1];
  for (const city of KNOWN_CITIES) {
    if (text.includes(city)) return city;
  }
  return null;
}

/** 提取地址线索 */
function extractAddress(text) {
  const m = text.match(/([一-龥]{2,8}(?:路|街|号|小区|大厦|广场|中心|大学|学院))/);
  return m ? m[1] : null;
}

/** 提取人数 */
function extractPeopleCount(text) {
  const m = text.match(/(\d+|[一二两三四五六七八九十])\s*(?:个人|人份|份|人)/);
  if (m) return cnToNumber(m[1]) || 1;
  if (/一人|单人|一个人/.test(text)) return 1;
  if (/双人|两人|二人/.test(text)) return 2;
  return 1;
}

/** 按意图校验必填参数 */
function validate(intent, params) {
  const missing = [];

  switch (intent) {
    case INTENT.FOOD_OPTIMAL:
      if (!params.foodKeywords.length && !params.budget) missing.push('餐品或预算');
      if (!params.beType) missing.push('取餐方式');
      // 外送场景依赖已授权的配送地址，不强制要求城市
      if (!params.city && !params.address && params.beType !== BE_TYPE.DELIVERY) missing.push('位置');
      break;
    case INTENT.BUDGET_RECOMMEND:
      if (!params.budget) missing.push('预算');
      if (!params.beType) missing.push('取餐方式');
      if (!params.city && !params.address && params.beType !== BE_TYPE.DELIVERY) missing.push('位置');
      break;
    case INTENT.CAMPAIGN_QUERY:
      if (!params.foodKeywords.length) missing.push('关注餐品');
      break;
    case INTENT.POINTS_EXCHANGE:
      // 积分兑换无需位置与取餐方式
      break;
    case INTENT.ORDER_REPEAT:
      if (!params.beType) missing.push('取餐方式');
      break;
    default:
      if (!params.foodKeywords.length && !params.budget) missing.push('需求');
  }
  return missing;
}

export default { parseIntent, INTENT, FOOD_LEXICON };
