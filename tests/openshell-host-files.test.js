'use strict';

// The byte-mediated file tools as an agent inside an OpenShell sandbox calls
// them: the sandbox home is the account's home, the engine's state lives in
// ~/.toolsenabled, and every call carries a transport-bound file scope.

const { useSandboxHome, sandboxCaller } = require('./lib/openshell-sandbox-home');
const HOME = useSandboxHome('openshell-host-files');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const work = (...parts) => path.join(HOME, 'work', ...parts);

test('Claude Code\'s own config file, which keeps an API key saved by /login, is refused like its sign-in folder', async (t) => {
  const { call, refusal } = sandboxCaller(t);
  fs.writeFileSync(path.join(HOME, '.claude.json'), '{"primaryApiKey":"made-up-for-the-test","oauthAccount":{}}');
  fs.writeFileSync(path.join(HOME, '.claude.json.backup'), '{"primaryApiKey":"made-up-for-the-test"}');
  for (const name of ['.claude.json', '.claude.json.backup']) {
    const refused = await refusal('host.read_file', { path: path.join(HOME, name) });
    assert.equal(refused.code, 'HOST_PATH_FORBIDDEN', name);
    assert.match(refused.text, /never exposed/);
  }
  const listed = await call('host.list_dir', { path: HOME });
  assert.deepEqual(listed.entries.map((entry) => entry.name).filter((name) => name.startsWith('.claude')), []);
  // A project file that merely starts with the same letters stays readable.
  fs.writeFileSync(work('claude.json'), '{}');
  assert.equal((await call('host.read_file', { path: work('claude.json') })).content, '{}');
});

test('the engine\'s own state in ~/.toolsenabled is not writable through the host file tools, and its databases are not read', async (t) => {
  const { call, refusal } = sandboxCaller(t);
  const store = require('../src/lib/owner-request-store');
  const filed = store.fileTask({ scope: 'global', words: 'Tidy the release notes.', filedBy: 'codex' });
  const stateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  const ledger = path.join(stateRoot, 'reports', 'OWNER-REQUEST-LEDGER.json');
  // The ledger can be read (ledger.read shows the same), but not rewritten:
  // a patch here turned an agent's own record into one "from owner".
  const read = await call('host.read_file', { path: ledger });
  const [filedBy] = read.content.match(/"filedBy":\s*"codex"/);
  const patched = await refusal('host.patch_file', { path: ledger, oldText: filedBy, newText: '"filedBy": "owner"' });
  assert.equal(patched.code, 'HOST_PATH_WRITE_PROTECTED');
  assert.match(patched.text, /runtime state and control roots/);
  assert.equal(store.findRecord(filed.id).filedBy, 'codex');
  fs.mkdirSync(path.join(stateRoot, 'openshell-tree'), { recursive: true });
  for (const target of [path.join(stateRoot, 'state', 'planted.json'), path.join(stateRoot, 'logs', 'actions.jsonl'),
    path.join(stateRoot, 'KILLSWITCH'), path.join(stateRoot, 'openshell-tree', 'tree.json'), ledger]) {
    const refused = await refusal('host.write_file', { path: target, content: '{}' });
    assert.match(refused.code, /^HOST_PATH_(WRITE_PROTECTED|FORBIDDEN)$/, target);
  }
  assert.equal(fs.existsSync(path.join(stateRoot, 'KILLSWITCH')), false);
  // The databases under state/ (tasks, memory, the search index, file receipts) are not exposed.
  const database = fs.readdirSync(path.join(stateRoot, 'state'), { recursive: true }).find((name) => /\.sqlite3?$/.test(name));
  const exposed = await refusal('host.read_file', { path: path.join(stateRoot, 'state', database) });
  assert.equal(exposed.code, 'HOST_PATH_FORBIDDEN');
  // Work files beside it are unaffected.
  assert.equal((await call('host.write_file', { path: work('notes.md'), content: 'ok\n' })).created, true);
});

// Reads a file from the start in the windows a sandbox returns; each window
// starts where the last one said to read next.
async function readInWindows(call, file, limit = 50) {
  const windows = [];
  let result = await call('host.read_file', { path: file });
  windows.push(result);
  while (result.truncated) {
    assert.ok(windows.length < limit, `more than ${limit} windows`);
    result = await call('host.read_file', { path: file, startByte: result.nextStartByte });
    windows.push(result);
  }
  return windows;
}

