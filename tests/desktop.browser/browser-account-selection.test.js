'use strict';

const isolated = require('../lib/isolated-environment').activate('browser-account-selection');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { applyGoogleAccount, isAccountAwareGoogleUrl } = require('../../src/lib/browser-account-url');
const browserOwner = require('../../src/lib/browser-owner');
const { executeTool, listTools, routeBrowserStart } = require('../helpers/dispatch');
const audit = require('../../src/lib/audit');
const { setThroughputModeForTests } = require('../../src/lib/throughput-mode');

(async () => {
const primary = 'accta@example.com';
const secondary = 'acctc@ucr.edu';

assert.equal(isAccountAwareGoogleUrl('https://myaccount.google.com/'), true);
assert.equal(isAccountAwareGoogleUrl('https://console.firebase.google.com/'), true);
assert.equal(isAccountAwareGoogleUrl('https://example.com/'), false);
assert.equal(
  applyGoogleAccount('https://myaccount.google.com/security', primary),
  `https://myaccount.google.com/security?authuser=${encodeURIComponent(primary)}`
);
assert.equal(
  applyGoogleAccount('https://drive.google.com/drive/u/0?authuser=acctc%40ucr.edu', primary),
  'https://drive.google.com/drive/u/0?authuser=acctc%40ucr.edu',
  'An explicit Google URL account selector must never be silently overwritten.'
);
assert.equal(applyGoogleAccount('https://example.com/path', primary), 'https://example.com/path');

const accounts = {
  resolve(selector) { return selector || 'accta'; },
  load() {
    return { accounts: {
      accta: { email: primary },
      acctc: { email: secondary }
    } };
  }
};
const defaultRoute = routeBrowserStart({ url: 'https://gemini.google.com/app' }, accounts);
assert.equal(defaultRoute.account, 'accta');
assert.match(defaultRoute.url, /authuser=accta%40example\.com/);
const chosenRoute = routeBrowserStart({ url: 'https://myaccount.google.com/', account: 'acctc' }, accounts);
assert.equal(chosenRoute.account, 'acctc');
assert.match(chosenRoute.url, /authuser=acctc%40ucr\.edu/);
const firebaseRoute = routeBrowserStart({
  url: 'https://console.firebase.google.com/project/example-revenue-project/settings/general',
  account: 'accta'
}, accounts);
assert.equal(firebaseRoute.account, 'accta');
assert.match(firebaseRoute.url, /^https:\/\/console\.firebase\.google\.com\/project\/example-revenue-project\/settings\/general\?authuser=accta%40example\.com$/);
assert.throws(
  () => routeBrowserStart({ url: 'https://example.com/', account: 'acctc' }, accounts),
  /only for supported Google HTTPS URLs/
);

const startTool = listTools().find(tool => tool.name === 'browser.start');
assert.ok(startTool);
assert.ok(startTool.inputSchema.properties.account, 'browser.start must expose an explicit registered-account selector.');

// The deferred provider accessor must be dereferenced at each real handler.
// A schema/URL-routing-only test missed browserOwner.start/status being read
// off the accessor function itself. These inert methods test the real handler
// boundary without launching, attaching to, or navigating any browser.
const originalStart = browserOwner.start;
const originalStatus = browserOwner.status;
const originalRecord = audit.record;
const originalRequire = audit.requireRecord;
const routedCalls = [];
try {
  setThroughputModeForTests('strict');
  // This is a dispatcher/provider binding test. The audit-intent suite proves
  // the refusing writer; here a served writer lets the inert handler run.
  audit.record = audit.requireRecord = () => ({ durable: true, anchored: true });
  browserOwner.start = function (url) {
    assert.equal(this, browserOwner, 'the provider method keeps its real module receiver');
    routedCalls.push(['start', url]);
    return { owned: true, generation: 'synthetic-browser-generation' };
  };
  browserOwner.status = function () {
    assert.equal(this, browserOwner);
    routedCalls.push(['status']);
    return { owned: false, ownerStatus: 'not_started' };
  };
  assert.deepEqual(await executeTool('browser.start', { url: 'https://example.com/' }), {
    owned: true, generation: 'synthetic-browser-generation', account: null
  });
  const status = await executeTool('browser.status', {});
  assert.equal(status.owned, false);
  assert.equal(status.ownerStatus, 'not_started');
  assert.ok(Object.hasOwn(status, 'defaultGoogleAccount'));
  assert.deepEqual(routedCalls, [['start', 'https://example.com/'], ['status']]);

  const refusal = Object.assign(new Error('synthetic ownership refusal'), { code: 'BROWSER_OWNER_CONFLICT' });
  browserOwner.start = () => { throw refusal; };
  await assert.rejects(executeTool('browser.start', { url: 'https://example.com/' }), error => error === refusal,
    'the handler must preserve a real owner-provider refusal');
} finally {
  browserOwner.start = originalStart;
  browserOwner.status = originalStatus;
  audit.record = originalRecord;
  audit.requireRecord = originalRequire;
  setThroughputModeForTests(null);
}

if (process.platform === 'win32') {
  const status = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', '..', 'tools', 'browser.ps1'), 'status'
  ], { encoding: 'utf8', env: process.env });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const launcherStatus = JSON.parse(status.stdout);
  assert.equal(path.resolve(launcherStatus.profile), path.resolve(process.env.TOOLSENABLED_BROWSER_PROFILE_PATH));
  assert.equal(path.dirname(launcherStatus.profile), isolated.root,
    'The launcher must honor an isolated/dedicated browser-profile path rather than a hard-coded shared path.');
} else if (process.platform === 'linux') {
  let runAttempts = 0;
  const launcherStatus = browserOwner.helper('status', {}, {
    platform: 'linux',
    environment: process.env,
    commandPath: () => null,
    run: () => { runAttempts += 1; }
  });
  assert.equal(path.resolve(launcherStatus.profile), path.resolve(process.env.TOOLSENABLED_BROWSER_PROFILE_PATH));
  assert.equal(path.dirname(launcherStatus.profile), isolated.root,
    'The Linux owner must honor the same isolated browser-profile path as the Windows helper.');
  assert.equal(launcherStatus.browser, null, 'an injected empty Linux browser inventory must not invent an executable.');
  assert.equal(runAttempts, 0, 'Linux browser status must not fall through to the Windows helper runner.');
}

let unsupportedRunAttempts = 0;
assert.throws(
  () => browserOwner.helper('status', {}, { platform: 'darwin', run: () => { unsupportedRunAttempts += 1; } }),
  error => error && error.code === 'BROWSER_OWNER_PLATFORM_UNSUPPORTED'
);
assert.equal(unsupportedRunAttempts, 0, 'an unsupported browser platform must refuse by name before any helper spawn attempt');

console.log('Dedicated browser Google-account routing tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
