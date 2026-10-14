'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { probeGeminiAccount, STATUS } = require('../../src/lib/multi-account/health');
const { defaultProbeFor, readAccountUsage } = require('../../src/lib/multi-account/rotation');

const account = { name: 'lab', provider: 'gemini', home: path.resolve('synthetic-gemini-home'), expectEmail: null };
const noWindows = { hourly: null, weekly: null, weeklyWindows: [] };
function metadataOnly(error = null) {
  const observed = [];
  const fsImpl = new Proxy({ statSync(file) {
    observed.push(file);
    if (error) throw Object.assign(Error('synthetic metadata failure'), { code: error });
    return { isFile: () => true };
  } }, { get(target, key) {
    if (key in target) return target[key];
    throw Error('Gemini account health attempted more than a metadata check');
  } });
  return { fsImpl, observed };
}

test('canonical Gemini account health checks presence without opening credentials or measuring allowance', async () => {
  const { fsImpl, observed } = metadataOnly();
  const row = await defaultProbeFor('gemini', { fsImpl })(account);
  assert.deepEqual(observed, [path.join(account.home, '.gemini', 'oauth_creds.json')]);
  assert.equal(row.status, STATUS.HEALTHY);
  assert.equal(row.canServe, true);
  assert.equal(row.email, null);
  assert.equal(row.usedPercent, null);
  assert.equal(row.resetsAt, null);
  assert.equal(row.readAt, null);
  assert.equal(row.allowanceBuckets, null);
  assert.deepEqual(row.windows, noWindows);
  assert.equal(row.usageStatus, 'not_reported');
  assert.equal(row.usageSource, null);
  assert.match(row.usageReason, /allowance is unknown/i);
});

test('a pinned Gemini identity remains unverified by file presence', async () => {
  const row = await probeGeminiAccount({ ...account, expectEmail: 'fixture@example.test' }, metadataOnly());
  assert.equal(row.status, STATUS.TRANSIENT);
  assert.equal(row.canServe, false);
  assert.equal(row.email, null);
  assert.equal(row.allowanceBuckets, null);
  assert.match(row.reason, /could not be confirmed/i);
});

for (const error of ['ENOENT', 'ENOTDIR', 'EACCES', 'EIO']) {
  test(`Gemini metadata failure ${error} distinguishes absent sign-in from an unreadable check`, async () => {
    const row = await probeGeminiAccount(account, metadataOnly(error));
    assert.equal(row.status, ['ENOENT', 'ENOTDIR'].includes(error) ? STATUS.SIGNED_OUT : STATUS.TRANSIENT);
    assert.equal(row.canServe, false);
    assert.equal(row.allowanceBuckets, null);
    assert.equal(row.usedPercent, null);
    assert.deepEqual(row.windows, noWindows);
    assert.match(row.usageReason, /unknown/i);
  });
}

test('a cancelled Gemini health check does no filesystem work', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fsImpl, observed } = metadataOnly();
  await assert.rejects(probeGeminiAccount(account, { fsImpl, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(observed, []);
});

test('rotation returns unknown Gemini allowance through the canonical reader', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-account-row-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registryPath = path.join(root, 'accounts.json');
  fs.writeFileSync(registryPath, JSON.stringify({ accounts: [{ name: 'lab', provider: 'gemini', homeDir: '.gemini-lab' }] }));
  const { fsImpl, observed } = metadataOnly();
  const options = { registryPath, homeDir: root, providers: ['gemini'], probeFor: id => defaultProbeFor(id, { homeDir: root, fsImpl }) };
  const reply = await readAccountUsage(options);
  assert.equal(reply.accounts.length, 1);
  const row = reply.accounts[0];
  assert.equal(row.status, STATUS.HEALTHY);
  assert.equal(row.canServe, true);
  assert.equal(row.usageStatus, 'not_reported');
  assert.equal(row.allowanceBuckets, null);
  assert.equal(row.reportedUsage, null);
  assert.deepEqual(row.windows, noWindows);
  assert.equal(observed.length, 1);
  const failed = await readAccountUsage({ ...options, probeFor: () => async () => { throw Error('synthetic failure'); } });
  assert.equal(failed.accounts[0].usageStatus, 'unavailable');
  assert.equal(failed.accounts[0].allowanceBuckets, null);
});
