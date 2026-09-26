'use strict';

// SIGNING OUT MUST REACH EVERY NAME THE CREDENTIAL HAS.
//
// linkCredential hard-links the owner's live sign-in into every confined home it
// prepares -- one per (agent, session, provider, tier, account). Nothing reaps
// those homes: `agent-home` appears in no cleanup, prune or sweep path in either
// repository. scrubStartableHome removes links, but only for the single home a
// failing prepare was working on, and only when that prepare is attempted again,
// which never happens for a retired agent or a closed session.
//
// MEASURED on a development machine while writing this: ~/.codex/auth.json had
// nlink=9 -- eight links under six different profile trees, every one from an
// agent or session that had ended. Deleting the owner's copy leaves the inode
// alive under eight other names, each a working OAuth refresh token. This is
// revocation-at-the-user's-copy failing to revoke (RFC 9700 s4.14).
//
// EVERYTHING HERE RUNS IN FIXTURES. No file outside the temporary root is read,
// linked or removed, and the suite never touches the owner's real credentials or
// agent-home trees.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { revokeCredentialLinks, credentialIdentity } =
  require('../src/lib/agent-session-confinement.js');

function fixture() {
  // Under $HOME, not os.tmpdir(): providers/host-control.js fences paths to the
  // owner profile tree, and a fixture outside it is refused before any assertion.
  const root = fs.mkdtempSync(path.join(os.homedir(), '.te-fanout-'));
  fs.chmodSync(root, 0o700);
  const owner = path.join(root, 'owner-codex');
  fs.mkdirSync(owner, { recursive: true, mode: 0o700 });
  const credential = path.join(owner, 'auth.json');
  fs.writeFileSync(credential, '{"refresh_token":"fixture-only-not-a-real-token"}', { mode: 0o600 });

  // The shape the product actually produces:
  // agent-home/@agents/<id>/@sessions/<sid>/<provider>/<tier>/<account>/auth.json
  const homeRoot = path.join(root, 'agent-home');
  const links = [];
  for (const [agent, session] of [['agent-a', 's1'], ['agent-a', 's2'], ['agent-b', 's3'],
    ['agent-c', 's4'], ['agent-c', 's5'], ['agent-d', 's6'], ['agent-e', 's7'], ['agent-f', 's8']]) {
    const home = path.join(homeRoot, '@agents', agent, '@sessions', session, 'codex', 'standard', '@default');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const link = path.join(home, 'auth.json');
    fs.linkSync(credential, link);
    links.push(link);
  }
  return { root, credential, homeRoot, links };
}

/* THE DEFECT, STATED EXECUTABLY.
 *
 * This case does NOT call the sweep. It does what the product did before it
 * existed -- delete the owner's own copy, as signing out does -- and shows the
 * credential is still there to be read under another name. It is the reason the
 * rest of this file exists, and if someone removes the sweep this is the
 * sentence that stops reading true. */
