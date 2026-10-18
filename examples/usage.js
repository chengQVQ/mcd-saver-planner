#!/usr/bin/env node
/**
 * 调用示例集
 *
 * 运行：node examples/usage.js
 *
 * 覆盖三种调用方式：
 *   1. CLI 单次调用（shell）
 *   2. 代码库调用（作为模块 import）
 *   3. 编程式多轮对话（会话状态）
 *
 * 本文件使用内置 Mock 数据，无需 MCP Token 即可直接运行。
 */

import { createPlanner } from '../src/factory.js';
import { setLevel } from '../src/utils/logger.js';

// 关闭日志，只看结果
setLevel('ERROR');

const line = (t = '') => console.log(t);
const title = (t) => {
  line();
  line('═'.repeat(66));
  line('  ' + t);
  line('═'.repeat(66));
};

/**
 * 示例 1：最简单的用法 —— 一句话，拿到最省方案
 */
async function example1_Simple() {
  title('示例 1：一句话拿到最省方案');

  const planner = createPlanner({ offline: true });
  const result = await planner.handle('深圳宝安，巨无霸，到店，怎么最省');

  line(`输入：深圳宝安，巨无霸，到店，怎么最省`);
  line(`识别意图：${result.intent}`);
  line(`匹配商品：${(result.matchedItems ?? []).map((m) => m.name).join('、') || '（无）'}`);
  line('');
  (result.plans ?? []).forEach((p, i) => {
    const price = typeof p.finalPrice === 'number' ? `¥${(p.finalPrice / 100).toFixed(2)}` : '计算中';
    const origin = typeof p.originalPrice === 'number' ? `¥${(p.originalPrice / 100).toFixed(2)}` : '—';
    const save = typeof p.discountAmount === 'number' ? `¥${(p.discountAmount / 100).toFixed(2)}` : '¥0.00';
    line(`  【方案${i + 1}】${p.planName}`);
    line(`    到手 ${price}（原价 ${origin}，省 ${save}）`);
    line(`    ${p.recommendReason}`);
  });
  line('');
  line(`本轮工具调用：${result.callCount} 次`);
}

/**
 * 示例 2：按预算自动搭配
 */
async function example2_Budget() {
  title('示例 2：按预算自动搭配餐品');

  const planner = createPlanner({ offline: true });
  const result = await planner.handle('深圳，40块预算，两个人，到店');

  line('输入：深圳，40块预算，两个人，到店');
  if (result.budgetCombo) {
    line(`搭配结果：${result.budgetCombo.desc}`);
    line(`商品清单：${result.budgetCombo.items.map((i) => `${i.productCode}×${i.quantity}`).join(', ')}`);
  }
  line('');
  (result.plans ?? []).forEach((p, i) => {
    line(`  【方案${i + 1}】到手 ¥${(p.finalPrice / 100).toFixed(2)}｜${p.planName}`);
  });
}

/**
 * 示例 3：多轮对话 —— 会话是有状态的
 *
 * 第一轮出方案，第二轮直接说「下单方案1」完成下单。
 */
async function example3_Conversation() {
  title('示例 3：多轮对话（下单闭环）');

  const planner = createPlanner({ offline: true });

  line('第1轮 >> 深圳宝安，巨无霸，到店，怎么最省');
  const r1 = await planner.handle('深圳宝安，巨无霸，到店，怎么最省');
  line(`  意图：${r1.intent}｜方案数：${(r1.plans ?? []).length}｜状态：${r1.state}`);

  if (!r1.plans?.length) {
    line('  （未生成方案，跳过下单演示）');
    return;
  }

  const best = r1.plans[0];
  line(`  最优：${best.planName} → ¥${(best.finalPrice / 100).toFixed(2)}`);

  line('');
  line('第2轮 >> 下单方案1');
  const order = await planner.order(1);
  if (order.success) {
    line(`  ✅ 下单成功`);
    line(`     订单号：${order.orderId}`);
    line(`     支付链接：${order.payUrl}`);
    line(`     取餐信息：${order.pickupInfo}`);
    line(`     下一步：${order.nextStep}`);
  } else {
    line(`  ❌ 下单失败：${order.errorMsg}`);
  }
}

/**
 * 示例 4：外送下单（地址处理）
 */
async function example4_Delivery() {
  title('示例 4：外送下单（地址处理）');

  const planner = createPlanner({ offline: true });

  const r1 = await planner.handle('深圳宝安，巨无霸，外送');
  if (r1.plans?.length) {
    line(`外送最省：${r1.plans[0].planName} → ¥${(r1.plans[0].finalPrice / 100).toFixed(2)}`);
  }
  line(`会话已自动解析地址：${planner.session.params.addressId ?? '（无）'}`);
  line('说明：真实环境下地址来自 delivery-query-addresses，用户授权后自动带入。');

  line('');
  line('>> 下单方案1');
  const order = await planner.order(1);
  line(`  结果：${order.success ? '✅ 成功 ' + order.orderId : '❌ ' + order.errorMsg}`);

  line('');
  line('>> 显式传入 addressId 覆盖');
  const withAddr = await planner.order(1, { addressId: 'ADDR001' });
  line(`  结果：${withAddr.success ? '✅ 成功 ' + withAddr.orderId : '❌ ' + withAddr.errorMsg}`);

  line('');
  line('>> 下单一个不存在的方案（应优雅报错，不崩溃）');
  const bad = await planner.order(99);
  line(`  结果：${bad.success ? '成功' : '❌ ' + bad.errorMsg}`);
}

/**
 * 示例 5：活动预判 —— 该现在买还是等活动
 */
