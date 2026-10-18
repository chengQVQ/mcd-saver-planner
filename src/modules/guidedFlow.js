/**
 * 引导式问卷（Guided Wizard）
 *
 * 设计目标：替代"一次性列出所有缺失字段"的旧补全逻辑，
 * 改为一次只问一个问题，回答填一个字段，逐步累积，
 * 全部填齐后再执行——彻底避免参数丢失与误解析。
 *
 * 特性：
 *  1. 每轮只问一个问题，用户不会被多个空格分隔的追问淹没
 *  2. 已收集的字段会保留，后续回答不会覆盖已填字段
 *  3. 可选字段可跳过；任何时候可"取消"/"重来"
 *  4. 进度可视化：1/5、2/5…
 *
 * 不同意图的问卷步骤不同（按依赖顺序排列）：
 *  - 指定餐品最优/按预算推荐：餐品 → 预算 → 取餐方式 → 位置 → 人数
 *  - 活动查询：餐品
 *  - 订单复购：取餐方式
 *  - 积分兑换：无（直接执行）
 */

import { parseIntent, INTENT, FOOD_LEXICON } from './intent.js';
import { BE_TYPE } from '../config.js';

/** 问卷步骤定义 */
export const STEP_DEFS = {
  food: {
    key: 'foodKeywords',
    label: '想吃点什么',
    hint: '比如：巨无霸、板烧鸡腿堡、麦乐鸡、薯条',
    required: true,
    extractor: extractFood,
    validate: (v) => (Array.isArray(v) && v.length > 0 ? null : '没识别到餐品，换个说法试试')
  },
  budget: {
    key: 'budget',
    label: '预算多少',
    hint: '直接说金额，比如「35」「35元」',
    required: false,
    extractor: extractBudget,
    validate: (v) => (typeof v === 'number' && v > 0 ? null : '预算得是大于 0 的数字')
  },
  takeType: {
    key: 'beType',
    label: '到店自取、得来速还是麦乐送外送',
    hint: '到店 / 外送 / 得来速',
    required: true,
    extractor: extractTakeType,
    validate: (v) => (typeof v === 'number' ? null : '请选择 到店 / 外送 / 得来速')
  },
  location: {
    key: 'city',
    label: '在哪个城市或附近哪个地标',
    hint: '比如「深圳宝安」「上海陆家嘴」',
    required: false,        // 外送场景可由地址自动推导，故设为可选
    extractor: extractLocation,
    validate: (v) => (v ? null : '没识别到位置，再说一次')
  },
  peopleCount: {
    key: 'peopleCount',
    label: '几个人吃',
    hint: '默认 1 人，可直接回车跳过',
    required: false,
    extractor: extractPeople,
    validate: () => null    // 人数恒可选，提取不到时返回 null 由问卷跳过
  }
};

/** 按意图组装问卷步骤序列 */
export const QUESTIONNAIRES = {
  [INTENT.FOOD_OPTIMAL]:    ['food', 'takeType', 'location', 'peopleCount'],
  [INTENT.BUDGET_RECOMMEND]:['food', 'budget', 'takeType', 'location', 'peopleCount'],
  [INTENT.CAMPAIGN_QUERY]:  ['food'],
  [INTENT.ORDER_REPEAT]:    ['takeType'],
  [INTENT.POINTS_EXCHANGE]: []
};

/**
 * 创建一个引导会话
 * @param {string} intent 意图
 * @param {Object} initialParams 初始已收集参数（来自第一句话的解析）
 * @returns {{intent, steps, cursor, params, done}}
 */
export function createWizard(intent, initialParams = {}) {
  const stepKeys = QUESTIONNAIRES[intent] ?? [];

  // 把已收集字段从初始参数里取出来，标记为"已填"以跳过对应问题
  const steps = stepKeys.map((key) => {
    const def = STEP_DEFS[key];
    const paramKey = def.key;
    let initialValue = initialParams[paramKey];
    // ⚠️ parseIntent 默认会把 peopleCount 设成 1，这会让问卷误判为"已填"。
    //    人数是可选问题，只有用户明确说了人数才视为已填，否则仍要问。
    if (key === 'peopleCount' && initialValue === 1 && !initialParams._peopleExplicit) {
      initialValue = null;
    }
    const hasValue = initialValue !== null && initialValue !== undefined &&
      !(Array.isArray(initialValue) && initialValue.length === 0);
    return {
      key,
      paramKey,
      label: def.label,
      hint: def.hint,
      required: def.required,
      filled: hasValue,
      value: hasValue ? initialValue : null
    };
  });

  // 找到第一个未填的步骤
  let cursor = steps.findIndex((s) => !s.filled);
  if (cursor === -1) cursor = steps.length; // 全部已填

  return {
    intent,
    steps,
    cursor,
    params: { ...initialParams },
    done: cursor >= steps.length
  };
}

/**
 * 把用户对当前问题的回答填入问卷
 * @param {Object} wizard 问卷对象（会被原地修改）
 * @param {string} answer 用户的回答原文
 * @returns {{ok:boolean, error?:string, advancedTo?:object, allDone?:boolean}}
 */
