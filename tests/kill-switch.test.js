'use strict';

// Direct contract tests for src/lib/kill-switch.js. Each case uses a fresh
// path below os.tmpdir(), never the repository's real KILLSWITCH file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-kill-switch-'));
const originalPath = process.env.TOOLSENABLED_KILLSWITCH_PATH;
const killSwitch = require('../src/lib/kill-switch.js');

try {
  const killFile = path.join(root, 'KILLSWITCH');
  process.env.TOOLSENABLED_KILLSWITCH_PATH = killFile;

  assert.deepEqual(killSwitch.status(), { active: false, path: killFile },
    'an absent marker must be reported as inactive at the configured path');

  fs.writeFileSync(killFile, 'stale marker that must not survive\n', 'utf8');
  const activated = killSwitch.activate();
  assert.deepEqual(activated, { active: true, path: killFile },
    'activation must report that the marker it wrote is active');
  const marker = fs.readFileSync(killFile, 'utf8');
  assert.match(marker, /^ToolsEnabled kill switch activated \d{4}-\d{2}-\d{2}T.*Z\n$/,
    'activation must replace stale contents with a timestamped marker');
  assert.doesNotMatch(marker, /stale marker/,
    'activation must overwrite rather than append to an existing marker');

  const deactivated = killSwitch.deactivate();
  assert.deepEqual(deactivated, { active: false, path: killFile },
    'deactivation must report that the marker it removed is inactive');
  assert.equal(fs.existsSync(killFile), false, 'deactivation must remove the marker');
  assert.deepEqual(killSwitch.deactivate(), { active: false, path: killFile },
    'deactivation must remain safely idempotent when the marker is absent');

  const missingParentFile = path.join(root, 'missing-parent', 'KILLSWITCH');
  process.env.TOOLSENABLED_KILLSWITCH_PATH = missingParentFile;
  assert.throws(() => killSwitch.activate(), error => error && error.code === 'ENOENT',
    'a marker write failure must throw rather than return a successful status');

  const directoryMarker = path.join(root, 'directory-marker');
  fs.mkdirSync(directoryMarker);
  process.env.TOOLSENABLED_KILLSWITCH_PATH = directoryMarker;
  assert.throws(() => killSwitch.deactivate(),
    'a marker removal failure must throw rather than report successful deactivation');

  console.log('kill-switch direct contract tests passed');
} finally {
  if (originalPath === undefined) delete process.env.TOOLSENABLED_KILLSWITCH_PATH;
  else process.env.TOOLSENABLED_KILLSWITCH_PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
}
