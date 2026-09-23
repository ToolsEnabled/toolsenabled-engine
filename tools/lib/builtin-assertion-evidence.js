'use strict';

// Measurement for reviewed CommonJS assertion programs. This does not replace
// process isolation, source review, or the process guardian. The unit is a
// completed outermost call to the real Node assertion library, never a file or
// a program's own "PASS" counter. Nested assertions belong to their containing
// assertion (notably throws/rejects) and cannot independently turn red/green.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const { stripVTControlCharacters } = require('node:util');

const ASSERT_MODULES = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);
const ASSERT_METHODS = new Set(['ok', 'fail', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual',
  'deepStrictEqual', 'notDeepStrictEqual', 'strictEqual', 'notStrictEqual', 'throws', 'doesNotThrow',
  'rejects', 'doesNotReject', 'ifError', 'match', 'doesNotMatch', 'partialDeepStrictEqual']);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => sha256(fs.readFileSync(file));
const isInside = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };

function validateRequest(request) {
  if (!request || request.schemaVersion !== 1 || !/^[a-f0-9]{32,}$/.test(request.nonce || '')) throw new Error('invalid assertion measurement request');
  const root = path.resolve(request.root || '');
  if (root !== request.root || fs.realpathSync(root) !== root) throw new Error('measurement root must be a real absolute directory');
  if (!Array.isArray(request.modules) || !request.modules.length || request.modules.length > 100) throw new Error('explicit reviewed fixture module scope is required');
  const files = new Set();
  for (const source of request.modules) {
    if (!source || !isInside(root, source.path) || path.resolve(source.path) !== source.path
        || fs.realpathSync(source.path) !== source.path || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) throw new Error('invalid measured fixture source');
    if (files.has(source.path) || fileHash(source.path) !== source.sha256) throw new Error('duplicate or changed measured fixture source');
    files.add(source.path);
  }
  if (!files.has(request.entry)) throw new Error('entry must be in the reviewed fixture module scope');
  const excludedAssertions = request.excludedAssertions || [];
  if (!Array.isArray(excludedAssertions)) throw new Error('explicit assertion exclusions must be an array');
  const excluded = new Set();
  for (const source of excludedAssertions) {
    if (!source || !isInside(root, source.path) || path.resolve(source.path) !== source.path || fs.realpathSync(source.path) !== source.path
        || !/^[a-f0-9]{64}$/.test(source.sha256 || '') || fileHash(source.path) !== source.sha256
        || files.has(source.path) || excluded.has(source.path)) throw new Error('invalid, changed or overlapping assertion exclusion');
    excluded.add(source.path);
  }
  if (request.sourceClosure !== undefined) {
    if (!Array.isArray(request.sourceClosure) || !request.sourceClosure.length) throw new Error('invalid reviewed source closure');
    const closure = new Set();
    for (const source of request.sourceClosure) {
      if (!source || !isInside(root, source.path) || path.resolve(source.path) !== source.path
          || fs.realpathSync(source.path) !== source.path || !/^[a-f0-9]{64}$/.test(source.sha256 || '')
          || closure.has(source.path) || fileHash(source.path) !== source.sha256) throw new Error('changed or invalid reviewed source closure');
      closure.add(source.path);
    }
    if ([...files].some(file => !closure.has(file))) throw new Error('reviewed source closure omits a measured fixture');
    if ([...excluded].some(file => !closure.has(file))) throw new Error('reviewed source closure omits an assertion exclusion');
  }
  if (request.expectedAssertions !== undefined && (!Number.isSafeInteger(request.expectedAssertions) || request.expectedAssertions < 1)) throw new Error('invalid reviewed assertion denominator');
  if (!Array.isArray(request.args) || request.args.some(value => typeof value !== 'string')) throw new Error('entry arguments must be explicit strings');
  if (!path.isAbsolute(request.tracePath) || files.has(request.tracePath)) throw new Error('a separate absolute trace path is required');
  return { ...request, excludedAssertions };
}

