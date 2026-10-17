/**
 * 指数退避重试工具
 *
 * 错误码处理规范（§5.2）：
 *  | 401 | Token 无效/过期 | 终止执行，提示检查 Token 配置（不重试）|
 *  | 429 | 触发限流       | 指数退避 1s/2s/4s，最多 3 次；仍失败降级返回已算结果 |
 *  | 其他 | 服务错误      | 降级处理，返回已生成方案 |
 */

import config from '../config.js';
import logger from './logger.js';

/** 业务异常：携带错误码，便于上层按码降级 */
export class McpError extends Error {
  constructor(message, code, raw) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.raw = raw;
  }

  /** 401 Token 失效：不可重试，需终止 */
  get isAuthError() {
    return this.code === 401;
  }

  /** 429 限流：可重试 */
  get isRateLimited() {
    return this.code === 429;
  }
}

/** 延时 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带指数退避的重试包装
 * @param {Function} fn 待执行函数
 * @param {Object} options
 * @param {number} options.retries 最大重试次数，默认取全局配置
 * @param {number} options.baseDelay 基础延迟，默认取全局配置
 * @param {Function} options.onRetry 重试回调
 * @returns {Promise<*>} 函数返回值
 */
export async function withRetry(fn, options = {}) {
  const retries = options.retries ?? config.mcp.maxRetryTimes;
  const baseDelay = options.baseDelay ?? config.mcp.retryBaseDelay;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // 401 不重试，直接终止
      if (err instanceof McpError && err.isAuthError) {
        logger.error('RETRY', 'MCP Token 无效或已过期，终止执行');
        throw err;
      }

      // 最后一次尝试失败则抛出
      if (attempt === retries) break;

      const delay = baseDelay * Math.pow(2, attempt); // 1s / 2s / 4s
      logger.warn('RETRY', `第 ${attempt + 1} 次失败，${delay}ms 后重试`, err.message);
      options.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * 并发受限执行器：单次并发 ≤ 10，批量间隔 ≥ 100ms
 * @param {Array<Function>} tasks 任务数组
 * @param {number} concurrency 并发上限
 * @param {number} interval 每批间隔（毫秒）
 */
export async function runLimited(tasks, concurrency = 10, interval = 100) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    // eslint-disable-next-line no-await-in-loop
    const settled = await Promise.allSettled(batch.map((t) => t()));
    results.push(...settled);
    if (i + concurrency < tasks.length && interval > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(interval);
    }
  }
  return results;
}

/**
 * 优雅降级：捕获错误并返回兜底值
 * @param {Function} fn
 * @param {*} fallback 兜底值
 */
export async function degrade(fn, fallback = null, tag = 'DEGRADE') {
  try {
    return await fn();
  } catch (err) {
    logger.warn(tag, '降级处理', err.message);
    return fallback;
  }
}

export default { withRetry, runLimited, degrade, McpError, sleep };
