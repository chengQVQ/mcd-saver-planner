/**
 * 主流程编排
 *
 * 全链路执行流程（§4.1）：
 *  1. 接收用户输入
 *  2. 调用模块 1（需求解析）→ 结构化参数
 *  3. 参数缺失 → 返回补全询问，等待补充
 *  4. 参数完整 → 并行拉取基础数据
 *  5. 调用模块 2（优惠计算）→ 基础最优方案
 *  6. 可选扩展：多渠道比价 / 凑单 / 活动预判 / 积分兑换
 *  7. 整合方案，排序输出
 *  8. 用户确认 → 模块 7（下单执行）→ 支付链接
 *  9. 可选：订单状态查询
 */

import config, { BE_TYPE } from '../config.js';
import logger from '../utils/logger.js';
import cache from '../utils/cache.js';
import { formatYuan } from '../utils/money.js';
import { SessionContext, STATE } from './stateMachine.js';
import { parseIntent, INTENT } from '../modules/intent.js';
import { createWizard, fillAnswer, currentStep, wizardParams, renderProgress } from '../modules/guidedFlow.js';
import { extractMenuItems, matchItems, buildBudgetCombo, buildComboAroundItems } from '../modules/menuMatcher.js';
import { calcBestPlans } from '../modules/priceEngine.js';
import { compareChannels } from '../modules/channelCompare.js';
import { recommendCombo } from '../modules/combo.js';
import { predictCampaign } from '../modules/campaign.js';
import { optimizePoints } from '../modules/points.js';
import { executeOrder } from '../modules/order.js';

/**
 * 省钱规划师主流程控制器
 */
export class SaverPlanner {
  /**
   * @param {Object} p
   * @param {import('../mcp/tools.js').default} p.tools MCP 工具封装
   * @param {boolean} [p.offline] 离线模式，使用内置mock 数据
   */
  constructor({ tools, offline = false }) {
    this.tools = tools;
    this.offline = offline;
    this.session = new SessionContext();
  }

  /**
   * 处理一轮用户输入
   * @param {string} input 用户自然语言输入
   * @returns {Promise<Object>} 本轮结果
   */
  async handle(input) {
    logger.resetCallCount();

    // 新一轮请求：若当前不在可接收输入的状态，先复位会话
    this.ensureAcceptingInput();

    // ── 引导问卷进行中：把本轮输入填入当前问题 ──
    if (this.session.state === STATE.GUIDED_ASKING && this.session.wizard) {
      return this.continueWizard(input);
    }

    // ── 步骤 2：模块 1 需求解析 ──
    this.session.transition('userInput');
    const parsed = parseIntent(input);
    this.session.intent = parsed.intent;

    logger.info('FLOW', `意图识别：${parsed.intent}｜参数：${JSON.stringify(parsed.params)}`);

    // ── 步骤 3：参数有缺失 → 进入引导问卷（一次问一个）──
    // 活动查询/积分兑换等无字段依赖的意图跳过问卷直接执行
    const wizardable = parsed.missingFields.length > 0 &&
      parsed.intent !== INTENT.CAMPAIGN_QUERY &&
      parsed.intent !== INTENT.POINTS_EXCHANGE &&
      parsed.intent !== INTENT.GENERAL;

    if (wizardable) {
      const wizard = createWizard(parsed.intent, parsed.params);
      this.session.wizard = wizard;
      this.session.params = parsed.params;
      this.session.transition('paramsMissing'); // → GUIDED_ASKING
      return this.askNext();
    }

    this.session.params = parsed.params;

    // ── 步骤 4a：解析门店 ──
    await this.resolveStore(parsed.params);

    // ── 步骤 4/5：并行拉取数据 + 优惠计算 ──
    this.session.transition('paramsComplete');
    try {
      const result = await this.executeIntent(parsed);
      this.session.transition('success');
      return result;
    } catch (err) {
      this.session.transition('failure');
      this.session.errorMsg = err.message;
      logger.error('FLOW', '执行失败', err.message);
      return {
        type: 'error',
        message: friendlyError(err),
        state: STATE.ERROR
      };
    }
  }

