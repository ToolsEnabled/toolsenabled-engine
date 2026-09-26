'use strict';

// A REFRESH MUST NOT STRAND EVERY OTHER NAME ON A CONSUMED TOKEN.
//
// linkCredential gives each confined home the SAME FILE as the person's sign-in:
// one inode, many names. A provider refresh rewrites through a temporary file
// and a rename, and a rename splits a hard link -- the refreshing name points at
// the new inode and every other name still points at the old one, which now
// holds a consumed refresh token.
//
// MEASURED on a development machine: the person's credential carried 9 links; a
// stranded family carried 34, of which 27 were located, last written 21 Sep.
// Nothing repaired them and nothing counted them. The danger is not the stale
// bytes: a sibling session that later presents a consumed refresh token can get
// the whole token family revoked by the provider, signing the person out
// everywhere. So the second refresh must not happen, rather than be cleaned up.
//
// EVERYTHING HERE IS A FIXTURE under $HOME (host-control fences paths to the
// owner profile tree). No real credential, agent-home or provider is touched,
// and no network call is made: `refresh` is a callback the case supplies.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const broker = require('../src/lib/credential-refresh-broker.js');

const SIGN_IN = 'auth.json';
const LIVE = '{"refresh_token":"fixture-live"}';
const NEXT = '{"refresh_token":"fixture-rotated"}';

/* The shape the product actually builds: one credential, hard-linked into
 * several confined session homes. */
function fixture({ homes = 4 } = {}) {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.te-refresh-'));
  fs.chmodSync(root, 0o700);
  const ownerDir = path.join(root, 'owner-codex');
  fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  const owner = path.join(ownerDir, SIGN_IN);
  fs.writeFileSync(owner, LIVE, { mode: 0o600 });

  const confinedRoot = path.join(root, 'agent-home');
  const names = [];
  for (let index = 0; index < homes; index += 1) {
    const home = path.join(confinedRoot, '@agents', `agent-${index}`, '@sessions', `s${index}`, 'codex', 'standard', '@default');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const name = path.join(home, SIGN_IN);
    fs.linkSync(owner, name);
    names.push(name);
  }
  return { root, owner, confinedRoot, names };
}

/* What a provider refresh actually does: write a temporary file and rename it
 * over the name being refreshed. That rename is what splits the link. */
function renameRefresh(target, bytes) {
  return () => {
    const temporary = `${target}.tmp-refresh`;
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, target);
  };
}

