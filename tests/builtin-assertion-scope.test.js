'use strict';

// These tests execute the maintained runner and guard modules in owned copied
// repositories. They never mutate the active engine, open a provider, or use
// an owner's state. Invalid scopes remain unexecuted, with raw failures kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { deleteEnvNames } = require('../src/lib/env-scrub');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = 'tests/builtin-assertion-scopes.json';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const guardFiles = ['tests/run-isolated.js', 'tests/lib/isolated-environment.js', 'tests/lib/suite-list.js', 'tests/lib/suite-timeouts.js',
  'tests/lib/isolated-child.js', 'src/lib/linux-process-control.js', 'src/lib/linux-process-supervisor.py',
  'src/lib/windows-job-control.js', 'src/lib/runtime-state-root.js', 'src/lib/account-profile-boundary.js', 'tools/windows-job-wrapper.ps1',
  'tools/lib/test-completion.js', 'tools/lib/strict-lifecycle-record.js', 'src/lib/env-scrub.js'];
const measurementFiles = ['tools/lib/builtin-assertion-evidence.js', 'tools/lib/builtin-assertion-scope.js', 'tools/measure-builtin-assertions.js'];
const ordinarySource = "require('node:assert/strict').equal(1, 1);\n";

function fixture(t, { source = ordinarySource, files = {}, expected = 1, modules = ['tests/entry.cjs'], excluded = [], closure, realPrograms = false, omitMeasurement = false } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'te-assert-scope-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'engine'), output = path.join(directory, 'out');
  fs.mkdirSync(root); fs.mkdirSync(output); fs.mkdirSync(path.join(root, 'config'));
  const write = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  // This is a CommonJS engine fixture even when the caller's owned temporary
  // directory lives below an unrelated package with type: module.
  write('package.json', JSON.stringify({ private: true, type: 'commonjs' }));
  for (const file of [...guardFiles, ...(omitMeasurement ? [] : measurementFiles)]) write(file, fs.readFileSync(path.join(ROOT, file)));
  let manifest;
  if (realPrograms) {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST)));
    for (const row of manifest.programs) for (const item of row.sourceClosure) write(item.file, fs.readFileSync(path.join(ROOT, item.file)));
  } else {
    const sources = { 'tests/entry.cjs': source, ...files };
    for (const [file, bytes] of Object.entries(sources)) write(file, bytes);
    manifest = { schemaVersion: 1, unit: 'outermost-builtin-assert-call', programs: [{
      file: 'tests/entry.cjs', modules, excludedAssertions: excluded, expectedAssertions: expected,
      sourceClosure: (closure || Object.keys(sources)).map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) })),
      review: 'Owned synthetic source fixture for a specific positive or negative assertion measurement contract; never native/provider acceptance.'
    }] };
  }
  if (!omitMeasurement) write(MANIFEST, JSON.stringify(manifest));
  let serial = 0;
  // The real nested measurement worker took 2.15–2.22s in the Linux .45
  // census, before its result could be reconciled. Give successful and
  // deliberately rejected programs time to reach the evidence assertions;
  // the timeout case below still kills a real live interval and checks its
  // partial trace. These are fixture budgets, not a runner timeout change.
  function invoke({ enabled = true, strict = true, scripts = [manifest.programs[0].file], timeout = 10000, summaryPath, assertionRoot, flags = [] } = {}) {
    const summary = summaryPath || path.join(output, `result-${++serial}.json`);
    const retained = assertionRoot || `${summary}.assertions`;
    const env = deleteEnvNames({ ...process.env }, ['NODE_TEST_CONTEXT', 'NODE_OPTIONS',
      'TOOLSENABLED_TEST_PROOF_ROOT', 'TOOLSENABLED_TEST_PROOF_ID', 'TOOLSENABLED_TEST_PROOF_DIGEST', 'TOOLSENABLED_TEST_PROOF_SCOPE']);
    env.TOOLSENABLED_TEST_STRICT = strict ? '1' : '0';
    env.NODE_OPTIONS = '--test-reporter=tap';
    const result = spawnSync(process.execPath, [path.join(root, 'tests/run-isolated.js'), '--config-integrity', '--summary', summary,
      ...(enabled ? ['--measure-builtin-assertions', retained] : []), '--timeout-ms', String(timeout), ...flags, ...scripts], {
      cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(result.error, undefined, 'the owned outer fixture must finish rather than losing process control');
    return { result, summary, retained, report: fs.existsSync(summary) ? JSON.parse(fs.readFileSync(summary)) : null };
  }
  const saveManifest = () => write(MANIFEST, JSON.stringify(manifest));
  return { root, directory, output, manifest, write, invoke, saveManifest };
}

function verifyArtifacts(run, index = 0) {
  const row = run.report.files[index], measurement = row.measurement;
  assert.equal(measurement.schemaVersion, 1);
  assert.equal(measurement.outputRoot, run.retained);
  assert.equal(measurement.file, row.file);
  assert.equal(measurement.process.pid, row.process.pid);
  assert.ok(Number.isSafeInteger(row.process.pid) && row.process.pid > 0);
  const bytes = {};
  for (const key of ['request', 'trace', 'stdout', 'stderr']) {
    const entry = measurement[key];
    assert.ok(entry, `retain ${key} even when evidence is refused`);
    assert.equal(entry.path, `${String(index + 1).padStart(5, '0')}/${key === 'request' ? 'request.json' : key === 'trace' ? 'trace.jsonl' : key + '.log'}`);
    bytes[key] = fs.readFileSync(path.join(run.retained, entry.path));
    assert.equal(hash(bytes[key]), entry.sha256);
    assert.equal(bytes[key].length, entry.bytes);
  }
  const request = JSON.parse(bytes.request), events = bytes.trace.toString().trim().split('\n').map(JSON.parse);
  assert.equal(events[0].pid, row.process.pid);
  assert.equal(events[0].entry, request.entry);
  assert.equal(request.expectedAssertions, events[0].expectedAssertions);
  assert.equal(events[0].nonce, request.nonce);
  assert.deepEqual(events[0].sourceClosure, request.sourceClosure);
  assert.deepEqual(events[0].excludedAssertions, request.excludedAssertions);
  assert.deepEqual(measurement.argv, [process.execPath, path.join(measurement.cwd, 'tools/measure-builtin-assertions.js'), '--request', path.join(run.retained, measurement.request.path)]);
  return { row, measurement, bytes, request, events };
}

test('explicit runner measurement retains actual assertion calls, main identity, raw bytes and deleted owned state', t => {
  const f = fixture(t, { expected: 4, source: `const assert=require('node:assert/strict'); const fs=require('node:fs');
    assert.equal(require.main,module); assert.equal(process.argv[1],__filename);
    assert.equal(process.env.TOOLSENABLED_TEST_ISOLATED,'1'); assert.ok(fs.existsSync(process.env.TOOLSENABLED_TEST_ROOT));
    process.stdout.write('OWNED_ROOT='+process.env.TOOLSENABLED_TEST_ROOT+'\\n');
    process.stdout.write(Buffer.from([0,255,97,10])); process.stderr.write(Buffer.from([254,10]));` });
  const run = f.invoke();
  assert.equal(run.result.status, 0, run.result.stderr.toString());
  assert.equal(run.report.requested, 1);
  const proof = verifyArtifacts(run);
  assert.equal(proof.row.status, 'pass');
  assert.equal(proof.row.evidence.kind, 'builtin-assert-invocations');
  assert.equal(proof.row.evidence.unit, 'outermost-builtin-assert-call');
  assert.deepEqual(proof.row.evidence.counts, { assertions: 4, pass: 4, fail: 0, pending: 0 });
  assert.ok(proof.bytes.stdout.subarray(-4).equals(Buffer.from([0,255,97,10])));
  assert.ok(proof.bytes.stderr.equals(Buffer.from([254,10])));
  const owned = /^OWNED_ROOT=(.+)$/m.exec(proof.bytes.stdout.toString())[1];
  assert.equal(fs.existsSync(owned), false, 'the raw proof survives removal of the actual isolated test state');
});

test('ordinary runner invocation does not load the optional measurement modules or fabricate legacy counts', t => {
  const f = fixture(t, { omitMeasurement: true });
  const run = f.invoke({ enabled: false });
  assert.equal(run.result.status, 0, run.result.stderr.toString());
  assert.deepEqual(run.report.files[0].evidence, { kind: 'process-exit', counts: null, unexecuted: null });
  assert.equal(run.report.files[0].measurement, undefined);
  assert.equal(fs.existsSync(run.retained), false);
});

test('a manifest never automatically enables measurement for an unreviewed selected program', t => {
  const f = fixture(t);
  f.write('tests/unreviewed.cjs', ordinarySource);
  const run = f.invoke({ scripts: ['tests/unreviewed.cjs'] });
  assert.equal(run.result.status, 0, run.result.stderr.toString());
  assert.equal(run.report.files[0].measurement, undefined);
  assert.deepEqual(run.report.files[0].evidence, { kind: 'process-exit', counts: null, unexecuted: null });
  assert.deepEqual(fs.readdirSync(run.retained), []);
});

test('a caught assertion failure remains failed and does not prevent the next independently measured file', t => {
  const f = fixture(t, { expected: 2, source: "const a=require('node:assert/strict'); try{a.equal(1,2)}catch{} a.ok(true); console.log('all passed');" });
  f.write('tests/later.cjs', ordinarySource);
  const later = structuredClone(f.manifest.programs[0]);
  Object.assign(later, { file: 'tests/later.cjs', modules: ['tests/later.cjs'], expectedAssertions: 1,
    sourceClosure: [{ file: 'tests/later.cjs', sha256: hash(Buffer.from(ordinarySource)) }] });
  f.manifest.programs.push(later); f.saveManifest();
  const run = f.invoke({ scripts: ['tests/entry.cjs', 'tests/later.cjs'] });
  assert.equal(run.result.status, 1);
  assert.deepEqual(run.report.files.map(row => row.status), ['fail', 'pass']);
  assert.deepEqual(verifyArtifacts(run).row.evidence.counts, { assertions: 2, pass: 1, fail: 1, pending: 0 });
  assert.deepEqual(verifyArtifacts(run, 1).row.evidence.counts, { assertions: 1, pass: 1, fail: 0, pending: 0 });
});

test('passing measured calls cannot bypass source configuration preservation or explicit fail-fast', t => {
  const mutating = fixture(t, { source: ordinarySource + "require('node:fs').writeFileSync('config/retained.json','changed');" });
  mutating.write('tests/later.cjs', "require('node:fs').writeFileSync('later-ran','yes');");
  const changed = mutating.invoke({ scripts: ['tests/entry.cjs', 'tests/later.cjs'] });
  assert.equal(changed.result.status, 1);
  const proof = verifyArtifacts(changed);
  assert.equal(proof.row.evidence.counts.pass, 1, 'the one actual assertion did pass');
  assert.equal(proof.row.status, 'config-mutation', 'source drift still rejects the run');
  assert.deepEqual(proof.row.mutated, ['config/retained.json']);
  assert.equal(changed.report.files[1].status, 'not-run');
  assert.equal(fs.readFileSync(path.join(mutating.root, 'config/retained.json'), 'utf8'), 'changed');
  assert.equal(fs.existsSync(path.join(mutating.root, 'later-ran')), false);

  const failed = fixture(t, { source: "try{require('node:assert/strict').equal(1,2)}catch{}" });
  failed.write('tests/later.cjs', "require('node:fs').writeFileSync('later-ran','yes');");
  const stopped = failed.invoke({ scripts: ['tests/entry.cjs', 'tests/later.cjs'], flags: ['--fail-fast'] });
  assert.equal(stopped.result.status, 1);
  assert.deepEqual(stopped.report.files.map(row => row.status), ['fail', 'not-run']);
  assert.equal(verifyArtifacts(stopped).row.evidence.counts.fail, 1);
  assert.equal(fs.existsSync(path.join(failed.root, 'later-ran')), false);
});

test('printed skips, pending assertions, explicit exit and changed denominator cannot receive measured credit', t => {
  for (const { source, expected = 1, reason } of [
    { source: ordinarySource + "console.log('SKIP missing native prerequisite');", reason: /skipped or unexecuted/ },
    { source: "require('node:assert/strict').rejects(new Promise(()=>{}));", reason: /unfinished-async-assertions/ },
    { source: ordinarySource + "process.once('beforeExit',()=>setImmediate(()=>process.exit(0)));", reason: /natural-completion|process exit/ },
    { source: ordinarySource, expected: 2, reason: /denominator/ },
  ]) {
    const f = fixture(t, { source, expected });
    const run = f.invoke();
    assert.notEqual(run.result.status, 0);
    const proof = verifyArtifacts(run);
    assert.equal(proof.row.status, 'fail');
    assert.equal(proof.row.evidence, undefined);
    assert.match(proof.row.evidenceError, reason);
  }
});

test('a timed-out measured program keeps raw partial evidence and its honest timeout status', t => {
  const f = fixture(t, { source: ordinarySource + 'setInterval(()=>{},1000);' });
  // Leave enough startup time for the real Node child to open its trace on
  // either host, then prove the maintained timeout ends its live interval.
  const run = f.invoke({ timeout: 5000 });
  assert.equal(run.result.status, 124);
  const proof = verifyArtifacts(run);
  assert.equal(proof.row.status, 'timeout');
  assert.equal(proof.row.process.error, 'ETIMEDOUT');
  assert.equal(proof.row.evidence, undefined);
  assert.equal(proof.events.at(-1).event === 'end', false);
});

test('unknown source imports and unreviewed assertions in a production-looking path remain incomplete', t => {
  for (const include of [false, true]) {
    const f = fixture(t, { source: ordinarySource + "require('../src/helper.cjs');", files: { 'src/helper.cjs': ordinarySource },
      ...(include ? {} : { closure: ['tests/entry.cjs'] }) });
    const run = f.invoke();
    assert.notEqual(run.result.status, 0);
    const proof = verifyArtifacts(run);
    assert.equal(proof.row.evidence, undefined);
    assert.match(proof.row.evidenceError, include ? /unmeasured-fixture-import:src\/helper\.cjs/ : /undeclared source import|unreviewed-source-import/);
  }
});

test('a byte-bound explicit production assertion exclusion cannot inflate the fixture count', t => {
  const f = fixture(t, { source: ordinarySource + "require('../src/helper.cjs');", files: { 'src/helper.cjs': ordinarySource }, excluded: ['src/helper.cjs'] });
  const run = f.invoke();
  assert.equal(run.result.status, 0, run.result.stderr.toString());
  const proof = verifyArtifacts(run);
  assert.equal(proof.row.evidence.counts.assertions, 1);
  assert.equal(proof.request.excludedAssertions.length, 1);
  assert.ok(proof.events.some(event => event.event === 'excluded-production-import'));
});

test('changed reviewed source, missing exclusions, overlap and unsafe manifest paths stop before any requested test', t => {
  for (const mutate of [
    f => f.write('tests/entry.cjs', ordinarySource + '// drift'),
    f => { delete f.manifest.programs[0].excludedAssertions; f.saveManifest() },
    f => { f.manifest.programs[0].excludedAssertions = ['tests/entry.cjs']; f.saveManifest() },
    f => { f.manifest.programs[0].sourceClosure[0].file = '../escape.cjs'; f.saveManifest() },
    f => { f.manifest.programs[0].sourceClosure[0].sha256 = '0'.repeat(64); f.saveManifest() },
  ]) {
    const f = fixture(t); mutate(f);
    const run = f.invoke({ scripts: ['tests/entry.cjs', 'tests/entry.cjs'] });
    assert.notEqual(run.result.status, 0);
    assert.equal(run.report.requested, 2);
    assert.deepEqual(run.report.files.map(row => row.status), ['not-run', 'not-run']);
    assert.equal(run.report.files.some(row => row.measurement || row.evidence), false);
  }
});

test('a changed manifest or measurement helper during execution cannot preserve a passing receipt', t => {
  for (const target of [MANIFEST, 'tools/lib/builtin-assertion-scope.js']) {
    const f = fixture(t, { source: ordinarySource + `require('node:fs').appendFileSync(${JSON.stringify(target)},'\\n');` });
    const run = f.invoke();
    assert.notEqual(run.result.status, 0);
    const proof = verifyArtifacts(run);
    assert.equal(proof.row.status, 'fail');
    assert.equal(proof.row.evidence, undefined);
    assert.match(proof.row.evidenceError, /authority changed during invocation/);
  }
});

test('reuse of a retained proof directory is refused without overwriting the earlier bytes', t => {
  const f = fixture(t), first = f.invoke();
  assert.equal(first.result.status, 0);
  const proof = verifyArtifacts(first), before = Buffer.from(proof.bytes.trace);
  const second = f.invoke({ summaryPath: first.summary, assertionRoot: first.retained });
  assert.notEqual(second.result.status, 0);
  assert.equal(second.report.files[0].status, 'not-run');
  assert.deepEqual(fs.readFileSync(path.join(first.retained, proof.measurement.trace.path)), before);
});

test('measurement refuses non-strict mode, unrelated output paths and duplicate flags', t => {
  for (const mode of ['non-strict', 'different-output', 'duplicate']) {
    const f = fixture(t);
    const run = f.invoke({ ...(mode === 'non-strict' ? { strict: false } : {}),
      ...(mode === 'different-output' ? { assertionRoot: path.join(f.output, 'unrelated') } : {}),
      ...(mode === 'duplicate' ? { flags: ['--measure-builtin-assertions', path.join(f.output, 'duplicate')] } : {}) });
    assert.equal(run.result.status, 2);
    assert.equal(run.report, null);
    assert.equal(fs.existsSync(run.retained), false);
  }
});

test('the reviewed real programs execute through the maintained runner with raw assertion authority', t => {
  const f = fixture(t, { realPrograms: true });
  const scripts = f.manifest.programs.map(row => row.file);
  const run = f.invoke({ scripts, timeout: 5000 });
  assert.equal(run.result.status, 0, run.result.stderr.toString());
  assert.equal(run.report.requested, scripts.length);
  for (let index = 0; index < scripts.length; index++) {
    const proof = verifyArtifacts(run, index);
    assert.equal(proof.row.file, scripts[index]);
    assert.equal(proof.row.evidence.counts.assertions, f.manifest.programs[index].expectedAssertions);
    assert.equal(proof.row.evidence.counts.pass, f.manifest.programs[index].expectedAssertions);
    assert.equal(proof.row.evidence.counts.fail, 0);
    assert.equal(proof.row.evidence.counts.pending, 0);
    assert.equal(proof.row.evidence.unexecuted, 0);
  }
});


test('the real role program refuses an imported JSON definition omitted from its reviewed closure', t => {
  const f = fixture(t, { realPrograms: true });
  const row = f.manifest.programs.find(entry => entry.file === 'tests/agent-roles.test.js');
  const removed = row.sourceClosure.find(entry => entry.file === 'src/lib/roles/controller.json');
  assert.ok(removed, 'the actual role JSON is part of the reviewed import graph');
  row.sourceClosure = row.sourceClosure.filter(entry => entry !== removed);
  f.saveManifest();
  // Keep the actual JSON on disk: rejection must concern missing authority,
  // not a missing module or a manufactured assertion failure.
  assert.equal(fs.existsSync(path.join(f.root, removed.file)), true);
  const run = f.invoke({ scripts: [row.file], timeout: 5000 });
  assert.notEqual(run.result.status, 0);
  const proof = verifyArtifacts(run);
  assert.equal(proof.row.evidence, undefined);
  assert.match(proof.row.evidenceError, /undeclared source import|unreviewed-source-import/);
});
