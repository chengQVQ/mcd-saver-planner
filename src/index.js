#!/usr/bin/env node
/**
 * 麦麦极致省钱规划师 · CLI 入口
 *
 * 用法：
 *   node src/index.js --demo                       离线演示（无需Token）
 *   node src/index.js "深圳宝安巨无霸套餐到店怎么最省"    真实调用
 *   node src/index.js --order 1 --address ADDR001  下单
 *   node src/index.js --test                       运行验收测试
 */

import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import config from './config.js';
import logger from './utils/logger.js';
import { createPlanner } from './factory.js';

export { createPlanner };

/** 打印结果 */
function render(result) {
  console.log('\n' + '─'.repeat(64));
  if (result.type === 'clarification') {
    console.log('💬 ' + result.message);
  } else if (result.type === 'plans') {
    console.log('💰 ' + result.message);
    if (result.comboAdvice?.needExtra) {
      console.log(`\n🛒 凑单建议：${result.comboAdvice.desc}`);
    }
    if (result.pointsAdvice?.bestCoupon) {
      console.log(`\n⭐ 积分建议：${result.pointsAdvice.desc}`);
    }
    if (result.nextActions?.length) {
      console.log('\n👉 ' + result.nextActions.join('  |  '));
    }
    console.log(`\n📊 本轮工具调用 ${result.callCount ?? '-'} 次`);
  } else if (result.type === 'campaign') {
    console.log('📅 ' + result.message);
  } else if (result.type === 'points') {
    console.log('⭐ ' + result.message);
    if (result.nextActions?.length) {
      console.log('\n👉 ' + result.nextActions.join('  |  '));
    }
  } else if (result.type === 'error') {
    console.log('⚠️  ' + result.message);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  console.log('─'.repeat(64));
}

/** 离线演示 */
async function runDemo() {
  console.log('\n🎪 麦麦极致省钱规划师 · 离线演示（内置真实数据采样，无需 MCP Token）\n');

  const planner = createPlanner({ offline: true });

  const scenarios = [
    { input: '深圳宝安，巨无霸套餐，到店，怎么最省' },
    { input: '30块预算，一个人，外送' },
    { input: '最近巨无霸有活动吗' },
    { input: '用积分兑换最划算的券' },
    { input: '再来一单' }
  ];

  for (const s of scenarios) {
    console.log(`\n👤 用户：${s.input}`);
    const result = await planner.handle(s.input);
    render(result);
  }

  // 下单演示
  console.log('\n👤 用户：下单方案1');
  const orderResult = await planner.order(1);
  console.log('\n' + '─'.repeat(64));
  console.log(orderResult.success
    ? `✅ 下单成功！订单号 ${orderResult.orderId}\n   支付链接 ${orderResult.payUrl}\n   ${orderResult.pickupInfo ?? ''}\n   ${orderResult.nextStep ?? ''}`
    : `⚠️  下单失败：${orderResult.errorMsg}`);
  console.log('─'.repeat(64));
}

/** 交互模式 */
async function runInteractive() {
  if (!config.mcp.token) {
    console.error('\n❌ 未检测到 MCP Token。请先设置环境变量：');
    console.error('   Windows (PowerShell):  $env:MCP_TOKEN = "your_token"');
    console.error('   macOS/Linux:          export MCP_TOKEN="your_token"\n');
    console.error('   或使用离线演示：node src/index.js --demo\n');
    process.exit(1);
  }

  const planner = createPlanner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n🍔 麦麦极致省钱规划师 · 交互模式（输入 exit 退出）\n');

  const ask = () =>
    new Promise((resolve) => {
      rl.question('👤 你：', async (input) => {
        const text = input.trim();
        if (!text) return ask();

        if (/^(exit|quit|退出)$/i.test(text)) {
          rl.close();
          return resolve(null);
        }
        if (/^下单方案\s*(\d+)/.test(text)) {
          const idx = Number(text.match(/^下单方案\s*(\d+)/)[1]);
          const r = await planner.order(idx);
          console.log('\n' + '─'.repeat(64));
          console.log(r.success ? `✅ 订单 ${r.orderId}｜${r.payUrl}` : `⚠️  ${r.errorMsg}`);
          console.log('─'.repeat(64));
          return resolve();
        }

        try {
          const result = await planner.handle(text);
          render(result);
        } catch (err) {
          console.error('⚠️  执行出错：', err.message);
        }
        resolve();
      });
    });

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const r = await ask();
    if (r === null) break;
  }
  console.log('\n👋 再见，祝你吃得省！\n');
}

/** 主函数 */
async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);

  if (has('--help') || has('-h')) {
    console.log(`
麦麦极致省钱规划师 MCD Saver Planner

用法:
  node src/index.js --demo                          离线演示（无需Token）
  node src/index.js                                 交互模式（需 MCP_TOKEN）
  node src/index.js "你的需求"                       单次执行
  node src/index.js --order 1 --address ADDR001     下单方案 1（外送需 --address）
  node src/index.js --test                          运行验收测试

环境变量:
  MCP_TOKEN        麦当劳 MCP Token（必填，交互/在线模式）
  MCD_MCP_URL      MCP 服务地址，默认 https://mcp.mcd.cn
  LOG_LEVEL        ERROR | WARN | INFO | DEBUG，默认 INFO
`);
    return;
  }

  if (has('--test')) {
    const { runAllTests } = await import('./workflow/testSuite.js');
    return runAllTests();
  }

  if (has('--demo')) return runDemo();

  const orderIdx = argv.find((a) => a.startsWith('--order'));
  if (orderIdx) {
    const planner = createPlanner({ offline: has('--offline') });
    const idx = Number(orderIdx.split('=')[1] ?? argv[argv.indexOf(orderIdx) + 1]);
    const addressFlag = argv.find((a) => a.startsWith('--address'));
    const addressId = addressFlag ? (addressFlag.split('=')[1] ?? argv[argv.indexOf(addressFlag) + 1]) : undefined;
    const r = await planner.order(idx, { addressId });
    console.log(r.success ? `✅ ${r.orderId}｜${r.payUrl}` : `⚠️ ${r.errorMsg}`);
    return;
  }

  const query = argv.filter((a) => !a.startsWith('--')).join(' ');
  if (query) {
    const planner = createPlanner({ offline: has('--offline') });
    render(await planner.handle(query));
    return;
  }

  return runInteractive();
}

// 仅在直接执行时启动（兼容 Windows 路径分隔符）
const isDirectRun = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error('致命错误：', err);
    process.exit(1);
  });
}

export default { createPlanner };