function installMeasurement(rawRequest) {
  const request = validateRequest(rawRequest);
  const scopes = new Set(request.modules.map(source => source.path));
  const excludedAssertions = new Set(request.excludedAssertions.map(source => source.path));
  const closure = request.sourceClosure ? new Set(request.sourceClosure.map(source => source.path)) : null;
  const originalLoad = Module._load;
  const loadDescriptor = Object.getOwnPropertyDescriptor(Module, '_load');
  const write = fs.writeSync.bind(fs);
  const fd = fs.openSync(request.tracePath, 'wx', 0o600);
  const assertionContext = new AsyncLocalStorage();
  const promisesThen = Function.call.bind(Promise.prototype.then);
  let sequence = 0;
  let nextId = 0;
  let naturalExit = false;
  const pending = new Set();
  const importedBy = new Set();
  const issues = new Set();
  const counts = { assertions: 0, pass: 0, fail: 0, pending: 0 };
  const emit = event => write(fd, `${JSON.stringify({ sequence: sequence++, ...event })}\n`);
  const issue = reason => { if (!issues.has(reason)) { issues.add(reason); emit({ event: 'integrity-issue', reason }); } };
  const harness = [__filename, path.resolve(__dirname, '..', 'measure-builtin-assertions.js')].map(file => ({ path: file, sha256: fileHash(file) }));
  const node = { path: process.execPath, version: process.version, sha256: fileHash(process.execPath) };
  emit({ event: 'begin', schemaVersion: 1, kind: 'builtin-assert-invocations', unit: 'outermost-builtin-assert-call',
    nonce: request.nonce, root: request.root, entry: request.entry, args: request.args,
    modules: request.modules, excludedAssertions: request.excludedAssertions, sourceClosure: request.sourceClosure, expectedAssertions: request.expectedAssertions,
    harness, node, platform: process.platform, pid: process.pid, cwd: process.cwd() });

  function invoke(actual, method, fixture, receiver, args) {
    if (assertionContext.getStore()?.active) return Reflect.apply(actual, receiver, args);
    const context = { active: true };
    const id = ++nextId;
    counts.assertions++;
    pending.add(id);
    emit({ event: 'assertion-start', id, method, fixture });
    const finish = (status, error) => {
      if (!pending.delete(id)) { issue('assertion-completed-twice'); return; }
      context.active = false;
      counts[status === 'passed' ? 'pass' : 'fail']++;
      emit({ event: 'assertion-result', id, status,
        ...(error ? { error: { name: String(error.name || 'Error'), code: typeof error.code === 'string' ? error.code : null } } : {}) });
    };
    try {
      const result = assertionContext.run(context, () => Reflect.apply(actual, receiver, args));
      if (result instanceof Promise) return promisesThen(result,
        value => { finish('passed'); return value; }, error => { finish('failed', error); throw error; });
      finish('passed');
      return result;
    } catch (error) { finish('failed', error); throw error; }
  }

  const proxyCaches = new Map();
  function assertionProxy(actual, fixture, method = 'ok') {
    let cache = proxyCaches.get(fixture);
    if (!cache) { cache = new Map(); proxyCaches.set(fixture, cache); }
    if (cache.has(actual)) return cache.get(actual);
    const target = function measuredAssertion(...args) { return invoke(actual, method, fixture, actual, args); };
    const proxy = new Proxy(target, {
      set() { issue('assertion-proxy-mutated'); return false; },
      defineProperty() { issue('assertion-proxy-mutated'); return false; },
      deleteProperty() { issue('assertion-proxy-mutated'); return false; }
    });
    cache.set(actual, proxy);
    for (const key of Object.keys(actual)) {
      const value = actual[key];
      if (key === 'strict') Object.defineProperty(target, key, { value: assertionProxy(value, fixture), enumerable: true });
      else if (ASSERT_METHODS.has(key)) Object.defineProperty(target, key, { enumerable: true,
        value: assertionProxy(value, fixture, key) });
      else if (key === 'AssertionError') Object.defineProperty(target, key, { value, enumerable: true });
      else Object.defineProperty(target, key, { enumerable: true, get() { issue(`unsupported-assertion-api:${key}`); return value; } });
    }
    Object.freeze(target);
    return proxy;
  }

  function measuredLoad(specifier, parent, isMain) {
    const fixture = parent && parent.filename;
    if (closure && (closure.has(fixture) || (isMain && specifier === request.entry))) {
      const resolved = Module._resolveFilename(specifier, parent, isMain);
      if (!Module.isBuiltin(resolved)) {
        if (!closure.has(resolved)) issue(`unreviewed-source-import:${resolved}`);
        emit({ event: 'source-import', file: resolved, requiredBy: fixture || null });
      }
    }
    const value = Reflect.apply(originalLoad, this, arguments);
    if (ASSERT_MODULES.has(specifier) && scopes.has(fixture)) {
      importedBy.add(fixture);
      emit({ event: 'assertion-import', fixture, specifier });
      return assertionProxy(value, fixture);
    }
    if (ASSERT_MODULES.has(specifier) && fixture && isInside(request.root, fixture)) {
      const relative = path.relative(request.root, fixture).replaceAll('\\', '/');
      if (excludedAssertions.has(fixture)) emit({ event: 'excluded-production-import', fixture, specifier });
      else issue(`unmeasured-fixture-import:${relative}`);
    }
    if ((specifier === 'node:test' || specifier === 'test') && scopes.has(fixture)) issue('node-test-requires-its-native-reporter');
    return value;
  }

  let currentLoad = measuredLoad;
  const loadGet = () => currentLoad;
  const loadSet = value => { issue('module-loader-replaced'); currentLoad = value; };
  // A descriptor replacement cannot bypass the setter and then restore it.
  // Assignments retain their normal value semantics, but invalidate coverage.
  Object.defineProperty(Module, '_load', { configurable: false, enumerable: loadDescriptor.enumerable, get: loadGet, set: loadSet });
  const originalExit = process.exit;
  const observedExit = function (...args) {
    naturalExit = false;
    issue('explicit-exit');
    return Reflect.apply(originalExit, this, args);
  };
  let currentExit = observedExit;
  const exitGet = () => currentExit;
  const exitSet = value => { issue('process-exit-replaced'); currentExit = value; };
  Object.defineProperty(process, 'exit', { configurable: false, enumerable: Object.getOwnPropertyDescriptor(process, 'exit').enumerable,
    get: exitGet, set: exitSet });
  process.on('beforeExit', () => { naturalExit = true; });
  process.on('exit', code => {
    const descriptor = Object.getOwnPropertyDescriptor(Module, '_load');
    if (descriptor.get !== loadGet || descriptor.set !== loadSet || currentLoad !== measuredLoad) issue('module-loader-integrity-lost');
    if (currentExit !== observedExit) issue('process-exit-integrity-lost');
    if (!naturalExit) issue('natural-completion-not-observed');
    for (const source of request.modules) {
      if (!importedBy.has(source.path)) issue(`declared-fixture-did-not-import-assert:${path.relative(request.root, source.path)}`);
    }
    for (const source of request.sourceClosure || [...request.modules, ...request.excludedAssertions]) {
      try { if (fileHash(source.path) !== source.sha256) issue('measured-source-changed'); }
      catch { issue('measured-source-unreadable'); }
    }
    for (const source of [...harness, node]) {
      try { if (fileHash(source.path) !== source.sha256) issue('measurement-runtime-changed'); }
      catch { issue('measurement-runtime-unreadable'); }
    }
    if (!counts.assertions) issue('zero-measured-assertions');
    if (request.expectedAssertions !== undefined && counts.assertions !== request.expectedAssertions) issue('reviewed-assertion-denominator-mismatch');
    counts.pending = pending.size;
    if (counts.pending) issue('unfinished-async-assertions');
    if (counts.fail && code === 0) process.exitCode = 1;
    else if (issues.size && code === 0) process.exitCode = 2;
    emit({ event: 'end', counts, naturalExit, issues: [...issues], exitCode: process.exitCode === undefined ? code : Number(process.exitCode) });
    // Keep the descriptor open until process teardown. Assertions in a later
    // exit listener append after this terminator and are rejected by validation.
  });
  return { run() { process.argv = [process.execPath, request.entry, ...request.args]; return Module._load(request.entry, null, true); } };
}