  /**
   * 引导问卷：填入用户的回答并推进
   */
  async continueWizard(input) {
    const text = String(input ?? '').trim();

    // 取消指令
    if (/^(取消|退出|重来|重新开始|exit|cancel|reset)$/.test(text)) {
      this.session.transition('cancel');
      this.session.wizard = null;
      return {
        type: 'cancelled',
        message: '已取消本次问卷，重新开始可以说点什么',
        state: this.session.state
      };
    }

    // 重置某个字段：用户说"预算改成50"
    const amend = text.match(/^(?:预算|位置|人数|餐品|取餐方式|城市)[改成换设为是]+(.+)$/);
    if (amend) {
      return this.amendField(amend);
    }

    // 填入当前问题
    this.session.transition('answer');
    const wizard = this.session.wizard;
    const result = fillAnswer(wizard, text);

    if (!result.ok) {
      return {
        type: 'wizard_error',
        message: result.error,
        currentStep: currentStep(wizard),
        progress: renderProgress(wizard),
        state: this.session.state
      };
    }

    // 全部填齐 → 执行
    if (wizard.done) {
      this.session.params = wizardParams(wizard);
      this.session.transition('complete');
      try {
        // 重新解析意图（保持一致），但用问卷收集的完整参数
        const parsed = { intent: wizard.intent, params: this.session.params, missingFields: [] };
        await this.resolveStore(parsed.params);
        const result = await this.executeIntent(parsed);
        this.session.transition('success');
        return {
          ...result,
          wizardSummary: renderProgress(wizard)   // 把问卷过程附在结果后，便于追溯
        };
      } catch (err) {
        this.session.transition('failure');
        this.session.errorMsg = err.message;
        return { type: 'error', message: friendlyError(err), state: STATE.ERROR };
      }
    }

    // 还有问题未答 → 问下一个
    return this.askNext();
  }

  /** 生成下一问题 */
  askNext() {
    const wizard = this.session.wizard;
    const step = currentStep(wizard);
    if (!step) {
      // 问卷已完整（理论上不会到这，但兜底）
      this.session.transition('complete');
      return { type: 'wizard_complete', state: this.session.state };
    }

    const required = step.required ? '（必填）' : '（可选，可输入「跳过」）';
    return {
      type: 'wizard_ask',
      message: `${step.index}/${step.total}｜${step.label}${required}\n💡 ${step.hint}`,
      currentStep: step,
      progress: renderProgress(wizard),
      state: this.session.state,
      hint: '回答后我会接着问下一个；说「取消」可退出，说「预算改成50」可修改已填字段'
    };
  }

  /** 修改已填字段 */
  amendField(amendMatch) {
    // 简化版：让用户重新回答对应步骤
    return {
      type: 'wizard_error',
      message: '修改已填字段功能开发中。如需修改，请说「取消」后重新开始',
      state: this.session.state
    };
  }

  /** 按意图分发执行 */
  async executeIntent(parsed) {
    switch (parsed.intent) {
      case INTENT.CAMPAIGN_QUERY:
        return this.runCampaign(parsed);
      case INTENT.POINTS_EXCHANGE:
        return this.runPoints(parsed);
      case INTENT.ORDER_REPEAT:
        return this.runRepeatOrder(parsed);
      case INTENT.BUDGET_RECOMMEND:
        return this.runBudget(parsed);
      case INTENT.FOOD_OPTIMAL:
      default:
        return this.runFoodOptimal(parsed);
    }
  }

  /**
   * 场景 A：指定餐品求最优（含可选多渠道比价）
   */
  async runFoodOptimal(parsed) {
    const { params } = parsed;
    const storeCode = params.storeCode;

    if (!storeCode) {
      // 门店未解析到 → 是位置查询失败的真实错误
      throw new Error(`未找到${params.city ?? '附近'}的可营业门店，请确认城市名或换个位置`);
    }

    const menu = await this.tools.queryMeals({
      storeCode, beType: params.beType, beCode: params.beCode
    });
    const menuItems = extractMenuItems(menu);
    const matched = matchItems(menuItems, params.foodKeywords);

    if (!matched.length) {
      return {
        type: 'no_result',
        intent: parsed.intent,
        message: `这家门店暂时没有「${params.foodKeywords.join('、')}」，换个餐品或让我按预算推荐`,
        state: this.session.state
      };
    }

    const items = matched.slice(0, 4).map((m) => ({ productCode: m.code, quantity: 1 }));

    // 未指定渠道 → 多渠道比价；已指定渠道 → 单渠道精算
    const plans = params.beType
      ? await calcBestPlans({
          tools: this.tools, storeCode, beType: params.beType, beCode: params.beCode,
          items, store: params.store ?? { storeName: storeCode }
        })
      : await this.runChannelCompare({ params, items, storeCode });

    this.session.plans = plans;

    // 可选扩展：凑单推荐
    const comboAdvice = await this.tryCombo({ storeCode, beType: params.beType, beCode: params.beCode, items, plans });

    // 可选扩展：积分最优兑换
    const pointsAdvice = config.features.enablePointsExchange
      ? await this.safeCall(() => optimizePoints({ tools: this.tools, currentPrice: plans[0]?.finalPrice ?? null }), null)
      : null;

    return {
      type: 'plans',
      intent: parsed.intent,
      message: this.buildPlanMessage(matched, plans),
      plans,
      matchedItems: matched,
      comboAdvice,
      pointsAdvice,
      callCount: logger.getCallCount(),
      state: this.session.state,
      nextActions: ['说「下单方案1」创建订单', '说「换一家店」重新比价', '说「再便宜点」查看凑单建议']
    };
  }

