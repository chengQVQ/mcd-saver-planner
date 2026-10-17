/**
 * 会话状态机
 *
 * 严格按状态流转执行，禁止跨状态跳转（§10）：
 *
 *  init → intentRecognizing → calculating → planReady → orderConfirming → ordering → ordered
 *                    ↓paramMissing ↑          ↓error ↑        ↓取消
 */

export const STATE = {
  INIT: 'init',
  INTENT_RECOGNIZING: 'intentRecognizing',
  PARAM_MISSING: 'paramMissing',
  CALCULATING: 'calculating',
  PLAN_READY: 'planReady',
  ORDER_CONFIRMING: 'orderConfirming',
  ORDERING: 'ordering',
  ORDERED: 'ordered',
  ERROR: 'error'
};

/** 状态转移表：key = `${from}:${event}` → to */
const TRANSITIONS = {
  [`${STATE.INIT}:userInput`]: STATE.INTENT_RECOGNIZING,
  [`${STATE.INTENT_RECOGNIZING}:paramsComplete`]: STATE.CALCULATING,
  [`${STATE.INTENT_RECOGNIZING}:paramsMissing`]: STATE.PARAM_MISSING,
  [`${STATE.PARAM_MISSING}:paramsComplete`]: STATE.CALCULATING,
  [`${STATE.PARAM_MISSING}:userInput`]: STATE.INTENT_RECOGNIZING,
  [`${STATE.CALCULATING}:success`]: STATE.PLAN_READY,
  [`${STATE.CALCULATING}:failure`]: STATE.ERROR,
  [`${STATE.PLAN_READY}:selectPlan`]: STATE.ORDER_CONFIRMING,
  [`${STATE.PLAN_READY}:adjust`]: STATE.CALCULATING,
  [`${STATE.ORDER_CONFIRMING}:confirm`]: STATE.ORDERING,
  [`${STATE.ORDER_CONFIRMING}:cancel`]: STATE.PLAN_READY,
  [`${STATE.ORDERING}:success`]: STATE.ORDERED,
  [`${STATE.ORDERING}:failure`]: STATE.ORDER_CONFIRMING,
  [`${STATE.ORDERED}:queryOrder`]: STATE.ORDERED,
  [`${STATE.ERROR}:retry`]: STATE.INIT,
  [`${STATE.ORDERED}:newRequest`]: STATE.INIT,
  [`${STATE.PLAN_READY}:newRequest`]: STATE.INIT,
  [`${STATE.PARAM_MISSING}:timeout`]: STATE.INIT
};

import logger from '../utils/logger.js';

/**
 * 会话上下文（§8.4）
 */
export class SessionContext {
  constructor(sessionId = `sess_${Date.now()}`) {
    this.sessionId = sessionId;
    this.state = STATE.INIT;
    this.intent = null;
    this.params = {};
    this.cachedData = {};
    this.plans = [];
    this.selectedPlanId = null;
    this.currentOrder = null;
    this.errorMsg = null;
  }

  /**
   * 触发状态转移
   * @param {string} event 触发事件
   * @returns {string} 新状态
   * @throws {Error} 非法转移
   */
  transition(event) {
    const key = `${this.state}:${event}`;
    const next = TRANSITIONS[key];
    if (!next) {
      throw new Error(`非法状态转移：${this.state} --${event}--> （无定义）`);
    }
    const from = this.state;
    this.state = next;
    loggerState(from, next, event);
    return next;
  }

  /** 重置会话 */
  reset() {
    this.state = STATE.INIT;
    this.intent = null;
    this.params = {};
    this.plans = [];
    this.selectedPlanId = null;
    this.currentOrder = null;
    this.errorMsg = null;
  }

  /** 选中方案 */
  selectPlan(planId) {
    const plan = this.plans.find((p) => p.id === planId);
    if (!plan) throw new Error(`方案不存在：${planId}`);
    this.selectedPlanId = planId;
    return plan;
  }

  /** 获取选中方案 */
  get selectedPlan() {
    return this.plans.find((p) => p.id === this.selectedPlanId) ?? null;
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      intent: this.intent,
      params: this.params,
      plans: this.plans.length,
      selectedPlanId: this.selectedPlanId,
      currentOrder: this.currentOrder,
      errorMsg: this.errorMsg
    };
  }
}

function loggerState(from, to, event) {
  logger.info('FLOW', `${from} --${event}--> ${to}`);
}

export default SessionContext;
