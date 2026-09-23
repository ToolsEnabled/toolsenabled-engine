'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const provenance = require('../src/lib/research/provenance');
const runners = require('../src/lib/research/runners');
const { createStateStore, hashInput } = require('../src/lib/state-store');
const { ResearchControl } = require('../src/lib/providers/research');
const { ResearchRunsWorker } = require('../src/lib/research/research-runs-worker');
const tasks = require('../src/lib/providers/tasks');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const enabled = { state: 'enabled', why: null };
const gate = () => ({ pipelineWithheld: false, pipeline: enabled, runners: { process: enabled, agent: enabled, http: enabled } });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-provenance-'));
  const file = path.join(dir, 'prompt.txt');
  const bytes = Buffer.from('Frozen prompt\r\n\0\u03bb\n', 'utf8');
  fs.writeFileSync(file, bytes);
  return { dir, file, bytes, pin: { path: file, sha256: digest(bytes) } };
}
function processSpec(config = {}) {
  return { runnerKind: 'process', runnerConfig: { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({ok:true}))'], ...config,
    envKeys: ['ELECTRON_RUN_AS_NODE', ...(config.envKeys || [])] }, timeoutMs: 30000 };
}
function build(t, config) {
  const sample = fixture();
  const state = createStateStore({ file: path.join(sample.dir, 'state.sqlite3') });
  state.health();
  t.after(() => state.close());
  const control = new ResearchControl({ state, gate, auditRequire: () => ({ durable: true }) });
  const { project } = control.projectSave({ actor: 'human', name: 'Pinned fixture', enabled: true });
  const experiment = {
    projectId: project.projectId, name: 'Pinned process', ...processSpec(config ? config(sample) : { pinnedFiles: [sample.pin] }),
    resultSchema: { fields: { ok: 'boolean' }, required: ['ok'] }, collector: { kind: 'stdout-json', recordKind: 'summary' }, maxParallel: 1
  };
  return { ...sample, state, control, experiment, worker: new ResearchRunsWorker({ state, gate, artifactRoot: path.join(sample.dir, 'artifacts') }) };
}

test('pinned declarations are optional, strict, immutable configuration', () => {
  const { file, pin } = fixture();
  assert.equal(provenance.validatePinnedFiles('process', {}), null);
  assert.deepEqual(provenance.validatePinnedFiles('process', { pinnedFiles: [pin] }), [pin]);
  for (const pins of [null, [], 'files', [{ path: file, sha256: 'abc' }], [{ ...pin, optional: true }], [pin, pin], Array(65).fill(pin)]) {
    assert.throws(() => provenance.validatePinnedFiles('process', { pinnedFiles: pins }), { code: 'RESEARCH_PIN_CONFIG_INVALID' });
  }
  for (const kind of ['agent', 'http']) {
    assert.throws(() => provenance.validatePinnedFiles(kind, { pinnedFiles: [pin] }), { code: 'RESEARCH_PIN_RUNNER_UNSUPPORTED' });
  }
  for (const filePath of ['relative.txt', path.join(path.parse(file).root, '..', 'escape.txt') + '\0']) {
    assert.throws(() => provenance.validatePinnedFiles('process', { pinnedFiles: [{ ...pin, path: filePath }] }), { code: 'RESEARCH_PIN_CONFIG_INVALID' });
  }
});

test('64 distinct source pins are checked at both real process boundaries and a changed final pin prevents startup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-pin-capacity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pins = Array.from({ length: 64 }, (_, index) => {
    const file = path.join(dir, 'source-' + index + '.mjs'), text = '// frozen source ' + index;
    fs.writeFileSync(file, text);
    return { path: file, sha256: digest(text) };
  });
  assert.equal(provenance.validatePinnedFiles('process', { pinnedFiles: pins }).length, 64);
  assert.throws(() => provenance.validatePinnedFiles('process', { pinnedFiles: [...pins, { ...pins[0], path: path.join(dir, 'extra.mjs') }] }), { code: 'RESEARCH_PIN_CONFIG_INVALID' });
  const experiment = processSpec({ pinnedFiles: pins });
  const result = await runners.runProcess({ experiment, run: { runId: 'full-source-set', params: {} }, artifactDir: dir });
  assert.equal(result.exitCode, 0);
  assert.equal(result.provenance.before.files.length, 64);
  assert.deepEqual(result.provenance.after.files, result.provenance.before.files);
  const marker = path.join(dir, 'must-not-start.txt');
  fs.writeFileSync(pins[63].path, '// changed final source');
  await assert.rejects(runners.runProcess({ experiment: processSpec({ pinnedFiles: pins,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"started")', marker] }),
    run: { runId: 'last-pin-refusal', params: {} }, artifactDir: dir }), { code: 'RESEARCH_PIN_HASH_MISMATCH' });
  assert.equal(fs.existsSync(marker), false);
  assert.equal(provenance.MAX_PINNED_BYTES, 256 * 1024 * 1024);
});

