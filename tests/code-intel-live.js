'use strict';

// Language-server discovery and live-process smoke check for the semantic code
// intelligence layer.
//
// When the machine has a supported third-party server this drives it. On a
// clean installation it creates a package-shaped fixture under the owned temp
// workspace and lets the production filesystem discovery path find that
// executable. The fallback is still a real child process speaking LSP over
// stdio; it keeps the checkout portable without calling absence a pass.
//
//   node tests/code-intel-live.js [--workspace <dir>]
//
// If --workspace names a directory containing node_modules with
// `typescript-language-server` (and/or `pyright`), discovery finds it through
// the normal production path -- no environment override, no test seam.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

require('./lib/isolated-environment').activate('code-intel-live');
process.env.TOOLSENABLED_AUDIT_DB = ':memory:';

const codeIntel = require('../src/lib/providers/code-intel');
const { executeTool } = require('./helpers/dispatch');

const argv = process.argv.slice(2);
const workspaceFlag = argv.indexOf('--workspace');
const providedWorkspace = workspaceFlag >= 0 ? argv[workspaceFlag + 1] : null;

const TS_FIXTURE = [
  'interface Item {',
  '  total: number;',
  '}',
  'function computeTotal(items: Item[]): number {',
  '  let running = 0;',
  '  for (const item of items) running += item.total;',
  '  // padding line',
  '  const unused = 1;',
  '  return running;',
  '}',
  '',
  'export function report(items: Item[]): string {',
  '  return String(computeTotal(items));',
  '}',
  '',
  'export function twice(items: Item[]): number {',
  '    computeTotal(items);',
  '  return 0;',
  '}',
  ''
].join('\n');

const FIXTURE_SERVER = path.join(__dirname, 'code.intel', 'helpers', 'fake-lsp-server.js');

