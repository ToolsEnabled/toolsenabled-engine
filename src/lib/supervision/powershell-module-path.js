'use strict';

const path = require('node:path');
const { filterEnvValue } = require('../env-scrub');

const NON_PROVIDER_LAUNCH_ENV_NAMES = /^(?:NODE_OPTIONS|NODE_PATH|PYTHON.*|LD_.*|DYLD_.*|GI_TYPELIB_PATH|GIO_EXTRA_MODULES|GTK_PATH|GTK_MODULES|PSModulePath)$/i;
const POWERSHELL_SEVEN_MODULE_ROOT_PATTERNS = [
  /(?:^|[\\/])Documents[\\/]PowerShell[\\/]Modules[\\/]?$/i,
  /(?:^|[\\/])Program Files[\\/]PowerShell[\\/]Modules[\\/]?$/i,
  /[\\/]WindowsApps[\\/]Microsoft\.PowerShell_[^\\/]*[\\/]Modules[\\/]?$/i
];

function isPowerShellSevenModuleRoot(entry) {
  return typeof entry === 'string' && entry !== ''
    && POWERSHELL_SEVEN_MODULE_ROOT_PATTERNS.some(pattern => pattern.test(entry));
}

// Windows PowerShell 5.1 cannot reliably autoload modules from PowerShell 7's
// module roots. Keep the user's own WindowsPowerShell and third-party roots.
function stripPowerShellSevenModulePathEntries(environment, { platform = process.platform, childExecutable } = {}) {
  if (platform !== 'win32') return environment;
  const childName = (platform === 'win32' ? path.win32 : path).basename(String(childExecutable || ''));
  if (!/^powershell\.exe$/i.test(childName)) return environment;
  if (!NON_PROVIDER_LAUNCH_ENV_NAMES.test('PSModulePath')) {
    throw new Error('PSModulePath is no longer recognized by NON_PROVIDER_LAUNCH_ENV_NAMES; the PowerShell 7 PSModulePath scrub and that list have drifted.');
  }
  return filterEnvValue(environment, 'PSModulePath', ';', entry => !isPowerShellSevenModuleRoot(entry));
}

module.exports = Object.freeze({
  NON_PROVIDER_LAUNCH_ENV_NAMES,
  isPowerShellSevenModuleRoot,
  stripPowerShellSevenModulePathEntries
});
