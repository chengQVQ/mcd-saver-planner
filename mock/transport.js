/**
 * 离线 Mock 传输层
 *
 * 通过注入 fetch-like 实现，让 McdClient 在无 Token、无网络环境下
 * 完整跑通「意图解析 → 优惠计算 → 方案输出 → 下单」全链路，
 * 用于演示、自动化测试与 CI 验证。
 */

import MOCK_STORE from '../mock/data.js';
import {
  MOCK_MENU, MOCK_STORE_COUPONS, MOCK_MY_COUPONS, MOCK_MMS_AVAILABLE,
  MOCK_ACCOUNT, MOCK_POINTS_GOODS, MOCK_CAMPAIGN, MOCK_ORDER_LIST,
  mockCalculatePrice, mockCreateOrder, mockStores
} from '../mock/data.js';

/** 构造 MCP tool result 包装 */
const wrap = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  structuredContent: payload
});

/**
 * 构造 JSON-RPC 2.0 响应体
 * McpClient 通过 payload.result 取工具结果，因此必须包在标准信封里。
 */
const rpc = (id, result) => ({
  jsonrpc: '2.0',
  id,
  result
});

/**
 * 构造最小 Response 替身
 * McpClient 通过 res.headers.get() / res.text() 读取响应，这里补齐这两个能力。
 */
const ok = (payload, id) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(rpc(id, wrap(payload)))
});

/**
 * 创建 Mock fetch 实现
 * @param {Object} options { latency 模拟延迟 }
 */
export function createMockFetch(options = {}) {
  const latency = options.latency ?? 0;
  const calls = [];

  const handler = async (url, init = {}) => {
    const body = JSON.parse(init.body ?? '{}');
    calls.push({ method: body.method, params: body.params });

    if (latency > 0) await new Promise((r) => setTimeout(r, latency));

    // MCP 协议握手
    if (body.method === 'initialize') {
      return ok({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mcd-mock', version: '1.0.0' } }, body.id);
    }
    if (body.method?.startsWith('notifications/')) {
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
    }

    if (body.method === 'tools/call') {
      const { name, arguments: args = {} } = body.params ?? {};
      return ok(dispatch(name, args), body.id);
    }

    return ok({ tools: [] }, body.id);
  };

  handler.calls = calls;
  return handler;
}

/** 工具路由 */
function dispatch(name, args) {
  switch (name) {
    case 'query-nearby-stores':
      return mockStores(args.beType);
    case 'delivery-query-addresses':
      return { success: true, code: 200, data: [{ addressId: 'ADDR001', address: '深圳市宝安区宝安国际机场' }] };
    case 'delivery-query-stores':
      return mockStores(2);    case 'query-meals':
      return MOCK_MENU;
    case 'query-meal-detail':
      return { success: true, code: 200, data: { code: args.code, name: MOCK_MENU.data.meals[args.code]?.name ?? '' } };
    case 'query-store-coupons':
      return MOCK_STORE_COUPONS;
    case 'available-coupons':
      return MOCK_MMS_AVAILABLE;
    case 'auto-bind-coupons':
      return { success: true, code: 200, data: { count: 3, message: '成功领取3张优惠券' } };
    case 'query-my-coupons':
      return MOCK_MY_COUPONS;
    case 'calculate-price':
      return mockCalculatePrice(args);
    case 'create-order':
      return mockCreateOrder(args);
    case 'query-order':
      return { success: true, code: 200, data: { orderId: args.orderId, orderStatus: '已支付' } };
    case 'order-list':
      return MOCK_ORDER_LIST;
    case 'campaign-calendar':
      return MOCK_CAMPAIGN;
    case 'query-my-account':
      return MOCK_ACCOUNT;
    case 'mall-points-products':
      return MOCK_POINTS_GOODS;
    case 'mall-create-order':
      return { success: true, code: 200, data: { orderId: 'MALL-MOCK-001' } };
    case 'mall-product-detail':
      return { success: true, code: 200, data: MOCK_POINTS_GOODS.data[0] };
    case 'now-time-info':
      return { success: true, code: 200, data: { nowTime: new Date().toISOString() } };
    default:
      return { success: false, code: 404, message: `Mock 未实现的工具：${name}` };
  }
}

export { MOCK_STORE };
export default { createMockFetch };
