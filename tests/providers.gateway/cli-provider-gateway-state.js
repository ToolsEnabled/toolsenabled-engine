'use strict';

require('../lib/isolated-environment').activate('cli-provider-gateway-state');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CliProviderGateway,
  vscodeCodexExecutable
} = require('../../src/lib/providers/cli-provider-gateway');

// "State did not exist" and "state could not be read" are distinct answers:
// only the former establishes the default, all-disabled provider controls.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-state-distinction-'));
try {
  const missing = new CliProviderGateway({ stateFile: path.join(root, 'missing.json') });
  // Four controls since a57cd698 (2026-09-10) added the grok provider descriptor
  // (cli-provider-gateway.js:85). The point of this line is that an ABSENT state
  // file yields every control disabled, which is unchanged -- grok defaults false
  // like the other three, and the shape stays exact so a new provider that
  // defaulted to enabled would still fail here.
  assert.deepEqual(missing.readState().providers, { codex: false, claude: false, gemini: false, grok: false });

  const unreadable = new CliProviderGateway({ stateFile: root });
  assert.throws(
    () => unreadable.readState(),
    error => error?.code === 'PROVIDER_STATE_UNAVAILABLE'
  );

  // THE UPGRADE. A file written before a provider existed names only the ids of
  // its day, and that is an older file, not a corrupt one. This regressed for
  // real: a57cd698 added 'grok' to SUBSCRIPTION_PROVIDER_IDS and readState()
  // required every current id to be present, so every 1.0.44 install that had
  // ever turned a provider on read PROVIDER_STATE_INVALID after upgrading.
  const upgraded = path.join(root, 'written-by-1044.json');
  fs.writeFileSync(upgraded, JSON.stringify({ version: 1, providers: { codex: true, claude: false, gemini: false } }));
  assert.deepEqual(new CliProviderGateway({ stateFile: upgraded }).readState().providers,
    { codex: true, claude: false, gemini: false, grok: false },
    'a state file older than a provider must keep its saved answers and default the new one OFF');

  // CONTROL, so the line above cannot be satisfied by accepting anything: a
  // value that IS present and is not a boolean is still corruption.
  const corrupt = path.join(root, 'corrupt-value.json');
  fs.writeFileSync(corrupt, JSON.stringify({ version: 1, providers: { codex: 'yes', claude: false, gemini: false, grok: false } }));
  assert.throws(
    () => new CliProviderGateway({ stateFile: corrupt }).readState(),
    error => error?.code === 'PROVIDER_STATE_INVALID'
  );
  console.log('Provider state absence versus unreadability distinction test passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// A busy or failing filesystem cannot establish that the bundled executable
// is absent. Only ENOENT retains the old, definite "not in this layout" value.
for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
  assert.throws(
    () => vscodeCodexExecutable({
      platform: 'win32',
      homeDirectory: 'C:\\Users\\fixture',
      fsImpl: { readdirSync() { throw Object.assign(new Error(code), { code }); } }
    }),
    error => error?.code === 'PROVIDER_EXECUTABLE_LOOKUP_UNAVAILABLE'
      && /does not mean Codex is absent/.test(error.message),
    `${code} must remain distinguishable from absence`
  );
  assert.throws(
    () => vscodeCodexExecutable({
      platform: 'win32',
      homeDirectory: 'C:\\Users\\fixture',
      fsImpl: {
        readdirSync() {
          return [{ name: 'openai.chatgpt-1.2.3-win32-x64', isDirectory: () => true }];
        },
        lstatSync() { throw Object.assign(new Error(code), { code }); }
      }
    }),
    error => error?.code === 'PROVIDER_EXECUTABLE_LOOKUP_UNAVAILABLE',
    `${code} during candidate inspection must remain distinguishable from absence`
  );
}
assert.equal(vscodeCodexExecutable({
  platform: 'win32',
  homeDirectory: 'C:\\Users\\fixture',
  fsImpl: { readdirSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }
}), null);

const diagnostic = id => ({
  id,
  label: id,
  available: true,
  authenticated: true,
  usable: null,
  status: 'ready',
  reason: 'measured'
});

(async () => {
  fs.mkdirSync(root, { recursive: true });
  const enabledState = name => {
    const file = path.join(root, name);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      providers: { codex: true, claude: false, gemini: false }
    }));
    return file;
  };
  const transient = new CliProviderGateway({
    stateFile: enabledState('transient-cache.json'),
    assertActive() {}
  });
  let transientCalls = 0;
  transient.diagnose = async id => {
    transientCalls += 1;
    if (id === 'codex') throw Object.assign(new Error('lookup unavailable'), {
      code: 'PROVIDER_EXECUTABLE_LOOKUP_UNAVAILABLE'
    });
    return diagnostic(id);
  };
  assert.equal((await transient.status()).providers[0].status, 'status_unavailable');
  assert.equal((await transient.status()).providers[0].status, 'status_unavailable');
  assert.equal(transientCalls, 2, 'could-not-tell status must not be cached');

  // CONTROL: a fully measured live status still uses the existing cache.
  const measured = new CliProviderGateway({
    stateFile: enabledState('measured-cache.json'),
    assertActive() {}
  });
  let measuredCalls = 0;
  measured.diagnose = async id => { measuredCalls += 1; return diagnostic(id); };
  await measured.status();
  assert.equal((await measured.status()).source, 'cached-live-provider-check');
  assert.equal(measuredCalls, 1, 'legitimate live results must remain cached');
  console.log('Provider executable lookup uncertainty and cache distinction test passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
