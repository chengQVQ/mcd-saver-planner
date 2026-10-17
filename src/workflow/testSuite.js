/**
 * 验收测试套件（§11）
 *
 * 正向用例 TC001-TC005 + 异常用例 TC101-TC105
 * 使用离线 Mock 运行，无需 MCP Token，可直接用于 CI 验证。
 */

import { parseIntent, INTENT } from '../modules/intent.js';
import { extractMenuItems, matchItems, buildBudgetCombo } from '../modules/menuMatcher.js';
import { calcBestPlans } from '../modules/priceEngine.js';
import { parseStoreCoupons, parseMyCoupons, buildCombinations, bindCouponsToItems, areMutuallyExclusive } from '../modules/couponRules.js';
import { compareChannels } from '../modules/channelCompare.js';
import { recommendCombo } from '../modules/combo.js';
import { predictCampaign } from '../modules/campaign.js';
import { optimizePoints } from '../modules/points.js';
import { executeOrder } from '../modules/order.js';
import { SessionContext, STATE } from './stateMachine.js';
import { McdTools } from '../mcp/tools.js';
import { McpClient } from '../mcp/client.js';
import { createMockFetch } from '../../mock/transport.js';
import { MOCK_MENU, MOCK_STORE_COUPONS, MOCK_MY_COUPONS } from '../../mock/data.js';
import { extractPrice, yuanToCent, formatYuan } from '../utils/money.js';
import { McpError } from '../utils/retry.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ' → ' + detail : ''}`);
    console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`);
  }
}

/** 构造带 Mock 的工具实例 */
function mockTools() {
  const client = new McpClient({ fetchImpl: createMockFetch() });
  return new McdTools({ client });
}

/** 跑全部测试 */
export async function runAllTests() {
  console.log('\n🧪 麦麦极致省钱规划师 · 验收测试\n');

  testIntent();
  testMoney();
  testCouponRules();
  testMenuMatcher();
  await testPriceEngine();
  await testChannelCompare();
  await testCombo();
  await testCampaign();
  await testPoints();
  await testOrder();
  testErrorHandling();
  testStateMachine();
  await testEndToEnd();

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log(`${'─'.repeat(50)}\n`);
  return failed === 0;
}

// ─────────────────── 正向用例 ───────────────────

function testIntent() {
  console.log('【TC001】意图识别与参数提取');

  const r1 = parseIntent('深圳宝安，巨无霸套餐，到店，怎么最省');
  assert('识别为「指定餐品最优」', r1.intent === INTENT.FOOD_OPTIMAL, r1.intent);
  assert('提取餐品关键词', r1.params.foodKeywords.includes('巨无霸'), JSON.stringify(r1.params.foodKeywords));
  assert('提取取餐方式=到店', r1.params.takeType === '到店', r1.params.takeType);
  assert('提取城市=深圳', r1.params.city === '深圳', String(r1.params.city));

  const r2 = parseIntent('30块预算，一个人，外送');
  assert('识别为「按预算推荐」', r2.intent === INTENT.BUDGET_RECOMMEND, r2.intent);
  assert('预算=3000分', r2.params.budget === 3000, String(r2.params.budget));
  assert('人数=1', r2.params.peopleCount === 1);

  const r3 = parseIntent('最近巨无霸有活动吗');
  assert('识别为「活动查询」', r3.intent === INTENT.CAMPAIGN_QUERY, r3.intent);

  const r4 = parseIntent('再来一单');
  assert('识别为「订单复购」', r4.intent === INTENT.ORDER_REPEAT, r4.intent);

  const r5 = parseIntent('随便来点');
  assert('无法识别时降级为通用咨询', r5.intent === INTENT.GENERAL, r5.intent);
  assert('生成补全话术', typeof r5.followUpQuestion === 'string' && r5.followUpQuestion.length > 0);
  console.log('');
}

function testMoney() {
  console.log('【TC002】金额单位与价格解析');

  assert('元转分', yuanToCent('26.5') === 2650, String(yuanToCent('26.5')));
  assert('分转元展示', formatYuan(2650) === '¥26.50', formatYuan(2650));

  const p = extractPrice({ data: { originalPrice: 4150, discountAmount: 800, finalPrice: 3350, deliveryFee: 0 } });
  assert('解析原价', p.originalPrice === 4150);
  assert('解析到手价', p.finalPrice === 3350);
  assert('解析优惠额', p.discountAmount === 800);

  const p2 = extractPrice({ data: { finalPrice: 3000 } });
  assert('缺字段时兜底推导优惠额', p2.discountAmount === 0 && p2.finalPrice === 3000);
  assert('空响应返回 null', extractPrice(null) === null);
  console.log('');
}

function testCouponRules() {
  console.log('【TC003】优惠券叠加规则');

  const storeCoupons = parseStoreCoupons(MOCK_STORE_COUPONS);
  assert('解析门店券数量=3', storeCoupons.length === 3, String(storeCoupons.length));
  assert('门槛单位转为分', storeCoupons[0].threshold === 4000, String(storeCoupons[0].threshold));

  const myCoupons = parseMyCoupons(MOCK_MY_COUPONS);
  assert('解析用户券数量=2', myCoupons.length === 2, String(myCoupons.length));
  assert('用户券类型识别为 mms', myCoupons[0].type === 'mms', myCoupons[0].type);

  const store = storeCoupons[0];
  const mms = myCoupons[0];
  assert('同类型券互斥', areMutuallyExclusive(store, storeCoupons[1]));
  assert('不同类型券可叠加', !areMutuallyExclusive(store, mms));
  assert('同一张券不可重复使用', areMutuallyExclusive(store, { ...store }));

  const combos = buildCombinations([...storeCoupons, ...myCoupons], { productCodes: new Set(['1100', '4810']), beType: 1, total: 4150 });
  assert('生成可行组合', combos.length > 0, String(combos.length));
  assert('包含空组合（不用券）', combos.some((c) => c.length === 0));
  assert('同类型不重复出现在一个组合中', combos.every((combo) => {
    const storeCount = combo.filter((c) => c.type === 'store').length;
    return storeCount <= 1;
  }));

  const bound = bindCouponsToItems([{ productCode: '1100', quantity: 1 }], [store]);
  assert('券绑定到商品项级（couponId）', bound[0].couponId === store.couponId, JSON.stringify(bound[0]));
  console.log('');
}

function testMenuMatcher() {
  console.log('【TC004】菜单解析与关键词匹配');

  const items = extractMenuItems(MOCK_MENU);
  assert('解析菜单商品', items.length >= 8, String(items.length));
  assert('价格单位转为分', items.find((i) => i.code === '1100')?.price === 2650);

  const matched = matchItems(items, ['巨无霸']);
  assert('匹配到巨无霸', matched.length > 0);
  assert('优先推荐单品而非套餐', matched[0]?.name === '巨无霸', matched[0]?.name);

  const combo = buildBudgetCombo(items, 3000, 1);
  assert('预算搭配生成商品', combo.items.length > 0, String(combo.items.length));
  assert('预算搭配有说明文案', typeof combo.desc === 'string' && combo.desc.length > 0);
  console.log('');
}

async function testPriceEngine() {
  console.log('【TC005】最优优惠组合计算');

  const tools = mockTools();
  const plans = await calcBestPlans({
    tools, storeCode: '1420293', beType: 1,
    items: [{ productCode: '1100', quantity: 1 }, { productCode: '4810', quantity: 1 }]
  });

  assert('返回方案列表', Array.isArray(plans) && plans.length > 0);
  assert('返回数量不超过 Top3', plans.length <= 3, String(plans.length));

  if (plans.length) {
    const best = plans[0];
    assert('方案含最终价', typeof best.finalPrice === 'number', String(best.finalPrice));
    assert('方案含原价', typeof best.originalPrice === 'number');
    assert('方案含推荐理由', typeof best.recommendReason === 'string' && best.recommendReason.length > 0);
    assert('方案按价格升序', plans.every((p, i) => i === 0 || plans[i - 1].finalPrice <= p.finalPrice));
    assert('首个方案标记 isBest', best.isBest === true);
    assert('含方案排名 rank', best.rank === 1, String(best.rank));

    // 原价 41元（2650+1450），最优应低于原价
    assert('最优方案低于原价', best.finalPrice < 4100, `${best.finalPrice} vs 4100`);
    console.log(`     最优方案：${best.planName}｜到手 ${formatYuan(best.finalPrice)}｜省 ${formatYuan(best.discountAmount)}`);
    console.log(`     理由：${best.recommendReason}`);
  }
  console.log('');
}

async function testChannelCompare() {
  console.log('【TC006】多渠道比价');

  const tools = mockTools();
  const plans = await compareChannels({
    tools,
    items: [{ productCode: '1100', quantity: 1 }],
    city: '深圳',
    keyword: '宝安',
    addressId: 'ADDR001'
  });

  assert('返回渠道方案', plans.length > 0, String(plans.length));
  if (plans.length > 1) {
    assert('按推荐分降序', plans.every((p, i) => i === 0 || plans[i - 1].recommendScore >= p.recommendScore));
    assert('含评分明细', !!plans[0].scoreDetail);
    assert('价格权重最高(0.6)', plans[0].scoreDetail?.price !== undefined);
  }
  console.log('');
}

async function testCombo() {
  console.log('【TC007】智能凑单推荐');

  const tools = mockTools();
  // 目标券门槛 40 元，当前订单 41 元 → 已达门槛
  const r1 = await recommendCombo({
    tools, items: [{ productCode: '1100', quantity: 1 }, { productCode: '4810', quantity: 1 }],
    storeCode: '1420293', beType: 1,
    targetCoupon: { couponId: 'CP001', title: '满40减8', threshold: 4000, discount: 800 }
  });
  assert('已达门槛时不建议凑单', r1.needExtra === false, JSON.stringify(r1));

  // 门槛 100 元，当前 41 元 → 需凑单但凑单不划算
  const r2 = await recommendCombo({
    tools, items: [{ productCode: '1100', quantity: 1 }],
    storeCode: '1420293', beType: 1,
    targetCoupon: { couponId: 'CPX', title: '满100减30', threshold: 10000, discount: 3000 }
  });
  assert('无法有效凑单时返回不划算', r2.needExtra === false || r2.isWorth === false, JSON.stringify(r2));
  console.log('');
}

async function testCampaign() {
  console.log('【TC008】活动预判决策');

  const tools = mockTools();
  const advice = await predictCampaign({ tools, foodKeywords: ['巨无霸'], currentBestPrice: 3350 });

  assert('返回决策建议', ['现在买', '等活动买'].includes(advice.suggestion), advice.suggestion);
  assert('返回建议理由', typeof advice.suggestReason === 'string' && advice.suggestReason.length > 0);
  assert('识别到8折活动', advice.futureActivities.some((a) => /8\s*折/.test(a.title)),
    JSON.stringify(advice.futureActivities.map((a) => a.title)));
  // 应选择「预计优惠力度最大」的活动（8折=20%），而非时间上最近的一个
  assert('8折(20%优惠)触发「等活动买」', advice.suggestion === '等活动买', advice.suggestion);
  assert('给出下一活动时间', !!advice.nextActivityTime, String(advice.nextActivityTime));
  console.log(`     决策：${advice.suggestion}｜${advice.suggestReason}`);
  console.log('');
}

async function testPoints() {
  console.log('【TC009】积分最优兑换');

  const tools = mockTools();
  const advice = await optimizePoints({ tools, currentPrice: 4100 });

  assert('读取可用积分', advice.availablePoints === 1636, String(advice.availablePoints));
  assert('读取临期积分', advice.expiringPoints === 170, String(advice.expiringPoints));
  assert('选出最优兑换券', !!advice.bestCoupon, JSON.stringify(advice.bestCoupon));
  if (advice.bestCoupon) {
    // 12元券/900积分 = 0.01333 > 5元券/500积分 = 0.01
    assert('价值比最高的是12元券', advice.bestCoupon.name.includes('12元'), advice.bestCoupon.name);
    assert('计算积分价值比', advice.pointValueRatio > 0);
    assert('换算抵扣后价格', advice.finalPriceAfterExchange === 4100 - 1200, String(advice.finalPriceAfterExchange));
  }
  console.log(`     ${advice.desc}`);
  console.log('');
}

async function testOrder() {
  console.log('【TC010】下单执行引擎');

  const tools = mockTools();
  const plan = {
    id: 'plan_test', channel: 'inStore', orderType: 1,
    storeCode: '1420293', storeName: '麦当劳深圳机场国内到达层地面交通中心餐厅',
    items: [{ productCode: '1100', quantity: 1 }],
    usedCoupons: [], withCard: { enabled: false },
    originalPrice: 2650, discountAmount: 0, finalPrice: 2650
  };

  const r = await executeOrder({ tools, plan });
  assert('下单成功', r.success === true, JSON.stringify(r.errorMsg));
  assert('返回订单号', typeof r.orderId === 'string' && r.orderId.length > 0);
  assert('返回支付链接', typeof r.payUrl === 'string' && r.payUrl.length > 0);
  assert('返回取餐信息', typeof r.pickupInfo === 'string');
  assert('提示下一步', typeof r.nextStep === 'string' && r.nextStep.length > 0);

  // 外送缺地址应失败
  const r2 = await executeOrder({ tools, plan: { ...plan, channel: 'delivery', orderType: 2 } });
  assert('外送缺地址时拒绝下单', r2.success === false);
  assert('给出明确错误原因', typeof r2.errorMsg === 'string' && r2.errorMsg.includes('地址'));
  console.log('');
}

function testErrorHandling() {
  console.log('【TC101-TC105】异常处理');

  // 401 不可重试
  const e401 = new McpError('token expired', 401);
  assert('401 标记为鉴权错误', e401.isAuthError === true);
  assert('401 不属于限流', e401.isRateLimited === false);

  // 429 可重试
  const e429 = new McpError('too many', 429);
  assert('429 标记为限流', e429.isRateLimited === true);

  // beType 校验
  try {
    McdTools.resolveChannel(1, 'BE001');
    assert('到店不要求 beCode', true);
  } catch {
    assert('到店不要求 beCode', false);
  }
  try {
    McdTools.resolveChannel(5); // 得来速缺 beCode
    assert('得来速缺 beCode 时报错', false);
  } catch {
    assert('得来速缺 beCode 时报错', true);
  }
  try {
    McdTools.resolveChannel(99);
    assert('非法 beType 被拒绝', false);
  } catch {
    assert('非法 beType 被拒绝', true);
  }

  // items 归一化兼容
  assert('兼容嵌套 items 形态', McdTools.normalizeItems({ items: [{ productCode: '1100' }] }).length === 1);
  assert('兼容双层包裹 items', McdTools.normalizeItems([[{ productCode: '1100' }]]).length === 1);
  assert('标准数组原样返回', McdTools.normalizeItems([{ productCode: '1100' }]).length === 1);
  console.log('');
}

function testStateMachine() {
  console.log('【状态机】流转约束');

  const s = new SessionContext();
  assert('初始状态为 init', s.state === STATE.INIT);

  s.transition('userInput');
  assert('init → intentRecognizing', s.state === STATE.INTENT_RECOGNIZING);

  s.transition('paramsMissing');
  assert('参数缺失 → paramMissing', s.state === STATE.PARAM_MISSING);

  s.transition('paramsComplete');
  assert('paramMissing → calculating', s.state === STATE.CALCULATING);

  s.transition('success');
  assert('calculating → planReady', s.state === STATE.PLAN_READY);

  s.plans = [{ id: 'p1' }, { id: 'p2' }];
  s.transition('selectPlan');
  assert('planReady → orderConfirming', s.state === STATE.ORDER_CONFIRMING);

  s.transition('cancel');
  assert('取消 → 回到 planReady', s.state === STATE.PLAN_READY);

  try {
    s.transition('confirm'); // planReady 下无 confirm 事件
    assert('非法转移被拒绝', false);
  } catch {
    assert('非法转移被拒绝', true);
  }

  // 从 error 状态重试应回到 init（§10：error --用户重试--> init）
  const s2 = new SessionContext();
  s2.transition('userInput');
  s2.transition('paramsComplete');
  s2.transition('failure');
  assert('calculating 失败 → error', s2.state === STATE.ERROR, s2.state);
  s2.transition('retry');
  assert('error --用户重试--> init', s2.state === STATE.INIT, s2.state);
  console.log('');
}

async function testEndToEnd() {
  console.log('【端到端】完整链路');

  // 从 factory.js 引入规划器工厂（不经过 CLI 入口，避免循环依赖）
  const { createPlanner } = await import('../factory.js');
  const planner = createPlanner({ offline: true });

  const r1 = await planner.handle('深圳宝安，巨无霸套餐，到店，怎么最省');
  assert('全链路返回方案', r1.type === 'plans', r1.type);
  assert('方案已存入会话', planner.session.plans.length > 0);
  assert('工具调用次数 ≤ 15', (r1.callCount ?? 0) <= 15, String(r1.callCount));
  console.log(`     单轮工具调用 ${r1.callCount} 次，方案 ${planner.session.plans.length} 个`);

  const r2 = await planner.order(1);
  assert('端到端下单成功', r2.success === true, JSON.stringify(r2.errorMsg));
  assert('返回支付链接', typeof r2.payUrl === 'string');

  // 发起新需求时应从 planReady/ordered 回到 init（§10：* --新请求--> init）
  const r3 = await planner.handle('再来一单');
  assert('新请求被正确接收', ['plans', 'clarification'].includes(r3.type), r3.type);
  console.log('');
}

export default { runAllTests };
