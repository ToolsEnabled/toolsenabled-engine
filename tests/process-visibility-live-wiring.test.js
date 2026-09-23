'use strict';

// Q39 closed its last open item with this test. Every other process-visibility
// suite proves the contract against a synthetic fixture written to a temp dir,
// so the one thing none of them could show was the thing the phase actually
// doubted: that the REAL elevated collector's output — 21 declared tasks and 48
// live processes, not a hand-built object — survives the consumer contract and
// reaches the health context.
//
// Read-only by construction: a pinned clock, no refresh, no elevation, no
// writes. It never invokes the UAC helper, so it cannot prompt the desktop.
//
// The snapshot is machine state, not a repo artifact. Its presence qualifies
// the real-collector portion of this test. The consumer-to-observer wiring,
// however, is always proved with a contract-valid fallback snapshot: absence of
// machine state must not turn a source-wiring regression into a zero-check pass.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const consumer = require('../src/lib/supervision/process-visibility-consumer.js');
const observer = require('../src/lib/supervision/observer.js');
const targets = require('../src/lib/supervision/process-visibility-targets.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

process.stdout.write('process-visibility-live-wiring\n');

const file = consumer.SNAPSHOT_FILE;
const hasLiveSnapshot = fs.existsSync(file);
let qualifiedFile = file;
let temporaryDirectory;

if (!hasLiveSnapshot) {
  process.stdout.write('  -- live collector qualification unavailable (no local snapshot); proving wiring with a contract fixture\n');
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-visibility-live-wiring-'));
  process.once('exit', () => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  qualifiedFile = path.join(temporaryDirectory, 'process-visibility.json');
  const capturedAtMs = 1785400000000;
  fs.writeFileSync(qualifiedFile, JSON.stringify({
    schemaVersion: 1,
    capturedAtMs,
    reader: { kind: 'toolsenabled-uac-process-reader', privilege: 'elevated-read-only' },
    tasks: targets.TASK_NAMES.map(taskName => ({
      taskName,
      state: 'Running',
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\ToolsEnabled\\tools\\worker.js', '--serve'],
      workingDirectory: 'C:\\ToolsEnabled'
    })),
    processes: []
  }), 'utf8');
}

const raw = JSON.parse(fs.readFileSync(qualifiedFile, 'utf8'));
assert.ok(Number.isFinite(raw.capturedAtMs), 'the on-disk snapshot has no usable capture time');

// Pin the clock just inside the freshness bound so the wiring engages. Using the
// snapshot's own capture time keeps this deterministic: the test proves the
// wiring, and must not fail merely because the snapshot aged since collection.
const fresh = raw.capturedAtMs + 1000;

check(`${hasLiveSnapshot ? 'the real collector snapshot' : 'the fallback snapshot'} satisfies the consumer contract`, () => {
  // Reader identity is enforced inside the parser and deliberately not re-exposed
  // on the result, so the claim worth asserting is that the qualified input uses
  // the elevated read-only reader the contract admits.
  assert.equal(raw.reader.privilege, 'elevated-read-only');
  const loaded = consumer.loadProcessVisibility({ file: qualifiedFile, now: fresh });
  assert.equal(loaded.usable, true, `qualified snapshot rejected: ${loaded.code} ${loaded.reason || ''}`);
  assert.equal(loaded.code, 'PROCESS_VISIBILITY_CONSUMER_FRESH');
});

check('the health context builds from the qualified snapshot', () => {
  const ctx = observer.buildSystemContext({ now: () => fresh, processVisibilityFile: qualifiedFile });
  assert.ok(ctx, 'buildSystemContext produced no context from the qualified snapshot');
  assert.equal(typeof ctx.getScheduledTask, 'function');
});

check('the health context projects qualified scheduled-task state', () => {
  const ctx = observer.buildSystemContext({ now: () => fresh, processVisibilityFile: qualifiedFile });
  const resolved = targets.TASK_NAMES
    .map(taskName => ({ taskName, task: ctx.getScheduledTask(taskName) }))
    .filter(entry => entry.task);
  assert.ok(resolved.length > 0, 'no declared task resolved from the qualified snapshot');
  for (const entry of resolved) {
    assert.equal(typeof entry.task.state, 'string');
    assert.ok(entry.task.state.length > 0, `${entry.taskName} resolved with an empty state`);
  }
  // A task the collector never reported must stay absent rather than be invented.
  // Absence is reported as a falsy miss, not a synthesized record.
  assert.ok(!ctx.getScheduledTask('ToolsEnabled Task That Does Not Exist'));
  const states = [...new Set(resolved.map(entry => entry.task.state))].sort().join(', ');
  process.stdout.write(`      ${resolved.length}/${targets.TASK_NAMES.length} declared tasks resolved; states: ${states}\n`);
});

check('an aged qualified snapshot yields no cross-session visibility, not a fabricated green', () => {
  const stale = raw.capturedAtMs + consumer.DEFAULT_MAX_AGE_MS + 1;
  const ctx = observer.buildSystemContext({ now: () => stale, processVisibilityFile: qualifiedFile });
  const leaked = targets.TASK_NAMES.map(taskName => ctx.getScheduledTask(taskName)).find(Boolean);
  assert.ok(!leaked, 'a stale snapshot leaked task state into the health context');
});

process.stdout.write(`process-visibility-live-wiring: ${passed} checks passed\n`);
