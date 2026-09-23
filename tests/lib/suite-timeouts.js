'use strict';

// Per-suite timeout floors for `tests/run-isolated.js`.
//
// WHY THIS EXISTS
// ---------------
// The runner applies ONE unconditional timeout to every suite it spawns, and
// three minutes was chosen because the slowest healthy suite in the tree
// measured roughly 94 seconds. tests/cloud-mirror.test.js is the first suite
// that is both healthy and slower than that guard. Its subject IS git plumbing,
// so each block builds a throwaway repository, filters a tree, publishes to a
// real bare remote and reads it back -- deliberately, per that file's own
// header. Measured 2026-08-25 on Windows with other agents running git
// concurrently: run directly it passed 103 checks in 278 seconds, and a quieter
// run of the same file took 229. Through this runner, which adds per-file
// isolation setup and config snapshotting on top, the same suite took 431
// seconds. Under the 180-second cap the runner killed it at 181 seconds and
// reported exit 124 having printed NOTHING AT ALL -- not one of its 103 checks
// reached stdout, so the only signal a batch got was a bare timeout code that
// reads exactly like a hang.
//
// WHY A FLOOR AND NOT A REPLACEMENT
// ---------------------------------
// These numbers are measurements of what a suite costs, not preferences about
// how long a run may take. So the effective budget is the LARGER of the
// caller's timeout and the floor. Raising the cap for a batch (--timeout-ms,
// TOOLSENABLED_TEST_TIMEOUT_MS) still works and still wins; lowering it below a
// documented cost cannot manufacture a timeout for a suite already known to
// need longer. Every suite NOT named here keeps the caller's timeout exactly,
// so the default guard is unchanged for the rest of the tree and a genuine hang
// is still caught -- by the floor rather than by nothing.
//
// Keep this list narrow and keep every entry measured. A suite that is slow
// because it is broken belongs in a fix, not in this file.

const DEFAULT_TIMEOUT_MS = 180_000;

const SLOW_SUITE_FLOORS = new Map([
  ['tests/host-byte-mediation.test.js', {
    timeoutMs: 600_000,
    // All 11 real registry/file/SQLite cases passed in 193.228s on Linux
    // after the .45 census's default deadline expired at 180s. Preserve the
    // stale-write, scope retirement and crash recovery assertions and each
    // operation deadline; only the enclosing suite needs this headroom.
    reason: 'real host byte authority, stale writes, transport retirement and crash recovery; measured 193.228s healthy on Linux against a 180s default'
  }],
  ['tests/audit-identity-maintenance.test.js', {
    timeoutMs: 600_000,
    // All 39 cases passed in 216.701s on Linux during the .45 census repair,
    // after the unchanged 180s cap killed the same suite. Its repeated raw
    // file inspections must use separate processes to preserve SQLite locks.
    // Keep every operation, lock and inspection deadline inside the suite.
    reason: 'real audit history, crash recovery and separate-process file inspection; measured 216.701s healthy on Linux against a 180s default'
  }],
  ['tests/check-single-copy-work.js', {
    timeoutMs: 1_200_000,
    // 21 checks passed in531.630s on native Windows, 2026-09-08. The final
    // real-repository check alone took481.913s:465 worktrees and333 branches,
    // all in the permitted account. Disposable cases completed in49.7s.
    // Allow twice the measured healthy cost; individual Git deadlines stay.
    reason: 'real Git fixtures and complete registered-worktree/local-branch census; measured 531.630s on Windows against a 180s default'
  }],
  ['tests/research-runs-worker.test.js', {
    timeoutMs: 900_000,
    // 67 assertions passed with two native Windows cases explicitly skipped
    // in 329.779s on Linux with a real private encrypted keyring, 2026-09-08.
    // The same healthy work was killed by the 180s default. Individual runner,
    // heartbeat, cancellation and process cleanup deadlines remain intact.
    reason: 'real research commands and durable task/audit transitions; measured 329.779s through the private-keyring isolated Linux runner against a 180s default'
  }],
  ['tests/fra-byte-mediation.test.js', {
    timeoutMs: 900_000,
    // All 12 real socket/authority cases passed in 349.563s on 2026-09-08.
    // The default cap stopped the same suite after seven passing cases.
    // This preserves each operation and cleanup deadline inside the suite.
    reason: 'real FRA sockets, SQLite authority and publication/revocation races; measured 349.563s through the isolated runner against a 180s default'
  }],
  ['tests/repo-byte-transport.test.js', {
    timeoutMs: 900_000,
    // All 27 registry/owner-host cases passed in 407.330s on 2026-09-08.
    // The default cap stopped the same suite after 13 passing cases.
    // Keep a finite suite bound with room for process and filesystem load.
    reason: 'real repository byte authority, transport scope retirement and owner-host sessions; measured 407.330s through the isolated runner against a 180s default'
  }],
  ['tests/cloud-mirror.test.js', {
    timeoutMs: 900_000,
    // Roughly twice the 431-second worst run observed through this runner, not
    // that measurement rounded up. The first floor tried here was 480s, which
    // the 431s run cleared by 11% -- close enough that ordinary git contention
    // on a busier machine would have put the false timeout straight back. A
    // suite whose cost swings 229s -> 431s with load needs headroom, not a
    // tight fit, and 15 minutes still bounds a genuine hang.
    reason: 'builds throwaway git repositories and publishes to a real bare remote; measured 229s and 278s standalone and 431s through this runner, against a 180s default'
  }],
  ['tests/luna-worktree-lane.test.js', {
    timeoutMs: 600_000,
    // 39 unfiltered native PowerShell/fake-Node scenarios passed in 257.345s
    // on 2026-09-05, including all original 12s/20s cleanup bounds and the 5s
    // canonical-verifier bound. Allow more than twice that healthy cost;
    // individual workload, output and cleanup guards are not changed here.
    reason: '39 native PowerShell/fake-Node scenarios plus concurrency controls; measured 257.345s healthy through the strict runner against a 180s default'
  }],
  ['tests/servercontrol-mechanical-connect.test.js', {
    timeoutMs: 600_000,
    // Measured 2026-09-07 at 0bcb522c with the pinned state root: the file
    // exits 0 BY ITSELF in 217s (72 passed, 0 failed) and takes 204s through
    // this runner, both over the 180s default. The cost is real work, not a
    // hang: ~40 native PowerShell spawns, a 30s stop race on a live -Serve
    // loop, a 10s bind deadline, a 2s slow-peer read and a 3s silent-peer
    // budget. Under the default the runner killed a fully passing suite at
    // 180s and reported "STRICT INCOMPLETE ... ETIMEDOUT", which reads exactly
    // like a hang -- and that single false red is what kept the whole test:fra
    // step in tools/check-chain-baseline.json. Twice the healthy runner cost,
    // for the same reason as the two entries above: this suite waits on real
    // processes, so its cost swings with machine load.
    reason: 'native PowerShell serve-loop, slow-peer and silent-peer scenarios against real sockets; measured 217s standalone and 204s through this runner against a 180s default'
  }]
]);

