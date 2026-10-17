/**
 * MCP 工具调用封装
 *
 * 统一处理官方 MCP 的传参规则，避免业务模块重复拼装：
 *  - 到店自取(beType=1) → orderType=1，不传 beCode
 *  - 得来速(beType=5)   → orderType=1，必传 beCode
 *  - 麦乐送(beType=2)   → orderType=2，必传 beCode
 *  - 团餐(beType=6)     → orderType=2，必传 beCode
 */

import config, { BE_TYPE, BE_TYPE_RULE } from '../config.js';
import cache from '../utils/cache.js';
import logger from '../utils/logger.js';
import { McpClient } from './client.js';
import { McpError } from '../utils/retry.js';

export class McdTools {
  /**
   * @param {Object} options
   * @param {McpClient} options.client MCP 客户端实例
   */
  constructor(options = {}) {
    this.client = options.client ?? new McpClient(options);
  }

  /**
   * 规范化商品列表
   *
   * ⚠️ 实测兼容点：官方 schema 中 items 被定义为
   *    { items: ProductItem[] } 的嵌套结构，但多数 MCP Client 的
   *    JSON Schema 校验器要求 items 直接为数组。此处两种形态都做兼容，
   *    业务侧统一按 ProductItem[] 传入。
   *
   * @param {Array} items 商品列表
   * @returns {Array} 规范化后的商品列表
   */
  static normalizeItems(items = []) {
    if (!Array.isArray(items)) {
      // 兼容 { items: [...] } 嵌套形态
      if (items && Array.isArray(items.items)) return items.items;
      return [];
    }
    // 兼容 [[{...}]] 双层包裹（部分 Client 的 schema 包装所致）
    if (items.length === 1 && Array.isArray(items[0])) return items[0];
    return items;
  }

  /**
   * 按 beType 推导并补全 orderType / beCode
   * @param {number} beType 业务类型
   * @param {string} beCode 业务编码
   * @param {number} orderType 可选，缺省时自动推导
   * @returns {{orderType:number, beCode:string|undefined}}
   */
  static resolveChannel(beType, beCode, orderType) {
    const rule = BE_TYPE_RULE[beType];
    if (!rule) throw new McpError(`非法的 beType：${beType}`, 400);
    if (rule.needBeCode && !beCode) {
      throw new McpError(`${rule.label}场景必须传beCode`, 400);
    }
    return {
      orderType: orderType ?? rule.orderType,
      beCode: rule.needBeCode ? beCode : undefined
    };
  }

  /** 剔除 undefined 字段，避免传给服务端造成校验失败 */
  static compact(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
  }

  // ───────────────────── 门店与渠道 ─────────────────────

  /**
   * 查询附近到店 / 得来速门店
   * @param {Object} p
   * @param {1|5} p.beType 1-到店自取, 5-得来速
   * @param {number} [p.searchType] 2-按位置搜索, 1-收藏餐厅
   * @param {string} [p.city] 城市（searchType=2 时必填）
   * @param {string} [p.keyword] 位置关键词（searchType=2 时必填）
   */
  async queryNearbyStores({ beType, searchType = 2, city, keyword }) {
    const args = McdTools.compact({ beType, searchType, city, keyword });
    const key = `stores:${beType}:${searchType}:${city}:${keyword}`;
    return cache.remember(key, config.cache.storeTTL, () => this.client.callTool('query-nearby-stores', args));
  }

  /** 获取用户配送地址列表 */
  async queryDeliveryAddresses() {
    return cache.remember('delivery:addresses', config.cache.couponTTL, () =>
      this.client.callTool('delivery-query-addresses', {})
    );
  }

  /**
   * 查询可配送门店
   * @param {Object} p
   * @param {string} p.addressId 地址 ID
   * @param {2|6} p.beType 2-麦乐送, 6-团餐
   */
  async queryDeliveryStores({ addressId, beType = BE_TYPE.DELIVERY }) {
    const key = `stores:delivery:${addressId}:${beType}`;
    return cache.remember(key, config.cache.storeTTL, () =>
      this.client.callTool('delivery-query-stores', McdTools.compact({ addressId, beType }))
    );
  }

  // ───────────────────── 餐品 ─────────────────────

  /**
   * 查询门店可售餐品列表
   * @param {Object} p
   * @param {string} p.storeCode 门店编码
   * @param {number} p.beType 业务类型
   * @param {string} [p.beCode] 业务编码（得来速/外送/团餐必传）
   * @param {string} [p.reservationDate] 预约时间 yyyy-MM-dd HH:mm
   */
  async queryMeals({ storeCode, beType, beCode, reservationDate }) {
    const { orderType, beCode: bc } = McdTools.resolveChannel(beType, beCode);
    const args = McdTools.compact({ storeCode, beType, orderType, beCode: bc, reservationDate });
    const key = `meals:${storeCode}:${beType}:${bc ?? '-'}:${reservationDate ?? '-'}`;
    return cache.remember(key, config.cache.menuTTL, () => this.client.callTool('query-meals', args));
  }

  /** 查询单餐品详情 / 配料（用于特调 key 规则） */
  async queryMealDetail({ code, storeCode, beType, beCode }) {
    const { orderType, beCode: bc } = McdTools.resolveChannel(beType, beCode);
    const args = McdTools.compact({ code, storeCode, beType, orderType, beCode: bc });
    return this.client.callTool('query-meal-detail', args);
  }

  // ───────────────────── 优惠券 ─────────────────────

