'use strict';

// Q51 package-owned runner. Each audit suite remains an isolated child so its
// temporary ledger and projection state cannot bleed into the next suite.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/audit-fresh-install.js',
  'tests/kernel.audit/vault-hardening.js',
  // Reading several secrets in one powershell.exe is the largest remaining
  // per-process cost once the ledger is bounded. These cases prove the batched
  // read carries the authority of N x 'get' and no more -- same denylist, same
  // access log, same not-configured distinction -- and degrades to today's
  // behaviour rather than to a guess when it cannot.
  'tests/vault-batched-read.test.js',
  'tests/kernel.audit/audit-store.js',
  'tests/kernel.audit/audit-reliability.js',
  'tests/kernel.audit/audit-concurrency.js',
  'tests/kernel.audit/audit-contention.js',
  // One record must serialize the ledger exactly once, and must still be
  // durable and projected before it answers. A future change that buys
  // throughput by answering the caller before the commit fails here.
  'tests/kernel.audit/audit-projection-batching.js',
  // Full-chain admission verification must never occupy SQLite's writer lock;
  // real hidden child processes must produce zero durability breaches.
  'tests/kernel.audit/audit-durability-multiprocess.js',
  'tests/kernel.audit/audit-legacy-scale.js',
  'tests/kernel.audit/audit-anchor-cross-process.js',
  'tests/kernel.audit/audit-ledger-vault-binding.js',
  // Bounding the live ledger means the oldest events leave, which means the
  // live chain stops starting at sequence 1 -- and front-truncation stops being
  // detected for free by the contiguity check. A signed archive boundary is what
  // replaces that. These cases are all attempts to get a boundary accepted that
  // should not be: forged, borrowed from the head-anchor domain, mutated field
  // by field, or presented with no verifying key at all.
  'tests/audit-archive-boundary.test.js',
  // The boundary only vouches for the archive's TAIL. What proves the bytes in
  // between are what was actually signed is verifyArchiveSegment() replaying
  // the exact same tamper table the live ledger is tested against, against
  // cold storage instead.
  'tests/audit-archive-segment.test.js',
  // The roll is the only operation in the audit system that DELETES evidence.
  // Ordering (archive durable before the row goes), atomicity (boundary and
  // delete commit together), and the refusals that stop a sink being stranded
  // or the ledger being emptied are all pinned here.
  'tests/audit-archive-roll.test.js',
  // Retention is the TRIGGER for the roll -- the only thing that decides an
  // event may leave. Its most important cases are the refusals: an unreadable
  // or nonsense setting must resolve to keeping everything, never to a
  // deletion nobody asked for.
  'tests/audit-retention.test.js',
  'tests/kernel.audit/audit-intent.js',
  // The durability sidecar must be able to say WHICH failure it recorded, and
  // must not report an unrecorded field as a measured zero. Wired here rather
  // than left as an orphan so tests/test-census.test.js keeps its teeth.
  'tests/audit-durability-classification-provenance.test.js',
  // Two more audit suites that reached no aggregate: the current-vs-historical
  // durability split, and the projection's total-render honesty.
  'tests/audit-durability-current-vs-historical.test.js',
  'tests/audit-projection-total-render.test.js',
  // logs/ retention. Wired here rather than left as an orphan: a retention
  // pass whose protect list is never re-proved is one refactor away from
  // deleting the evidence the audit system needs to verify itself.
  'tests/kernel.audit/audit-logs-retention.js',
  // The emergency-spool drain carries many records under one commit, because
  // one commit is one fsync. Batching an append loop is exactly the kind of
  // speed-up that can quietly trade away durability, so these cases kill a
  // drain mid-batch with a real process abort and prove what survives: no
  // partially drained records, the drain source still on disk, and a re-drain
  // that restores every record once with a contiguous, signature-valid chain.
  'tests/audit-spool-batch-durability.test.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
