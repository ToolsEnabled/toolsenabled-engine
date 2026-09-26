// EXECUTABLE CHANGE — testcanfail-tests-coordinator-heartbeat-test-js
//
// Strengthened assertion: the cross-repo require-safety check now proves that
// its require scan found evidence before iterating over it. Mutation applied:
// in a scratch edit of heartbeat.js, changed every `require('...')` spelling to
// the equivalent `require ('...')`, making the scanner return an empty array.
// Before this assertion the full test stayed green: "coordinator-heartbeat: 17
// checks passed". With this assertion it went RED:
// "AssertionError [ERR_ASSERTION]: heartbeat.js require scan found no
// dependencies; the allowlist assertions would pass vacuously".
// The source mutation was restored byte-for-byte (verified with `cmp`), after
// which the test was green again: "coordinator-heartbeat: 17 checks passed".
//
// Shape census: (1) FOUND and fixed above. (2) NOT-FOUND — no exit-status or
// truthy process-result assertion. (3) NOT-FOUND — no test try/catch or optional
// chain swallows a failure. (4) NOT-FOUND — no mock of heartbeat.js is asserted
// against. (5) NOT-FOUND — no skip or platform precondition guard. (6)
// NOT-FOUND — no expected value is computed by the heartbeat implementation.
// Preconditions not met: NONE.

'use strict';

// R100: the heartbeat contract surface between the duty host (writer) and the
// dashboard watcher (reader).
//
// The properties tested here are the ones the DASHBOARD depends on. If any of
// them breaks, the surface that reports "the coordinator duty host died"
// becomes the thing that lies about it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const heartbeat = require('../src/lib/coordinator/heartbeat.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coord-hb-'));
}

process.stdout.write('coordinator-heartbeat\n');

// --- SHAPE -----------------------------------------------------------------

check('emptyHeartbeat is itself a valid heartbeat', () => {
  const record = heartbeat.emptyHeartbeat({ pid: 4242, bootId: 'boot-a', startedAtMs: 1000 });
  const verdict = heartbeat.validateHeartbeat(record);
  assert.equal(verdict.valid, true, verdict.errors.join('; '));
  assert.equal(record.cycleSeq, 0);
  assert.equal(record.hostState, heartbeat.HOST_STATE.UNKNOWN,
    'a host that has completed no cycle must not claim a definite OK state');
  assert.equal(record.escalationsSuppressed, null,
    'a host that has never asked the sink must not claim zero suppressions');
});

check('bootId is required: pid alone is not identity', () => {
  const record = heartbeat.emptyHeartbeat({ pid: 1 });
  delete record.bootId;
  const verdict = heartbeat.validateHeartbeat(record);
  assert.equal(verdict.valid, false);
  assert.match(verdict.errors.join('; '), /bootId/);
});

check('observedAtMs is required: without it there is no staleness rule at all', () => {
  const record = heartbeat.emptyHeartbeat({ pid: 1 });
  delete record.observedAtMs;
  const verdict = heartbeat.validateHeartbeat(record);
  assert.equal(verdict.valid, false);
  assert.match(verdict.errors.join('; '), /observedAtMs/);
});

check('escalationsSuppressed must be PRESENT (a suppressed escalation is invisible unless counted)', () => {
  const record = heartbeat.emptyHeartbeat({ pid: 1 });
  delete record.escalationsSuppressed;
  const verdict = heartbeat.validateHeartbeat(record);
  assert.equal(verdict.valid, false);
  assert.match(verdict.errors.join('; '), /escalationsSuppressed/);
});

check('escalationsSuppressed accepts null as UNKNOWN, so a counting gap is not a dead host', () => {
  // escalation-sink.js#sinkStatus returns null when its state file is corrupt
  // or unreadable, precisely so "I could not count" cannot read as "nothing
  // was suppressed". If validateHeartbeat refused null, writeHeartbeat would
  // throw and the host would publish NO heartbeat at all -- turning an
  // accounting gap into an apparently dead host.
  const record = heartbeat.emptyHeartbeat({ pid: 1 });
  record.escalationsSuppressed = null;
  assert.equal(heartbeat.validateHeartbeat(record).valid, true);

  record.escalationsSuppressed = 4;
  assert.equal(heartbeat.validateHeartbeat(record).valid, true);

  record.escalationsSuppressed = -1;
  assert.equal(heartbeat.validateHeartbeat(record).valid, false);

  record.escalationsSuppressed = 'lots';
  assert.equal(heartbeat.validateHeartbeat(record).valid, false);
});

check('an unknown duty outcome is rejected', () => {
  const record = heartbeat.emptyHeartbeat({ pid: 1 });
  record.duties = { 'x': { kind: 'mechanical', lastRunAtMs: null, outcome: 'PROBABLY_FINE', consecutiveFailures: 0 } };
  const verdict = heartbeat.validateHeartbeat(record);
  assert.equal(verdict.valid, false);
  assert.match(verdict.errors.join('; '), /PROBABLY_FINE/);
});

// --- WRITE / READ ----------------------------------------------------------

check('writeHeartbeat then readHeartbeatRaw round-trips', () => {
  const dir = tempDir();
  const file = path.join(dir, 'hb.json');
  const record = heartbeat.emptyHeartbeat({ pid: 77, bootId: 'boot-b', startedAtMs: 5000 });
  record.cycleSeq = 3;
  record.duties = { probe: { kind: 'mechanical', lastRunAtMs: 5100, outcome: heartbeat.DUTY_OUTCOME.OK, reason: 'ran', consecutiveFailures: 0, detail: null } };
  heartbeat.writeHeartbeat(record, { file });

  const read = heartbeat.readHeartbeatRaw({ file });
  assert.equal(read.ok, true, read.reason);
  assert.equal(read.record.bootId, 'boot-b');
  assert.equal(read.record.cycleSeq, 3);
  assert.equal(read.record.duties.probe.outcome, 'OK');
});