// Use the same static invocation authority as the test census. Merely importing
// the native entry would execute it, and copying its argv into another table
// would let the enclosing budget drift when the acceptance selection changes.
function nativeAggregateMembers() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { javaScriptReferences } = require('../../tools/invocation-graph');
  const entry = path.resolve(__dirname, '../linux-native.js');
  const members = javaScriptReferences(entry, fs.readFileSync(entry, 'utf8')).files
    .filter(file => file.startsWith('tests/') && file !== 'tests/run-isolated.js');
  if (!members.length || members.includes('tests/linux-native.js')) {
    throw new Error('Linux native acceptance has an empty or recursive invocation selection');
  }
  return members;
}

// relativeFile is the repository-relative, forward-slash path the runner
// already derives for its other per-suite registries. callerTimeoutMs may be
// null only on the paths where the runner has not resolved a default yet.
function timeoutForSuite(relativeFile, callerTimeoutMs) {
  if (relativeFile === 'tests/linux-native.js') {
    // The .45 census cut this 56-suite aggregate off at 180s even though
    // audit-identity alone measured 216.701s. Preserve every member's finite
    // deadline, plus one default budget for serial launch/cleanup overhead.
    // Read the actual entry with the maintained invocation reader, without
    // executing it or copying its selection into another registry.
    const members = nativeAggregateMembers();
    return DEFAULT_TIMEOUT_MS + members.reduce((total, file) =>
      total + timeoutForSuite(file, callerTimeoutMs ?? DEFAULT_TIMEOUT_MS), 0);
  }
  const floor = SLOW_SUITE_FLOORS.get(relativeFile);
  if (!floor) return callerTimeoutMs;
  if (callerTimeoutMs == null) return floor.timeoutMs;
  return Math.max(callerTimeoutMs, floor.timeoutMs);
}

module.exports = { DEFAULT_TIMEOUT_MS, SLOW_SUITE_FLOORS, timeoutForSuite, nativeAggregateMembers };
