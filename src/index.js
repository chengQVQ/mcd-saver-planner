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
import { setLevel } from './utils/logger.js';

export { createPlanner };

/** 打印结果 */
function render(result) {
  console.log('\n' + '─'.repeat(64));
  if (result.type === 'clarification') {
    console.log('💬 ' + result.message);
  } else if (result.type === 'wizard_ask') {
    console.log('❓ ' + result.message);
    if (result.progress) console.log('  ' + result.progress.split('\n')[0]);
  } else if (result.type === 'wizard_error') {
    console.log('⚠️  ' + result.message);
    if (result.progress) console.log('  ' + result.progress.split('\n')[0]);
  } else if (result.type === 'cancelled') {
    console.log('↩️  ' + result.message);
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
  } else if (result.type === 'no_result') {
    console.log('📭 ' + (result.message || '暂无可用结果'));
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

/** 配置自检：确认 Token 是否已正确配置 */
function showConfig() {
  const token = config.mcp.token;
  const masked = token
    ? `${token.slice(0, 6)}****${token.slice(-4)}（长度 ${token.length}）`
    : '未配置';

  console.log('\n🍔 麦麦极致省钱规划师 · 配置自检\n');
  console.log('─'.repeat(52));
  console.log(`MCP Server : ${config.mcp.serverUrl}`);
  console.log(`协议类型   : ${config.mcp.protocol}`);
  console.log(`MCP Token  : ${masked}`);
  console.log(`日志级别   : ${process.env.LOG_LEVEL || 'INFO'}`);
  console.log(`限流阈值   : ${config.mcp.rateLimitPerMinute} 次/分钟`);
  console.log('─'.repeat(52));

  if (!token || token === 'YOUR_MCP_TOKEN_HERE') {
    console.log('\n⚠️  尚未配置有效 Token，交互模式与在线调用将不可用。\n');
    console.log('配置步骤：');
    console.log('  1) 打开 https://open.mcd.cn/mcp doc 页面');
    console.log('  2) 右上角【控制台】→【激活】→ 复制 MCP Token');
    console.log('  3) 在项目根目录执行：cp .env.example .env');
    console.log('  4) 用编辑器打开 .env，填入：MCP_TOKEN=你的token');
    console.log('  5) 再次运行 node src/index.js --config 验证\n');
    console.log('  仅想看效果？直接运行：node src/index.js --demo（无需 Token）\n');
  } else {
    console.log('\n✅ Token 已配置，可运行：node src/index.js\n');
  }
}

/** 交互模式 */
async function runInteractive() {
  if (!config.mcp.token || config.mcp.token === 'YOUR_MCP_TOKEN_HERE') {
    console.error('\n❌ 未检测到有效 MCP Token。请先配置：\n');
    console.error('   方式一（推荐，零依赖）：');
    console.error('     cp .env.example .env      （Windows: copy .env.example .env）');
    console.error('     然后用编辑器打开 .env，填入 MCP_TOKEN=你的token\n');
    console.error('   方式二（临时生效，仅当前窗口）：');
    console.error('     Windows PowerShell :  $env:MCP_TOKEN = "your_token"');
    console.error('     macOS/Linux         :  export MCP_TOKEN="your_token"\n');
    console.error('   Token 申请地址：https://open.mcd.cn/mcp/doc（右上角【控制台】→【激活】）\n');
    console.error('   自检配置：node src/index.js --config');
    console.error('   无需 Token 先看效果：node src/index.js --demo\n');
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
  node src/index.js "你的需求" --offline             单次执行（用内置Mock，不联网）
  node src/index.js --config                       配置自检（检查 Token）
  node src/index.js --order 1 --address ADDR001     下单方案 1（外送需 --address）
  node src/index.js --test                          运行验收测试

通用选项:
  -q, --quiet                静默模式，只输出结果（适合脚本调用/录屏）
  --offline                  使用内置 Mock 数据，不请求真实接口

Token 配置（零依赖，无需 npm install）:
  cp .env.example .env        Windows 用: copy .env.example .env
  然后编辑 .env 填入 MCP_TOKEN=你的token
  Token 申请：https://open.mcd.cn/mcp/doc 右上角【控制台】→【激活】

环境变量:
  MCP_TOKEN        麦当劳 MCP Token（优先级高于 .env）
  MCD_MCP_URL      MCP 服务地址，默认 https://mcp.mcd.cn
  LOG_LEVEL        ERROR | WARN | INFO | DEBUG，默认 INFO
`);
    return;
  }

  if (has('--config')) return showConfig();

  if (has('--test')) {
    const { runAllTests } = await import('./workflow/testSuite.js');
    return runAllTests();
  }

  if (has('--demo') || has('--offline-demo')) {
    if (has('--quiet') || has('-q')) setLevel('ERROR');
    return runDemo();
  }

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
    // --quiet：静默模式，只输出结果，适合脚本调用与录屏
    if (has('--quiet') || has('-q')) setLevel('ERROR');
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
