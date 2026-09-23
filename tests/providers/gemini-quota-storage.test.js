'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validatePlainPersonalHome, unsupportedEnvironment, installGeminiStorageBoundary } = require('../../src/lib/providers/gemini-quota-storage');
const auth = (name = 'original') => JSON.stringify({ access_token: `synthetic-${name}`, refresh_token: 'synthetic-refresh', expiry_date: 2000000000000 });
async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-storage-'));
  const directory = path.join(home, '.gemini'); fs.mkdirSync(directory);
  const leaf = path.join(directory, 'oauth_creds.json'); fs.writeFileSync(leaf, auth());
  const fsImpl = { ...fs, promises: { ...fs.promises } };
  try { await run({ home, directory, leaf, fsImpl }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}
test('personal plaintext route is admitted without returning credential values', async () => fixture(async ({ home }) => {
  const answer = validatePlainPersonalHome(home);
  assert.deepEqual(answer, { home, storage: 'personal-oauth-plaintext' });
  assert.equal(JSON.stringify(answer).includes('synthetic-refresh'), false);
}));
test('a file growing after stat cannot turn the credential read into unbounded allocation', async () => fixture(async ({ home, leaf, fsImpl }) => {
  const initial = fs.statSync(leaf).size;
  let requested = 0, changed = false;
  fsImpl.readSync = (fd, buffer, offset, length, position) => {
    requested += length;
    if (!changed) { changed = true; fs.appendFileSync(leaf, Buffer.alloc(2 * 1024 * 1024, 120)); }
    return fs.readSync(fd, buffer, offset, length, position);
  };
  assert.throws(() => validatePlainPersonalHome(home, { fsImpl }), error => error.code === 'GEMINI_AUTH_FILE_CHANGED');
  assert.equal(requested, initial + 1);
}));
test('ADC, service-account, encrypted and environmental auth routes are explicitly unsupported', async () => fixture(async ({ home, leaf, directory }) => {
  for (const extra of [{ type: 'authorized_user' }, { type: 'service_account' }, { private_key: 'synthetic' }, { client_id: 'synthetic' }]) {
    fs.writeFileSync(leaf, JSON.stringify({ ...JSON.parse(auth()), ...extra }));
    assert.throws(() => validatePlainPersonalHome(home), { code: 'GEMINI_AUTH_MODE_UNSUPPORTED' });
  }
  fs.writeFileSync(leaf, auth());
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
  assert.throws(() => validatePlainPersonalHome(home), { code: 'GEMINI_AUTH_MODE_UNSUPPORTED' });
  for (const field of ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_ACCESS_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE']) {
    assert.equal(unsupportedEnvironment({ [field]: 'true' }), true);
  }
  assert.equal(unsupportedEnvironment({ GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' }), false);
}));
test('SDK refresh atomically replaces the exact original leaf and retains its refresh token', async () => fixture(async ({ home, leaf, directory, fsImpl }) => {
  const before = fs.readFileSync(leaf, 'utf8');
  const boundary = installGeminiStorageBoundary(home, { fsImpl });
  assert.equal(await fsImpl.promises.readFile(leaf, 'utf-8'), before);
  await fsImpl.promises.writeFile(leaf, auth('refreshed'), { mode: 0o600 });
  await fsImpl.promises.chmod(leaf, 0o600);
  await boundary.drain();
  assert.deepEqual(JSON.parse(fs.readFileSync(leaf, 'utf8')), JSON.parse(auth('refreshed')));
  assert.deepEqual(fs.readdirSync(directory), ['oauth_creds.json']);
  assert.equal(boundary.failureCode(), null);
}));
test('SDK sees a replacement ADC file as unsupported before receiving its bytes', async () => fixture(async ({ home, leaf, fsImpl }) => {
  validatePlainPersonalHome(home);
  const boundary = installGeminiStorageBoundary(home, { fsImpl });
  fs.writeFileSync(leaf, JSON.stringify({ type: 'service_account', private_key: 'synthetic-not-a-key' }));
  await assert.rejects(fsImpl.promises.readFile(leaf, 'utf-8'), { code: 'GEMINI_AUTH_MODE_UNSUPPORTED' });
  assert.equal(boundary.failureCode(), 'GEMINI_AUTH_MODE_UNSUPPORTED');
}));
for (const timing of ['before-write', 'during-temp-write']) test(`changed credentials ${timing} cannot be overwritten by the earlier refresh`, async () => fixture(async ({ home, leaf, directory, fsImpl }) => {
  const replacement = auth('replacement-owner-signin');
  if (timing === 'during-temp-write') {
    const open = fsImpl.promises.open;
    fsImpl.promises.open = async (...args) => {
      const handle = await open(...args), writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => { await writeFile(...values); fs.writeFileSync(leaf, replacement); };
      return handle;
    };
  }
  const boundary = installGeminiStorageBoundary(home, { fsImpl });
  await fsImpl.promises.readFile(leaf, 'utf-8');
  if (timing === 'before-write') fs.writeFileSync(leaf, replacement);
  await assert.rejects(fsImpl.promises.writeFile(leaf, auth('obsolete-refresh')), { code: 'GEMINI_AUTH_FILE_CHANGED' });
  assert.equal(fs.readFileSync(leaf, 'utf8'), replacement);
  assert.deepEqual(fs.readdirSync(directory), ['oauth_creds.json']);
  assert.equal(boundary.failureCode(), 'GEMINI_AUTH_FILE_CHANGED');
}));
for (const operation of ['write', 'sync', 'rename']) test(`atomic refresh ${operation} failure preserves the original tokens`, async () => fixture(async ({ home, leaf, directory, fsImpl }) => {
  const before = fs.readFileSync(leaf, 'utf8');
  if (operation === 'rename') fsImpl.promises.rename = async () => { throw Object.assign(Error('synthetic failure'), { code: 'EIO' }); };
  else {
    const open = fsImpl.promises.open;
    fsImpl.promises.open = async (...args) => { const handle = await open(...args);
      handle[operation === 'write' ? 'writeFile' : 'sync'] = async () => { throw Object.assign(Error('synthetic failure'), { code: 'EIO' }); };
      return handle;
    };
  }
  installGeminiStorageBoundary(home, { fsImpl });
  await fsImpl.promises.readFile(leaf, 'utf-8');
  await assert.rejects(fsImpl.promises.writeFile(leaf, auth('refreshed')), { code: 'GEMINI_AUTH_FILE_UNAVAILABLE' });
  assert.equal(fs.readFileSync(leaf, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['oauth_creds.json']);
}));