  /**
   * 查询指定门店 + 订单类型下可使用的优惠券
   * @param {Object} p
   * @param {string} p.storeCode 门店编码
   * @param {number} p.beType 业务类型
   * @param {string} [p.beCode]
   */
  async queryStoreCoupons({ storeCode, beType, beCode, reservationDate }) {
    const { orderType, beCode: bc } = McdTools.resolveChannel(beType, beCode);
    const args = McdTools.compact({ storeCode, beType, orderType, beCode: bc, reservationDate });
    const key = `coupons:store:${storeCode}:${beType}:${bc ?? '-'}`;
    return cache.remember(key, config.cache.couponTTL, () =>
      this.client.callTool('query-store-coupons', args)
    );
  }

  /** 查询麦麦省可领优惠券 */
  async availableCoupons() {
    return cache.remember('coupons:available', config.cache.couponTTL, () =>
      this.client.callTool('available-coupons', {})
    );
  }

  /**
   * 一键领取所有麦麦省券
   * ⚠️ 该操作会真实领取优惠券到用户账户，下单前调用一次即可
   */
  async autoBindCoupons() {
    const res = await this.client.callTool('auto-bind-coupons', {});
    // 领取后券发生变化，立即失效缓存
    cache.invalidate('coupons:');
    return res;
  }

  /** 查询用户已拥有的优惠券 */
  async queryMyCoupons({ page, pageSize } = {}) {
    const args = McdTools.compact({ page, pageSize });
    return cache.remember('coupons:mine', config.cache.couponTTL, () =>
      this.client.callTool('query-my-coupons', args)
    );
  }

  // ───────────────────── 交易 ─────────────────────

  /**
   * 计算订单最终价格
   *
   * ⚠️ 关键契约：优惠券绑定在「商品项」上（item.couponId / item.couponCode），
   *    而非订单级别。多张券叠加时需将券分别挂到不同商品项上。
   *
   * @param {Object} p
   * @param {string} p.storeCode
   * @param {number} p.beType
   * @param {Array} p.items 商品列表
   * @param {string} [p.beCode]
   * @param {Object} [p.withOrder] 随单购商品
   * @param {boolean} [p.needTableware]
   */
  async calculatePrice({ storeCode, beType, items, beCode, withOrder, needTableware, reservationDate }) {
    const { orderType, beCode: bc } = McdTools.resolveChannel(beType, beCode);
    const args = McdTools.compact({
      storeCode,
      beType,
      orderType,
      beCode: bc,
      items: McdTools.normalizeItems(items),
      withOrder,
      needTableware,
      reservationDate
    });
    return this.client.callTool('calculate-price', args);
  }

  /**
   * 创建订单并返回支付链接
   * @param {Object} p
   * @param {string} p.storeCode
   * @param {number} p.beType
   * @param {Array} p.items
   * @param {string} [p.takeWayCode] 到店必传，取自 calculate-price 的 takeWayList[].code
   * @param {string} [p.addressId] 外送必传
   * @param {string} [p.remark] 订单备注（≤50字）
   */
  async createOrder({ storeCode, beType, items, beCode, takeWayCode, addressId, remark, needTableware, withOrder, reservationDate }) {
    const { orderType, beCode: bc } = McdTools.resolveChannel(beType, beCode);
    const args = McdTools.compact({
      storeCode,
      beType,
      orderType,
      beCode: bc,
      items: McdTools.normalizeItems(items),
      takeWayCode: orderType === 1 ? takeWayCode : undefined,
      addressId: orderType === 2 ? addressId : undefined,
      remark,
      needTableware,
      withOrder,
      reservationDate
    });
    return this.client.callTool('create-order', args);
  }

  /** 查询订单详情 / 状态 */
  async queryOrder({ orderId }) {
    return this.client.callTool('query-order', McdTools.compact({ orderId }));
  }

  /** 查询历史订单 */
  async orderList() {
    return cache.remember('orders:list', config.cache.couponTTL, () =>
      this.client.callTool('order-list', {})
    );
  }

  // ───────────────────── 活动与积分 ─────────────────────

  /** 查询营销活动日历 */
  async campaignCalendar({ specifiedDate } = {}) {
    const args = McdTools.compact({ specifiedDate });
    const key = `campaign:${specifiedDate ?? 'current'}`;
    return cache.remember(key, config.cache.campaignTTL, () =>
      this.client.callTool('campaign-calendar', args)
    );
  }

  /** 查询用户积分账户 */
  async queryMyAccount() {
    return cache.remember('points:account', config.cache.couponTTL, () =>
      this.client.callTool('query-my-account', {})
    );
  }

  /** 查询麦麦商城可兑换商品 */
  async mallPointsProducts({ catRuleIds } = {}) {
    const args = McdTools.compact({ catRuleIds });
    return this.client.callTool('mall-points-products', args);
  }

  /** 积分兑换商品下单 */
  async mallCreateOrder({ skuId, spuCategory }) {
    return this.client.callTool('mall-create-order', McdTools.compact({ skuId, spuCategory }));
  }

  /** 查询积分商城商品详情 */
  async mallProductDetail({ spuId } = {}) {
    return this.client.callTool('mall-product-detail', McdTools.compact({ spuId }));
  }

  /** 获取当前标准时间 */
  async nowTimeInfo() {
    return cache.remember('time:now', 60_000, () => this.client.callTool('now-time-info', {}));
  }

  /** 获取本轮工具调用次数 */
  getCallCount() {
    return logger.getCallCount();
  }
}

export default McdTools;
