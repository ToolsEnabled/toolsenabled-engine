'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fileHash, validateAssertionEvidence } = require('../tools/lib/builtin-assertion-evidence');

const engineRoot = path.resolve(__dirname, '..');
const launcher = path.join(engineRoot, 'tools', 'measure-builtin-assertions.js');
const expectedHarness = [path.join(engineRoot, 'tools', 'lib', 'builtin-assertion-evidence.js'), launcher]
  .map(file => ({ path: file, sha256: fileHash(file) }));
const expectedNode = { path: process.execPath, version: process.version, sha256: fileHash(process.execPath) };

function run(t, source, { files = {}, scope = ['entry.cjs'], args = [], excluded = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'te-assertion-measurement-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries({ 'entry.cjs': source, ...files })) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return execute(root, path.join(root, 'entry.cjs'), scope.map(relative => path.join(root, relative)), path.join(root, 'trace.jsonl'), args,
    excluded.map(relative => path.join(root, relative)));
}

function execute(root, entry, scope, tracePath, args = [], excluded = []) {
  const request = { schemaVersion: 1, nonce: crypto.randomBytes(24).toString('hex'), root, entry, args,
    modules: scope.map(file => ({ path: file, sha256: fileHash(file) })),
    excludedAssertions: excluded.map(file => ({ path: file, sha256: fileHash(file) })), tracePath };
  const requestPath = `${tracePath}.request.json`;
  fs.writeFileSync(requestPath, JSON.stringify(request));
  // These fixtures contain no provider, network, external tool, or owner paths.
  // No preload is inherited by any hypothetical child of the measured entry.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [launcher, '--request', requestPath], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
  });
  const trace = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8') : '';
  const input = { trace, request, result, expectedHarness, expectedNode, expectedPlatform: process.platform, expectedCwd: root };
  return { ...input, check: changes => validateAssertionEvidence({ ...input, ...changes }) };
}

test('records actual loop calls, destructured methods, aliases, and the original CommonJS main identity', t => {
  const f = run(t, `const assert = require('node:assert/strict');
    const { equal } = assert;
    for (let i = 0; i < 5; i++) equal(i, i);
    assert.ok(require.main === module);
    assert.equal(process.argv[2], 'literal argument');
    assert.strict(true);
    assert(true);
    assert.equal(assert.equal, assert.strictEqual);
    console.log('some PASS counter says 9999');`, { args: ['literal argument'] });
  assert.equal(f.result.status, 0, f.result.stderr);
  const evidence = f.check();
  assert.equal(evidence.unit, 'outermost-builtin-assert-call');
  assert.deepEqual(evidence.counts, { assertions: 10, pass: 10, fail: 0, pending: 0 });
});

test('nested expected failures belong to their real containing assertion', t => {
  const f = run(t, `const assert = require('assert');
    assert.throws(() => assert.fail('expected'), assert.AssertionError);
    assert.strict.throws(() => assert.strict.equal(1, 2), assert.AssertionError);
    assert.doesNotThrow(() => assert.ok(true));
    (async () => {
      await assert.rejects(async () => assert.strict.equal(1, 2), assert.AssertionError);
      await assert.doesNotReject(async () => assert.ok(true));
    })();`);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.deepEqual(f.check().counts, { assertions: 5, pass: 5, fail: 0, pending: 0 });
});

test('a caught real assertion failure remains failed despite a successful manual summary', t => {
  const f = run(t, `const assert = require('node:assert');
    try { assert.equal(1, 2); } catch {}
    assert.equal(3, 3);
    console.log('all tests passed');`);
  assert.equal(f.result.status, 1);
  assert.equal(f.check().status, 'failed');
  assert.deepEqual(f.check().counts, { assertions: 2, pass: 1, fail: 1, pending: 0 });
});

test('an awaited failed async assertion cannot be hidden by catching its rejection', t => {
  const f = run(t, `const assert = require('node:assert/strict');
    (async () => { try { await assert.rejects(async () => {}); } catch {} })();`);
  assert.equal(f.result.status, 1);
  assert.deepEqual(f.check().counts, { assertions: 1, pass: 0, fail: 1, pending: 0 });
});

test('a permanently pending assertion prevents completion even when Node naturally exits', t => {
  const f = run(t, `const assert = require('node:assert/strict');
    assert.ok(true);
    assert.rejects(new Promise(() => {}));`);
  assert.equal(f.result.status, 2);
  assert.throws(() => f.check(), /unfinished-async-assertions/);
});