test('the actual runner preserves byte hashes, resolved invocation, stdin bytes and environment fingerprint', async () => {
  const { dir, pin, bytes } = fixture();
  const run = { runId: 'run-exact', params: { sample: '\u03bb\r\n', replicate: 3 } };
  const script = 'process.stdout.write(require("node:fs").readFileSync(0,"utf8"))';
  const experiment = processSpec({ pinnedFiles: [pin], stdin: 'params-json', args: ['-e', script, '{replicate}'] });
  const result = await runners.runProcess({ experiment, run, artifactDir: dir });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, JSON.stringify(run.params), 'the child actually received the bytes whose digest is recorded');
  const receipt = result.provenance;
  assert.equal(receipt.scope, 'declared-file-checks-at-process-boundaries');
  assert.equal(receipt.version, 1);
  assert.equal(receipt.runId, run.runId);
  assert.deepEqual(receipt.before.files, [{ ...pin, bytes: bytes.length }]);
  assert.deepEqual(receipt.after.files, receipt.before.files);
  assert.ok(receipt.after.checkedAtMs >= receipt.before.checkedAtMs);
  assert.deepEqual(receipt.invocation.args, ['-e', script, '3']);
  assert.equal(receipt.invocation.command, process.execPath);
  assert.equal(receipt.invocation.cwd, dir);
  assert.deepEqual(receipt.invocation.stdin, { mode: 'params-json', bytes: Buffer.byteLength(JSON.stringify(run.params)), sha256: digest(JSON.stringify(run.params)) });
  assert.ok(receipt.invocation.environmentKeys.includes('TOOLSENABLED_RESEARCH_RUN'));
  assert.match(receipt.invocation.environmentSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.invocationSha256, hashInput(receipt.invocation));
  const { receiptSha256, ...unsigned } = receipt;
  assert.equal(receiptSha256, hashInput(unsigned));
  assert.equal(Object.hasOwn(receipt.invocation, 'environment'), false, 'environment values are not exported');
});

test('changing an allowed launch variable changes the actual child and its recorded environment hash', async () => {
  const { dir, pin } = fixture();
  const prior = process.env.RESEARCH_PROVENANCE_VALUE;
  const experiment = processSpec({ pinnedFiles: [pin], envKeys: ['RESEARCH_PROVENANCE_VALUE'], args: ['-e', 'process.stdout.write(process.env.RESEARCH_PROVENANCE_VALUE)'] });
  const receipts = [];
  try {
    for (const value of ['first-value', 'second-value']) {
      process.env.RESEARCH_PROVENANCE_VALUE = value;
      const result = await runners.runProcess({ experiment, run: { runId: 'environment-fixture', params: {} }, artifactDir: dir });
      assert.equal(result.stdout, value);
      assert.equal(JSON.stringify(result.provenance).includes(value), false);
      receipts.push(result.provenance.invocation);
    }
  } finally {
    if (prior === undefined) delete process.env.RESEARCH_PROVENANCE_VALUE;
    else process.env.RESEARCH_PROVENANCE_VALUE = prior;
  }
  assert.deepEqual(receipts[0].environmentKeys, receipts[1].environmentKeys);
  assert.notEqual(receipts[0].environmentSha256, receipts[1].environmentSha256);
});

test('wrong hash and missing inputs prevent the real command from starting', async t => {
  for (const scenario of ['wrong hash', 'missing']) await t.test(scenario, async () => {
    const { dir, file, pin } = fixture();
    if (scenario === 'missing') fs.unlinkSync(file);
    const marker = path.join(dir, 'started.txt');
    const experiment = processSpec({
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"started")', marker],
      pinnedFiles: [{ ...pin, sha256: scenario === 'wrong hash' ? '0'.repeat(64) : pin.sha256 }]
    });
    await assert.rejects(runners.runProcess({ experiment, run: { runId: 'refused', params: {} }, artifactDir: dir }), {
      code: scenario === 'wrong hash' ? 'RESEARCH_PIN_HASH_MISMATCH' : 'RESEARCH_PIN_READ_FAILED'
    });
    assert.equal(fs.existsSync(marker), false);
  });
});