  /**
   * 场景 B：按预算推荐
   */
  async runBudget(parsed) {
    const { params } = parsed;
    const storeCode = params.storeCode;
    if (!storeCode) {
      throw new Error(`未找到${params.city ?? '附近'}的可营业门店，请确认城市名或换个位置`);
    }

    const menu = await this.tools.queryMeals({
      storeCode, beType: params.beType, beCode: params.beCode
    });
    const menuItems = extractMenuItems(menu);

    // ⚠️ 关键：用户已明确指定餐品时（如「板烧鸡腿堡，预算100」），
    //    必须以指定餐品为主体，再在预算内补充小食/饮品，
    //    而不能忽略用户诉求去做通用搭配。
    const specified = matchItems(menuItems, params.foodKeywords);

    let combo;
    if (specified.length) {
      combo = buildComboAroundItems(menuItems, specified, params.budget, params.peopleCount);
    } else {
      combo = buildBudgetCombo(menuItems, params.budget, params.peopleCount);
    }

    if (!combo.items.length) {
      return {
        type: 'no_result',
        intent: parsed.intent,
        message: menuItems.length
          ? `预算${formatYuan(params.budget)}内这家门店暂无可搭配商品`
          : '这家门店暂时取不到菜单，请稍后重试或换一家门店',
        state: this.session.state
      };
    }

    const plans = await calcBestPlans({
      tools: this.tools, storeCode, beType: params.beType, beCode: params.beCode,
      items: combo.items, store: params.store ?? { storeName: storeCode }
    });

    this.session.plans = plans;

    return {
      type: 'plans',
      intent: parsed.intent,
      message: `${combo.desc}。以下是实际可用优惠券算出的最低到手价：\n${this.buildPlanMessage(combo.matchedItems ?? [], plans)}`,
      plans,
      budgetCombo: combo,
      matchedItems: combo.matchedItems ?? [],
      callCount: logger.getCallCount(),
      state: this.session.state,
      nextActions: ['说「下单方案1」创建订单', '说「换个搭配」重新推荐']
    };
  }

  /**
   * 场景 C：活动查询 / 预判
   */
  async runCampaign(parsed) {
    const advice = await predictCampaign({
      tools: this.tools,
      foodKeywords: parsed.params.foodKeywords,
      currentBestPrice: this.session.plans[0]?.finalPrice ?? null
    });

    return {
      type: 'campaign',
      intent: parsed.intent,
      message: advice.suggestReason,
      advice,
      state: this.session.state,
      nextActions: advice.suggestion === '等活动买'
        ? [`活动开始时间：${advice.nextActivityTime ?? '详见活动页'}`]
        : ['说「现在帮我下单」直接按最优方案购买']
    };
  }

  /**
   * 场景 E：积分最优兑换
   */
  async runPoints(parsed) {
    if (!config.features.enablePointsExchange) {
      throw new Error('积分兑换能力已关闭');
    }

    const advice = await optimizePoints({
      tools: this.tools,
      currentPrice: this.session.plans[0]?.finalPrice ?? null
    });

    if (!advice.bestCoupon) {
      return {
        type: 'no_result',
        intent: parsed.intent,
        message: advice.desc,
        advice,
        state: this.session.state
      };
    }

    return {
      type: 'points',
      intent: parsed.intent,
      message: advice.desc,
      advice,
      callCount: logger.getCallCount(),
      state: this.session.state,
      nextActions: ['说「兑换并下单」生成兑换订单', '说「用积分买巨无霸」结合点餐方案一起算']
    };
  }

