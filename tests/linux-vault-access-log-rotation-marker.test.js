'use strict';

// DISCARDING THE ACCESS LOG MUST LEAVE A MARK.
//
// access_log() bounds the Linux vault access log at 4 MiB and keeps one
// previous generation in <log>.1, so roughly 8 MiB of entries rolls the oldest
// off the end for good. Its entries carry ts, pid, action and key and NO
// sequence number, so before this there was nothing in a log that said how much
// had come before it: history could be pushed out and no reader could tell it
// had ever existed.
//
// WHO CAN PUSH IT. A confined agent cannot write the vault directory -- it is
// 0700 and the confined tier refuses host writes -- but it does not need to.
// Every read verb ('get', 'get-many', 'list', 'exists', 'present', 'verify')
// writes an entry, so calling a vault-reading tool in a loop is the whole
// prerequisite for rolling the record of what it read an hour ago out of
// existence. That is anti-forensics reachable from the narrowest tier.
//
// The bound stays -- it exists because a measured live vault was carrying tens
// of megabytes of this. What changes is that the discarding is now
// ATTRIBUTABLE: every rotated-into log opens with a marker naming the running
// total of rotations, copied forward across each one, and the bytes discarded
// by the most recent. An attacker can still roll the log; they cannot roll it
// quietly, and they cannot reset the count without writing the directory, which
// is the thing they cannot do.
//
// These cases drive the real access_log() and rotate_access_log() out of the
// shipped src/linux-vault.py, so they pin what ships rather than a
// transcription. Everything happens in a temporary directory; no real vault,
// no real access log, and no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const VAULT = path.resolve(__dirname, '..', 'src', 'linux-vault.py');

const DRIVER = String.raw`
import importlib.util, json, os, sys, tempfile

spec = importlib.util.spec_from_file_location("linux_vault", sys.argv[1])
lv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lv)

NAME = "vault"
LOG = NAME + ".access.log"
root = tempfile.mkdtemp(prefix="vault-marker-")
d = os.open(root, os.O_RDONLY | os.O_DIRECTORY)


def fill_to_bound():
    """Grow the live log to the bound the way entries do: by APPENDING.

    An earlier version of this opened the file "wb" and wrote 4 MiB of padding,
    which truncated the log and destroyed the marker sitting at its head -- so
    case 3 failed against correct code, for a reason that was purely the
    fixture's. Real traffic only ever appends, and the marker stays at line one,
    which is the whole mechanism being tested.
    """
    p = os.path.join(root, LOG)
    have = os.path.getsize(p) if os.path.exists(p) else 0
    with open(p, "ab") as handle:
        handle.write(b"x" * max(0, lv.ACCESS_LOG_MAX_BYTES - have))


def lines(name):
    p = os.path.join(root, name)
    if not os.path.exists(p):
        return []
    with open(p, "rb") as handle:
        return [l for l in handle.read().decode("utf-8", "replace").split("\n") if l]


def head(name):
    got = lines(name)
    try:
        return json.loads(got[0]) if got else None
    except Exception:
        return None


out = {}

# 1. an ordinary entry, no rotation: there must be no marker at all.
lv.access_log(d, NAME, "get", ["k0"])
out["quiet_first_action"] = (head(LOG) or {}).get("action")
out["quiet_line_count"] = len(lines(LOG))

# 2. cross the bound: the new log opens with the marker, and the entry that
#    triggered the rotation is still written after it.
fill_to_bound()
lv.access_log(d, NAME, "get", ["k1"])
first = head(LOG) or {}
out["first_marker"] = first
out["entry_survived"] = any(json.loads(l).get("key") == "k1" for l in lines(LOG))
out["generation_kept"] = os.path.getsize(os.path.join(root, LOG + ".1"))

# 3. roll again -- the rotation that DISCARDS generation 1 must carry the count.
fill_to_bound()
lv.access_log(d, NAME, "get", ["k2"])
out["second_marker"] = head(LOG) or {}

# 4. and again, to show it keeps counting rather than sticking at 2.
fill_to_bound()
lv.access_log(d, NAME, "get", ["k3"])
out["third_marker"] = head(LOG) or {}

os.close(d)
print(json.dumps(out))
`;

function run() {
  const result = spawnSync('/usr/bin/python3', ['-c', DRIVER, VAULT], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `driver failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

const observed = run();

test('the control: a log that never crossed the bound carries no marker', () => {
  // Without this, a marker written unconditionally would satisfy every case
  // below while telling a reader nothing about whether history was discarded.
  assert.equal(observed.quiet_first_action, 'get',
    'an ordinary log must begin with the ordinary entry, not with a rotation marker');
  assert.equal(observed.quiet_line_count, 1);
});

test('crossing the bound opens the new log with a marker, and costs no entry', () => {
  const marker = observed.first_marker;
  assert.equal(marker.action, 'access-log-rotated');
  assert.equal(marker.rotations, 1, 'the first rotation must be counted as the first');
  assert.ok(marker.discardedBytes >= 4 * 1024 * 1024,
    `the marker must say how much went: ${marker.discardedBytes}`);
  assert.ok(typeof marker.ts === 'string' && marker.ts.endsWith('Z'));
  // A marker that cost the entry which triggered it would be a worse trade than
  // the silence it replaces.
  assert.equal(observed.entry_survived, true,
    'the entry that crossed the bound was lost to the marker');
  assert.ok(observed.generation_kept >= 4 * 1024 * 1024,
    'the retained generation must still be retained');
});

test('the count is carried across the rotation that discards the log holding it', () => {
  // This is the whole point. Generation 1 -- which held marker #1 -- is
  // discarded by the second rotation, so a count that lived only in the file
  // being thrown away would reset to 1 and an attacker could roll for ever at
  // rotations=1. It is read forward out of the live log before the rename.
  assert.equal(observed.second_marker.action, 'access-log-rotated');
  assert.equal(observed.second_marker.rotations, 2);
  assert.equal(observed.third_marker.rotations, 3,
    'the running total must keep counting, so a reader can see how much has been discarded');
});
