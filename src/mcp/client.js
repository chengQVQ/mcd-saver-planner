/**
 * MCP Client 封装（Streamable HTTP + JSON-RPC 2.0）
 *
 * 服务地址：https://mcp.mcd.cn
 * 协议类型：streamablehttp
 * 认证方式：Authorization: Bearer {MCP_TOKEN}
 * 限流阈值：单 Token 每分钟 ≤ 600 次请求
 *
 * 说明：MCP Streamable HTTP 传输中，客户端需先发送 initialize 完成握手，
 * 获取 mcp-session-id 后，后续请求需携带该会话头。
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { McpError, withRetry } from '../utils/retry.js';

/** JSON-RPC 错误码映射 */
const JSONRPC_ERROR_MAP = {
  [-32601]: 404,
  [-32602]: 400
};

export class McpClient {
  /**
   * @param {Object} options
   * @param {string} options.serverUrl MCP 服务地址
   * @param {string} options.token MCP Token
   * @param {Function} options.fetchImpl 注入 fetch 实现（便于离线 mock 测试）
   */
  constructor(options = {}) {
    this.serverUrl = options.serverUrl ?? config.mcp.serverUrl;
    this.token = options.token ?? config.mcp.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sessionId = null;
    this.initialized = false;
    this._requestId = 0;
    /** 本地滑动窗口限流计数 */
    this._rateWindow = [];
  }

  /** 鉴权头 */
  get headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  /** 生成自增请求 ID */
  nextId() {
    this._requestId += 1;
    return this._requestId;
  }

  /** 限流预检：单 Token 每分钟 ≤ 600 次 */
  checkRateLimit() {
    const now = Date.now();
    this._rateWindow = this._rateWindow.filter((t) => now - t < 60_000);
    if (this._rateWindow.length >= config.mcp.rateLimitPerMinute) {
      throw new McpError('本地限流保护：单分钟请求数已达阈值', 429);
    }
    this._rateWindow.push(now);
  }

  /**
   * 发送一次 JSON-RPC 请求
   * @param {string} method 方法名
   * @param {Object} params 参数
   * @returns {Promise<*>} result
   */
  async request(method, params = {}) {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId(),
      method,
      params
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.mcp.requestTimeout);

    let res;
    try {
      res = await this.fetchImpl(this.serverUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      throw new McpError(`网络请求失败：${err.message}`, -1);
    }
    clearTimeout(timer);

    // 捕获会话 ID
    const sid = res.headers?.get?.('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401) throw new McpError('MCP Token 无效或已过期', 401);
    if (res.status === 429) throw new McpError('请求过于频繁，已触发限流', 429);
    if (!res.ok) throw new McpError(`服务返回异常状态：${res.status}`, res.status);

    const raw = await res.text();

    // Streamable HTTP 可能返回 SSE 格式，需提取 data: 行
    const jsonText = raw.includes('data:')
      ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      : raw;

    if (!jsonText) return null;

    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch {
      throw new McpError('响应解析失败，非合法 JSON', -2, raw);
    }

    if (payload.error) {
      const code = payload.error.code ?? -1;
      throw new McpError(payload.error.message || 'MCP 调用失败', JSONRPC_ERROR_MAP[code] ?? code, payload);
    }

    return payload.result ?? null;
  }

  /**
   * 初始化连接（握手）
   * MCP 协议要求先 initialize，再发送 notifications/initialized
   */
  async connect() {
    if (this.initialized) return true;
    if (!this.token && !this.fetchImpl) {
      throw new McpError('缺少 MCP Token，请通过环境变量 MCP_TOKEN 配置', 401);
    }

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: 'mcd-saver-planner', version: '1.0.0' }
    });

    // 通知服务端初始化完成（notification 无需响应）
    await this.notify('notifications/initialized');

    this.initialized = true;
    logger.info('MCP', '连接已建立', this.serverUrl);
    return true;
  }

  /** 发送无需响应的通知 */
  async notify(method, params = {}) {
    await this.fetchImpl(this.serverUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params })
    }).catch(() => {});
  }

  /**
   * 调用 MCP Tool
   * @param {string} name 工具名
   * @param {Object} args 工具入参
   */
  async callTool(name, args = {}) {
    this.checkRateLimit();
    logger.toolCall(name, args);

    return withRetry(async () => {
      await this.connect();
      const result = await this.request('tools/call', { name, arguments: args });
      return unwrapToolResult(result);
    });
  }

  /** 列出服务端可用工具 */
  async listTools() {
    await this.connect();
    return (await this.request('tools/list'))?.tools ?? [];
  }
}

/**
 * 解析 MCP tool result
 * MCP 返回 { content: [{type:'text', text}], structuredContent?, isError }
 */
export function unwrapToolResult(result) {
  if (!result) return null;

  if (result.isError) {
    const text = extractText(result);
    throw new McpError(`工具执行失败：${text}`, -1, result);
  }

  // 优先使用结构化内容
  if (result.structuredContent) return result.structuredContent;

  const text = extractText(result);
  if (!text) return result;

  // 尝试解析为 JSON
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, text };
  }
}

/** 提取 text 类型内容 */
export function extractText(result) {
  if (!result?.content) return '';
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export default McpClient;
