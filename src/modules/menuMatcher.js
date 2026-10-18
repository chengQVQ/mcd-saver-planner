/**
 * 餐品匹配工具
 *
 * 职责：把用户自然语言中的餐品关键词，映射到门店菜单中的真实商品编码与价格。
 * 这是「自然语言 → 可下单商品」的关键桥梁。
 */

import { FOOD_LEXICON } from './intent.js';
import logger from '../utils/logger.js';

/** 分类关键词 → 用于凑单/套餐推荐 */
/**
 * 商品品类识别规则
 *
 * ⚠️ 真实菜单实测：商品名不总带「堡」字（如「巨无霸」「双层吉士汉堡」），
 *    且官方 categories 里的分类名更可靠。
 *    因此采用「分类名优先 → 品名兜底」两级判定。
 *    顺序敏感：套餐类先判，避免「巨无霸三件套」被误判为饮品等。
 */
const CATEGORY_RULES = [
  { category: 'fries', categoryRe: /薯条|小食|炸物|热食/, nameRe: /薯条|薯|鸡翅|鸡块|麦乐鸡|脆薯|鸡排|上校|骨肉相连| chicken ?wings?/i },
  { category: 'drink', categoryRe: /饮品|饮料|咖啡|冷饮|热饮/, nameRe: /可乐|雪碧|咖啡|红茶|绿茶|奶茶|豆奶|牛奶|果汁|汽水|饮|冰爽|鲜萃|美式|拿铁|奶铁/i },
  { category: 'dessert', categoryRe: /甜品|冰淇淋|其他小食|派/, nameRe: /冰淇淋|甜筒|圆筒|新地|圣代|派|布丁|蛋糕|旋风|甜品|蛋筒/i },
  { category: 'burger', categoryRe: /堡|汉堡/, nameRe: /堡|巨无霸|吉士|鳕鱼|深海|培根|双层|板烧|麦辣|鸡腿|牛肉堡|汉堡|牛堡/i },
  { category: 'chicken', categoryRe: /炸鸡|鸡肉/, nameRe: /麦辣鸡翅|麦乐鸡|炸鸡|鸡翅|鸡块|鸡排|脆皮炸鸡|V翅|鸡柳/i }
];

/**
 * 排除非食品类商品（周边、玩具等），这些不能参与搭配
 */
const NON_FOOD_RE = /帽|徽章|贴|摆件|玩具|礼盒|钥匙扣|周边|公仔|卡包|雨伞|套餐卡|礼品/;

/**
 * 判定商品品类
 * @param {string} name 商品名
 * @param {string} categoryName 官方菜单分类名
 * @returns {string} category
 */
export function guessCategory(name, categoryName = '') {
  const n = String(name ?? '');

  // 周边类直接排除
  if (NON_FOOD_RE.test(n)) return 'nonfood';

  // ① 分类名优先（官方数据更可靠）
  for (const rule of CATEGORY_RULES) {
    if (categoryName && rule.categoryRe.test(categoryName)) return rule.category;
  }

  // ② 品名兜底
  for (const rule of CATEGORY_RULES) {
    if (rule.nameRe.test(n)) return rule.category;
  }

  return 'other';
}

/**
 * 从门店菜单中提取商品列表
 * @param {*} menuPayload query-meals 返回
 * @returns {Array<{code,name,price,originalPrice,category,canWithOrder,categoryName,tags}>}
 */
export function extractMenuItems(menuPayload) {
  const meals = menuPayload?.data?.meals;
  if (!meals || typeof meals !== 'object') return [];

  // 反查分类名
  const categoryOf = new Map();
  for (const cat of menuPayload?.data?.categories ?? []) {
    for (const m of cat.meals ?? []) categoryOf.set(String(m.code), cat.name);
  }

  return Object.entries(meals)
    .map(([code, m]) => {
      const name = String(m.name ?? code);
      const categoryName = categoryOf.get(String(code)) ?? '';
      return {
        code: String(code),
        name,
        price: Math.round(Number(m.currentPrice ?? 0) * 100),   // 元 → 分
        originalPrice: Math.round(Number(m.originalPrice ?? 0) * 100),
        canWithOrder: Boolean(m.canWithOrder),
        discountType: m.discountType ?? null,
        withOrder: m.withOrder ?? null,
        category: guessCategory(name, categoryName),
        categoryName,
        tags: []
      };
    })
    .filter((m) => m.price > 0)
    .filter((m) => m.category !== 'nonfood');   // 剔除周边等非食品
}

/**
 * 按关键词匹配门店商品
 * @param {Array} menuItems 门店商品列表
 * @param {string[]} keywords 关键词列表
 * @returns {Array} 匹配到的商品（按匹配度与价格排序）
 */
