'use strict';
/* OUTSIDE CONTROL: whether a program outside the desktop app may drive it.
 *
 * Owner, 2026-09-02: "the version on my computer SHOULD allow you an agent to
 * touch buttons from the outside and this should be a setting not a standard".
 * So it is a setting, `app.outside_control`, shipped OFF, and this module is
 * its one reader. The desktop shell asks outsideControlPolicy() before Electron
 * is ready and opens Chromium's DevTools protocol on the loopback address only
 * when the answer is an explicit, CHOSEN on. The rule is the one policy.js
 * applies to agent.tool_approvals, for the same reason: the value must be
 * exactly true, classified in the person's own settings file, with `user` or
 * `installer` provenance. A flipped registry default, an unreadable settings
 * file, or a value nobody chose all leave the port closed, because closed is
 * what a person who never met the setting expects, and open hands every program
 * on the computer a way to run code inside the app.
 *
 * The port is fixed rather than a second setting: one number for the person to
 * remember and for the program driving the app to use. The shell lets a port
 * named on the command line win over it, so a test can still pick its own.
 *
 * This decides nothing by itself. Nothing in the engine opens a port; the
 * desktop shell (shell/outside-control.cjs) is what turns the decision into a
 * command-line switch, and only before the app is ready. */
const SETTING_ID = 'app.outside_control';
const DEFAULT_PORT = 9223;
const ADDRESS = '127.0.0.1';
const CHOOSING_PROVENANCE = Object.freeze(['user', 'installer']);

function closed(reason, extra = {}) {
  return Object.freeze({
    enabled: false,
    settingId: SETTING_ID,
    port: DEFAULT_PORT,
    address: ADDRESS,
    reason,
    ...extra,
  });
}

/**
 * Decide whether outside control is on. Never throws: every failure to read is
 * a closed port with the reason named, so the shell can say why.
 *
 *   reason  'off'                 the value is not exactly true
 *           'not-chosen'          true, but nobody chose it (default provenance)
 *           'not-declared'        the registry has no such row
 *           'settings-unreadable' the settings layer threw
 *           'chosen'              on, with the choosing source named
 */
function outsideControlPolicy({ loadSettings: loadSettingsImpl } = {}) {
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
  return Object.freeze({
    enabled: true,
    settingId: SETTING_ID,
    port: DEFAULT_PORT,
    address: ADDRESS,
    reason: 'chosen',
    source,
  });
}

module.exports = {
  SETTING_ID,
  DEFAULT_PORT,
  ADDRESS,
  CHOOSING_PROVENANCE,
  outsideControlPolicy,
};