test('a real process changing or removing its pinned input cannot return an accepted receipt', async t => {
  for (const action of ['write', 'remove']) await t.test(action, async () => {
    const { dir, file, pin } = fixture();
    const script = action === 'write'
      ? 'require("node:fs").writeFileSync(process.argv[1],"changed"); console.log(JSON.stringify({ok:true}))'
      : 'require("node:fs").unlinkSync(process.argv[1]); console.log(JSON.stringify({ok:true}))';
    await assert.rejects(runners.runProcess({
      experiment: processSpec({ args: ['-e', script, file], pinnedFiles: [pin] }), run: { runId: 'changed', params: {} }, artifactDir: dir
    }), { code: action === 'write' ? 'RESEARCH_PIN_HASH_MISMATCH' : 'RESEARCH_PIN_READ_FAILED' });
    assert.equal(fs.existsSync(file), action === 'write');
    if (action === 'write') assert.equal(fs.readFileSync(file, 'utf8'), 'changed', 'the mutation command actually ran');
  });
});

test('a linked parent is refused without reading the target file', async () => {
  const { dir, pin } = fixture();
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(provenance.verifyPinnedFiles([{ ...pin, path: path.join(alias, 'prompt.txt') }], 'before-process'), { code: 'RESEARCH_PIN_PATH_REFUSED' });
});

test('foreign Windows profile spellings are refused before even an lstat', { skip: process.platform !== 'win32' }, async () => {
  const original = fs.promises.lstat;
  let inspections = 0;
  fs.promises.lstat = async () => { inspections++; throw new Error('No foreign fixture may be probed'); };
  try {
    for (const file of ['C:\\Users\\foreign-fixture-never-access\\input.txt', 'C:\\Users\\FOREIG~9\\input.txt']) {
      await assert.rejects(provenance.verifyPinnedFiles([{ path: file, sha256: '0'.repeat(64) }], 'before-process'), { code: 'RESEARCH_PIN_PATH_REFUSED' });
    }
    assert.equal(inspections, 0);
  } finally { fs.promises.lstat = original; }
});

test('Windows device, stream and normalized-away path aliases are rejected as declarations', { skip: process.platform !== 'win32' }, () => {
  const { pin } = fixture();
  for (const file of ['\\\\localhost\\C$\\input.txt', '\\\\?\\C:\\input.txt', 'C:\\input.txt:stream', 'C:\\input.\\file.txt', 'C:\\input\\..\\file.txt', '\\relative-to-drive.txt']) {
    assert.throws(() => provenance.validatePinnedFiles('process', { pinnedFiles: [{ ...pin, path: file }] }), { code: 'RESEARCH_PIN_PATH_REFUSED' });
  }
});

test('an input changed after lstat but before descriptor inspection is refused', async () => {
  const { file, pin } = fixture();
  const original = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === file) fs.writeFileSync(file, 'raced bytes');
    return handle;
  };
  try {
    await assert.rejects(provenance.verifyPinnedFiles([pin], 'before-process'), { code: 'RESEARCH_PIN_CHANGED_DURING_READ' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'raced bytes');
  } finally { fs.promises.open = original; }
});

test('bounded hashing refuses a declared file larger than the total limit before opening', async () => {
  const { file, pin } = fixture();
  const originalStat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  let opens = 0;
  fs.promises.lstat = async (...args) => {
    const stat = await originalStat(...args);
    return args[0] === file ? Object.assign(Object.create(stat), { size: BigInt(provenance.MAX_PINNED_BYTES) + 1n }) : stat;
  };
  fs.promises.open = async (...args) => { opens++; return originalOpen(...args); };
  try {
    await assert.rejects(provenance.verifyPinnedFiles([pin], 'before-process'), { code: 'RESEARCH_PIN_LIMIT_EXCEEDED' });
    assert.equal(opens, 0);
  } finally { fs.promises.lstat = originalStat; fs.promises.open = originalOpen; }
});

