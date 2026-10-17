/**
 * 本地 TTL 缓存
 *
 * 缓存规则（§5.1）：
 *  - 门店菜单、活动日历：1 小时
 *  - 用户优惠券、积分：5 分钟
 *  - 同一轮请求内相同参数不重复调用
 */

const store = new Map();

/**
 * 写入缓存
 * @param {string} key 缓存键
 * @param {*} value 缓存值
 * @param {number} ttl 有效期（毫秒）
 */
export function set(key, value, ttl) {
  const expireAt = Date.now() + ttl;
  store.set(key, { value, expireAt, ttl });
  // 兜底清理，避免长时间运行内存无限增长
  if (store.size > 500) evictExpired();
}

/**
 * 读取缓存
 * @param {string} key 缓存键
 * @returns {*} 命中返回值，未命中或过期返回 undefined
 */
export function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expireAt) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

/** 是否命中 */
export function has(key) {
  return get(key) !== undefined;
}

/**
 * 缓存包装器：命中直接返回，未命中执行 fn 并写入缓存
 * @param {string} key
 * @param {number} ttl
 * @param {Function} fn
 */
export async function remember(key, ttl, fn) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  const value = await fn();
  if (value !== undefined && value !== null) set(key, value, ttl);
  return value;
}

/** 按前缀批量失效（如用户券过期后清理） */
export function invalidate(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

function evictExpired() {
  const now = Date.now();
  for (const [key, hit] of store.entries()) {
    if (now > hit.expireAt) store.delete(key);
  }
}

export function clear() {
  store.clear();
}

export default { set, get, has, remember, invalidate, clear };
