'use strict';

// Explicit live-Docker acceptance, not a hermetic test or an installer proof.
// Requires the fixed product image already built; never downloads or rebuilds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { activate } = require('./lib/isolated-environment');
assert.equal(process.platform, 'linux');
const isolated = activate('linux-sandbox-sterile-live');
const profile = path.join(isolated.root, 'fresh-user-profile');
fs.mkdirSync(profile, { mode: 0o700 });
const environment = { ...process.env, HOME: profile, USERPROFILE: profile,
  XDG_CONFIG_HOME: path.join(profile, '.config'), XDG_DATA_HOME: path.join(profile, '.local/share'),
  DOCKER_CONFIG: path.join(profile, '.docker') };
delete environment.DOCKER_HOST;
delete environment.DOCKER_CONTEXT;
const child = spawnSync(process.execPath, ['-e', `
  const assert = require('node:assert/strict');
  const sandbox = require('./src/lib/providers/agent-sandbox');
  sandbox.imageLockWrite();
  const doctor = sandbox.doctor();
  assert.equal(doctor.available, true, doctor.code);
  assert.equal(doctor.compatible, true, doctor.code);
  assert.equal(doctor.imageReady, true, doctor.imageCode);
  require('./tests/agent-sandbox-live-smoke');
`], { cwd: path.resolve(__dirname, '..'), env: environment,
  encoding: 'utf8', timeout: 180000, maxBuffer: 1048576 });
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
assert.ifError(child.error);
assert.equal(child.status, 0, 'Fresh-profile full sandbox acceptance failed');
assert.match(child.stdout, /"status":"passed"/);
assert.doesNotMatch(child.stdout, /verified fail-closed doctor outcome/);
