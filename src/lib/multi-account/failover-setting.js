'use strict';
/* THE READER FOR `accounts.failover`, WHICH THE CATALOGUE HAS NAMED SINCE THE
 * ROW WAS WRITTEN AND WHICH DID NOT EXIST.
 *
 * MEASURED 2026-09-03 on this tree. `config/settings-registry.json` declares
 * `accounts.failover` with `enforcedBy: "src/lib/multi-account/rotation.js"`,
 * and the string `accounts.failover` appears in no .js, .mjs, .cjs or .ps1 file
 * outside node_modules -- rotation.js included. rotation.js mentions "the
 * settings row's own words" twice in its header and never asks what the row
 * says. The only production caller, shell/main.cjs resolveSessionAccount(),
 * passes `selectionMode` off the ACCOUNT REGISTRY and never passes `mode`, so
 * the `legacy` slot in rotation's precedence had no production caller either.
 * A person who moved this control changed nothing, and `tools/settings-set.js
 * --list` told them it was enforced.
 *
 * THE ROW ALSO MISREPORTED THE VALUE IN FORCE. It shipped `default: "manual"`
 * -- "stop and let me switch" -- while `DEFAULT_SELECTION_MODE` in
 * ./selection-modes.js is `MODE.PRIORITY`, the walk. The owner changed the
 * shipped behaviour to the walk on 2026-09-02 ("a person who had added and
 * signed in a second account found it never used") and the row was not
 * changed with it, so it named the wrong answer as well as failing to change
 * one. The default is now `"auto"`, which is what the product does.
 *
 * THE RULE FOR READING IT is the one src/lib/outside-control.js and
 * src/lib/policy.js already apply, and it is here for the same reason: the
 * value must be one of the row's own choices AND classified in the person's
 * own settings file with `user` or `installer` provenance. A registry default,
 * a flipped default, an unreadable settings file and a value nobody chose all
 * answer `chosen: false`, which leaves whatever the product did before this
 * module existed exactly where it was. That is what makes wiring this row safe
 * to land: it can only move behaviour for someone who went and moved it.
 *
 * NEVER THROWS. Every failure to read is an unchosen answer with the reason
 * named, because a settings file is not allowed to stop an agent starting --
 * see rotation.js property 1.
 */

const SETTING_ID = 'accounts.failover';

/* The row's own two options, read as the row's, not restated as behaviour:
   turning them into a selection mode is rotation.js's job and stays there. */
const CHOICES = Object.freeze(['manual', 'auto']);

/* A value nobody chose cannot decide anything. */
const CHOOSING_PROVENANCE = Object.freeze(['user', 'installer']);

function unchosen(reason, extra = {}) {
  return Object.freeze({ chosen: false, settingId: SETTING_ID, value: null, reason, ...extra });
}

/**
 * What the person chose on the `accounts.failover` row, if anything.
 *
 *   reason  'not-declared'        the registry has no such row
 *           'not-a-choice'        the stored value is not one of CHOICES
 *           'not-chosen'          a valid value nobody chose (default provenance)
 *           'settings-unreadable' the settings layer threw
 *           'chosen'              chosen, with the choosing source named
 */
function failoverChoice({ loadSettings: loadSettingsImpl } = {}) {
  let settings;
  try {
    settings = (loadSettingsImpl || require('../settings').loadSettings)();
  } catch (error) {
    // A diagnostic must not turn an unreadable setting into a failed start.
    // Read once, contain accessors, and describe opaque failures by type.
    let detail = `Settings could not be read (${error === null ? 'null' : typeof error} thrown).`;
    try {
      const message = error?.message;
      if (typeof message === 'string' && message) detail = message;
    } catch { /* Retain the named unreadable result when no reason is readable. */ }
    return unchosen('settings-unreadable', { detail });
  }
  const values = settings && settings.values;
  if (!values || !Object.prototype.hasOwnProperty.call(values, SETTING_ID)) return unchosen('not-declared');
  const stored = values[SETTING_ID];
  if (!CHOICES.includes(stored)) return unchosen('not-a-choice', { stored });
  const recorded = settings.provenance ? settings.provenance[SETTING_ID] : null;
  const source = recorded && typeof recorded.source === 'string' ? recorded.source : 'default';
  if (!CHOOSING_PROVENANCE.includes(source)) return unchosen('not-chosen', { source });
  return Object.freeze({ chosen: true, settingId: SETTING_ID, value: stored, reason: 'chosen', source });
}

module.exports = Object.freeze({
  CHOICES,
  CHOOSING_PROVENANCE,
  SETTING_ID,
  failoverChoice
});