test('unrelated concurrent assertions remain visible while an expected asynchronous failure is pending', t => {
  const f = run(t, `const assert = require('node:assert/strict');
    let finish;
    const expected = assert.rejects(new Promise((resolve, reject) => { finish = reject; }));
    assert.equal(1, 1);
    finish(new Error('expected'));
    expected.then(() => assert.ok(true));`);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.check().counts.assertions, 3);
});

test('detached work after its enclosing assertion completes is measured even when it catches its failure', t => {
  const f = run(t, `const assert = require('node:assert/strict');
    assert.doesNotThrow(() => { setTimeout(() => { try { assert.equal(1, 2); } catch {} }, 1); });`);
  assert.equal(f.result.status, 1);
  assert.deepEqual(f.check().counts, { assertions: 2, pass: 1, fail: 1, pending: 0 });
});

test('no assertions, an explicit early successful exit, and printed skips cannot earn coverage', t => {
  for (const [source, pattern] of [
    [`require('node:assert/strict'); console.log('PASS 5');`, /zero-measured-assertions/],
    [`require('node:assert/strict').ok(true); process.exit(0);`, /natural-completion-not-observed|disagrees with process exit/],
    [`require('node:assert/strict').ok(true); console.log('SKIP Windows fixture unavailable');`, /skipped or unexecuted/],
    [`require('node:assert/strict').ok(true); console.log('\\u001b[33mSKIP colored diagnostic\\u001b[0m');`, /skipped or unexecuted/],
    [`require('node:assert/strict').ok(true); console.log('5 passed; 1 skipped');`, /skipped or unexecuted/]
  ]) {
    const f = run(t, source);
    assert.throws(() => f.check(), pattern);
  }
});

test('production assertions are excluded and undeclared fixture imports remain an explicit gap', t => {
  const source = `const assert = require('node:assert/strict'); require('./src/product.cjs'); assert.ok(true);`;
  const f = run(t, source, { files: { 'src/product.cjs': `require('node:assert/strict').ok(true);` }, excluded: ['src/product.cjs'] });
  assert.equal(f.check().counts.assertions, 1);
  assert.match(f.trace, /excluded-production-import/);
  const unreviewed = run(t, source, { files: { 'src/product.cjs': `require('node:assert/strict').ok(true);` } });
  assert.throws(() => unreviewed.check(), /unmeasured-fixture-import/,
    'a filename outside tests cannot silently exclude an unreviewed assertion helper');
  const missing = run(t, `require('node:assert/strict').ok(true); require('./tests/helper.cjs');`, {
    files: { 'tests/helper.cjs': `require('node:assert/strict').ok(true);` }
  });
  assert.throws(() => missing.check(), /unmeasured-fixture-import/);
  const scoped = run(t, `require('node:assert/strict').ok(true); require('./tests/helper.cjs');`, {
    files: { 'tests/helper.cjs': `require('node:assert/strict').ok(true);` }, scope: ['entry.cjs', 'tests/helper.cjs']
  });
  assert.equal(scoped.check().counts.assertions, 2);
});

test('temporary loader replacement and attempted proxy mutation cannot silently weaken measurement', t => {
  const loader = run(t, `const assert = require('node:assert/strict');
    const Module = require('node:module'); const original = Module._load;
    Module._load = function () { return original.apply(this, arguments); }; Module._load = original;
    assert.ok(true);`);
  assert.throws(() => loader.check(), /module-loader-replaced/);
  const proxy = run(t, `const assert = require('node:assert/strict');
    try { assert.equal = () => {}; } catch {} assert.ok(true);`);
  assert.throws(() => proxy.check(), /assertion-proxy-mutated/);
});

test('assertions registered after the exit terminator are detected instead of being omitted', t => {
  const f = run(t, `const assert = require('node:assert/strict'); assert.ok(true);
    process.on('exit', () => assert.ok(true));`);
  assert.throws(() => f.check(), /one final completion/);
});

test('an explicit exit after beforeExit cannot impersonate natural completion', t => {
  const f = run(t, `const assert = require('node:assert/strict'); assert.ok(true);
    process.once('beforeExit', () => { setImmediate(() => process.exit(0)); });`);
  assert.throws(() => f.check(), /natural-completion|explicit-exit|process exit|final completion/);
});

