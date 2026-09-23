'use strict';

/* THE OWNER'S SWITCH FOR EDITING THE PRODUCT'S OWN SOURCE IN A CHECKOUT.
 *
 * Read by src/lib/providers/host-control.js before it refuses a write to a
 * product code folder (src, shell, bin, tools, scripts, sidecars, packages,
 * captures, scratch, tmp) inside a ToolsEnabled checkout. It decides nothing
 * else: the running installation and the integrity anchors stay refused in
 * host-control.js whatever this answers.
 *
 * Same shape and same provenance rule as src/lib/outside-control.js: only a
 * `true` the person chose in their own settings file (user or installer
 * provenance) counts. A flipped registry default or a value nobody chose keeps
 * the fence shut, and every failure to read is "off" with the reason named.
 *
 *   reason  'off'                 the value is not exactly true
 *           'not-chosen'          true, but nobody chose it (default provenance)
 *           'not-declared'        the registry has no such row
 *           'settings-unreadable' the settings layer threw
 *           'chosen'              on, with the choosing source named
 */
const SETTING_ID = 'agent.product_source_writes';
const CHOOSING_PROVENANCE = Object.freeze(['user', 'installer']);

function closed(reason, extra = {}) {
  return Object.freeze({ enabled: false, settingId: SETTING_ID, reason, ...extra });
}

function productSourceWritesPolicy({ loadSettings: loadSettingsImpl } = {}) {
  let settings;
  try {
    settings = (loadSettingsImpl || require('./settings').loadSettings)();
  } catch (error) {
    return closed('settings-unreadable', { detail: error && error.message ? error.message : String(error) });
  }
  const values = settings && settings.values;
  if (!values || !Object.prototype.hasOwnProperty.call(values, SETTING_ID)) return closed('not-declared');
  if (values[SETTING_ID] !== true) return closed('off');
  const recorded = settings.provenance ? settings.provenance[SETTING_ID] : null;
  const source = recorded && typeof recorded.source === 'string' ? recorded.source : 'default';
  if (!CHOOSING_PROVENANCE.includes(source)) return closed('not-chosen', { source });
  return Object.freeze({ enabled: true, settingId: SETTING_ID, reason: 'chosen', source });
}

module.exports = { SETTING_ID, CHOOSING_PROVENANCE, productSourceWritesPolicy };
