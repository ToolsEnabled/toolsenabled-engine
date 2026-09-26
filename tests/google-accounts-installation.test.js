'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'src/lib/google-accounts.js');
const programProfile = path.join(ROOT, 'config/google-accounts.profile.json');
const digest = file => fs.existsSync(file)
  ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

function run(stateRoot, script) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('TOOLSENABLED_') && !/TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)));
  env.TOOLSENABLED_STATE_ROOT = stateRoot;
  const child = spawnSync(process.execPath, ['-e', `const accounts = require(${JSON.stringify(MODULE)});\n${script}`], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 10000
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('Google account reads and registration remain inside the selected installation', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'google-account-installations-'));
  const before = digest(programProfile);
  try {
    const a = path.join(temporary, 'a');
    const b = path.join(temporary, 'b');
    for (const [root, alias] of [[a, 'alpha'], [b, 'beta']]) {
      fs.mkdirSync(path.join(root, 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'config/google-accounts.profile.json'), JSON.stringify({
        defaultAccount: alias, accounts: { [alias]: { email: `${alias}@example.invalid`, label: alias } }
      }));
    }
    assert.deepEqual(run(a, 'console.log(JSON.stringify(accounts.load().accounts));'), {
      alpha: { email: 'alpha@example.invalid', label: 'alpha' }
    });
    assert.deepEqual(run(b, 'console.log(JSON.stringify(accounts.load().accounts));'), {
      beta: { email: 'beta@example.invalid', label: 'beta' }
    });
    const bBefore = digest(path.join(b, 'config/google-accounts.profile.json'));
    const saved = run(a, "accounts.register('second', 'second@example.invalid', {label:'Second βeta 🧪',makeDefault:true}); console.log(JSON.stringify(accounts.load()));");
    assert.equal(saved.defaultAccount, 'second');
    assert.deepEqual(saved.accounts.second, { email: 'second@example.invalid', label: 'Second βeta 🧪' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, 'config/google-accounts.profile.json'), 'utf8')).accounts, saved.accounts);
    assert.equal(digest(path.join(b, 'config/google-accounts.profile.json')), bBefore);
    assert.equal(digest(programProfile), before);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('an absent or corrupt selected roster never falls back to another installation', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'google-account-absence-'));
  try {
    assert.deepEqual(run(temporary, 'console.log(JSON.stringify(accounts.load().accounts));'), {});
    fs.mkdirSync(path.join(temporary, 'config'));
    fs.writeFileSync(path.join(temporary, 'config/google-accounts.profile.json'), '{broken');
    const error = run(temporary, 'try { accounts.load(); console.log(JSON.stringify({failed:false})); } catch(error) { console.log(JSON.stringify({failed:true,message:error.message})); }');
    assert.equal(error.failed, true);
    assert.ok(error.message.includes(path.join(temporary, 'config/google-accounts.profile.json')));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
