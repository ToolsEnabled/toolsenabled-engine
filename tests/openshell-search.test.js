'use strict';

// Local search as an agent inside an OpenShell sandbox uses it: the working
// folder under the sandbox home, files agents and the person copy in, edit,
// delete and lock, and several agents indexing at once.

const { useSandboxHome } = require('./lib/openshell-sandbox-home');
const HOME = useSandboxHome('openshell-search');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORK = path.join(HOME, 'work');
const registry = require('../src/lib/tool-registry');
registry.confinedWorkspaceRoots = () => [WORK];
const search = require('../src/lib/search');
test.after(() => search.close());

const folder = (name, files) => {
  const root = path.join(WORK, name);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
};
const names = (result) => result.matches.map((match) => path.relative(WORK, match.path));

test('files the host file tools refuse as sign-in or credential stores are never indexed or shown in snippets', async () => {
  // Shapes of real sign-in files: Codex's auth.json, Claude Code's
  // .credentials.json and .claude.json, a token and a cookie store.
  const root = folder('creds', {
    'notes.md': 'The okapi project notes.',
    'auth.json': '{"tokens":{"id_token":"eyJhbGciOiJSUzI1NiJ9.eyJva2FwaSI6MX0.c2ln","refresh_token":"rt_okapi_made_up"}}',
    '.credentials.json': '{"claudeAiOauth":{"accessToken":"okapi made up"}}',
    '.claude.json': '{"primaryApiKey":"okapi made up"}',
    'token.json': '{"token":"okapi made up"}',
    'cookies.json': '{"okapi":"made up"}'
  });
  const run = await search.indexPath({ root, embedder: 'lexical' });
  assert.equal(run.filesIndexed, 1);
  assert.equal(run.filesSensitiveSkipped, 5);
  assert.deepEqual(names(await search.query({ query: 'okapi' })), ['creds/notes.md']);
  assert.deepEqual(names(await search.query({ query: 'refresh_token rt_okapi_made_up' })).filter((name) => name !== 'creds/notes.md'), []);
});

test('an index made before a file counted as a credential store no longer returns it', async () => {
  const root = folder('older', { 'plain.md': 'the wombat ledger lines' });
  await search.indexPath({ root, embedder: 'lexical' });
  // What an earlier index holds for a file this rule now refuses.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(process.env.TOOLSENABLED_STATE_ROOT, 'state', 'search-index.sqlite'));
  const stored = path.join(root, 'plain.md');
  const renamed = path.join(root, 'auth.json');
  for (const table of ['chunks', 'files', 'memberships']) db.prepare(`UPDATE ${table} SET path = ? WHERE path = ?`).run(renamed, stored);
  db.close();
  assert.equal(names(await search.query({ query: 'wombat ledger' })).includes('older/auth.json'), false);
});

test('a query never returns a deleted file, marks one edited since indexing, and a folder deleted from disk can be dropped', async () => {
  const root = folder('changing', { 'a.md': 'The zebra crossing is near the library.\n', 'sub/b.txt': 'Quantum flux capacitor notes.\n' });
  await search.indexPath({ root, embedder: 'lexical' });
  fs.writeFileSync(path.join(root, 'a.md'), 'Now it is about giraffes only.\n');
  fs.rmSync(path.join(root, 'sub', 'b.txt'));
  const flux = await search.query({ query: 'quantum flux capacitor', root });
  assert.equal(names(flux).includes(path.join('changing', 'sub', 'b.txt')), false);
  const zebra = await search.query({ query: 'zebra crossing library', root });
  assert.deepEqual(names(zebra), ['changing/a.md']);
  assert.equal(zebra.matches[0].stale, true);
  assert.match(zebra.note, /changed since it was indexed.*search\.index/);
  // The whole folder goes; indexing it again drops what the index still held.
  fs.rmSync(root, { recursive: true, force: true });
  const dropped = await search.indexPath({ root, embedder: 'lexical' });
  assert.equal(dropped.filesRemoved, 2);
  assert.equal(dropped.rootMissing, true);
  assert.equal((await search.status()).roots.some((entry) => entry.root === root), false);
  // A folder that never existed is still refused.
  await assert.rejects(search.indexPath({ root: path.join(WORK, 'never-here'), embedder: 'lexical' }), { code: 'SEARCH_ROOT_INVALID' });
});

test('a file or folder the sandbox user cannot read is skipped and counted, not the end of the whole index run', { skip: process.getuid?.() === 0 && 'root reads every file' }, async () => {
  const root = folder('locked', { 'open.md': 'the heron migration notes', 'shut.md': 'heron secrets', 'inner/deep.md': 'heron deep notes' });
  fs.chmodSync(path.join(root, 'shut.md'), 0);
  fs.chmodSync(path.join(root, 'inner'), 0);
  try {
    const run = await search.indexPath({ root, embedder: 'lexical' });
    assert.equal(run.filesIndexed, 1);
    assert.equal(run.filesUnreadable, 2);
    assert.deepEqual(names(await search.query({ query: 'heron migration', root })), ['locked/open.md']);
  } finally {
    fs.chmodSync(path.join(root, 'inner'), 0o755);
    fs.chmodSync(path.join(root, 'shut.md'), 0o644);
  }
});

test('several agents indexing at once all finish; none is told "internal error" because another holds the index', async () => {
  const root = folder('shared', Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`note-${i}.md`, `note ${i} about herons ${'text '.repeat(300)}`])));
  const { spawn } = require('node:child_process');
  // Each agent's server is its own process with its own connection to the index.
  const agent = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', `
      const os = require('node:os');
      const userInfo = os.userInfo;
      os.userInfo = (options) => ({ ...userInfo(options), homedir: ${JSON.stringify(HOME)} });
      require(${JSON.stringify(require.resolve('../src/lib/tool-registry'))}).confinedWorkspaceRoots = () => [${JSON.stringify(WORK)}];
      require(${JSON.stringify(require.resolve('../src/lib/search'))}).indexPath({ root: ${JSON.stringify(root)}, embedder: 'lexical' })
        .then((run) => { console.log(JSON.stringify(run)); process.exit(0); }, (error) => { console.log(JSON.stringify({ code: error.code, message: error.message })); process.exit(1); });
    `], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', (status) => resolve({ status, out: out.trim() }));
  });
  const runs = await Promise.all([agent(), agent(), agent(), agent()]);
  assert.deepEqual(runs.map((run) => run.status), [0, 0, 0, 0], runs.map((run) => run.out).join('\n'));
  assert.equal(runs.map((run) => JSON.parse(run.out)).reduce((sum, run) => sum + run.filesIndexed + run.filesSkipped, 0), 4 * 300);
});