export function matchItems(menuItems, keywords) {
  if (!keywords?.length) return [];

  const results = [];
  for (const kw of keywords) {
    const entry = FOOD_LEXICON.find((f) => f.key === kw);
    const aliases = entry?.aliases ?? [kw];

    for (const item of menuItems) {
      // 排除周边类非食品商品
      if (/帽|徽章|贴|摆件|玩具|礼盒|钥匙扣/.test(item.name)) continue;

      const hitAlias = aliases.find((a) => item.name.includes(a));
      if (!hitAlias) continue;

      // 匹配度：名称完全等于关键词 > 关键词在名称开头 > 名称中包含
      let score = 0.5;
      if (item.name === kw) score = 1;
      else if (item.name.startsWith(hitAlias)) score = 0.85;
      else if (new RegExp(hitAlias).test(item.name)) score = 0.7;

      // 单品优先于套餐（单品更灵活）
      if (/套餐|三件套|四件套|双人/.test(item.name) && !/套餐/.test(kw)) score -= 0.15;
      // 原价越低越适合作为默认推荐
      score += Math.max(0, 0.15 - item.price / 100000);

      results.push({ ...item, matchScore: score, matchedKeyword: kw });
    }
  }

  // 按关键词优先级 + 匹配度排序，同关键词下取最优
  const best = new Map();
  for (const r of results.sort((a, b) => b.matchScore - a.matchScore)) {
    if (!best.has(r.matchedKeyword)) best.set(r.matchedKeyword, r);
  }

  return [...best.values()].sort(
    (a, b) => keywords.indexOf(a.matchedKeyword) - keywords.indexOf(b.matchedKeyword)
  );
}

/**
 * 按预算挑选商品组合
 * 遵循官方 MCP 的企业团餐搭配建议：
 *  - 20元以下: 小食
 *  - 20-30元：汉堡+小食 或 汉堡+饮料
 *  - 30-40元：汉堡+薯条/小食+饮料
 *  - 40-50元：汉堡+薯条+小食+饮料
 *  - 50元以上：丰富组合
 *
 * @param {Array} menuItems
 * @param {number} budget 预算（分）
 * @param {number} peopleCount 用餐人数
 * @returns {{items:Array, total:number, desc:string}}
 */
export function buildBudgetCombo(menuItems, budget, peopleCount = 1) {
  const priceOf = (code) => menuItems.find((m) => m.code === code)?.price ?? 0;

  // 各品类的候选商品（排除周边，extractMenuItems 已过滤）
  const pool = {
    burger:  menuItems.filter((i) => i.category === 'burger'),
    chicken: menuItems.filter((i) => i.category === 'chicken'),
    fries:   menuItems.filter((i) => i.category === 'fries'),
    drink:   menuItems.filter((i) => i.category === 'drink'),
    dessert: menuItems.filter((i) => i.category === 'dessert')
  };

  const items = [];
  let spent = 0;
  const add = (item, qty = 1) => {
    if (!item || qty <= 0) return false;
    items.push({ productCode: item.code, quantity: qty });
    spent += item.price * qty;
    return true;
  };
  const left = () => budget - spent;

  /**
   * ⚠️ 按「一餐结构」贪心组餐，而非固定档位硬选。
   *    固定档位的问题：30 元预算会选出 38.5 元套餐 + 薯条 + 可乐 = 63.5 元，超预算一倍。
   *
   *    人数处理：主餐数量在选品时就按人数确定（不是事后扩容），
   *    否则贪心阶段已把预算花光，导致多人都配不齐。
   */
  const mainQty = Math.max(1, peopleCount);

  const mealPlan = [
    { key: 'burger',  label: '汉堡', qty: mainQty },
    { key: 'chicken', label: '鸡肉', qty: Math.ceil(mainQty / 2), optional: true },
    { key: 'fries',   label: '小食', qty: 1, optional: true },
    { key: 'drink',   label: '饮品', qty: 1, optional: true },
    { key: 'dessert', label: '甜品', qty: 1, optional: true }
  ];

  for (const step of mealPlan) {
    if (left() <= 0) break;
    // 预算不足以覆盖本步骤所需数量时，逐件降级直到买得起
    let added = false;
    for (let q = step.qty; q >= 1; q--) {
      const need = priceOfCheapest(pool[step.key]);
      if (need === null || need * q > left()) continue;
      const affordable = pool[step.key].filter((i) => i.price * q <= left());
      const chosen = pickBest(affordable);
      if (chosen && add(chosen, q)) { added = true; break; }
    }
    // 主餐（汉堡）买不起则整体放弃，不拼凑
    if (!added && step.key === 'burger') break;
  }

  const total = spent;

  // 人数是否被满足（预算不足以配齐所有人的主餐时需明确告知）
  const mainQtyActual = items.find((i) => pool.burger.some((b) => b.code === i.productCode))?.quantity ?? 0;
  const shortOfPeople = mainQtyActual > 0 && mainQtyActual < mainQty;

  const desc =
    shortOfPeople
      ? `预算${(budget / 100).toFixed(0)}元仅够 ${mainQtyActual} 人份主餐（${peopleCount}人聚餐已尽力搭配），合计约${(total / 100).toFixed(2)}元，可加购小食或提高预算`
      : total > 0 && total <= budget
        ? `按${(budget / 100).toFixed(0)}元预算为${peopleCount}人搭配，合计约${(total / 100).toFixed(2)}元` +
          (budget - total > 0 ? `（还剩 ${((budget - total) / 100).toFixed(2)} 元可继续加购）` : '')
        : `预算${(budget / 100).toFixed(0)}元内可选商品有限，已挑选最接近的方案`;

  logger.info('MATCH', desc);

  return { items, total, desc };
}
/**
 * 以「用户指定的餐品」为主体，在预算内补充小食/饮品
 *
 * 场景：用户说「板烧鸡腿堡，到店，预算100」
 *   → 主体必须是板烧鸡腿堡（用户明确要的），
 *     剩余预算再补薯条/可乐，而不是无视诉求去做通用搭配。
 *
 * @param {Array} menuItems 门店商品列表
 * @param {Array} specified 用户指定的商品（已匹配到真实商品）
 * @param {number} budget 预算（分）
 * @param {number} peopleCount 用餐人数
 * @returns {{items:Array, total:number, desc:string, matchedItems:Array}}
 */