  /**
   * 场景 D：订单复购
   */
  async runRepeatOrder(parsed) {
    const orders = await this.tools.orderList();
    const list = orders?.data;

    if (!Array.isArray(list) || !list.length) {
      return {
        type: 'no_result',
        message: '没有找到你的历史订单，试试直接说想吃什么，我帮你找最划算的方案',
        state: this.session.state
      };
    }

    const last = list[0];
    const items = (last.items ?? last.orderItems ?? []).map((i) => ({
      productCode: String(i.productCode ?? i.code ?? ''),
      quantity: Number(i.quantity ?? 1)
    })).filter((i) => i.productCode);

    if (!items.length) {
      return {
        type: 'no_result',
        message: `上次订单（${last.orderId ?? ''}）的商品信息不完整，请直接告诉我你想吃什么`,
        state: this.session.state
      };
    }

    const storeCode = last.storeCode ?? parsed.params.storeCode;
    const plans = await calcBestPlans({
      tools: this.tools, storeCode, beType: parsed.params.beType ?? 1,
      items, store: { storeName: last.storeName ?? storeCode }
    });
    this.session.plans = plans;

    return {
      type: 'plans',
      intent: parsed.intent,
      message: `找到你上次的订单了${last.createTime ? `（${last.createTime}）` : ''}。` +
        `按今天的优惠重新计算，最省方案如下：\n${this.buildPlanMessage([], plans)}`,
      plans,
      state: this.session.state,
      nextActions: ['说「下单方案1」创建订单']
    };
  }

  /**
   * 多渠道比价（模块 3）
   */
  async runChannelCompare({ params, items, storeCode }) {
    const channels = await compareChannels({
      tools: this.tools,
      items,
      city: params.city,
      keyword: params.address,
      addressId: params.addressId
    });

    if (!channels.length) {
      return calcBestPlans({
        tools: this.tools, storeCode, beType: 1, items,
        store: params.store ?? { storeName: storeCode }
      });
    }

    // 每个渠道取其最优方案，合并后按最终价排序输出
    return channels.map((c) => c.availablePlans?.[0] ?? c);
  }

  /**
   * 凑单建议（模块 4）：当最优方案优惠不明显时尝试
   */
  async tryCombo({ storeCode, beType, beCode, items, plans }) {
    if (!config.features.enableComboRecommend || !beType) return null;

    const best = plans[0];
    // 已是最低价且优惠率高，无需凑单
    if (!best || best.saveRate >= 0.35) return null;
    // 未使用任何券，说明没有可用的满减券可凑
    if (!best.usedCoupons?.length) return null;

    const target = best.usedCoupons.find((c) => c.threshold > 0);
    if (!target) return null;

    return this.safeCall(
      () => recommendCombo({ tools: this.tools, items, storeCode, beType, beCode, targetCoupon: target }),
      null
    );
  }

  /**
   * 用户确认方案后下单
   * @param {number|string} planRef 方案序号或ID
   * @param {Object} options { addressId, remark }
   */
  async order(planRef, options = {}) {
    if (!this.session.plans.length) {
      return { success: false, errorMsg: '当前没有可下单的方案，请先描述你的需求' };
    }

    const plan = typeof planRef === 'number'
      ? this.session.plans[planRef - 1]
      : this.session.plans.find((p) => p.id === planRef);

    if (!plan) {
      return {
        success: false,
        errorMsg: `方案不存在，可选范围：${this.session.plans.map((p, i) => `方案${i + 1}`).join('、')}`
      };
    }

    // 状态复位：下单失败后（orderConfirming）或已下单（ordered）再次下单时，
    // 需先回到 planReady，否则会触发非法状态转移。
    if (this.session.state !== STATE.PLAN_READY && this.session.state !== STATE.INIT) {
      this.session.state = STATE.PLAN_READY;
    }

    // 选中方案：planReady --selectPlan--> orderConfirming
    this.session.transition('selectPlan');
    this.session.selectPlan(plan.id);

    // 确认下单：orderConfirming --confirm--> ordering
    this.session.transition('confirm');

    const result = await executeOrder({
      tools: this.tools,
      // 方案对象已自带 beType / orderType / beCode，无需再手工推导
      plan,
      addressId: options.addressId ?? this.session.params.addressId,
      remark: options.remark,
      skipCouponBind: options.skipCouponBind
    });

    this.session.transition(result.success ? 'success' : 'failure');
    if (result.success) {
      this.session.currentOrder = result;
    } else {
      this.session.errorMsg = result.errorMsg;
    }

    return { ...result, state: this.session.state };
  }

  /**
   * 查询订单状态
   * @param {string} orderId
   */
  async queryOrder(orderId) {
    const id = orderId ?? this.session.currentOrder?.orderId;
    if (!id) return { success: false, errorMsg: '缺少订单号' };

    const payload = await this.tools.queryOrder({ orderId: String(id) });
    this.session.transition('queryOrder');
    return { success: true, orderId: id, detail: payload };
  }