test('a temporary loader descriptor replacement cannot remove and restore observation silently', t => {
  const f = run(t, `const assert = require('node:assert/strict'); const Module = require('node:module');
    const descriptor = Object.getOwnPropertyDescriptor(Module, '_load'), original = Module._load;
    Object.defineProperty(Module, '_load', { configurable: true, writable: true, value: original });
    Object.defineProperty(Module, '_load', descriptor); assert.ok(true);`);
  assert.throws(() => f.check(), /natural-completion|zero-measured|loader|process exit/);
});

test('temporary exit replacement remains incomplete after restoring the observed function', t => {
  const f = run(t, `const assert = require('node:assert/strict'); const original = process.exit;
    process.exit = () => {}; process.exit = original; assert.ok(true);`);
  assert.throws(() => f.check(), /process-exit-replaced/);
});

test('assertion exclusions bind the reviewed bytes and cannot be forged in a trace', t => {
  const f = run(t, `const assert = require('node:assert/strict'); require('./src/product.cjs'); assert.ok(true);`, {
    files: { 'src/product.cjs': `require('node:assert/strict').ok(true);` }, excluded: ['src/product.cjs']
  });
  assert.equal(f.check().counts.assertions, 1);
  assert.throws(() => f.check({ request: { ...f.request, excludedAssertions: [] } }), /identity mismatch/);
  const events = f.trace.trimEnd().split('\n').map(line => JSON.parse(line));
  events.find(event => event.event === 'excluded-production-import').fixture = f.request.entry;
  assert.throws(() => f.check({ trace: events.map(event => JSON.stringify(event)).join('\n') + '\n' }), /invalid excluded assertion import/);
  fs.appendFileSync(f.request.excludedAssertions[0].path, '\n// changed excluded assertion authority\n');
  assert.throws(() => f.check(), /changed or overlapping assertion exclusion/);
});

test('the raw trace, measured source, runtime, and actual process status must reconcile', t => {
  const f = run(t, `require('node:assert/strict').equal(1, 1);`);
  assert.equal(f.check().status, 'passed');
  assert.throws(() => f.check({ trace: f.trace.replace('"pass":1', '"pass":9') }), /not the measured event count/);
  assert.throws(() => f.check({ trace: f.trace.slice(0, -1) }), /truncated/);
  assert.throws(() => f.check({ result: { ...f.result, status: 1 } }), /process exit/);
  assert.throws(() => f.check({ result: { ...f.result, signal: 'SIGTERM' } }), /did not complete/);
  assert.throws(() => f.check({ result: { ...f.result, pid: f.result.pid + 1 } }), /process identity/);
  assert.throws(() => f.check({ result: { ...f.result, pid: undefined } }), /process identity/);
  assert.throws(() => f.check({ request: { ...f.request, nonce: 'f'.repeat(48) } }), /identity mismatch/);
  assert.throws(() => f.check({ expectedPlatform: process.platform === 'win32' ? 'linux' : 'win32' }), /runtime identity/);
  assert.throws(() => f.check({ expectedHarness: [] }), /runtime identity/);
  fs.appendFileSync(f.request.entry, '\n// changed after execution\n');
  assert.throws(() => f.check(), /changed measured fixture source/);
});

test('source mutation during execution remains incomplete even if a new source hash is supplied afterward', t => {
  const f = run(t, `require('node:assert/strict').ok(true);
    require('node:fs').appendFileSync(__filename, '\\n// changed\\n');`);
  const request = { ...f.request, modules: f.request.modules.map(source => ({ ...source, sha256: fileHash(source.path) })) };
  assert.equal(f.result.status, 2);
  assert.match(f.trace, /measured-source-changed/);
  assert.throws(() => f.check({ request }), /identity mismatch/);
});

test('measures the existing pure cloud lifecycle assertion program without rewriting its checks', t => {
  const output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'te-cloud-assertion-proof-')));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const entry = path.join(engineRoot, 'tests', 'cloud-agent-state-machine.test.js');
  const before = fileHash(entry);
  const f = execute(engineRoot, entry, [entry], path.join(output, 'trace.jsonl'));
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(fileHash(entry), before);
  assert.match(f.result.stdout, /cloud-agent state-machine tests passed/);
  // Independent expected actual outer calls: 3 bind/submit successes,
  // 20 accepted observations, 11 throws contracts, and 4 canAdvance values.
  assert.deepEqual(f.check().counts, { assertions: 38, pass: 38, fail: 0, pending: 0 });
});
