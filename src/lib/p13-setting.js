'use strict';
const SETTING_ID = 'tools.policy_enforcement';
function p13Setting({ loadSettings, env = process.env } = {}) {
  // Preserve explicit operator/test launch pins. The app stamps its own value
  // at startup and after a user change, before launching any new helper.
  if (env.TOOLSENABLED_P13_POLICY_ENFORCE === '1') return true;
  if (env.TOOLSENABLED_P13_POLICY_ENFORCE === '0') return false;
  try {
    const settings = (loadSettings || require('./settings').loadSettings)({ env });
    return settings?.values?.[SETTING_ID] === true && ['user', 'installer'].includes(settings?.provenance?.[SETTING_ID]?.source);
  } catch { return false; }
}
function launcherEnvironment(options = {}) { return { TOOLSENABLED_P13_POLICY_ENFORCE: p13Setting(options) ? '1' : '0' }; }
module.exports = Object.freeze({ SETTING_ID, p13Setting, launcherEnvironment });
