'use strict';

// THE ROW SAYS THE KEY IS NEVER WRITTEN INTO SETTINGS. IT WAS.
//
// THE DEFECT, MEASURED ON THIS TREE. config/settings-registry.json row
// `model.api_key` states, twice -- once under consequence and once under risks
// -- "The key is kept in the Windows-protected vault and is never written into
// settings, logs, audit records, or model results."
//
// tools/settings-set.js, the product's only write path for a user setting,
// accepted it. Run against a scratch settings file it exited 0, echoed the key
// back on stdout, and left it in settings.json in plain text. loadSettings()
// then handed it straight back -- and loadSettings() is exactly what the
// `settings.read` tool returns (src/lib/tool-registry.js defines it as
// `() => require('./settings').loadSettings()`), a local-read tool listed on
// the confined agent surface in src/lib/confined-tool-surface.js. So the one
// row that promises a credential never reaches settings put it somewhere every
// agent on the machine can read it.
//
// Nothing gained anything by that write: src/lib/providers/customer-model.js
// reads the credential from the vault (`getSecret('user_model_api_key')`) and
// no file in the product reads `model.api_key` at all.
//
// The row is now declared read-only in the catalogue, with the sentence that
// says where the key IS set, and both the writer and the reader honour that
// declaration.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const registryModule = require('../src/lib/settings-registry');
const settings = require('../src/lib/settings');
const settingsSet = require('../tools/settings-set');

const API_KEY_ID = 'model.api_key';
const SECRET = 'sk-live-this-value-must-never-reach-settings-json';

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-api-key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function capture() {
  const written = [];
  return {
    written,
    streams: {
      stdin: { isTTY: false },
      stdout: { isTTY: false, write: text => written.push(text) },
      stderr: { write: text => written.push(text) }
    }
  };
}

test('the writer refuses the key and names where it is actually set', (t) => {
  const valuesPath = path.join(scratch(t), 'settings.json');
  const { written, streams } = capture();
  const code = settingsSet.main(
    [API_KEY_ID, SECRET, '--source', 'installer'],
    { TOOLSENABLED_SETTINGS_PATH: valuesPath, TOOLSENABLED_INSTALLER: '1' },
    streams
  );

  const output = written.join('');
  assert.equal(code, 1, 'writing a vault-backed credential into settings must fail');
  assert.equal(fs.existsSync(valuesPath), false, 'nothing may be written to the settings file');
  assert.equal(output.includes(SECRET.slice(3)), false,
    `the refusal must not echo the credential. It said: ${JSON.stringify(output)}`);
  assert.match(output, /vault/i, 'the refusal must say where the key is kept');
  assert.match(output, /credential form|secrets\.ps1/i, 'the refusal must name what to use instead');
});

test('a key already hand-written into settings.json is not handed back by the reader', (t) => {
  const valuesPath = path.join(scratch(t), 'settings.json');
  fs.writeFileSync(valuesPath, JSON.stringify({
    revision: 4,
    values: { [API_KEY_ID]: SECRET },
    provenance: { [API_KEY_ID]: { source: 'user', atMs: 1, directive: null } }
  }));

  const resolved = settings.loadSettings({ valuesPath });
  const registry = registryModule.loadRegistry();

  assert.equal(resolved.values[API_KEY_ID], registry.byId.get(API_KEY_ID).default,
    'a stored credential must never become the resolved value settings.read returns');

  const refusal = resolved.rejected.find(item => item.id === API_KEY_ID);
  assert.ok(refusal, 'the reader must say it refused the row rather than dropping it silently');
  assert.match(refusal.reason, /read-only/i);

  // Refusing a secret must not publish it. `rejected` travels back through
  // settings.read with everything else, so a rejection that carried the value
  // would leak exactly what the rejection exists to prevent.
  assert.equal(JSON.stringify(resolved).includes(SECRET.slice(3)), false,
    'no part of the resolved settings document may carry the refused credential');
});

test('the other model rows still write and read back, so the provider path is intact', (t) => {
  const valuesPath = path.join(scratch(t), 'settings.json');
  const env = { TOOLSENABLED_SETTINGS_PATH: valuesPath, TOOLSENABLED_INSTALLER: '1' };
  for (const [id, value] of [['model.endpoint', 'https://example.invalid/v1'], ['model.name', 'a-model']]) {
    const { streams } = capture();
    assert.equal(settingsSet.main([id, value, '--source', 'installer'], env, streams), 0,
      `${id} must remain writable: src/lib/providers/customer-model.js reads it out of settings.json`);
  }
  const resolved = settings.loadSettings({ valuesPath });
  assert.equal(resolved.values['model.endpoint'], 'https://example.invalid/v1');
  assert.equal(resolved.values['model.name'], 'a-model');
  assert.deepEqual(resolved.rejected, []);
});
