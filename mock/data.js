/**
 * 离线 Mock 数据
 *
 * 数据来源：麦当劳 MCP Server 真实响应采样（2026-10-17，深圳宝安机场店 storeCode=1420293），
 * 用于无 Token 环境下演示与自动化测试。菜单价格与门店信息与线上保持一致结构。
 */

export const MOCK_STORE = {
  storeCode: '1420293',
  storeName: '麦当劳深圳机场国内到达层地面交通中心餐厅',
  address: '宝安国际机场GTC编号为GTC-209',
  distance: 736,
  businessStatus: true,
  businessStartTime: '00:00',
  businessEndTime: '23:59'
};

export const MOCK_MENU = {
  success: true,
  code: 200,
  data: {
    categories: [
      { name: '人气热卖', meals: [{ code: '9900014838', tags: ['全球爆款'] }] },
      { name: '巨无霸\n牛鱼肉堡', meals: [{ code: '1100', tags: ['单品', '全球爆款'] }, { code: '9900005466', tags: ['套餐'] }] },
      { name: '小食甜品\n/其他', meals: [{ code: '4810', tags: ['小食'] }, { code: '515837', tags: ['冰淇淋'] }] },
      { name: '饮品', meals: [{ code: '9900008751', tags: ['冷饮'] }, { code: '3060', tags: ['冷饮'] }] }
    ],
    meals: {
      '1100': { name: '巨无霸', currentPrice: '26.5', originalPrice: '26.5', canWithOrder: false },
      '9900005466': { name: '巨无霸三件套', currentPrice: '41', originalPrice: '51.5', canWithOrder: false },
      '9900014838': { name: '枫糖风味厚松饼猪柳蛋堡三件套', currentPrice: '32.5', originalPrice: '42.5', canWithOrder: false },
      '4810': { name: '薯条', currentPrice: '14.5', originalPrice: '14.5', canWithOrder: false },
      '515837': { name: '圆筒冰淇淋', currentPrice: '5', originalPrice: '5', canWithOrder: false },
      '9900008751': { name: '可乐', currentPrice: '10.5', originalPrice: '10.5', canWithOrder: false },
      '3060': { name: '雪碧', currentPrice: '10.5', originalPrice: '10.5', canWithOrder: false },
      '9900008752': { name: '派', currentPrice: '9', originalPrice: '9', canWithOrder: false },
      '1700': { name: '麦辣鸡翅', currentPrice: '15', originalPrice: '15', canWithOrder: false },
      '1401': { name: '麦乐鸡', currentPrice: '15', originalPrice: '15', canWithOrder: false }
    },
    frequent: { code: '515837', tags: ['我的常点'] }
  }
};

/** 门店券：一张满 40 减 8，一张单品券 */
export const MOCK_STORE_COUPONS = {
  success: true,
  code: 200,
  data: [
    {
      couponId: 'CP001',
      couponCode: 'CP001-A1',
      title: '满40减8门店券',
      tradeDateTime: '2026-10-01 至 2026-11-30',
      products: []
    },
    {
      couponId: 'CP002',
      couponCode: 'CP002-B2',
      title: '巨无霸6元券',
      // threshold/discount 单位为「元」，与官方券字段口径一致
      threshold: 0,
      discount: 6,
      tradeDateTime: '2026-10-01 至 2026-12-31',
      products: [{ productCode: '1100', productName: '巨无霸' }]
    },
    {
      couponId: 'CP003',
      couponCode: 'CP003-C3',
      title: '薯条买一送一券',
      threshold: 0,
      discount: 7,
      tradeDateTime: '2026-10-10 至 2026-10-31',
      products: [{ productCode: '4810', productName: '薯条' }]
    }
  ]
};

/** 用户已持券（麦麦省券，与门店券不同类型，可叠加） */
export const MOCK_MY_COUPONS = {
  success: true,
  code: 200,
  data: [
    {
      couponId: 'MMS100',
      couponCode: 'MMS100-X1',
      title: '麦麦省满30减5券',
      type: 'mms',
      threshold: 30,
      discount: 5,
      products: []
    },
    {
      couponId: 'MMS200',
      couponCode: 'MMS200-Y2',
      title: '麦麦省9元咖啡券',
      type: 'mms',
      threshold: 0,
      discount: 9,
      products: [{ productCode: '9900008751', productName: '可乐' }]
    }
  ]
};

export const MOCK_MMS_AVAILABLE = {
  success: true,
  code: 200,
  data: [
    { title: '免费脆薯饼', status: '可领取' },
    { title: '人气麦旋风买一送一', status: '可领取' },
    { title: '9.9元中杯冰美式', status: '可领取' }
  ]
};

export const MOCK_ACCOUNT = {
  success: true,
  code: 200,
  data: {
    accountId: 'MOCK-ACCOUNT',
    availablePoint: '1636.1',
    accumulativePoint: '7578.1',
    usedPoint: '2904',
    expiredPoint: '3023',
    currentMouthExpirePoint: '170.8',
    frozenPoint: '0',
    currency: '麦享会积分'
  }
};

