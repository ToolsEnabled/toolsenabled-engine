'use strict';
// Executed only by linux-vault.test.js's owned private D-Bus/keyring fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = process.env.TOOLSENABLED_TEST_ROOT;
const keyringRoot = path.dirname(process.env.XDG_DATA_HOME || '');
assert.ok(keyringRoot.startsWith('/tmp/toolsenabled-component-libsecret-'));
assert.ok(typeof root === 'string' && path.dirname(path.dirname(root)) === '/tmp');
assert.match(path.basename(path.dirname(root)), /^te-[A-Za-z0-9]+$/);
assert.match(path.basename(root), /^[0-9]{3,}$/);
assert.equal(process.env.TOOLSENABLED_TEST_ISOLATED, '1');
assert.equal(path.dirname(process.env.XDG_RUNTIME_DIR), keyringRoot);
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS);
const file = process.env.TOOLSENABLED_VAULT_PATH;
assert.equal(path.dirname(file), root);
const marker = crypto.randomBytes(48).toString('hex');
const helper = path.resolve(__dirname, '..', '..', 'src', 'lib', 'linux-credential-prompt.py');
const source = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('prompt',${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np=json.load(sys.stdin)\nm.save_to_vault(p['file'],p['key'],p['value'])`;
const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', source], { env: { ...process.env },
  input: JSON.stringify({ file, key: 'custom.native_prompt_fixture', value: marker }),
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, shell: false });
assert.equal(result.status, 0, 'native input must reach the maintained production custody implementation');
assert.equal(result.stdout, '', 'native vault Save returns no entered value');
assert.equal(result.stderr, '', 'native vault Save emits no diagnostics containing input');
assert.ok(require('../../src/lib/runtime').getSecret('custom.native_prompt_fixture', { prompt: false }) === marker);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
const plaintextMarkers = [marker];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(target);
    else if (entry.isFile()) for (const value of plaintextMarkers) assert.ok(!fs.readFileSync(target).includes(Buffer.from(value)), 'plaintext must not appear in fixture state');
  }
}
scan(root);
scan(keyringRoot);
console.log('PASS native credential Save uses production encryption and reopens through runtime without plaintext output or disk state');

// Protected native card custody: only the private input helper can save this
// version3 document. The generic agent read/write API remains refused.
const card = { version: 3, cardholder: { givenName: 'Fixture', familyName: 'Owner' },
  cardholderName: 'Fixture Owner', cardNumber: '4242424242424242', expMonth: 12,
  expYear: new Date().getFullYear() + 3, postalCode: '12345' };
plaintextMarkers.push(card.cardNumber, card.cardholderName);
const saveCard = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('prompt',${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np=json.load(sys.stdin)\nr=m.save_to_vault(p['file'],'payment_card_default',p['card'],kind='payment_card')\nv=m.load_vault()\nwith v.vault_directory(p['file'],False) as directory:\n name=v.os.path.basename(p['file'])\n with v.vault_lock(directory,name):\n  actual=v.operate({'action':'get','key':'payment_card_default','file':p['file']},v.secure_service(),directory,name,v.read_vault(directory,name))\n  assert v.decode_json(actual)==p['card']\nprint(json.dumps(r))`;
const runPython = (source, input) => spawnSync('/usr/bin/python3', ['-I', '-B', '-c', source], {
  env: { ...process.env }, input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, shell: false });
const runtime = require('../../src/lib/runtime');
for (const status of ['created', 'updated']) {
  const saved = runPython(saveCard, { file, card });
  assert.equal(saved.status, 0, 'private native card Save must reach encrypted custody');
  assert.equal(saved.stderr, '');
  assert.deepEqual(JSON.parse(saved.stdout), { key: 'payment_card_default', status });
  assert.deepEqual(runtime.scrubPaymentCardSecurityCode(), { key: 'payment_card_default', status: 'clean' });
}
assert.equal(require('../../src/lib/vault-linux').presence('payment_card_default'), 'present');
assert.ok(!runtime.listSecretKeys().includes('payment_card_default'));
const protectedBytes = fs.readFileSync(file);
for (const call of [() => runtime.getSecret('payment_card_default', { prompt: false }),
  () => runtime.setSecret('payment_card_default', JSON.stringify(card)),
  () => runtime.readSecretsFromVault(['payment_card_default'])]) {
  assert.throws(call, error => error.code === 'SECRET_ACCESS_DENIED');
  assert.ok(fs.readFileSync(file).equals(protectedBytes));
}
for (const invalid of [ { ...card, expYear: 2000 }, { ...card, cardNumber: '4242424242424241' } ]) {
  const refused = runPython(saveCard, { file, card: invalid });
  assert.notEqual(refused.status, 0);
  // The direct private fixture can see Python traceback lines, so only check
  // their contents in memory; never forward a captured value to the report.
  assert.ok(fs.readFileSync(file).equals(protectedBytes));
}
const oldRecord = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('prompt',${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nv=m.load_vault();p=json.load(sys.stdin)\nwith v.vault_directory(p['file'],False) as directory:\n name=v.os.path.basename(p['file'])\n with v.vault_lock(directory,name):\n  v.operate({'action':'set-many','file':p['file'],'entries':[{'key':'payment_card_default','value':json.dumps({'version':2})}]},v.secure_service(),directory,name,v.read_vault(directory,name))`;
assert.equal(runPython(oldRecord, { file }).status, 0);
const oldBytes = fs.readFileSync(file);
assert.throws(() => runtime.scrubPaymentCardSecurityCode(), error => error.code === 'SECRET_PAYMENT_CARD_REVIEW_REQUIRED');
assert.ok(fs.readFileSync(file).equals(oldBytes), 'hygiene must not rewrite malformed old records');
fs.writeFileSync(file, protectedBytes);
assert.deepEqual(runtime.scrubPaymentCardSecurityCode(), { key: 'payment_card_default', status: 'clean' });
const identityCheck = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('prompt',${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nv=m.load_vault();p=json.load(sys.stdin)\nassert v.owner_identity_for_payment_prompt(p['file']) is None\nfor record,expected in [({'schemaVersion':1,'purpose':'owner_legal_identity','fields':{'givenName':'  Fixture   Name ','familyName':' Example '}},{'givenName':'Fixture Name','familyName':'Example'}),({'schemaVersion':1,'purpose':'owner_legal_identity','fields':{'givenName':'X','familyName':'Example'}},None),({'schemaVersion':2,'fields':{}},None)]:\n with v.vault_directory(p['file'],False) as directory:\n  name=v.os.path.basename(p['file'])\n  with v.vault_lock(directory,name):\n   v.operate({'action':'set-many','file':p['file'],'entries':[{'key':'owner_legal_identity_v1','value':json.dumps(record)}]},v.secure_service(),directory,name,v.read_vault(directory,name))\n assert v.owner_identity_for_payment_prompt(p['file'])==expected\nprint('PASS private optional identity prefill and invalid fallback')`;
const identityResult = runPython(identityCheck, { file });
assert.equal(identityResult.status, 0, 'optional identity names stay in private Python custody');
assert.equal(identityResult.stdout.trim(), 'PASS private optional identity prefill and invalid fallback');
assert.equal(identityResult.stderr, '');
const identityBytes = fs.readFileSync(file);
for (const call of [() => runtime.getSecret('owner_legal_identity_v1', { prompt: false }),
  () => runtime.setSecret('owner_legal_identity_v1', '{}')]) {
  assert.throws(call, error => error.code === 'SECRET_ACCESS_DENIED');
  assert.ok(fs.readFileSync(file).equals(identityBytes));
}
plaintextMarkers.push('Fixture Name', 'Example');
scan(root); scan(keyringRoot);
console.log('PASS native payment card version3 save/update and hygiene use encrypted custody; generic oracle, invalid input and old records refuse');