test('without the sweep, deleting the owner copy leaves the credential readable', () => {
  const { root, credential, links } = fixture();
  try {
    const secret = fs.readFileSync(credential, 'utf8');
    fs.rmSync(credential, { force: true });
    assert.equal(fs.existsSync(credential), false, 'the owner\u2019s copy is gone, as after a sign-out');

    // The inode is not: eight other names still hold it, and the bytes read back.
    const survivor = links[0];
    assert.equal(fs.existsSync(survivor), true,
      'this is the defect: a confined home still holds the revoked credential');
    assert.equal(fs.readFileSync(survivor, 'utf8'), secret,
      'and its bytes are intact, so the token the person revoked still works');
    assert.equal(fs.lstatSync(survivor).nlink, 8,
      'eight names remain for an inode the person believes they destroyed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every hard link of a revoked credential is removed, matched by inode not by name', () => {
  const { root, credential, homeRoot, links } = fixture();
  try {
    assert.equal(fs.lstatSync(credential).nlink, 9,
      'the fixture must reproduce the measured fan-out: one owner copy plus eight confined links');

    const identity = credentialIdentity(credential);
    assert.ok(identity && identity.ino, 'the identity must be captured while the credential still exists');

    const result = revokeCredentialLinks(homeRoot, identity);
    assert.equal(result.complete, true, `the sweep did not complete: ${JSON.stringify(result.failures)}`);
    assert.equal(result.removed.length, 8, 'every confined link must be removed');
    for (const link of links) {
      assert.equal(fs.existsSync(link), false, `a link survived revocation: ${link}`);
    }

    // The owner's own copy is NOT the sweep's business: it lives outside the
    // search root, and the caller deletes it themselves.
    assert.equal(fs.existsSync(credential), true,
      'the sweep must not reach outside the tree it was given');
    assert.equal(fs.lstatSync(credential).nlink, 1,
      'after the sweep the credential must have exactly one name left -- the owner’s');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a different credential in the same tree is left alone', () => {
  const { root, credential, homeRoot } = fixture();
  try {
    // A second account's sign-in, living in the same agent-home tree under the
    // same file name. Matching by name would destroy it; matching by inode must not.
    const other = path.join(homeRoot, '@agents', 'agent-z', '@sessions', 's9', 'codex', 'standard', '@default');
    fs.mkdirSync(other, { recursive: true, mode: 0o700 });
    const otherCredential = path.join(other, 'auth.json');
    fs.writeFileSync(otherCredential, '{"refresh_token":"a-different-account"}', { mode: 0o600 });

    const result = revokeCredentialLinks(homeRoot, credentialIdentity(credential));
    assert.equal(result.complete, true);
    assert.equal(result.removed.length, 8, 'only the revoked credential’s links may be removed');
    assert.equal(fs.existsSync(otherCredential), true,
      'a different account’s sign-in with the same file name must survive');
    assert.equal(fs.readFileSync(otherCredential, 'utf8'), '{"refresh_token":"a-different-account"}',
      'the surviving sign-in must be untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink planted in the tree cannot steer the sweep at a file outside it', () => {
  const { root, credential, homeRoot } = fixture();
  try {
    const outside = path.join(root, 'not-ours.json');
    fs.writeFileSync(outside, 'a file the sweep must never touch', { mode: 0o600 });

    // Both shapes: a symlink to a file outside the tree, and a symlink to a
    // directory outside it. Neither may be followed or removed.
    const planted = path.join(homeRoot, '@agents', 'agent-a', 'planted.json');
    fs.symlinkSync(outside, planted);
    const plantedDir = path.join(homeRoot, '@agents', 'escape');
    fs.symlinkSync(path.dirname(outside), plantedDir);

    const result = revokeCredentialLinks(homeRoot, credentialIdentity(credential));
    assert.equal(result.complete, true);
    assert.equal(fs.existsSync(outside), true, 'the sweep followed a symlink out of its tree');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'a file the sweep must never touch');
    assert.equal(fs.lstatSync(planted).isSymbolicLink(), true,
      'the symlink itself must be left in place rather than removed as if it were a link to the credential');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an incomplete sweep reports incomplete rather than reporting success', () => {
  const { root, credential, homeRoot } = fixture();
  try {
    // A scan that hits its bound has not seen every name, so it must not claim
    // the credential was revoked.
    const result = revokeCredentialLinks(homeRoot, credentialIdentity(credential), { limit: 3 });
    assert.equal(result.complete, false,
      'a truncated scan must never be reported as a completed revocation');
    assert.ok(result.removed.length < 8, 'a truncated scan cannot have removed every link');

    // And a missing tree is not a success either way: nothing removed, nothing claimed.
    const absent = revokeCredentialLinks(path.join(root, 'no-such-tree'), credentialIdentity(credential));
    assert.equal(absent.removed.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an identity captured after the credential is gone matches nothing', () => {
  const { root, credential, homeRoot, links } = fixture();
  try {
    fs.rmSync(credential, { force: true });
    assert.equal(credentialIdentity(credential), null,
      'an identity cannot be captured once the last owner-side name is gone');

    // This is the operational point of credentialIdentity: capture BEFORE the
    // delete. A caller that deletes first has nothing left to match against, and
    // the links stay. The sweep must not paper over that by guessing from names.
    const result = revokeCredentialLinks(homeRoot, null);
    assert.equal(result.complete, false, 'a sweep with no identity must not claim completion');
    assert.equal(result.removed.length, 0);
    assert.equal(fs.existsSync(links[0]), true, 'nothing may be removed on a name-only guess');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
