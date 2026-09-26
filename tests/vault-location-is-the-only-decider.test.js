/*
 * MUTATION RECORD: changed `let file = explicit` to `let file = null` in
 * src/lib/vault-location.js, making the authority ignore an explicit override.
 * The edit landed (confirmed by printing its mutated line), but this file stayed green.
 * After adding the behavioral assertion below, the same landed mutation went red.
 */

'use strict';

/*
 * THE VAULT LOCATION IS DECIDED IN ONE PLACE, AND THIS LIST ONLY SHRINKS.
 *
 * `src/lib/vault-location.js` is the authority. Every other file that names
 * TOOLSENABLED_VAULT_PATH, or joins a root with 'vault' and 'secrets.json' for
 * itself, is deciding the vault location a second time -- and second decisions
 * agree with the first only while their assumptions do. When they stopped
 * agreeing, a presence check answered a confident "no such credential" for a
 * credential that existed, because it had opened a different file.
 *
 * The migration is not done. Eleven files still decide for themselves, and
 * fixing them at once, in a tree several lanes are writing, is how you get a
 * half-migration that nobody can finish. So this is a RATCHET, in the idiom
 * this repository already uses for settings enforcement: the debt is named,
 * shrinking it is the work, and growing it is the regression.
 *
 * TO SHRINK IT: migrate a file to vaultLocation()/vaultPath()/vaultEnvironment(),
 * delete its entry here, and watch this test stay green.
 * DO NOT add an entry to make a new file pass. That is the one edit that
 * defeats the instrument.
 *
 * THE SCAN READS CODE, NOT PROSE. It strips comments before matching, the
 * same way src/lib/secret-store/requirements.js already strips them before
 * scanning for getSecret() consumers -- for the same reason: a file that only
 * ever TALKS ABOUT the vault path (an incident note, an ACL helper
 * documenting what it hardens) is not a second decision, and matching it as
 * one hides real debt behind false debt. MEASURED 2026-09-03:
 * src/lib/agent-session-confinement.js gained a comment citing a real crash
 * that zeroed `vault/secrets.json`, purely as motivation for an unrelated
 * durable-write helper for session files -- the file never reads
 * TOOLSENABLED_VAULT_PATH and never builds a vault path. Unstripped, that one
 * sentence read as a new violation. Stripped, it does not, and eight existing
 * entries turned out to have been the same false match wearing a debt-list
 * entry as cover -- see the note above DECIDES_FOR_ITSELF.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ENGINE_ROOT = path.resolve(__dirname, '..');
const AUTHORITY = 'src/lib/vault-location.js';

const NAMES_ENV = /TOOLSENABLED_VAULT_PATH/;
const BUILDS_LEAF = /["']vault["']\s*,\s*["']secrets\.json["']|vault[\\/]+secrets\.json/;

// Measured 2026-08-24, immediately after the authority landed. Every one of
// these predates it. The count is the debt.
//
// EIGHT NAMES REMOVED 2026-09-03, and none of them migrated. Each one's only
// match against NAMES_ENV/BUILDS_LEAF was inside a comment -- confirmed by
// reading every matched line -- so under the comment-stripped scan below none
// of them ever decided the vault location in the first place:
// agent-coord-integrity.js, fleet-supervisor/worktree.js,
// runtime-state-root.js and vault-presence.js each cite the vault path while
// documenting something else; agent-coord-attest-migrate.js and
// tools/lib/vault-acl.ps1 describe access they operate on through a path a
// caller hands them; online-fra-claim-cli.js and vault-access-probe.ps1
// explain a resolution or a redirection they never perform themselves.
// Carrying them was not caution -- it was cover. A REAL decision added to any
// of those eight files would have landed inside an already-blessed entry, and
// this ratchet would never have seen it.
const DECIDES_FOR_ITSELF = [
  'src/lib/audit.js',
  'src/lib/capability-features.js',
  'src/lib/runtime.js',
  'src/lib/secret-store/powershell.js',
  'tools/fra-token-enrollment-lifecycle.js',
  'tools/lib/fra-token-enrollment-vault.js',
  'tools/lib/link-bus-token-rotation-vault.js',
  'tools/link-bus-token-rotation-a.js',
  'tools/link-bus-token-rotation-receiver.js',
  'tools/secrets-manager.ps1',
  'tools/secrets.ps1'
];

// Same idiom src/lib/secret-store/requirements.js uses before it scans for
// getSecret() consumers: strip comments so a mention reads as prose, not as
// the decision it is describing. PowerShell's line comment is '#', not '//',
// so it needs its own pass rather than the JS one above it.
function stripComments(text, isPowerShell) {
  if (isPowerShell) {
    return text
      .replace(/<#[\s\S]*?#>/g, '')
      .replace(/(^|[^:])#.*$/gm, '$1');
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function productionFilesThatDecide() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') walk(full);
        continue;
      }
      if (!/\.(js|cjs|mjs|ps1)$/.test(entry.name)) continue;
      const rel = path.relative(ENGINE_ROOT, full).split(path.sep).join('/');
      if (rel === AUTHORITY) continue;
      const text = fs.readFileSync(full, 'utf8');
      const code = stripComments(text, entry.name.endsWith('.ps1'));
      if (NAMES_ENV.test(code) || BUILDS_LEAF.test(code)) found.push(rel);
    }
  };
  for (const root of ['src', 'tools']) walk(path.join(ENGINE_ROOT, root));
  return found.sort();
}

test('no NEW file decides the vault location for itself', () => {
  const actual = productionFilesThatDecide();
  const known = new Set(DECIDES_FOR_ITSELF);
  const added = actual.filter(file => !known.has(file));

  assert.deepEqual(added, [],
    'these files decide the vault location outside the authority and are not in the '
    + 'known debt. Use vaultLocation()/vaultPath()/vaultEnvironment() from '
    + `${AUTHORITY} instead of naming the path yourself. Adding them to the list `
    + 'is not the fix.');
});

test('the debt list is honest: every entry still decides, or it should be deleted', () => {
  const actual = new Set(productionFilesThatDecide());
  const stale = DECIDES_FOR_ITSELF.filter(file => !actual.has(file));

  assert.deepEqual(stale, [],
    'these entries no longer decide the vault location -- either they were migrated '
    + '(delete the entry and take the win) or the file moved. A debt list that '
    + 'over-reports is how a finished migration goes unnoticed.');
});

test('the authority exists and is the thing callers are pointed at', () => {
  const authority = require('../src/lib/vault-location');
  for (const name of ['vaultLocation', 'vaultPath', 'vaultEnvironment', 'assertVaultPath', 'resolveVaultLocation']) {
    assert.equal(typeof authority[name], 'function',
      `${name} is named in the migration instructions above, so it must exist`);
  }
});

test('the authority gives an explicit vault path precedence', () => {
  const { resolveVaultLocation } = require('../src/lib/vault-location');
  const explicit = path.resolve(ENGINE_ROOT, 'chosen-vault', 'credentials.json');

  const location = resolveVaultLocation({
    environment: { TOOLSENABLED_VAULT_PATH: explicit },
    programRoot: path.resolve(ENGINE_ROOT, 'different-program-root'),
  });

  assert.equal(location.file, explicit);
  assert.equal(location.directory, path.dirname(explicit));
});
