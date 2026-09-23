'use strict';

// Only explicit feature switches activate optional infrastructure. Old working
// presets stamped audit.activity=Full exactly like individual choices, so that
// retained preference is never evidence that audit itself was enabled.
const IDS = Object.freeze(['audit.enabled', 'ledger.verify_history', 'audit.activity', 'agent.persistent_continuation']);
const CHOSEN = new Set(['user', 'installer']);
function resolveRuntimePolicy(settings = {}) {
  const values = settings.values || {};
  const rejected = settings.rejected || [];
  const invalid = id => rejected.some(row => row.id === '*' || row.id === id);
  const chosen = id => CHOSEN.has(settings.provenance?.[id]?.source) && !invalid(id);
  const auditEnabled = chosen('audit.enabled') && values['audit.enabled'] === true;
  const verifyHistory = chosen('ledger.verify_history') && values['ledger.verify_history'] === true;
  const activity = chosen('audit.activity') && ['Full', 'Essential', 'Off'].includes(values['audit.activity'])
    ? values['audit.activity'] : 'Off';
  const continuationEnabled = !invalid('agent.persistent_continuation')
    && (chosen('agent.persistent_continuation') ? values['agent.persistent_continuation'] === true : true);
  return Object.freeze({ auditEnabled, verifyHistory, activity: auditEnabled ? activity : 'Off',
    retainedActivity: activity, continuationEnabled,
    configurationAvailable: !rejected.some(row => row.id === '*'),
    rejected: Object.freeze(rejected.filter(row => row.id === '*' || IDS.includes(row.id)).map(row => row.id)) });
}
function runtimePolicy(options = {}) {
  const read = options.loadSettings || require('./settings').loadSettings;
  try { return resolveRuntimePolicy(read({ ...options, ids: IDS })); }
  catch { return resolveRuntimePolicy({ rejected: [{ id: '*' }] }); }
}
module.exports = Object.freeze({ IDS, resolveRuntimePolicy, runtimePolicy });
