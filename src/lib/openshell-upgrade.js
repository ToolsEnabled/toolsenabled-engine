'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function upgrade(binDir, argv) {
  if (process.platform !== 'linux' || process.env.OPENSHELL_SANDBOX !== '1') {
    throw Object.assign(new Error('TARGET: run upgrade inside your Linux OpenShell sandbox.'), { code: 'TARGET' });
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--archive', '--sha256', '--previous-archive', '--previous-sha256'].includes(flag) || options[flag] !== undefined || !value || value.startsWith('-')) {
      throw Object.assign(new Error('Use: toolsenabled upgrade --archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256'), { code: 'INSTALL' });
    }
    options[flag] = value;
  }
  if (!path.isAbsolute(options['--archive'] || '') || !/^[a-f0-9]{64}$/.test(options['--sha256'] || '')) {
    throw Object.assign(new Error('INTEGRITY: an absolute archive and independently published SHA-256 are required.'), { code: 'INTEGRITY' });
  }
  const previous = [];
  if (options['--previous-archive'] !== undefined || options['--previous-sha256'] !== undefined) {
    if (!path.isAbsolute(options['--previous-archive'] || '') || !/^[a-f0-9]{64}$/.test(options['--previous-sha256'] || '')) {
      throw Object.assign(new Error('INTEGRITY: previous archive and independent release digest must be supplied together.'), { code: 'INTEGRITY' });
    }
    previous.push('--previous-archive', options['--previous-archive'], '--previous-sha256', options['--previous-sha256']);
  }
  const { prefix } = require('./openshell-install-lifecycle').installedManifest(binDir);
  const driver = path.join(binDir, '../libexec/fleet_upgrade.py');
  // The installed bootstrap verifies/extracts NEW bytes outside the moving
  // prefix. Its staged transaction driver owns serialization and recovery.
  const result = spawnSync('/usr/bin/python3', ['-B', driver, '--prefix', prefix,
    '--archive', options['--archive'], '--sha256', options['--sha256'], ...previous], { stdio: 'inherit', env: process.env });
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    throw Object.assign(new Error('OUTCOME_UNCERTAIN: upgrade did not settle; retain the archive and any reported stage/journal.'), { code: 'OUTCOME_UNCERTAIN' });
  }
  return result.status;
}

module.exports = Object.freeze({ upgrade });