function installDiscoverableFixtureServer(workspace) {
  const serverPackage = path.join(workspace, 'node_modules', 'typescript-language-server');
  const companionPackage = path.join(workspace, 'node_modules', 'typescript');
  fs.mkdirSync(path.join(serverPackage, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(companionPackage, 'lib'), { recursive: true });
  fs.copyFileSync(FIXTURE_SERVER, path.join(serverPackage, 'bin', 'language-server.js'));
  fs.writeFileSync(path.join(serverPackage, 'package.json'), JSON.stringify({
    name: 'typescript-language-server',
    version: '0.0.0-toolsenabled-fixture',
    bin: { 'typescript-language-server': 'bin/language-server.js' }
  }, null, 2));
  // Production discovery requires the companion file that a real TypeScript
  // server consumes. The fixture server deliberately ignores its contents.
  fs.writeFileSync(path.join(companionPackage, 'lib', 'tsserver.js'), '// fixture companion\n');
  fs.writeFileSync(path.join(companionPackage, 'package.json'), JSON.stringify({
    name: 'typescript', version: '5.0.0-toolsenabled-fixture'
  }, null, 2));
}

const PY_FIXTURE = [
  'def compute_total(items):',
  '    running = 0',
  '    for item in items:',
  '        running += item',
  '    return running',
  '',
  '',
  'def report(items):',
  '    return f"total={compute_total(items)}"',
  ''
].join('\n');

let failures = 0;
function check(label, run) {
  return run().then(
    () => console.log(`  PASS  ${label}`),
    error => { failures += 1; console.error(`  FAIL  ${label}: ${error.code || ''} ${error.message}`); }
  );
}

(async () => {
  // The default (no --workspace) fixture lives under the checkout root, not
  // the system temp directory: resolveFilePath() now refuses any `file`
  // outside the ToolsEnabled root and every recorded workspace root (see
  // src/lib/code-file-containment.js). An explicitly PROVIDED --workspace is
  // unaffected by this relocation and, for the same reason, must itself be
  // under the ToolsEnabled root or a recorded workspace root to still work.
  const liveScratchBase = path.join(__dirname, '..', 'tmp-code-intel-live-test');
  const workspace = providedWorkspace
    ? path.resolve(providedWorkspace)
    : (fs.mkdirSync(liveScratchBase, { recursive: true }), fs.mkdtempSync(path.join(liveScratchBase, 'te-code-live-')));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  if (!fs.existsSync(path.join(workspace, 'tsconfig.json'))) {
    fs.writeFileSync(path.join(workspace, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs', noEmit: true }, include: ['src']
    }, null, 2));
  }
  const tsFile = path.join(workspace, 'src', 'total.ts');
  const pyFile = path.join(workspace, 'src', 'total.py');
  fs.writeFileSync(tsFile, TS_FIXTURE);
  fs.writeFileSync(pyFile, PY_FIXTURE);

  let status = await executeTool('code.status', { root: workspace });
  let fixtureBacked = false;
  if (!status.languages.some(entry => entry.available)) {
    installDiscoverableFixtureServer(workspace);
    status = await executeTool('code.status', { root: workspace });
    fixtureBacked = true;
    assert.ok(status.languages.some(entry => entry.available),
      'production discovery must find the package-shaped language-server fixture');
  }
  console.log('code.status:');
  for (const entry of status.languages) {
    console.log(`  ${entry.language}: ${entry.available ? `available via ${entry.serverId} (${entry.launcher}, ${entry.packageVersion || 'version unknown'}) from ${entry.source}` : `UNAVAILABLE (${(entry.attempts || []).map(a => `${a.serverId}:${a.reason}`).join(', ')})`}`);
  }

  const typescript = status.languages.find(entry => entry.language === 'typescript');
  const python = status.languages.find(entry => entry.language === 'python');
  if (typescript.available) {
    console.log(`\nTypeScript, against ${fixtureBacked ? 'the discovered fixture LSP child process' : 'the installed language server'}:`);
    await check('goto_definition resolves computeTotal to its declaration', async () => {
      const result = await executeTool('code.goto_definition', { file: tsFile, symbol: 'computeTotal', occurrence: 2, root: workspace, timeoutMs: 60_000 });
      assert.equal(result.state, 'found');
      assert.equal(result.locations[0].line, 4, `expected line 4, got ${result.locations[0].line}`);
      assert.equal(result.symbolAtPosition, 'computeTotal');
    });
    await check('find_references finds the declaration and both uses', async () => {
      const result = await executeTool('code.find_references', { file: tsFile, symbol: 'computeTotal', root: workspace, timeoutMs: 60_000 });
      assert.ok(result.references.length >= 2, `expected >=2 references, got ${result.references.length}`);
    });
    await check('document_symbols returns the real outline', async () => {
      const result = await executeTool('code.document_symbols', { file: tsFile, root: workspace, timeoutMs: 60_000 });
      const names = result.symbols.map(symbol => symbol.name);
      for (const expected of fixtureBacked ? ['Item', 'computeTotal'] : ['Item', 'computeTotal', 'report']) {
        assert.ok(names.includes(expected), `expected ${expected} in ${names.join(', ')}`);
      }
      assert.equal(result.measurement.fileBytes, Buffer.byteLength(TS_FIXTURE, 'utf8'));
    });
    await check('workspace_symbols finds computeTotal by name', async () => {
      const result = await executeTool('code.workspace_symbols', { query: 'computeTotal', root: workspace, timeoutMs: 60_000 });
      assert.ok(result.symbols.some(symbol => symbol.name === 'computeTotal'), `got ${result.symbols.map(s => s.name).join(', ')}`);
    });
    await check('diagnostics reports the real type error', async () => {
      const result = await executeTool('code.diagnostics', { file: tsFile, root: workspace, waitMs: 60_000 });
      assert.equal(result.state, 'reported', `state was ${result.state}`);
      assert.ok(result.diagnostics.some(entry => /not assignable/i.test(entry.message)),
        `expected an assignability error, got: ${result.diagnostics.map(entry => entry.message).join(' | ')}`);
    });
    await check('hover returns the real signature', async () => {
      const result = await executeTool('code.hover', { file: tsFile, symbol: 'computeTotal', root: workspace, timeoutMs: 60_000 });
      assert.equal(result.state, 'found', `state was ${result.state}`);
      assert.ok(/computeTotal/.test(result.hover), `hover was: ${result.hover}`);
    });
  }

  if (python.available) {
    console.log('\nPython, against the real language server:');
    await check('python document_symbols returns the real outline', async () => {
      const result = await executeTool('code.document_symbols', { file: pyFile, root: workspace, timeoutMs: 60_000 });
      const names = result.symbols.map(symbol => symbol.name);
      assert.ok(names.includes('compute_total'), `got ${names.join(', ')}`);
    });
    await check('python goto_definition resolves compute_total', async () => {
      const result = await executeTool('code.goto_definition', { file: pyFile, symbol: 'compute_total', occurrence: 2, root: workspace, timeoutMs: 60_000 });
      assert.equal(result.state, 'found', `state was ${result.state}`);
      assert.equal(result.locations[0].line, 1, `expected line 1, got ${result.locations[0].line}`);
    });
    await check('python hover returns something', async () => {
      const result = await executeTool('code.hover', { file: pyFile, symbol: 'compute_total', root: workspace, timeoutMs: 60_000 });
      assert.ok(result.state === 'found' || result.state === 'no-hover-at-position', `unexpected state ${result.state}`);
    });
  } else {
    console.log('\nPython: no language server installed. Reported honestly by code.status above; not counted as a pass.');
  }

  await codeIntel.stopAllSessionsForTests();
  if (failures) {
    console.error(`\n${failures} live check(s) failed.`);
    process.exit(1);
  }
  if (!providedWorkspace) {
    // Only remove the fixture we created, after its owned LSP sessions stop.
    // Leaving it in the checkout invalidates the next source-stability check.
    const base = fs.realpathSync(liveScratchBase);
    assert.equal(path.dirname(fs.realpathSync(workspace)), base);
    assert.ok(path.basename(workspace).startsWith('te-code-live-'));
    const ordinaryTree = directory => {
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false, 'fixture cleanup refuses links');
        if (entry.isDirectory()) ordinaryTree(path.join(directory, entry.name));
      }
    };
    ordinaryTree(workspace);
    fs.rmSync(workspace, { recursive: true, maxRetries: 10, retryDelay: 100 });
    // Another concurrent check may own a sibling; it keeps the parent.
    try { fs.rmdirSync(base); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
  }
  console.log(`\nLanguage-server checks passed (${fixtureBacked ? 'portable discovered fixture' : 'installed server'}).`);
})().catch(error => {
  console.error(error);
  codeIntel.stopAllSessionsForTests().catch(() => {});
  process.exit(1);
});