test('transient filesystem exhaustion remains indeterminate, not a fabricated missing input', async () => {
  const { file, pin } = fixture();
  const original = fs.promises.lstat;
  fs.promises.lstat = async (...args) => {
    if (args[0] === file) throw Object.assign(new Error('fixture resource exhaustion'), { code: 'EMFILE' });
    return original(...args);
  };
  try { await assert.rejects(provenance.verifyPinnedFiles([pin], 'before-process'), { code: 'EMFILE' }); }
  finally { fs.promises.lstat = original; }
});

test('the default worker atomically retains pins and the invocation receipt beside actual collected records', async t => {
  const { control, state, experiment, worker, pin, bytes } = build(t);
  const submitted = control.runSubmit({ actor: 'human', experiment, params: { replicate: 0 } });
  assert.deepEqual(submitted.experiment.runnerConfig.pinnedFiles, [pin]);
  assert.throws(() => state.updateResearchExperiment({ experimentId: submitted.experiment.experimentId, runnerConfig: { pinnedFiles: [] } }), { code: 'RESEARCH_EXPERIMENT_IMMUTABLE' });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'succeeded', JSON.stringify(run.task.error));
  assert.equal(run.task.result.evidenceStatus, 'collected');
  assert.deepEqual(run.task.result.provenance.before.files, [{ ...pin, bytes: bytes.length }]);
  assert.deepEqual(run.task.result.provenance.after.files, run.task.result.provenance.before.files);
  assert.equal(run.task.result.provenance.runId, run.runId);
  assert.equal(run.task.result.provenance.invocation.cwd, run.artifactDir);
  assert.equal(run.task.result.attempt, run.task.attempt);
  const { receiptSha256, ...unsigned } = run.task.result.provenance;
  assert.equal(receiptSha256, hashInput(unsigned), 'the receipt remains independently checkable after durable JSON key sorting');
  provenance.assertProcessReceipt(run.task.result.provenance, { pins: [pin], runId: run.runId, artifactDir: run.artifactDir });
  assert.match(run.task.result.collectionHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(control.results({ runId: run.runId }).results.map(record => record.record), [{ ok: true }]);
});

test('changed inputs fail the worker with no accepted results despite valid success-shaped stdout', async t => {
  const { control, experiment, worker, file } = build(t, sample => ({
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"changed"); console.log(JSON.stringify({ok:true}))', sample.file], pinnedFiles: [sample.pin]
  }));
  const { run: submitted } = control.runSubmit({ actor: 'human', experiment, params: { replicate: 0 } });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.runId }).runs[0];
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed');
  assert.equal(run.task.status, 'failed');
  assert.equal(run.task.error.code, 'RESEARCH_PIN_HASH_MISMATCH');
  assert.deepEqual(control.results({ runId: run.runId }).results, []);
});

test('configuration validation refuses unsupported runners before creating an experiment or dispatching work', async t => {
  const { control, state, experiment, pin } = build(t);
  for (const runnerKind of ['http', 'agent']) {
    assert.throws(() => control.runSubmit({ actor: 'human', experiment: { ...experiment, runnerKind }, params: {} }), { code: 'RESEARCH_PIN_RUNNER_UNSUPPORTED' });
    assert.deepEqual(state.listResearchExperiments({ projectId: experiment.projectId }), []);
  }
  await assert.rejects(runners.runHttp({ experiment: { runnerConfig: { pinnedFiles: [pin], url: 'https://example.test' } }, run: { params: {} } }), { code: 'RESEARCH_PIN_RUNNER_UNSUPPORTED' });
  let dispatches = 0;
  await assert.rejects(runners.runAgent({ experiment, run: { params: {} }, dispatch: () => { dispatches++; } }), { code: 'RESEARCH_PIN_RUNNER_UNSUPPORTED' });
  assert.equal(dispatches, 0);
});

test('a runner omitting the promised pin receipt cannot pass worker collection', async t => {
  const { control, experiment, worker } = build(t);
  const { run: submitted } = control.runSubmit({ actor: 'human', experiment, params: {} });
  worker.runProcess = async context => {
    const outcome = await runners.runProcess(context);
    assert.equal(outcome.processLifecycle.acceptanceReady, true);
    assert.ok(outcome.provenance, 'the actual runner must first produce the receipt this test removes');
    const { provenance: omitted, ...withoutProvenance } = outcome;
    return withoutProvenance;
  };
  await worker.runOnce();
  const run = control.runs({ runId: submitted.runId }).runs[0];
  assert.equal(run.task.status, 'failed');
  assert.equal(run.task.error.code, 'RESEARCH_PIN_RECEIPT_MISSING');
  assert.deepEqual(control.results({ runId: run.runId }).results, []);
});

