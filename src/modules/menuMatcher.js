/**
 * 餐品匹配工具
 *
 * 职责：把用户自然语言中的餐品关键词，映射到门店菜单中的真实商品编码与价格。
 * 这是「自然语言 → 可下单商品」的关键桥梁。
 */

import { FOOD_LEXICON } from './intent.js';
import logger from '../utils/logger.js';

/** 分类关键词 → 用于凑单/套餐推荐 */
const CATEGORY_HINT = {
  burger: /堡/,
  chicken: /鸡|翅|块/,
  fries: /薯条/,
  drink: /可乐|雪碧|咖啡|茶|奶|饮/,
  dessert: /派|冰淇淋|地|甜品|旋风/
};

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
      return {
        code: String(code),
        name,
        price: Math.round(Number(m.currentPrice ?? 0) * 100),   // 元 → 分
        originalPrice: Math.round(Number(m.originalPrice ?? 0) * 100),
        canWithOrder: Boolean(m.canWithOrder),
        discountType: m.discountType ?? null,
        withOrder: m.withOrder ?? null,
        category: guessCategory(name),
        categoryName: categoryOf.get(String(code)) ?? '',
        tags: []
      };
    })
    .filter((m) => m.price > 0);
}

/** 按名称猜测商品品类 */
function guessCategory(name) {
  for (const [key, re] of Object.entries(CATEGORY_HINT)) {
    if (re.test(name)) return key;
  }
  return 'other';
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
  const burger = pickBest(menuItems.filter((i) => i.category === 'burger'));
  const chicken = pickBest(menuItems.filter((i) => i.category === 'chicken' && !/套餐/.test(i.name)));
  const fries = pickBest(menuItems.filter((i) => i.category === 'fries'));
  const drink = pickBest(menuItems.filter((i) => i.category === 'drink'));
  const dessert = pickBest(menuItems.filter((i) => i.category === 'dessert'));

  const items = [];
  const push = (item, qty = 1) => { if (item) items.push({ productCode: item.code, quantity: qty }); };

  // 按预算档位搭配
  if (budget < 2000) {
    push(dessert || drink || fries);
  } else if (budget < 3000) {
    push(burger); push(fries || drink);
  } else if (budget < 4000) {
    push(burger); push(fries); push(drink);
  } else if (budget < 5000) {
    push(burger); push(fries); push(drink); push(dessert);
  } else {
    push(burger); push(chicken); push(fries); push(drink);
  }

  // 按人数扩容主餐
  if (peopleCount > 1 && burger) {
    const mainItems = items.filter((i) => i.productCode === burger.code);
    if (mainItems.length) mainItems[0].quantity = peopleCount;
    else items.push({ productCode: burger.code, quantity: peopleCount });
  }

  // 剔除超预算的方案并记录
  const total = items.reduce((s, i) => {
    const item = menuItems.find((m) => m.code === i.productCode);
    return s + (item ? item.price * i.quantity : 0);
  }, 0);

  const desc =
    total <= budget
      ? `按${(budget / 100).toFixed(0)}元预算为${peopleCount}人搭配，合计约${(total / 100).toFixed(2)}元`
      : `预算${(budget / 100).toFixed(0)}元可选商品有限，已搭配最接近的方案`;

  logger.info('MATCH', desc);

  return { items, total, desc };
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
