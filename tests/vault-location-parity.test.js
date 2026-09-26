'use strict';

/*
 * THE AUTHORITY AND THE RESOLVER IT REPLACES MUST ANSWER THE SAME.
 *
 * Twenty callers still use runtime.vaultFilePath() and will be migrated to
 * src/lib/vault-location.js a few at a time. For as long as both exist, a
 * migrated caller and an unmigrated one are reading the same machine -- so the
 * day the two resolvers stop agreeing is the day the migration silently splits
 * the vault, which is precisely the failure the authority was built to end.
 *
 * This test is the guard on that window. Delete it when the last caller in
 * tests/vault-location-is-the-only-decider.test.js is migrated and
 * vaultFilePath() is gone; until then it must stay green.
 *
 * WHY EACH RESOLVER GETS ITS OWN PROCESS, which is the whole difficulty here.
 *
 * runtime.js binds its answer at module load, the authority memoizes on first
 * call, and -- the part that invalidated two earlier versions of this test --
 * runtime.js PUBLISHES its answer into TOOLSENABLED_VAULT_PATH when the state
 * root is redirected, precisely so the PowerShell half cannot rederive a
 * different one. So any process that loads runtime first hands the authority an
 * explicit override, the authority takes its override branch, and its own
 * state-root logic never runs. A test written that way asks runtime the same
 * question twice and calls the agreement meaningful.
 *
 * It was caught the only way it could be: by deliberately breaking the
 * authority's state-root branch and watching the test stay green.
 *
 * So each resolver is asked in a SEPARATE process, neither of which has loaded
 * the other, with the environment set before either loads -- the shape the
 * packaged product actually starts in (shell/main.cjs publishes
 * TOOLSENABLED_STATE_ROOT before the engine is used).
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ENGINE_ROOT = path.resolve(__dirname, '..');

// Each probe loads exactly ONE resolver. Loading both in one process is what
// let runtime's publisher answer on the authority's behalf.
const RUNTIME_PROBE = `
console.log(JSON.stringify({ answer:
  require(${JSON.stringify(path.join(ENGINE_ROOT, 'src/lib/runtime.js'))}).vaultFilePath() }));
`;
const AUTHORITY_PROBE = `
console.log(JSON.stringify({ answer:
  require(${JSON.stringify(path.join(ENGINE_ROOT, 'src/lib/vault-location.js'))}).vaultPath() }));
`;

let probeDir;
let runtimeProbe;
let authorityProbe;
test.before(() => {
  probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-parity-'));
  runtimeProbe = path.join(probeDir, 'ask-runtime.js');
  authorityProbe = path.join(probeDir, 'ask-authority.js');
  fs.writeFileSync(runtimeProbe, RUNTIME_PROBE, 'utf8');
  fs.writeFileSync(authorityProbe, AUTHORITY_PROBE, 'utf8');
});
test.after(() => {
  // Leave nothing behind: the vault suites used to litter TEMP with stores.
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function ask(probe, environment) {
  const output = execFileSync(process.execPath, [probe], {
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    timeout: 60_000
  });
  return JSON.parse(output.trim().split('\n').pop()).answer;
}

function answersUnder(environment) {
  const existing = ask(runtimeProbe, environment);
  const authority = ask(authorityProbe, environment);
  return { existing, authority, same: path.resolve(existing) === path.resolve(authority) };
}

test('with no override, both resolvers name the same file', () => {
  const answer = answersUnder({ TOOLSENABLED_VAULT_PATH: '', TOOLSENABLED_STATE_ROOT: '' });
  assert.equal(answer.same, true,
    `runtime says ${answer.existing}, the authority says ${answer.authority}`);
});

test('under an explicit absolute override, both resolvers name the same file', () => {
  const override = path.join(os.tmpdir(), 'vault-parity-explicit', 'secrets.json');
  const answer = answersUnder({ TOOLSENABLED_VAULT_PATH: override });
  assert.equal(answer.same, true,
    `runtime says ${answer.existing}, the authority says ${answer.authority}`);
  assert.equal(path.resolve(answer.authority), path.resolve(override));
});

test('under a redirected state root -- the packaged shape -- both name the same file', () => {
  const stateRoot = path.join(os.tmpdir(), 'vault-parity-state');
  const answer = answersUnder({ TOOLSENABLED_STATE_ROOT: stateRoot, TOOLSENABLED_VAULT_PATH: '' });
  assert.equal(answer.same, true,
    `runtime says ${answer.existing}, the authority says ${answer.authority}`);
  // CANONICAL, NOT A SPELLING. src/lib/account-profile-boundary.js now expands
  // a configured TOOLSENABLED_STATE_ROOT through the filesystem before
  // runtime-state-root.js uses it ("An 8.3 short name is the same account,
  // spelled shorter") -- the deepest EXISTING ancestor is resolved to its real
  // name and the not-yet-created tail is re-appended, so the authority never
  // answers with the alias it was handed. `stateRoot` here never exists on
  // disk (this suite is deliberately hermetic against a real vault), so the
  // existing ancestor is %TEMP% itself, which on a machine where %TEMP% is
  // handed out under an 8.3 short alias of the owner's profile folder is
  // exactly the segment that expands. MEASURED: the authority answered the
  // expanded (long) form of the path while a plain path.join off os.tmpdir()
  // named the 8.3-alias spelling of the identical file.
  const canonicalTemp = fs.realpathSync.native(os.tmpdir());
  const expectedVault = path.join(canonicalTemp, path.basename(stateRoot), 'vault', 'secrets.json');
  assert.equal(path.resolve(answer.authority), path.resolve(expectedVault),
    'a redirected state root must carry the vault with it');
});

test('the one divergence is deliberate: a relative override is refused, not resolved', () => {
  // runtime.vaultFilePath() calls path.resolve() on a relative override, which
  // anchors it to the current working directory -- so one setting names a
  // different vault from every directory. The authority refuses instead. This
  // is the single intended behaviour change, asserted so it cannot be
  // "fixed" back into agreement by someone chasing parity.
  const { resolveVaultLocation } = require('../src/lib/vault-location');
  assert.throws(
    () => resolveVaultLocation({ environment: { TOOLSENABLED_VAULT_PATH: 'relative/secrets.json' } }),
    (error) => (error.code === 'VAULT_PATH_NOT_ABSOLUTE'),
    'the authority must refuse a relative override even though runtime resolves it');
});