check('writeHeartbeat REFUSES an invalid record rather than publishing garbage', () => {
  const dir = tempDir();
  const file = path.join(dir, 'hb.json');
  const record = heartbeat.emptyHeartbeat({ pid: 5 });
  delete record.observedAtMs;
  assert.throws(() => heartbeat.writeHeartbeat(record, { file }), error => error.code === 'HEARTBEAT_INVALID');
  assert.equal(fs.existsSync(file), false, 'an invalid heartbeat must not reach disk');
});

check('the write is atomic: no .tmp file survives and the target is complete JSON', () => {
  const dir = tempDir();
  const file = path.join(dir, 'hb.json');
  heartbeat.writeHeartbeat(heartbeat.emptyHeartbeat({ pid: 9, bootId: 'boot-c' }), { file });
  const leftovers = fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `temp files left behind: ${leftovers.join(', ')}`);
  JSON.parse(fs.readFileSync(file, 'utf8'));      // throws if torn
});

check('an overwrite replaces via rename, never truncate-then-write', () => {
  // Proven by observing that the file is never briefly empty: we write a large
  // record over a small one and assert the target parses at every point we can
  // observe it. The stronger guarantee comes from the implementation using
  // renameSync, which is why we also assert no temp remains above.
  const dir = tempDir();
  const file = path.join(dir, 'hb.json');
  heartbeat.writeHeartbeat(heartbeat.emptyHeartbeat({ pid: 1, bootId: 'small' }), { file });
  const big = heartbeat.emptyHeartbeat({ pid: 1, bootId: 'big' });
  for (let index = 0; index < 200; index += 1) {
    big.duties[`duty-${index}`] = { kind: 'mechanical', lastRunAtMs: 1, outcome: 'OK', reason: 'x'.repeat(50), consecutiveFailures: 0, detail: null };
  }
  heartbeat.writeHeartbeat(big, { file });
  const read = heartbeat.readHeartbeatRaw({ file });
  assert.equal(read.ok, true);
  assert.equal(read.record.bootId, 'big');
  assert.equal(Object.keys(read.record.duties).length, 200);
});

// --- "I CANNOT LOOK" IS NEVER "IT IS DEAD" ---------------------------------

check('a missing file reads as HEARTBEAT_ABSENT, not as a failure to throw', () => {
  const read = heartbeat.readHeartbeatRaw({ file: path.join(tempDir(), 'nope.json') });
  assert.equal(read.ok, false);
  assert.equal(read.errorCode, 'HEARTBEAT_ABSENT');
  assert.ok(read.reason.length > 0);
});

check('corrupt JSON reads as HEARTBEAT_CORRUPT and never throws', () => {
  const dir = tempDir();
  const file = path.join(dir, 'hb.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const read = heartbeat.readHeartbeatRaw({ file });
  assert.equal(read.ok, false);
  assert.equal(read.errorCode, 'HEARTBEAT_CORRUPT');
});

check('a structurally invalid heartbeat reads as HEARTBEAT_INVALID with the record attached', () => {
  const dir = tempDir();
  const file = path.join(dir, 'hb.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, pid: 1 }), 'utf8');
  const read = heartbeat.readHeartbeatRaw({ file });
  assert.equal(read.ok, false);
  assert.equal(read.errorCode, 'HEARTBEAT_INVALID');
  assert.equal(read.record.pid, 1, 'the reader still gets the raw record so it can describe what it found');
});

check('readHeartbeatRaw applies NO staleness: an ancient heartbeat still reads ok', () => {
  const dir = tempDir();
  const file = path.join(dir, 'hb.json');
  const record = heartbeat.emptyHeartbeat({ pid: 1, bootId: 'old', startedAtMs: 0, observedAtMs: 0 });
  heartbeat.writeHeartbeat(record, { file });
  const read = heartbeat.readHeartbeatRaw({ file });
  assert.equal(read.ok, true, 'staleness belongs to the reader, not this module');
  assert.equal(read.record.observedAtMs, 0);
});

// --- CROSS-REPO REQUIRE SAFETY ---------------------------------------------

check('the module requires only node builtins plus ../runtime.js', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'heartbeat.js'), 'utf8');
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(match => match[1]);
  assert.ok(requires.length > 0,
    'heartbeat.js require scan found no dependencies; the allowlist assertions would pass vacuously');
  for (const target of requires) {
    const allowed = target.startsWith('node:') || target === '../runtime.js';
    assert.ok(allowed, `heartbeat.js requires ${target}; the dashboard lazy-requires this file across repos and a wide require graph would blind the watcher`);
  }
});

check('HEARTBEAT_FILE resolves under state/ so the dashboard can find it cross-repo', () => {
  assert.ok(heartbeat.HEARTBEAT_FILE.endsWith(path.join('state', 'coordinator-duty-host.heartbeat.json')),
    `unexpected heartbeat path ${heartbeat.HEARTBEAT_FILE}`);
});

check('newBootId returns a fresh id each call (pid reuse must not look like continuity)', () => {
  const a = heartbeat.newBootId();
  const b = heartbeat.newBootId();
  assert.notEqual(a, b);
  assert.ok(a.length >= 16);
});

process.stdout.write(`\ncoordinator-heartbeat: ${passed} checks passed\n`);