test('the defect: a plain refresh strands every other name on the consumed token', () => {
  const { root, owner, names } = fixture();
  try {
    const before = fs.lstatSync(owner).ino;
    // No broker. This is what happens today.
    renameRefresh(names[0], NEXT)();
    assert.notEqual(fs.lstatSync(names[0]).ino, before, 'the refreshed name moved to a new inode');
    for (const stale of names.slice(1)) {
      assert.equal(fs.lstatSync(stale).ino, before, 'every other confined name is still on the old inode');
      assert.equal(fs.readFileSync(stale, 'utf8'), LIVE, 'and still holds the consumed token');
    }
    assert.equal(fs.readFileSync(owner, 'utf8'), LIVE, 'including the person’s own file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the broker brings every confined name onto the live token', () => {
  const { root, owner, confinedRoot, names } = fixture();
  try {
    const result = broker.brokeredRefresh({
      liveCredential: names[0],
      confinedRoot,
      ownerCredential: owner,
      refresh: renameRefresh(names[0], NEXT)
    });
    assert.equal(result.refreshed, true);
    assert.equal(result.split, true, 'the rename split the link, which is the case this exists for');
    assert.equal(result.complete, true, `not complete: ${JSON.stringify(result.failed)}`);
    assert.equal(result.repointed.length, names.length - 1, 'every other confined name must be repointed');

    const live = fs.lstatSync(names[0]).ino;
    for (const name of names) {
      assert.equal(fs.lstatSync(name).ino, live, `${name} is not on the live token`);
      assert.equal(fs.readFileSync(name, 'utf8'), NEXT);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the person’s own file is reported stale, never rewritten', () => {
  const { root, owner, confinedRoot, names } = fixture();
  try {
    const ownerBefore = fs.readFileSync(owner, 'utf8');
    const result = broker.brokeredRefresh({
      liveCredential: names[0],
      confinedRoot,
      ownerCredential: owner,
      refresh: renameRefresh(names[0], NEXT)
    });
    assert.equal(result.ownerStale, true,
      'the broker must say the person’s sign-in is now on a consumed token');
    /* agent-session-confinement is explicit that their home is never written to
       -- their file, their terminal, their business -- and healing it is an
       owner decision. A broker that quietly edited the user's credential would
       be a worse defect than the one it fixes. */
    assert.equal(fs.readFileSync(owner, 'utf8'), ownerBefore,
      'the person’s own file must be left exactly as it was');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a caller holding a name that went stale does not mint a second token', () => {
  const { root, owner, confinedRoot, names } = fixture();
  try {
    /* The situation that strands tokens in practice: something refreshed WITHOUT
       the broker (today's behaviour, case 1 above), so names[1..] are now on a
       consumed token. A sibling on one of those names asks to refresh it. It does
       not know it is behind. Refreshing there mints a second token and consumes
       the live one -- the replay that can get the whole family revoked. */
    renameRefresh(names[0], NEXT)();
    /* Age the stale side, because that is the real timeline: the family was
       linked when the sessions started and one name was refreshed later. The
       fixture otherwise writes both inside one millisecond, and mtime is the
       only fact available to rank a split family -- see the broker's own note on
       what an exact tie means. */
    const old = new Date(Date.now() - 3_600_000);
    for (const stale of names.slice(1)) fs.utimesSync(stale, old, old);
    fs.utimesSync(owner, old, old);
    const live = fs.lstatSync(names[0]).ino;
    assert.notEqual(fs.lstatSync(names[1]).ino, live, 'the fixture must actually be split');

    let refreshCalls = 0;
    const second = broker.brokeredRefresh({
      liveCredential: names[1], confinedRoot, ownerCredential: owner,
      refresh: () => { refreshCalls += 1; renameRefresh(names[1], '{"refresh_token":"SECOND"}')(); }
    });

    assert.equal(refreshCalls, 0, 'a second flight must NOT call the provider again');
    assert.equal(second.alreadyRefreshed, true, 'and must say why it did not');
    assert.equal(second.refreshed, false);
    assert.equal(fs.lstatSync(names[0]).ino, live, 'the live token must not have moved');
    // and it still does the useful half: every name ends up on the live token.
    for (const name of names) {
      assert.equal(fs.lstatSync(name).ino, live, `${name} was left on the consumed token`);
      assert.equal(fs.readFileSync(name, 'utf8'), NEXT);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the control: the ordinary path still calls the provider', () => {
  const { root, owner, confinedRoot, names } = fixture();
  try {
    /* Without this, a broker that never refreshed anything would satisfy every
       other case in this file. It is a control, not a test of the concurrent
       branch.
       HONEST LIMIT: the `movedUnderUs` branch -- the credential moving between
       the identity this caller read and the lock being granted -- is NOT covered
       by a case here. Driving it needs an injection point between those two
       lines that the module does not expose, and I would rather say so than name
       a case after a branch it does not reach. */
    let refreshCalls = 0;
    const result = broker.brokeredRefresh({
      liveCredential: names[0], confinedRoot, ownerCredential: owner,
      refresh: () => { refreshCalls += 1; }
    });
    assert.equal(refreshCalls, 1, 'the ordinary path must still refresh');
    assert.equal(result.alreadyRefreshed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a held lock refuses rather than racing, and a dead holder does not block forever', () => {
  const { root, owner, confinedRoot, names } = fixture();
  try {
    const lockFile = `${names[0]}${broker.LOCK_SUFFIX}`;

    // A live holder: refuse, and do not touch the credential.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
    let refreshCalls = 0;
    assert.throws(() => broker.brokeredRefresh({
      liveCredential: names[0], confinedRoot, ownerCredential: owner,
      lockTimeoutMs: 80,
      refresh: () => { refreshCalls += 1; }
    }), error => error?.code === 'REFRESH_BROKER_BUSY',
    'a refresh that cannot take the lock must refuse, because proceeding is the two-inode case');
    assert.equal(refreshCalls, 0, 'and must not have called the provider');

    /* A DEAD HOLDER MUST NOT BE OBEYED FOREVER. A refresh that can never run
       strands every name on the old token permanently, which is worse than
       running late. pid 2^22 is above the Linux default pid_max, so it is not a
       live process. */
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 4194303, at: Date.now() }), { mode: 0o600 });
    const result = broker.brokeredRefresh({
      liveCredential: names[0], confinedRoot, ownerCredential: owner,
      lockTimeoutMs: 200,
      refresh: renameRefresh(names[0], NEXT)
    });
    assert.equal(result.refreshed, true, 'a lock held by a process that is gone must be broken');
    assert.equal(result.complete, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a refresh that does not move the inode leaves nothing stranded', () => {
  const { root, owner, confinedRoot, names } = fixture();
  try {
    // Some providers rewrite in place. There is no split and nothing to repoint,
    // and the broker must not invent work or report a failure.
    const result = broker.brokeredRefresh({
      liveCredential: names[0], confinedRoot, ownerCredential: owner,
      refresh: () => { fs.writeFileSync(names[0], NEXT); }
    });
    assert.equal(result.split, false);
    assert.equal(result.repointed.length, 0);
    assert.equal(result.complete, true);
    for (const name of names) assert.equal(fs.readFileSync(name, 'utf8'), NEXT,
      'an in-place rewrite reaches every name already, because they are one file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a symlink in the tree cannot steer the repoint at a file outside it', () => {
  const { root, owner, confinedRoot, names } = fixture();
  try {
    const outside = path.join(root, 'not-ours.json');
    fs.writeFileSync(outside, 'must never be touched', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(confinedRoot, '@agents', 'planted.json'));

    const result = broker.brokeredRefresh({
      liveCredential: names[0], confinedRoot, ownerCredential: owner,
      refresh: renameRefresh(names[0], NEXT)
    });
    assert.equal(result.complete, true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'must never be touched',
      'the walk followed a symlink out of the tree');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
