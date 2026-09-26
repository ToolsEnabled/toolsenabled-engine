'use strict';

// Registration removal is intentionally narrower than account deletion: it
// must only remove the selected registry row and must never inspect, read,
// enumerate, or delete anything else in the provider's sign-in home -- WITH
// ONE DELIBERATE EXCEPTION, added 2026-09-07 (see the "credential destroyed"
// checks below): the one file that home's own provider spec names as the
// sign-in (signInFilePath) is destroyed, because leaving it behind is a live
// credential for an account the person no longer sees as registered, not
// preserved session history. Session history, cached config, and every other
// file in the home are still never inspected or touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addAccount, removeAccount } = require('../src/lib/multi-account/registry-write');
const { loadRegistry, providerSpec, signInFilePath, GEMINI_STATE_DIR } = require('../src/lib/multi-account/registry');

function area() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-remove-'));
  return {
    root,
    registry: path.join(root, 'config', 'accounts.json'),
    homes: path.join(root, 'homes')
  };
}

function refuses(run, code) {
  assert.throws(run, error => error && error.code === code);
}

function add(root, name, provider = 'codex') {
  return addAccount({ name, provider, configPath: root.registry, homesRoot: root.homes });
}

function remove(root, name, provider = 'codex') {
  return removeAccount({ name, provider, configPath: root.registry });
}

let checks = 0;
function check(run) { run(); checks += 1; }