export function buildComboAroundItems(menuItems, specified, budget, peopleCount = 1) {
  const priceOf = (code) => menuItems.find((m) => m.code === code)?.price ?? 0;

  // ① 主体：用户指定的商品，按人数调整主餐数量
  const items = [];
  const mainQty = Math.max(1, peopleCount);
  for (const s of specified) {
    items.push({ productCode: s.code, quantity: mainQty });
  }
  let total = items.reduce((sum, i) => sum + priceOf(i.productCode) * i.quantity, 0);

  // ② 剩余预算补充：优先饮品 → 小食 → 甜品
  //    原则是「够用即止」：主体已满足一餐的基本需求时，
  //    最多补 1-2 样凑成完整一餐，而不是把预算全部花光。
  const remaining = budget - total;
  const supplements = [
    { list: menuItems.filter((i) => i.category === 'drink'),   max: 2500, label: '饮品', maxCount: 1 },
    { list: menuItems.filter((i) => i.category === 'fries'),   max: 2500, label: '小食', maxCount: 1 },
    { list: menuItems.filter((i) => i.category === 'dessert'), max: 1500, label: '甜品', maxCount: 1 }
  ];

  let left = remaining;
  const added = [];
  for (const s of supplements) {
    if (left <= 0 || added.length >= 2) break;   // 最多补 2 样
    // 排除已在主体中的商品，避免重复
    const candidates = s.list.filter((i) => !items.some((it) => it.productCode === i.code));
    const affordable = pickBest(candidates.filter((i) => i.price <= left && i.price <= s.max));
    if (!affordable) continue;
    items.push({ productCode: affordable.code, quantity: 1 });
    added.push(affordable.name);
    total += affordable.price;
    left -= affordable.price;
  }

  const names = specified.map((s) => s.name).join('、');
  const desc =
    added.length
      ? `按你指定的${names}搭配${peopleCount}人份，补充${added.join('、')}，合计约${(total / 100).toFixed(2)}元` +
        (total <= budget ? `（预算内还剩 ${((budget - total) / 100).toFixed(2)} 元）` : '（已超出预算）')
      : `按你指定的${names}为${peopleCount}人搭配，合计约${(total / 100).toFixed(2)}元`;

  logger.info('MATCH', desc);

  return { items, total, desc, matchedItems: specified };
}

/** 取某品类中最便宜的单价（分），无商品返回 null */
function priceOfCheapest(list) {
  if (!list.length) return null;
  return Math.min(...list.map((i) => i.price));
}

/** 挑选性价比最优商品：优先有折扣的，其次价格适中 */
function pickBest(list) {
  if (!list.length) return null;
  return [...list].sort((a, b) => {
    const aDiscount = a.originalPrice > a.price ? 1 : 0;
    const bDiscount = b.originalPrice > b.price ? 1 : 0;
    if (aDiscount !== bDiscount) return bDiscount - aDiscount;
    // 有折扣的优先选折扣力度大的
    const aSave = a.originalPrice - a.price;
    const bSave = b.originalPrice - b.price;
    if (aSave !== bSave) return bSave - aSave;
    return a.price - b.price;
  })[0];
}

export default { extractMenuItems, matchItems, buildBudgetCombo };
