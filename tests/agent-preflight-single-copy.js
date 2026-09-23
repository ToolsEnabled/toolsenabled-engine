'use strict';

// Pins the stranded-work detector on the production agent-preflight path.
// Plain-node test: counted checks, exit 0/1, no framework.

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'agent-preflight.js');
let checks = 0;

function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

function run(args = []) {
  return execFileSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000
  });
}

function runWithPreload(preloadBody, args = []) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-preflight-'));
  const preload = path.join(tempDir, 'mutate-detector.js');
  fs.writeFileSync(preload, `'use strict';\n${preloadBody}\n`);
  try {
    return execFileSync(process.execPath, ['--require', preload, TOOL, ...args], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000
    });
  } finally {
    try { fs.unlinkSync(preload); } catch { /* best-effort test cleanup */ }
    try { fs.rmdirSync(tempDir); } catch { /* best-effort test cleanup */ }
  }
}

// Preload a one-process mutation of child_process.spawnSync. This exercises
// the real CLI path without renaming or editing the live detector while other
// sessions may be using the shared working tree.
function runWithDetectorMutation(mutationBody, args = []) {
  return runWithPreload(`
const childProcess = require('node:child_process');
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function mutatedSpawnSync(command, args, options) {
  if (Array.isArray(args) && args.some(value => String(value).includes('check-single-copy-work.js'))) {
    ${mutationBody}
  }
  return realSpawnSync.call(childProcess, command, args, options);
};
`, args);
}

function main() {
  check('the real preflight exposes the detector three-valued result in JSON', () => {
    const report = JSON.parse(run(['--json']));
    assert.ok(['clean', 'stranded', 'indeterminate'].includes(report.singleCopyWork.status));
  });

  check('the detector throwing fails open and normal preflight output still completes', () => {
    const output = runWithDetectorMutation("throw new Error('mutated detector explosion');");
    assert.match(output, /## Single-copy work/);
    assert.match(output, /INDETERMINATE \(SINGLE_COPY_CHECK_ERROR\)/);
    assert.match(output, /mutated detector explosion/);
    assert.match(output, /## MCP reality/, 'the rest of preflight must still run');
    assert.match(output, /## Who else is already working/, 'normal orientation output must survive');
  });

  check('a missing detector fails open and is reported as indeterminate', () => {
    const output = runWithPreload(`
const nativeFs = require('node:fs');
const realExistsSync = nativeFs.existsSync;
nativeFs.existsSync = function mutatedExistsSync(file) {
  if (String(file).includes('check-single-copy-work.js')) return false;
  return realExistsSync.call(nativeFs, file);
};
`);
    assert.match(output, /INDETERMINATE \(SINGLE_COPY_CHECK_MISSING\)/);
    assert.match(output, /## MCP reality/, 'the rest of preflight must still run');
  });

  check('a detector timeout fails open within the bounded wrapper', () => {
    const output = runWithDetectorMutation(`const error = new Error('mutated timeout');
      error.code = 'ETIMEDOUT';
      return { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error };`);
    assert.match(output, /INDETERMINATE \(SINGLE_COPY_CHECK_TIMEOUT\)/);
    assert.match(output, /3000ms preflight budget/);
    assert.match(output, /## MCP reality/, 'the rest of preflight must still run');
  });

  check('an indeterminate detector result is preserved and never rendered as clean', () => {
    const mutation = `return {
        status: 2,
        stdout: JSON.stringify({
          status: 'indeterminate', exitCode: 2, root: process.cwd(), durationMs: 1,
          code: 'MUTATED_INDETERMINATE', reason: 'mutation could not determine',
          findings: [], advisories: [], summary: 'could not determine: mutation'
        }),
        stderr: '', signal: null
      };`;
    const human = runWithDetectorMutation(mutation);
    assert.match(human, /INDETERMINATE \(MUTATED_INDETERMINATE\)/);
    assert.doesNotMatch(human, /## Single-copy work\s+clean\b/i);

    const report = JSON.parse(runWithDetectorMutation(mutation, ['--json']));
    assert.equal(report.singleCopyWork.status, 'indeterminate');
    assert.notEqual(report.singleCopyWork.status, 'clean');
  });

  check('stranded work is prominent but does not make preflight exit nonzero', () => {
    const mutation = `return {
        status: 1,
        stdout: JSON.stringify({
          status: 'stranded', exitCode: 1, root: process.cwd(), durationMs: 1,
          code: null, reason: null,
          findings: [{ type: 'untracked-files', fileCount: 1,
            detail: '1 mutation fixture exists only here', examples: ['fixture.js'] }],
          advisories: [], summary: 'stranded work found'
        }),
        stderr: '', signal: null
      };`;
    const output = runWithDetectorMutation(mutation);
    assert.match(output, /WARNING: STRANDED WORK/);
    assert.match(output, /fixture\.js/);

    const hook = JSON.parse(runWithDetectorMutation(mutation, ['--hook']));
    assert.match(hook.hookSpecificOutput.additionalContext, /SINGLE-COPY WARNING: STRANDED WORK/);
  });

  process.stdout.write(`agent-preflight single-copy tests passed (${checks} checks).\n`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