export const MOCK_POINTS_GOODS = {
  success: true,
  code: 200,
  data: [
    { spuId: 'SPU001', skuId: 'SKU001', name: '点餐优惠券 5元', points: 500, value: 5, categoryName: '点餐' },
    { spuId: 'SPU002', skuId: 'SKU002', name: '点餐优惠券 12元', points: 900, value: 12, categoryName: '点餐' },
    { spuId: 'SPU003', skuId: 'SKU003', name: '点餐优惠券 30元', points: 3000, value: 30, categoryName: '点餐' }
  ]
};

export const MOCK_CAMPAIGN = {
  success: true,
  code: 200,
  data: [
    { title: '巨无霸 8 折限时活动', status: '即将开始', startTime: '2026-11-01', endTime: '2026-11-07', description: '巨无霸单品8折' },
    { title: '会员日全场立减 10 元', status: '即将开始', startTime: '2026-10-25', endTime: '2026-10-25', description: '会员日专享' }
  ]
};

export const MOCK_ORDER_LIST = {
  success: true,
  code: 200,
  data: [
    {
      orderId: 'ORDER-20261001-001',
      storeCode: '1420293',
      storeName: MOCK_STORE.storeName,
      createTime: '2026-10-01 12:30',
      items: [
        { productCode: '1100', quantity: 1, name: '巨无霸' },
        { productCode: '4810', quantity: 1, name: '薯条' }
      ]
    }
  ]
};

/**
 * 计算价格模拟器
 * 依据真实业务规则：门店券同类型互斥、麦麦省券可与门店券叠加、满减需达门槛
 *
 * 券的适用范围与优惠金额与 couponRules.parseStoreCoupons 保持一致：
 *  - 适用范围取 products[].productCode（为空表示全场通用）
 *  - 优惠金额从 title 文案解析（满X减Y / X元券 / X折）
 */
export function mockCalculatePrice({ items = [], storeCode }) {
  const menu = MOCK_MENU.data.meals;
  const unit = (code) => Number(menu[code]?.currentPrice ?? 0);

  // 原价：按菜单现价（真实 calculate-price 中已含单品促销价）
  const originalPrice = Math.round(
    items.reduce((sum, i) => sum + unit(i.productCode) * Number(i.quantity || 1), 0) * 100
  );

  // 汇总用到的券
  const usedIds = new Set();
  for (const i of items) {
    if (i.couponId) usedIds.add(i.couponId);
    for (const extra of i.couponCodes ?? []) if (extra?.couponId) usedIds.add(extra.couponId);
  }

  let discount = 0;
  const allCoupons = [...MOCK_STORE_COUPONS.data, ...MOCK_MY_COUPONS.data];
  const appliedByType = new Map(); // type -> 已用金额，用于同类型取最大

  for (const cid of usedIds) {
    const c = allCoupons.find((x) => x.couponId === cid);
    if (!c) continue;

    const type = c.type ?? 'store';
    // 同类型互斥：只保留该类型金额最大的一张
    if (appliedByType.has(type)) {
      if (appliedByType.get(type) >= Number(c.discount ?? 0) * 100) continue;
      discount -= appliedByType.get(type);
    }

    const threshold = Number(c.threshold ?? 0) * 100;
    if (threshold > 0 && originalPrice < threshold) continue;

    // 商品范围校验
    const scope = c.products ?? [];
    if (scope.length && !scope.some((p) => items.some((i) => String(i.productCode) === String(p.productCode)))) continue;

    const value = Number(c.discount ?? 0) * 100;
    appliedByType.set(type, value);
    discount += value;
  }

  discount = Math.max(0, Math.min(discount, originalPrice));

  return {
    success: true,
    code: 200,
    data: {
      originalPrice,
      discountAmount: discount,
      finalPrice: originalPrice - discount,
      deliveryFee: 0,
      takeWayList: [
        { code: 'TAKEWAY_STORE', name: '到店取餐' },
        { code: 'TAKEWAY_CAR', name: '车道取餐' }
      ]
    }
  };
}

/** 创建订单模拟 */
export function mockCreateOrder() {
  return {
    success: true,
    code: 200,
    data: {
      orderId: `MOCK-${Date.now()}`,
      payUrl: 'https://pay.mcd.cn/mock-order',
      orderStatus: '待支付'
    }
  };
}

/**
 * 门店查询模拟
 * @param {number} beType 业务类型；外送/团餐场景必须带 beCode
 */
export function mockStores(beType) {
  const needBeCode = beType === 2 || beType === 5 || beType === 6;
  const beCodeFor = (n) => `BE-${beType}-${n}`;
  return {
    success: true,
    code: 200,
    data: [
      {
        ...MOCK_STORE,
        ...(needBeCode ? { beCode: beCodeFor('001') } : {})
      },
      {
        ...MOCK_STORE,
        storeCode: '1420758',
        storeName: '麦当劳深圳后瑞地铁站餐厅',
        distance: 1969,
        ...(needBeCode ? { beCode: beCodeFor('002') } : {})
      }
    ]
  };
}

export default {
  MOCK_STORE, MOCK_MENU, MOCK_STORE_COUPONS, MOCK_MY_COUPONS, MOCK_MMS_AVAILABLE,
  MOCK_ACCOUNT, MOCK_POINTS_GOODS, MOCK_CAMPAIGN, MOCK_ORDER_LIST,
  mockCalculatePrice, mockCreateOrder, mockStores
};
