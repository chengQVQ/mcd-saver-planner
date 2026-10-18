/**
 * 全局配置项定义
 *
 * 所有可配置项统一管理，禁止硬编码。
 * 敏感信息（Token）仅从环境变量或 .env 文件读取，不写入代码仓库。
 * .env 已被 .gitignore 忽略，可安全存放本地 Token。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 加载 .env 文件（零依赖实现）
 *
 * 优先级：真实环境变量 > .env 文件
 * .env 中已存在的值不会被覆盖，避免误伤命令行显式传入的配置。
 */
function loadDotEnv() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = resolve(here, '..', '.env');
    if (!existsSync(envPath)) return;

    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      // 跳过空行与注释
      if (!line || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq === -1) continue;

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();

      // 去掉成对包裹的引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // 环境变量优先，不覆盖
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env 读取失败不应影响程序运行，静默忽略
  }
}

loadDotEnv();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  mcp: {
    /** MCP Server 服务地址 */
    serverUrl: process.env.MCD_MCP_URL || 'https://mcp.mcd.cn',
    /** 协议类型：streamablehttp */
    protocol: 'streamablehttp',
    /** 用户 MCP Token，务必通过环境变量注入，切勿提交到仓库 */
    token: process.env.MCP_TOKEN || '',
    /** 单 Token 每分钟请求上限 */
    rateLimitPerMinute: num(process.env.MCD_RATE_LIMIT, 600),
    /** 最大重试次数 */
    maxRetryTimes: num(process.env.MCD_MAX_RETRY, 3),
    /** 重试基础延迟（毫秒），指数退避：1s / 2s / 4s */
    retryBaseDelay: num(process.env.MCD_RETRY_DELAY, 1000),
    /** 单次请求超时（毫秒） */
    requestTimeout: num(process.env.MCD_REQUEST_TIMEOUT, 15000)
  },

  cache: {
    /** 菜单缓存有效期 1 小时 */
    menuTTL: 3600 * 1000,
    /** 优惠券 / 积分缓存有效期 5 分钟 */
    couponTTL: 5 * 60 * 1000,
    /** 活动日历缓存有效期 1 小时 */
    campaignTTL: 3600 * 1000,
    /** 门店缓存有效期 1 小时 */
    storeTTL: 3600 * 1000
  },

  recommend: {
    channelWeight: {
      /** 价格权重 */
      price: 0.6,
      /** 时间权重 */
      time: 0.25,
      /** 距离权重 */
      distance: 0.15
    },
    /** 输出方案数 */
    topPlanCount: 3
  },

  /** 单轮请求内允许的最大工具调用次数 */
  limits: {
    /** 单轮工具调用总数上限 */
    maxCallsPerRound: 15,
    /** 单次并发调用上限 */
    maxConcurrency: 10,
    /** 批量价格计算间隔（毫秒） */
    batchInterval: 100,
    /** 价格组合最大枚举数，防止组合爆炸 */
    maxCombinations: 12
  },

  features: {
    /** 是否启用积分兑换 */
    enablePointsExchange: true,
    /** 是否启用活动预判 */
    enableCampaignPredict: true,
    /** 是否启用凑单推荐 */
    enableComboRecommend: true,
    /** 是否启用多渠道比价 */
    enableChannelCompare: true
  },

  /** 凑单候选商品价格区间（分） */
  combo: {
    minPrice: 500,
    maxPrice: 1500
  },

  /** 活动预判窗口（天）与触发阈值 */
  campaign: {
    lookaheadDays: 14,
    /** 活动折扣优于当前价的比例阈值（0-1），达到则建议等活动 */
    waitThreshold: 0.1
  }
};

/** 业务类型枚举：beType */
export const BE_TYPE = {
  IN_STORE: 1,     // 到店自取
  DELIVERY: 2,     // 麦乐送到家
  DRIVE_THRU: 5,   // 得来速车道取餐
  GROUP_MEAL: 6    // 企业团餐
};

/** 订单类型枚举：orderType */
export const ORDER_TYPE = {
  PICKUP: 1,       // 到店（含到店自取 + 得来速）
  DELIVERY: 2      // 外送（含麦乐送 + 企业团餐）
};

/**
 * beType → { orderType, needBeCode }
 * 官方 MCP 传参规则：
 *  - 到店自取(beType=1)   → orderType=1，不传 beCode
 *  - 得来速(beType=5)     → orderType=1，必传 beCode
 *  - 麦乐送(beType=2)     → orderType=2，必传 beCode
 *  - 团餐(beType=6)       → orderType=2，必传 beCode
 */
export const BE_TYPE_RULE = {
  [BE_TYPE.IN_STORE]:   { orderType: ORDER_TYPE.PICKUP,   needBeCode: false, label: '到店自取' },
  [BE_TYPE.DRIVE_THRU]: { orderType: ORDER_TYPE.PICKUP,   needBeCode: true,  label: '得来速' },
  [BE_TYPE.DELIVERY]:   { orderType: ORDER_TYPE.DELIVERY, needBeCode: true,  label: '麦乐送' },
  [BE_TYPE.GROUP_MEAL]: { orderType: ORDER_TYPE.DELIVERY, needBeCode: true,  label: '企业团餐' }
};

export default config;
