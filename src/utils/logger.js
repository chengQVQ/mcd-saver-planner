/**
 * 分级日志工具
 *
 * ERROR：工具调用失败、订单创建失败、状态异常
 * WARN ：重试、降级、数据不一致
 * INFO ：状态流转、工具调用、方案生成
 * DEBUG：详细参数、计算过程、中间结果
 */

const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

let currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.INFO;
/** 本轮工具调用计数，用于执行 §5.1 限流约束 */
let callCounter = 0;

export function setLevel(name) {
  if (LEVELS[name] !== undefined) currentLevel = LEVELS[name];
}

function fmt(obj) {
  if (obj === undefined) return '';
  if (typeof obj === 'string') return obj;
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function emit(level, color, tag, args) {
  if (LEVELS[level] > currentLevel) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const body = args.map(fmt).join(' ');
  console.log(`${color}[${ts}] [${level}] [${tag}]${body ? ' ' + body : ''}${color ? '' : ''}`);
  // 结束着色
  if (color) process.stdout.write('\x1b[0m');
}

export const logger = {
  error: (tag, ...a) => emit('ERROR', '\x1b[31m', tag, a),
  warn: (tag, ...a) => emit('WARN', '\x1b[33m', tag, a),
  info: (tag, ...a) => emit('INFO', '\x1b[36m', tag, a),
  debug: (tag, ...a) => emit('DEBUG', '\x1b[90m', tag, a),

  /** 记录一次工具调用并累加计数 */
  toolCall(tool, params) {
    callCounter++;
    emit('INFO', '\x1b[32m', `CALL#${callCounter}`, [tool, params]);
  },

  getCallCount() {
    return callCounter;
  },

  resetCallCount() {
    callCounter = 0;
  }
};

export default logger;