export function fillAnswer(wizard, answer) {
  if (wizard.cursor >= wizard.steps.length) {
    return { ok: false, error: '问卷已完成，无需再答' };
  }

  const step = wizard.steps[wizard.cursor];
  const def = STEP_DEFS[step.key];

  // 跳过指令
  const trimmed = String(answer ?? '').trim();
  if (/^(跳过|skip|默认|无|随便)$/.test(trimmed)) {
    if (step.required) {
      return { ok: false, error: `这一项必填，不能跳过：${step.label}` };
    }
    step.filled = true;
    step.value = null;
    advance(wizard);
    return { ok: true, skipped: true, advancedTo: currentStep(wizard), allDone: wizard.done };
  }

  // 提取值
  const extracted = def.extractor(trimmed);

  // 可选字段且提取不到 → 自动跳过（用默认值）
  if (extracted === null || extracted === undefined || (Array.isArray(extracted) && extracted.length === 0)) {
    if (!step.required) {
      step.filled = true;
      step.value = null;
      advance(wizard);
      return { ok: true, skipped: true, advancedTo: currentStep(wizard), allDone: wizard.done };
    }
    return { ok: false, error: `没识别到「${step.label}」，换个说法试试，比如：${step.hint}` };
  }

  const validationError = def.validate(extracted);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  step.filled = true;
  step.value = extracted;
  wizard.params[step.paramKey] = extracted;

  advance(wizard);
  return { ok: true, advancedTo: currentStep(wizard), allDone: wizard.done };
}

/** 推进游标到下一个未填步骤 */
function advance(wizard) {
  while (wizard.cursor < wizard.steps.length && wizard.steps[wizard.cursor].filled) {
    wizard.cursor++;
  }
  wizard.done = wizard.cursor >= wizard.steps.length;
}

/** 获取当前应问的步骤信息（含进度） */
export function currentStep(wizard) {
  if (wizard.done) return null;
  const step = wizard.steps[wizard.cursor];
  return {
    index: wizard.cursor + 1,
    total: wizard.steps.length,
    label: step.label,
    hint: step.hint,
    required: step.required
  };
}

/** 把问卷已收集的字段汇总成可执行的参数对象 */
export function wizardParams(wizard) {
  const params = { ...wizard.params };
  // 人数兜底
  if (!params.peopleCount) params.peopleCount = 1;
  // 位置兜底：未填且外送渠道 → 不强制（resolveStore 会去取地址）
  if (!params.city && !params.address && params.beType === BE_TYPE.DELIVERY) {
    // 留空，让 resolveStore 自动取地址
  }
  return params;
}

/** 问卷可视化：进度条 + 已填项 */
export function renderProgress(wizard) {
  const filled = wizard.steps.filter((s) => s.filled).length;
  const total = wizard.steps.length;
  const bar = '█'.repeat(filled) + '░'.repeat(total - filled);
  const lines = [`进度 [${bar}] ${filled}/${total}`];
  wizard.steps.forEach((s, i) => {
    if (s.filled) {
      const v = formatValue(s.value, s.key);
      lines.push(`  ${i + 1}. ${s.label}：${v}`);
    } else if (i === wizard.cursor) {
      lines.push(`  ${i + 1}. ${s.label}：← 当前问题${s.required ? '（必填）' : '（可选）'}`);
    } else {
      lines.push(`  ${i + 1}. ${s.label}：（待填）`);
    }
  });
  return lines.join('\n');
}

function formatValue(value, key) {
  if (value === null || value === undefined) return '（跳过）';
  if (key === 'budget') return `¥${(value / 100).toFixed(0)}`;
  if (key === 'foodKeywords') return Array.isArray(value) ? value.join('、') : String(value);
  if (key === 'beType') return { 1: '到店自取', 2: '麦乐送', 5: '得来速' }[value] ?? String(value);
  if (key === 'peopleCount') return `${value} 人`;
  return String(value);
}

// ─────────────── 字段提取器（独立于 parseIntent，单字段语义更聚焦） ───────────────

function extractFood(text) {
  const hits = [];
  for (const entry of FOOD_LEXICON) {
    if (entry.aliases.some((a) => text.includes(a))) hits.push(entry.key);
  }
  // 用户可能直接说商品名，没匹配词典时把整句当作一个关键词
  if (!hits.length && text.length >= 2 && text.length <= 20) {
    return [text.replace(/[，,。.、的个份人块元预算怎么最省到店外送得来速麦乐送]+/g, '').trim()].filter(Boolean);
  }
  return [...new Set(hits)];
}

function extractBudget(text) {
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const yuan = Number(m[1]);
  return Number.isFinite(yuan) && yuan > 0 ? Math.round(yuan * 100) : null;
}

function extractTakeType(text) {
  const t = text.toLowerCase();
  if (/外送|外卖|送到|麦乐送|配送/.test(t)) return BE_TYPE.DELIVERY;
  if (/得来速|车道|驾车|开车|车取|drive/.test(t)) return BE_TYPE.DRIVE_THRU;
  if (/到店|自取|自提|堂食|取餐|店里|到店取/.test(t)) return BE_TYPE.IN_STORE;
  return null;
}

function extractLocation(text) {
  // 优先匹配「XX市」「XX区」
  const withSuffix = text.match(/([一-龥]{2,6})(?:市|区|县)/);
  if (withSuffix) return withSuffix[1];
  // 关键词清理后直接当位置
  const cleaned = text.replace(/[，,。.、的个份人块元预算怎么最省到店外送得来速麦乐送巨无霸板烧麦乐鸡薯条可乐]+/g, '').trim();
  return cleaned.length >= 2 ? cleaned : null;
}

function extractPeople(text) {
  // 必须明确包含"人/份"才视为人数回答，避免「深圳宝安」被默认成 1 人
  if (!/人|份|个/.test(text)) return null;

  const m = text.match(/(\d+|[一二两三四五六七八九十])\s*(?:个?人|人份|份)/);
  if (m) {
    const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : cn[m[1]];
    if (n && n > 0) return n;
  }
  if (/一人|单人|一个人/.test(text)) return 1;
  if (/双人|两人|二人/.test(text)) return 2;
  return null;   // 含"人"但无法解析 → 返回 null 让问卷报错，而不是默认 1
}

export default { createWizard, fillAnswer, currentStep, wizardParams, renderProgress, STEP_DEFS, QUESTIONNAIRES };