function validateAssertionEvidence({ trace, request: rawRequest, result, expectedHarness, expectedNode, expectedPlatform, expectedCwd }) {
  const request = validateRequest(rawRequest);
  if (!result || result.error || result.signal || !Number.isInteger(result.status)) throw new Error('measured process did not complete');
  if (!String(trace).endsWith('\n')) throw new Error('truncated assertion trace');
  const events = String(trace).trimEnd().split('\n').map(line => JSON.parse(line));
  if (events.length < 2 || events.some((event, index) => event.sequence !== index)) throw new Error('assertion trace sequence does not reconcile');
  const begin = events[0];
  const end = events.at(-1);
  if (begin.event !== 'begin' || end.event !== 'end' || events.slice(1, -1).some(event => event.event === 'begin' || event.event === 'end')) throw new Error('assertion trace lacks one final completion');
  for (const key of ['nonce', 'root', 'entry', 'args', 'modules', 'excludedAssertions', 'sourceClosure', 'expectedAssertions']) {
    if (JSON.stringify(begin[key]) !== JSON.stringify(request[key])) throw new Error(`assertion source/request identity mismatch: ${key}`);
  }
  if (begin.schemaVersion !== 1 || begin.kind !== 'builtin-assert-invocations' || begin.unit !== 'outermost-builtin-assert-call'
      || !Number.isInteger(begin.pid) || begin.pid <= 0 || begin.pid !== result.pid) throw new Error('unsupported or mismatched assertion process identity');
  if (JSON.stringify(begin.harness) !== JSON.stringify(expectedHarness) || JSON.stringify(begin.node) !== JSON.stringify(expectedNode)
      || begin.platform !== expectedPlatform || begin.cwd !== expectedCwd) throw new Error('assertion runtime identity mismatch');
  const assertions = new Map();
  const imports = new Set();
  const issues = [];
  let nextId = 0;
  for (const event of events.slice(1, -1)) {
    if (event.event === 'integrity-issue') { issues.push(event.reason); continue; }
    if (event.event === 'source-import') {
      if (!request.sourceClosure?.some(source => source.path === event.file)
          || (event.requiredBy !== null && !request.sourceClosure.some(source => source.path === event.requiredBy))) throw new Error('undeclared source import');
      continue;
    }
    if (event.event === 'assertion-import') {
      if (!request.modules.some(source => source.path === event.fixture) || !ASSERT_MODULES.has(event.specifier)) throw new Error('undeclared assertion import');
      imports.add(event.fixture); continue;
    }
    if (event.event === 'excluded-production-import') {
      if (!request.excludedAssertions.some(source => source.path === event.fixture) || !ASSERT_MODULES.has(event.specifier)) throw new Error('invalid excluded assertion import');
      continue;
    }
    if (event.event === 'assertion-start') {
      if (event.id !== ++nextId || !ASSERT_METHODS.has(event.method) || !imports.has(event.fixture)) throw new Error('unbound assertion invocation');
      assertions.set(event.id, null); continue;
    }
    if (event.event === 'assertion-result') {
      if (!assertions.has(event.id) || assertions.get(event.id) !== null || !['passed', 'failed'].includes(event.status)) throw new Error('assertion result does not reconcile');
      assertions.set(event.id, event.status); continue;
    }
    throw new Error('unknown assertion evidence event');
  }
  const values = [...assertions.values()];
  const counts = { assertions: values.length, pass: values.filter(value => value === 'passed').length,
    fail: values.filter(value => value === 'failed').length, pending: values.filter(value => value === null).length };
  if (JSON.stringify(counts) !== JSON.stringify(end.counts)) throw new Error('assertion summary is not the measured event count');
  if (request.expectedAssertions !== undefined && counts.assertions !== request.expectedAssertions) throw new Error('reviewed assertion denominator does not match measured calls');
  if (JSON.stringify(issues) !== JSON.stringify(end.issues)) throw new Error('assertion integrity issues were omitted');
  if (end.exitCode !== result.status) throw new Error('assertion receipt disagrees with process exit');
  if (issues.length || !end.naturalExit || counts.pending || !counts.assertions || request.modules.some(source => !imports.has(source.path))) throw new Error(`incomplete assertion measurement: ${issues.join(', ') || 'unfinished scope'}`);
  if (/(?:^\s*(?:#\s*)?(?:SKIP|SKIPPED|TODO)\b|\s#\s*(?:SKIP|TODO)\b|\b[1-9]\d*\s+(?:skipped|todo)\b|\b(?:skipped|todo)\s*[:=]\s*[1-9]\d*)/im.test(stripVTControlCharacters(`${result.stdout || ''}\n${result.stderr || ''}`))) throw new Error('standalone program reported skipped or unexecuted coverage');
  if ((counts.fail === 0 && result.status !== 0) || (counts.fail > 0 && result.status !== 1)) throw new Error('assertion results disagree with process status');
  return { kind: begin.kind, unit: begin.unit, counts, unexecuted: 0, status: counts.fail ? 'failed' : 'passed',
    traceSha256: sha256(trace), measuredSources: request.modules };
}

module.exports = { fileHash, validateRequest, installMeasurement, validateAssertionEvidence };
