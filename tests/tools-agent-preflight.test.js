'use strict';

// Refusal/exit-code contract for tools/agent-preflight.js. Each case invokes
// the CLI with a concrete dependency result; source inventory then makes a
// newly added or removed named refusal fail until this table is updated.

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'agent-preflight.js');
const SOURCE = fs.readFileSync(TOOL, 'utf8');
let checks = 0;

function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

function run({ args = [], preload = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-preflight-contract-'));
  const preloadFile = path.join(dir, 'preload.js');
  fs.writeFileSync(preloadFile, `'use strict';\n${preload}\n`);
  try {
    return execFileSync(process.execPath, ['--require', preloadFile, TOOL, ...args], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function detectorPreload(body) {
  return `
const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = function (command, args, options) {
  if (args && args.some(value => String(value).includes('check-single-copy-work.js'))) {
    ${body}
  }
  return original.call(cp, command, args, options);
};`;
}

function detectorResult(status, exitCode) {
  return detectorPreload(`return {
    status: ${exitCode}, stderr: '', signal: null,
    stdout: JSON.stringify({ status: '${status}', exitCode: ${exitCode}, durationMs: 1,
      findings: ${status === 'stranded' ? "[{ detail: 'fixture stranded work', examples: [] }]" : '[]'},
      advisories: [], code: ${status === 'indeterminate' ? "'FIXTURE_INDETERMINATE'" : 'null'},
      reason: ${status === 'indeterminate' ? "'fixture uncertainty'" : 'null'}, summary: '${status}' })
  };`);
}

check('all three named detector exits are accepted with their exact values', () => {
  const cases = [
    ['clean', 0],
    ['stranded', 1],
    ['indeterminate', 2]
  ];
  for (const [status, exitCode] of cases) {
    const report = JSON.parse(run({ args: ['--json'], preload: detectorResult(status, exitCode) }));
    assert.equal(report.singleCopyWork.status, status);
    assert.equal(report.singleCopyWork.exitCode, exitCode);
  }
});

check('an empty requested topic refuses to claim there is no prior work', () => {
  const report = JSON.parse(run({ args: ['--topic', '--json'] }));
  assert.deepEqual(
    { state: report.priorWork.state, reason: report.priorWork.reason },
    { state: 'UNKNOWN', reason: 'EMPTY_TOPIC' }
  );
});

check('a failed prior-work lookup refuses to report a miss', () => {
  const preload = `
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './prior-work-index' && parent && parent.filename.endsWith('agent-preflight.js')) {
    return { query() { throw new Error('fixture index failure'); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};`;
  const report = JSON.parse(run({ args: ['--topic', 'fixture', '--json'], preload }));
  assert.equal(report.priorWork.state, 'UNKNOWN');
  assert.equal(report.priorWork.reason, 'PRIOR_WORK_INDEX_FAILED');
  assert.match(report.priorWork.message, /NOT a finding that the topic is unexplored/);
});

check('every detector execution refusal is named and remains fail-open', () => {
  const cases = [
    ['SINGLE_COPY_CHECK_MISSING', `
const fs = require('node:fs');
const exists = fs.existsSync;
fs.existsSync = file => String(file).includes('check-single-copy-work.js') ? false : exists(file);`],
    ['SINGLE_COPY_CHECK_ERROR', detectorPreload("throw new Error('fixture spawn throw');")],
    ['SINGLE_COPY_CHECK_ERROR', detectorPreload("return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('fixture spawn error'), { code: 'EACCES' }) };")],
    ['SINGLE_COPY_CHECK_TIMEOUT', detectorPreload("return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) };")],
    ['SINGLE_COPY_CHECK_CONTRACT_INVALID', detectorPreload("return { status: 0, stdout: JSON.stringify({ status: 'clean', exitCode: 1 }), stderr: '', signal: null };")]
  ];
  for (const [code, preload] of cases) {
    const report = JSON.parse(run({ args: ['--json'], preload }));
    assert.equal(report.singleCopyWork.status, 'indeterminate');
    assert.equal(report.singleCopyWork.exitCode, 2);
    assert.equal(report.singleCopyWork.code, code);
  }
});

check('the removed owner channel keeps its named refusal in the automatic packet', () => {
  const hook = JSON.parse(run({ args: ['--hook'] }));
  assert.match(hook.hookSpecificOutput.additionalContext, /refuses? with OWNER_CHAT_NO_TRANSPORT/);
});

check('managed-process guidance comes from the current declaration, never a historical request', () => {
  const report = JSON.parse(run({ args: ['--json'] }));
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'managed-processes.json'), 'utf8')).processes;
  const observed = report.inFlight.managedProcesses;
  assert.ok(['CONFIGURED', 'INDETERMINATE'].includes(observed.state));
  assert.doesNotMatch(JSON.stringify(observed), /\bR\d{2,}\b|do not query|do not .*otherwise work/i,
    'a historical request id must never create a live unconditional agent command');
  assert.equal(observed.state, 'CONFIGURED');
  assert.match(observed.note, new RegExp(`^${Object.keys(current).length} managed process`));
});

check('the source refusal-code census cannot silently shrink or grow', () => {
  const found = [...SOURCE.matchAll(/\b(EMPTY_TOPIC|PRIOR_WORK_INDEX_FAILED|SINGLE_COPY_CHECK_[A-Z_]+|OWNER_CHAT_NO_TRANSPORT)\b/g)]
    .map(match => match[1]);
  assert.deepEqual([...new Set(found)].sort(), [
    'EMPTY_TOPIC',
    'OWNER_CHAT_NO_TRANSPORT',
    'PRIOR_WORK_INDEX_FAILED',
    'SINGLE_COPY_CHECK_CONTRACT_INVALID',
    'SINGLE_COPY_CHECK_ERROR',
    'SINGLE_COPY_CHECK_MISSING',
    'SINGLE_COPY_CHECK_TIMEOUT'
  ]);
});

process.stdout.write(`tools/agent-preflight refusal tests passed (${checks} checks).\n`);