  // ─────────────── 内部工具 ───────────────

  /**
   * 解析门店
   *
   * 意图解析阶段只能拿到城市 / 地址关键词，具体门店需按渠道查询：
   *  - 到店自取 / 得来速：query-nearby-stores（searchType=2）
   *  - 麦乐送：delivery-query-stores（需addressId）
   *  取距离最近且当前营业的 1 家门店。
   *
   * @param {Object} params 意图参数（原地补充 storeCode / store / beCode）
   */
  async resolveStore(params) {
    if (params.storeCode) return params.store;

    const beType = params.beType ?? BE_TYPE.IN_STORE;

    // 外送：需先取地址再查可配送门店
    if (beType === BE_TYPE.DELIVERY || beType === BE_TYPE.GROUP_MEAL) {
      let addressId = params.addressId;
      if (!addressId) {
        const addresses = await this.safeCall(() => this.tools.queryDeliveryAddresses(), null);
        const first = Array.isArray(addresses?.data) ? addresses.data[0] : null;
        addressId = first ? String(first.addressId ?? first.id ?? '') : null;
        if (addressId) params.addressId = addressId;
      }
      if (!addressId) return null;

      const payload = await this.safeCall(
        () => this.tools.queryDeliveryStores({ addressId, beType }),
        null
      );
      const store = pickNearestStore(payload);
      if (store) Object.assign(params, { storeCode: store.storeCode, beCode: store.beCode, store });
      return params.store ?? null;
    }

    // 到店 / 得来速：按城市 + 关键词搜索
    if (!params.city && !params.address) return null;

    const payload = await this.safeCall(
      () => this.tools.queryNearbyStores({
        beType, searchType: 2, city: params.city, keyword: params.address ?? params.city
      }),
      null
    );
    const store = pickNearestStore(payload);
    if (store) Object.assign(params, { storeCode: store.storeCode, beCode: store.beCode, store });
    return params.store ?? null;
  }

  /**
   * 确保会话处于可接收新输入的状态
   * planReady / ordered / error 等状态需先复位，避免跨状态非法跳转
   */
  ensureAcceptingInput() {
    // 引导问卷进行中：不复位，让用户继续作答
    if (this.session.state === STATE.GUIDED_ASKING && this.session.wizard) {
      return;
    }
    if (this.session.state !== STATE.INIT) {
      logger.info('FLOW', `新请求到达，复位会话（原状态 ${this.session.state}）`);
      this.session.reset();
    }
  }

  /** 安全调用：失败不中断主流程 */
  async safeCall(fn, fallback = null) {
    try {
      return await fn();
    } catch (err) {
      logger.warn('FLOW', '可选能力降级', err.message);
      return fallback;
    }
  }

  /** 构造方案展示文案 */
  buildPlanMessage(matched, plans) {
    const lines = [];
    if (matched.length) {
      lines.push(`已匹配：${matched.map((m) => `${m.name}（${formatYuan(m.price)}）`).join('、')}`);
    }

    plans.forEach((p, i) => {
      const price = typeof p.finalPrice === 'number' ? formatYuan(p.finalPrice) : '计算中';
      const origin = typeof p.originalPrice === 'number' ? formatYuan(p.originalPrice) : '—';
      lines.push(
        `\n【方案${i + 1}】${p.channelLabel ?? ''}${p.planName}\n` +
        `  到手价 ${price}（原价 ${origin}，省 ${formatYuan(p.discountAmount ?? 0)}）` +
        (p.withCard?.enabled ? '，含随单购卡' : '') +
        (p.tags?.length ? `\n  标签：${p.tags.join('、')}` : '')
      );
    });

    return lines.join('\n');
  }
}

/** 选取距离最近且当前营业的门店（营业状态缺失时按距离排序） */
function pickNearestStore(payload) {
  const list = payload?.data;
  if (!Array.isArray(list) || !list.length) return null;
  const open = list.filter((s) => s.businessStatus !== false);
  const pool = open.length ? open : list;
  return [...pool].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
}

/** 友好错误提示（§5.2） */
function friendlyError(err) {
  const code = err?.code;
  if (code === 401) return 'MCP Token 无效或已过期，请检查 MCP 配置后重试';
  if (code === 429) return '请求过于频繁，已触发限流，请稍后重试';
  if (code === 400) return `参数有误：${err.message}`;
  return `执行失败：${err.message}。已返回当前可用的结果，建议稍后重试`;
}

export default SaverPlanner;
