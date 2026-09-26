'use strict';

// Native desktop API acceptance. The former Telegram screenshot relay was
// removed with that product; it is not a current desktop dependency. Both
// platform sets remain required by the common release contract. Running this
// entry on one OS never discharges the companion platform's acceptance.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', '..');
const suites = {
  linux: ['tests/linux-desktop.test.js', 'tests/linux-desktop-ask.test.js', 'tests/linux-desktop-temp.test.js'],
  win32: ['tests/desktop-advanced.js', 'tests/desktop-app-capture.js', 'tests/desktop-window-close-guard.js']
}[process.platform];

if (!suites || !suites.length) {
  process.stderr.write('Native desktop acceptance unsupported on this platform.\n');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [path.join(root, 'tests/run-isolated.js'), ...suites], {
    cwd: root, stdio: 'inherit', windowsHide: true, shell: false, timeout: 120_000
  });
  if (result.error) {
    process.stderr.write(`${result.error.stack || result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  }
}