test('long non-UTF8/binary inputs refuse explicitly while valid UTF8 text remains readable to its end', async (t) => {
  const { call, refusal } = sandboxCaller(t);
  // "café" saved as Latin-1 in the first and the second 32 KiB window.
  const latin1 = Buffer.alloc(40000, 0x61);
  latin1.write('café ', 1000, 'latin1');
  latin1.write('café ', 35000, 'latin1');
  fs.writeFileSync(work('latin1.txt'), latin1);
  const latin1Refusal = await refusal('host.read_file', { path: work('latin1.txt') });
  assert.equal(latin1Refusal.code, 'HOST_FILE_TEXT_ENCODING_UNSUPPORTED');
  assert.doesNotMatch(latin1Refusal.text, /\uFFFD/);
  // Every byte value, as in a binary file.
  const binary = Buffer.from(Array.from({ length: 40000 }, (_, i) => (i * 7919) % 256));
  fs.writeFileSync(work('binary.dat'), binary);
  assert.equal((await refusal('host.read_file', { path: work('binary.dat') })).code, 'HOST_FILE_BINARY_UNSUPPORTED');
  const text = 'déjà vu 日本語 😀\n'.repeat(4000);
  fs.writeFileSync(work('long-utf8.txt'), text);
  const windows = await readInWindows(call, work('long-utf8.txt'));
  assert.ok(windows.length >= 2);
  assert.equal(windows.at(-1).endByte, Buffer.byteLength(text));
  assert.equal(windows.map(window => window.content).join(''), text);
  // A window that starts or ends inside a real character is still refused.
  fs.writeFileSync(work('accents.txt'), 'déjà vu\n');
  for (const [startByte, endByte] of [[2, 6], [0, 2]]) {
    const cut = await refusal('host.read_file', { path: work('accents.txt'), startByte, endByte });
    assert.equal(cut.code, 'HOST_FILE_UTF8_BOUNDARY_INVALID', `${startByte}-${endByte}`);
  }
});

test('a file or folder the sandbox user may not read is refused with a sentence, not "internal error"', { skip: process.getuid?.() === 0 && 'root reads every file' }, async (t) => {
  const { refusal } = sandboxCaller(t);
  fs.writeFileSync(work('locked.txt'), 'locked');
  fs.mkdirSync(work('locked-folder'));
  fs.chmodSync(work('locked.txt'), 0);
  fs.chmodSync(work('locked-folder'), 0);
  t.after(() => { fs.chmodSync(work('locked.txt'), 0o644); fs.chmodSync(work('locked-folder'), 0o755); });
  for (const [tool, args] of [
    ['host.read_file', { path: work('locked.txt') }],
    ['host.list_dir', { path: work('locked-folder') }],
    ['host.write_file', { path: work('locked-folder', 'new.txt'), content: 'x' }]
  ]) {
    const refused = await refusal(tool, args);
    assert.doesNotMatch(refused.text, /internal error/, `${tool}: ${refused.code}`);
    assert.match(refused.text, /permission|could not be checked/, tool);
  }
});

test('a folder with thousands of entries is listed in order within what the CLIs keep, marked truncated with its total', async (t) => {
  const { call } = sandboxCaller(t);
  fs.mkdirSync(work('many'));
  const names = Array.from({ length: 3000 }, (_, i) => `entry-${String(i).padStart(4, '0')}-with-a-descriptive-name.txt`);
  for (const name of [...names].reverse()) fs.writeFileSync(work('many', name), 'x');
  const listed = await call('host.list_dir', { path: work('many') });
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= 32 * 1024, `${Buffer.byteLength(JSON.stringify(listed))} bytes`);
  assert.equal(listed.truncated, true);
  assert.equal(listed.totalEntries, 3000);
  assert.ok(listed.entries.length > 100);
  assert.deepEqual(listed.entries.map((entry) => entry.name), names.slice(0, listed.entries.length));
  assert.match(listed.note, new RegExp(`${listed.entries.length} of 3000`));
  // A folder that fits is listed whole, with nothing added.
  const few = await call('host.list_dir', { path: work() });
  assert.equal(few.truncated, undefined);
  assert.ok(few.entries.some((entry) => entry.name === 'many'));
});
