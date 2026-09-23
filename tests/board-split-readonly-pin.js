'use strict';

// Companion to the retired tree's tests/board-split-readonly-pin.js (see
// docs/design/PARALLEL-STRUCTURE.md section 6.1 / T4, and agent-coord key
// claim/hunter-1-6f84bf9b/board-split-t4-lite).
//
// Root cause: src/lib/state-store.js resolves its durable-state database
// path relative to __dirname (repo-root-relative), unless TOOLSENABLED_STATE_PATH
// is set. That is fine for a session rooted in THIS tree today -- __dirname
// already resolves here -- but it is a trap for tomorrow: any worktree
// (`git worktree add`) cut from this HEAD inherits an identical .mcp.json
// with a repo-root-relative toolsenabled-readonly declaration, and would
// silently mint its OWN local board sharing zero keys with this one, exactly
// the defect measured for the retired tree today (key-set intersection 0).
//
// This guard pins the machine-wide declaration contract from T4:
// toolsenabled-readonly must declare an EXPLICIT, ABSOLUTE
// TOOLSENABLED_STATE_PATH pointing at the installation's selected state file.
// The per-installation .mcp.json is represented by an owned fixture below, so
// a published source checkout does not need an operator's live client file.
//
// KNOWN LIMIT -- do not mistake this test passing for "the board is not split".
// It reads ONE isolated declaration and asserts on its TEXT. It cannot
// see, and therefore cannot fail for:
//   * another tree's .mcp.json (the retired tree, or any other project that
//     declares a toolsenabled server -- one such config was found pointing at
//     the retired tree's schema-18 database);
//   * the USER-scope server in ~/.claude.json, which every session gets;
//   * whether two servers actually agree at runtime (no round trip here);
//   * a RUNNING server started before a config change -- an MCP server never
//     re-reads .mcp.json, so it keeps serving the old tree until its session
//     restarts. That is how the split survived being "fixed": this test was
//     green the whole time.
// tools/check-memory-board-unity.js covers those cases: it resolves each
// configured server's database by running that server's own code in that
// server's environment, writes a probe through the writable server and reads it
// back through the readonly one, and reports stale live processes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activate } = require('./lib/isolated-environment');

const ROOT = path.resolve(__dirname, '..');
activate('board-split-readonly-pin');
const FIXTURE_ROOT = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'board-pin-fixture-'));
const MCP_JSON = path.join(FIXTURE_ROOT, '.mcp.json');
const EXPECTED_STATE_PATH = path.join(FIXTURE_ROOT, 'state', 'toolsenabled.sqlite3');
fs.mkdirSync(path.dirname(EXPECTED_STATE_PATH), { recursive: true });
fs.writeFileSync(EXPECTED_STATE_PATH, 'fixture board\n', 'utf8');
fs.writeFileSync(MCP_JSON, JSON.stringify({
  mcpServers: {
    'toolsenabled-readonly': {
      command: 'node',
      args: [path.join(ROOT, 'src', 'mcp-server.js')],
      env: { TOOLSENABLED_STATE_PATH: EXPECTED_STATE_PATH }
    }
  }
}, null, 2), 'utf8');
process.once('exit', () => {
  try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* isolated cleanup */ }
});

function run() {
  const parsed = JSON.parse(fs.readFileSync(MCP_JSON, 'utf8'));
  const entry = parsed.mcpServers && parsed.mcpServers['toolsenabled-readonly'];
  assert.ok(entry, 'toolsenabled-readonly must still be declared in .mcp.json');

  const pinned = entry.env && entry.env.TOOLSENABLED_STATE_PATH;
  assert.ok(typeof pinned === 'string' && pinned.length > 0,
    'toolsenabled-readonly must declare an explicit TOOLSENABLED_STATE_PATH so a future ' +
    'worktree inherits a pin instead of a repo-root-relative default (the exact defect ' +
    'measured against the retired tree -- see docs/design/PARALLEL-STRUCTURE.md section 6.1)');
  assert.ok(path.isAbsolute(pinned), `TOOLSENABLED_STATE_PATH must be absolute, got: ${pinned}`);
  assert.equal(path.resolve(pinned).toLowerCase(), path.resolve(EXPECTED_STATE_PATH).toLowerCase(),
    `TOOLSENABLED_STATE_PATH must point at the selected installation state file. ` +
    `Expected ${EXPECTED_STATE_PATH}, got ${pinned}`);
  assert.ok(fs.existsSync(pinned), `pinned state file does not exist on disk: ${pinned}`);

  console.log('board-split-readonly-pin: toolsenabled-readonly.env.TOOLSENABLED_STATE_PATH pinned to', pinned, '-- OK');
  console.log('board-split-readonly-pin tests passed.');
}

run();