test('changed, partial and cross-attempt receipts are refused even when their outer hash is recomputed', async () => {
  const { dir, pin } = fixture();
  const runId = 'receipt-integrity';
  const result = await runners.runProcess({ experiment: processSpec({ pinnedFiles: [pin] }), run: { runId, params: {} }, artifactDir: dir });
  const original = result.provenance;
  for (const change of [
    receipt => { receipt.before.files = []; },
    receipt => { receipt.after.files[0].sha256 = '0'.repeat(64); },
    receipt => { receipt.after.files[0].bytes++; },
    receipt => { receipt.runId = 'a-different-run'; },
    receipt => { receipt.invocation.cwd = path.join(dir, 'a-different-attempt'); },
    receipt => { receipt.after.startedAtMs = receipt.before.startedAtMs - 1; },
    receipt => { receipt.invocationSha256 = '0'.repeat(64); }
  ]) {
    const receipt = JSON.parse(JSON.stringify(original));
    change(receipt);
    const { receiptSha256: _old, ...unsigned } = receipt;
    receipt.receiptSha256 = hashInput(unsigned);
    assert.throws(() => provenance.assertProcessReceipt(receipt, { pins: [pin], runId, artifactDir: dir }), { code: 'RESEARCH_PIN_RECEIPT_INVALID' });
  }
  const tampered = { ...original, receiptSha256: '0'.repeat(64) };
  assert.throws(() => provenance.assertProcessReceipt(tampered, { pins: [pin], runId, artifactDir: dir }), { code: 'RESEARCH_PIN_RECEIPT_INVALID' });
  assert.throws(() => provenance.assertProcessReceipt({}, { pins: [pin], runId, artifactDir: dir }), { code: 'RESEARCH_PIN_RECEIPT_INVALID' });
});

test('the atomic state boundary also refuses completion without the pinned attempt receipt', async t => {
  const { control, state, experiment, dir } = build(t);
  const { run } = control.runSubmit({ actor: 'human', experiment, params: {} });
  const wrapped = tasks.internalResearchRunsState(state);
  const { handle } = await tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: 'pin-boundary-test', leaseSeconds: 300 }, { state: wrapped });
  await tasks.start({ handle, leaseSeconds: 300 }, { state: wrapped });
  state.setResearchRunArtifactDir({ runId: run.runId, artifactDir: path.join(dir, 'attempt'), handle });
  const completion = { runnerKind: 'process', evidenceStatus: 'collected', summary: 'fixture completion' };
  for (const receipt of [undefined, {}]) {
    assert.throws(() => state.completeResearchRun(handle, {
      runId: run.runId, records: [{ recordKind: 'summary', record: { ok: true } }],
      result: receipt === undefined ? completion : { ...completion, provenance: receipt }
    }), { code: receipt === undefined ? 'RESEARCH_PIN_RECEIPT_MISSING' : 'RESEARCH_PIN_RECEIPT_INVALID' });
    assert.equal(control.runs({ runId: run.runId }).runs[0].task.status, 'running');
    assert.deepEqual(control.results({ runId: run.runId }).results, []);
  }
});

test('cancellation after asynchronous input verification prevents the real command from starting', async t => {
  const { control, state, experiment, worker, dir } = build(t, sample => ({
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"started"); console.log(JSON.stringify({ok:true}))', path.join(sample.dir, 'started.txt')],
    pinnedFiles: [sample.pin]
  }));
  const { run: submitted } = control.runSubmit({ actor: 'human', experiment, params: {} });
  let checked = false;
  worker.runProcess = context => runners.runProcess({ ...context, beforeLaunch: async () => {
    checked = true;
    state.cancelTask({ taskId: submitted.taskId, reason: 'fixture cancellation during pin verification' });
    await context.beforeLaunch();
  } });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.runId }).runs[0];
  assert.equal(checked, true);
  assert.equal(run.task.status, 'cancelled');
  assert.equal(fs.existsSync(path.join(dir, 'started.txt')), false);
  assert.deepEqual(control.results({ runId: run.runId }).results, []);
});
