'use strict';

// CONCURRENT ROTATION MUST NOT DESTROY THE RETAINED GENERATION.
//
// access_log() bounds the Linux access log at 4 MiB and keeps one previous
// generation in <log>.1. os.rename replaces its destination atomically, so a
// check-then-rename with no lock lets the second logger to cross the bound
// rename the FRESH log the first one just created over the generation the
// first one just saved. The original comment there reasoned only about entry
// loss -- a writer holding the renamed inode does keep appending to it, which
// is true -- and concluded no lock was needed; that never covered the retained
// generation, which is the part a person actually reads.
//
// Measured against the unfixed code: 25 of 25 trials destroyed the generation,
// reducing 4,194,304 bytes of history to as little as 74. Under concurrency
// that was the ordinary outcome, not an unlucky interleaving -- every read verb
// ('get', 'get-many', 'list', 'exists', 'present', 'verify') logs from OUTSIDE
// the vault lock, so two concurrent reads are the whole prerequisite.
//
// THE SYNCHRONISATION IS THE TEST. An earlier version of this file released the
// loggers with a gate file they polled for; that version PASSED against the
// unfixed code, because renaming a 4 MiB file is a metadata operation that
// finished before the other loggers had even stat'ed it, so the window never
// opened and the suite proved nothing. The loggers are forked from one parent
// and released by a real multiprocessing.Barrier, which is what reproduced the
// defect 25 times out of 25. A weaker rendezvous here silently turns these
// cases back into decoration.
//
// The trial drives the real access_log() out of the shipped linux-vault.py, so
// it pins the behaviour of the code that ships rather than a transcription.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const VAULT = path.resolve(__dirname, '..', 'src', 'linux-vault.py');

const TRIAL = String.raw`
import importlib.util, json, multiprocessing as mp, os, shutil, sys, tempfile

spec = importlib.util.spec_from_file_location("linux_vault", sys.argv[1])
lv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lv)

FILL, LOGGERS, ROUNDS = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
NAME = "vault"
LOG = NAME + ".access.log"


def worker(root, barrier, rounds):
    d = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        barrier.wait()                      # every logger enters access_log together
        for _ in range(rounds):
            lv.access_log(d, NAME, "get", ["some_key"])
    finally:
        os.close(d)


def entries(p):
    if not os.path.exists(p):
        return 0
    with open(p, "rb") as fh:
        return sum(1 for line in fh if b'"action"' in line)


root = tempfile.mkdtemp(prefix="te-rotate-")
os.chmod(root, 0o700)
try:
    live = os.path.join(root, LOG)
    with open(live, "wb") as fh:
        fh.write(b"H" * FILL)
    os.chmod(live, 0o600)

    barrier = mp.Barrier(LOGGERS)
    procs = [mp.Process(target=worker, args=(root, barrier, ROUNDS)) for _ in range(LOGGERS)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(120)

    previous = live + ".1"
    print(json.dumps({
        "kept": os.path.getsize(previous) if os.path.exists(previous) else 0,
        "entries": entries(live) + entries(previous),
        "exits": [p.exitcode for p in procs],
    }))
finally:
    shutil.rmtree(root, ignore_errors=True)
`;

function trial({ fill, loggers, rounds }) {
  const run = spawnSync('python3', ['-c', TRIAL, VAULT, String(fill), String(loggers), String(rounds)],
    { encoding: 'utf8', timeout: 180000 });
  assert.equal(run.status, 0,
    `the trial harness must run for this suite to mean anything: ${run.stderr || run.error}`);
  const result = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.ok(result.exits.every((code) => code === 0),
    `every logger must exit cleanly, got ${JSON.stringify(result.exits)}`);
  return result;
}

function bound() {
  const probe = spawnSync('python3', ['-c',
    'import importlib.util,sys;s=importlib.util.spec_from_file_location("v",sys.argv[1]);'
    + 'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.ACCESS_LOG_MAX_BYTES)',
    VAULT], { encoding: 'utf8' });
  assert.equal(probe.status, 0, 'the vault module must import for this suite to mean anything');
  return Number(probe.stdout.trim());
}

if (process.platform !== 'linux') {
  test('linux access log rotation', { skip: 'Linux custody only' }, () => {});
} else {
  test('a concurrent rotation keeps the whole retained generation', () => {
    const max = bound();
    const { kept } = trial({ fill: max, loggers: 8, rounds: 1 });
    assert.ok(kept >= max,
      `the previous generation must survive concurrent rotation: kept ${kept} of ${max} bytes`);
  });

  test('every entry still lands while the log is rotating', () => {
    const max = bound();
    const loggers = 8;
    const rounds = 3;
    const { entries } = trial({ fill: max, loggers, rounds });
    assert.equal(entries, loggers * rounds,
      'rotation is best-effort, the entry is not: no logger may lose a line to a rotation');
  });

  test('ordinary logging below the bound rotates nothing', () => {
    const { kept, entries } = trial({ fill: 0, loggers: 4, rounds: 10 });
    assert.equal(kept, 0, 'nothing may be rotated while the log is under the bound');
    assert.equal(entries, 40, 'every entry must land on the ordinary path');
  });
}
