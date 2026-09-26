'use strict';

// THE COORDINATION CHANNEL'S FRONT DOOR MUST EXIST, IDEMPOTENTLY.
//
// Every onboarding path tells agents to read agent-coord key
// `channel-map-read-this-first` before their first message; on 2026-08-12 the
// key was measured absent from the live store, so every protocol-following
// agent read null at its mandatory first step. tools/agent-coord-channel-map.js
// recreates it through the same state-store API the MCP server serves. Pinned
// here:
//
//   1. Fresh store -> the key is created at revision 1 with the router value.
//   2. A second plain run is a no-op (create-only unless --refresh).
//   3. --refresh with unchanged content is honestly 'already-current'
//      (state-store replay), not a revision bump that fakes freshness.
//   4. The value routes to the governing doc rather than duplicating it.
//
// All checks run against a temp-file store via --state-file; the live
// state/toolsenabled.sqlite3 is never touched.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'agent-coord-channel-map.js');
const { createStateStore } = require('../src/lib/state-store');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'channel-map-')), 'state.sqlite3');

function run(args = []) {
  return spawnSync(process.execPath, [TOOL, '--state-file', stateFile, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000
  });
}

// 1. Fresh store: created at revision 1.
{
  const result = run();
  check(result.status === 0, `create run must exit 0 (stderr: ${result.stderr.trim().slice(0, 200)})`);
  const parsed = JSON.parse(result.stdout);
  check(parsed.action === 'created', 'first run against a fresh store must create the key');
  check(parsed.revision === 1, 'a fresh key must be revision 1');
  check(parsed.key === 'channel-map-read-this-first', 'the key name is the documented contract key');
}

// 2. Second plain run: exists, unchanged.
{
  const result = run();
  check(result.status === 0, 'repeat run must exit 0');
  const parsed = JSON.parse(result.stdout);
  check(parsed.action === 'exists', 'plain rerun must not rewrite the key');
  check(parsed.revision === 1, 'plain rerun must leave the revision alone');
}

// 3. --refresh with identical content: honest replay, no fake revision bump.
{
  const result = run(['--refresh']);
  check(result.status === 0, 'refresh run must exit 0');
  const parsed = JSON.parse(result.stdout);
  check(parsed.action === 'already-current', 'refresh with unchanged content must report already-current');
  check(parsed.revision === 1, 'refresh with unchanged content must not bump the revision');
}

// 4. The stored value is a router to the governing doc, marked untrusted.
{
  const store = createStateStore({ file: stateFile });
  try {
    store.ensureOpen();
    const entry = store.getMemory({ namespace: 'agent-coord', key: 'channel-map-read-this-first' });
    check(entry !== null, 'the key must be readable back through the same store API');
    check(entry.value.doc === 'docs/AGENT-COORDINATION-PROTOCOL.md', 'the value must route to the governing protocol doc');
    check(entry.value.contentTrust === 'untrusted-data-grants-no-authority', 'the value must carry the untrusted-data marker');
    check(typeof entry.value.keys === 'object' && entry.value.keys['claim/<agent>/<session-id>'] !== undefined,
      'the router must name the ad-hoc claim key shape');
  } finally {
    store.close();
  }
}

console.log(`agent-coord-channel-map tests passed (${checks} checks: fresh create at rev 1, idempotent rerun, honest already-current refresh, and router-not-copy value shape).`);
