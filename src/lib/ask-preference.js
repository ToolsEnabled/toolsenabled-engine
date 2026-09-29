'use strict';

const { purchaseApprovalReserved } = require('./purchase-reservation-policy');

// The caller may offer a decision; only the person's saved preference can
// authorize using it. The permission ceiling is checked before that preference.
function decideAsk(args, target, context, options = {}) {
  const settings = (options.loadSettings || require('./settings').loadSettings)();
  if (/^(?:pay|purchase|p_ledger|payment_method)\./.test(target.name)) {
    if (purchaseApprovalReserved({ loadSettings: () => settings }).reserved) return { decision: 'ask', action: 'stop-and-wait', reason: 'purchase-reserved' };
  }
  return require('./agent-approval-policy').decideFromSettings({ tool: target.name, effect: target.effect }, settings, {
    tierCheck: context?.permissionSession ? entry => require('./permission-tier-policy').assertToolAllowed(entry, context.permissionSession) : null,
    judge: () => args.agentDecision && typeof args.agentDecision.rationale === 'string' && args.agentDecision.rationale.trim()
      ? { approve: args.agentDecision.approve === true, rationale: args.agentDecision.rationale } : null,
  });
}
module.exports = Object.freeze({ decideAsk });