try {
  check(() => {
    const root = area();
    try {
      const first = add(root, 'first');
      const second = add(root, 'second');
      fs.writeFileSync(path.join(first.home, 'auth-fixture.txt'), 'must-survive');
      const receipt = remove(root, 'FIRST');
      assert.deepEqual(receipt, {
        name: 'first', provider: 'codex', registryPath: root.registry,
        remainingAccountCount: 1, homePreserved: true, credentialDestroyed: true
      });
      assert.equal(fs.readFileSync(path.join(first.home, 'auth-fixture.txt'), 'utf8'), 'must-survive');
      assert.equal(fs.statSync(second.home).isDirectory(), true);
      assert.deepEqual(loadRegistry({ configPath: root.registry }).accounts.map(entry => entry.name), ['second']);
    } finally { fs.rmSync(root.root, { recursive: true, force: true }); }
  });

  check(() => {
    const root = area();
    try {
      const codex = add(root, 'shared', 'codex');
      const claude = add(root, 'shared', 'claude');
      const receipt = remove(root, 'shared', 'codex');
      assert.equal(receipt.provider, 'codex');
      const after = loadRegistry({ configPath: root.registry });
      assert.deepEqual(after.accounts.map(entry => `${entry.provider}:${entry.name}`), ['claude:shared']);
      assert.equal(fs.statSync(codex.home).isDirectory(), true);
      assert.equal(fs.statSync(claude.home).isDirectory(), true);
    } finally { fs.rmSync(root.root, { recursive: true, force: true }); }
  });

  check(() => {
    const root = area();
    try {
      const only = add(root, 'only');
      fs.writeFileSync(path.join(only.home, 'sign-in-fixture.txt'), 'untouched');
      const receipt = remove(root, 'only');
      assert.equal(receipt.remainingAccountCount, 0);
      assert.equal(fs.existsSync(root.registry), false, 'the final removal must return to missing-registry state, not leave invalid empty JSON');
      assert.equal(fs.readFileSync(path.join(only.home, 'sign-in-fixture.txt'), 'utf8'), 'untouched');
    } finally { fs.rmSync(root.root, { recursive: true, force: true }); }
  });

  check(() => {
    const root = area();
    try {
      add(root, 'known');
      const before = fs.readFileSync(root.registry);
      refuses(() => remove(root, 'absent'), 'ACCOUNTS_ACCOUNT_NOT_REGISTERED');
      assert.deepEqual(fs.readFileSync(root.registry), before, 'an absent selection must not rewrite registrations');
      fs.rmSync(root.registry, { force: true });
      refuses(() => remove(root, 'known'), 'ACCOUNTS_REGISTRY_MISSING');
    } finally { fs.rmSync(root.root, { recursive: true, force: true }); }
  });

  check(() => {
    const root = area();
    try {
      fs.mkdirSync(path.dirname(root.registry), { recursive: true });
      fs.writeFileSync(root.registry, '{ invalid');
      const before = fs.readFileSync(root.registry);
      refuses(() => remove(root, 'anything'), 'ACCOUNTS_REGISTRY_UNPARSABLE');
      assert.deepEqual(fs.readFileSync(root.registry), before, 'a damaged registry must be refused, not repaired by deletion');
    } finally { fs.rmSync(root.root, { recursive: true, force: true }); }
  });

  // --- removal destroys the credential, for every provider --------------------

  for (const provider of ['codex', 'claude', 'gemini']) {
    check(() => {
      const root = area();
      try {
        const account = add(root, 'leaving', provider);
        const spec = providerSpec(provider);
        const credentialPath = signInFilePath(account.home, spec);
        fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
        fs.writeFileSync(credentialPath, 'fixture-sign-in-bytes');
        const decoyPath = path.join(account.home, 'session-history-fixture.txt');
        fs.writeFileSync(decoyPath, 'must-survive');

        assert.equal(fs.existsSync(credentialPath), true, 'setup: the credential fixture must exist before removal');
        remove(root, 'leaving', provider);

        assert.equal(fs.existsSync(credentialPath), false,
          `[${provider}] the credential file must be destroyed by removeAccount, not left behind`);
        assert.equal(fs.readFileSync(decoyPath, 'utf8'), 'must-survive',
          `[${provider}] a file in the home that is not the credential must be untouched`);
        assert.equal(fs.statSync(account.home).isDirectory(), true,
          `[${provider}] the home directory itself must survive; only the credential file is destroyed`);
      } finally { fs.rmSync(root.root, { recursive: true, force: true }); }
    });
  }

  check(() => {
    // Gemini's credential lives inside a subdirectory of the home
    // (GEMINI_STATE_DIR), not the home root -- destroying it must not require
    // or cause the subdirectory itself, or a sibling file inside it, to go.
    const root = area();
    try {
      const account = add(root, 'leaving', 'gemini');
      const spec = providerSpec('gemini');
      const stateDir = path.join(account.home, GEMINI_STATE_DIR);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, spec.signInFile), 'fixture-sign-in-bytes');
      fs.writeFileSync(path.join(stateDir, 'settings.json'), 'must-survive');

      remove(root, 'leaving', 'gemini');

      assert.equal(fs.existsSync(path.join(stateDir, spec.signInFile)), false,
        'the gemini credential inside .gemini must be destroyed');
      assert.equal(fs.readFileSync(path.join(stateDir, 'settings.json'), 'utf8'), 'must-survive',
        'a sibling file inside .gemini that is not the credential must be untouched');
      assert.equal(fs.statSync(stateDir).isDirectory(), true, 'the .gemini subdirectory itself must survive');
    } finally { fs.rmSync(root.root, { recursive: true, force: true }); }
  });

  check(() => {
    // An account that was registered but never actually signed in has no
    // credential file at all. Removal must still succeed -- "destroy the
    // credential if one exists" is not "require one to exist".
    const root = area();
    try {
      const account = add(root, 'never-signed-in', 'codex');
      const credentialPath = signInFilePath(account.home, providerSpec('codex'));
      assert.equal(fs.existsSync(credentialPath), false, 'setup: no credential fixture was written');
      const receipt = remove(root, 'never-signed-in', 'codex');
      assert.equal(receipt.remainingAccountCount, 0);
    } finally { fs.rmSync(root.root, { recursive: true, force: true }); }
  });

  process.stdout.write(`multi-account registry remove: ${checks} checks passed\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