async function example5_Campaign() {
  title('示例 5：活动预判（现在买 vs 等活动）');

  const planner = createPlanner({ offline: true });
  const result = await planner.handle('最近巨无霸有活动吗');

  line('输入：最近巨无霸有活动吗');
  line(`决策：${result.advice?.suggestion}`);
  line(`理由：${result.advice?.suggestReason}`);
  if (result.advice?.futureActivities?.length) {
    line('未来活动：');
    result.advice.futureActivities.forEach((a) => {
      line(`  · ${a.title}（${a.startTime ?? '时间待定'}）`);
    });
  }
}

/**
 * 示例 6：积分最优兑换
 */
async function example6_Points() {
  title('示例 6：积分价值比最优兑换');

  const planner = createPlanner({ offline: true });
  const result = await planner.handle('用积分兑换最划算的券');

  line('输入：用积分兑换最划算的券');
  line(`结果：${result.message}`);
  if (result.advice?.bestCoupon) {
    const c = result.advice.bestCoupon;
    line(`  最优券：${c.name}`);
    line(`  消耗：${c.points} 积分 → 面值 ¥${c.value}`);
    line(`  价值比：${result.advice.pointValueRatio} 元/积分`);
  }
}

/**
 * 示例 7：参数缺失时自动追问
 */
async function example7_Clarify() {
  title('示例 7：信息不全时主动追问');

  const planner = createPlanner({ offline: true });

  line('>> 巨无霸（没说城市和渠道）');
  const r = await planner.handle('巨无霸');
  line(`  返回类型：${r.type}`);
  line(`  追问：${r.message}`);
  line(`  缺失字段：${(r.missingFields ?? []).join('、') || '（无）'}`);

  line('');
  line('>> 补充后：深圳宝安，巨无霸，到店，怎么最省');
  const r2 = await planner.handle('深圳宝安，巨无霸，到店，怎么最省');
  line(`  返回类型：${r2.type}｜方案数：${(r2.plans ?? []).length}`);
}

/**
 * 示例 8：查询历史订单并复购
 */
async function example8_Repeat() {
  title('示例 8：订单复购（按今天的优惠重算）');

  const planner = createPlanner({ offline: true });
  const r = await planner.handle('再来一单');

  line('输入：再来一单');
  line(`返回类型：${r.type}`);
  line(`结果：${r.message ?? ''}`);
  if (r.plans?.length) {
    line(`今日最省：¥${(r.plans[0].finalPrice / 100).toFixed(2)}（${r.plans[0].planName}）`);
  }
}

/**
 * 示例 9：切换到真实 MCP（需先配置 Token）
 *
 * 取消注释即可使用。
 */
async function example9_Live() {
  title('示例 9：连接真实麦当劳 MCP');

  line('需要先配置 Token：');
  line('  cp .env.example .env   （Windows: copy .env.example .env）');
  line('  编辑 .env 填入 MCP_TOKEN=你的token');
  line('');
  line('然后把下面代码取消注释：');
  line(`
  import { createPlanner } from './src/factory.js';

  const planner = createPlanner();          // 不传 offline = 连真实接口
  const result = await planner.handle('深圳南山，巨无霸，到店，怎么最省');

  console.log(result.plans?.[0]?.planName);
  console.log('到手价 ¥' + (result.plans?.[0]?.finalPrice / 100).toFixed(2));
`);

  const hasToken = !!process.env.MCP_TOKEN;
  line('');
  line(hasToken
    ? '✅ 检测到 MCP_TOKEN，可直接运行 createPlanner() 连接真实接口'
    : 'ℹ️  当前未检测到 MCP_TOKEN，以上为示例代码');
}

/**
 * 示例 10：引导式问卷（一次问一个问题）
 *
 * 用户说一句话后，AI 按固定顺序逐项追问，
 * 全部填齐再生成方案——彻底避免参数丢失。
 */
async function example10_GuidedWizard() {
  title('示例 10：引导式问卷（一次问一个）');

  const planner = createPlanner({ offline: true });

  line('用户: 板烧鸡腿堡');
  const r1 = await planner.handle('板烧鸡腿堡');
  line(`AI  : ${r1.message}`);
  line(`  [${r1.progress?.split('\n')[0]}]`);
  line('');

  line('用户: 到店');
  const r2 = await planner.handle('到店');
  line(`AI  : ${r2.message}`);
  line(`  [${r2.progress?.split('\n')[0]}]`);
  line('');

  line('用户: 深圳宝安');
  const r3 = await planner.handle('深圳宝安');
  line(`AI  : ${r3.message}`);
  line(`  [${r3.progress?.split('\n')[0]}]`);
  line('');

  line('用户: 1个人');
  const r4 = await planner.handle('1个人');
  line(`AI  : ${r4.message?.split('\n')[0]}`);
  (r4.plans ?? []).forEach((p, i) => {
    line(`  方案${i + 1}: ${p.planName} → ¥${(p.finalPrice / 100).toFixed(2)}`);
  });

  line('');
  line('💡 任何时候可以：');
  line('   · 说「跳过」跳过可选问题');
  line('   · 说「取消」退出问卷重来');
}

/** 主函数 */
async function runAll() {
  console.log('\n🍔 麦麦极致省钱规划师 · 调用示例集');
  console.log('（使用内置 Mock 数据，无需 Token，可直接运行）');

  await example1_Simple();
  await example2_Budget();
  await example3_Conversation();
  await example4_Delivery();
  await example5_Campaign();
  await example6_Points();
  await example7_Clarify();
  await example8_Repeat();
  await example9_Live();
  await example10_GuidedWizard();

  title('全部示例运行完毕');
  line('');
  line('💡 交互式体验：node src/index.js --demo');
  line('💡 跑测试    ：node src/index.js --test');
  line('');
}

runAll().catch((err) => {
  console.error('示例执行出错：', err);
  process.exit(1);
});
