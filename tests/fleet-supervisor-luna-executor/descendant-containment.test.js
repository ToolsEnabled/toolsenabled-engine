// Mutation audit (2026-08-27): changed runBoundedCommand's computed
// descendantsContained value to unconditional true in luna-executor.js.
// The one-target replacement landed (confirmed by an exact source search).
// This file initially stayed green (exit 0) because its product drive skipped
// off Windows; after adding the injected behavioral probe, it went red (exit 1).
// The module was then restored to its pre-mutation SHA-256.

'use strict';

// Q66 Windows regression: a bounded command must not resolve its timeout
// until both a direct child and that child's grandchild have been terminated.
// Every fixture and result artifact lives under this test's disposable temp
// repository/evidence pair; the checkout is used only to load the contract.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const luna = require('../../src/lib/fleet-supervisor/luna-executor.js');

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function writeFixture(repoRoot) {
  const grandchildPath = path.join(repoRoot, 'grandchild.js');
  const childPath = path.join(repoRoot, 'child.js');
  const rootPath = path.join(repoRoot, 'root.js');

  fs.writeFileSync(grandchildPath, "setInterval(() => {}, 1000);\n", 'utf8');
  fs.writeFileSync(childPath, [
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    "const path = require('node:path');",
    "const grandchild = spawn(process.execPath, [path.join(__dirname, 'grandchild.js')], { stdio: 'ignore', windowsHide: true });",
    "process.stdout.write(`${JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid })}\\n`);",
    'setInterval(() => {}, 1000);'
  ].join('\n'), 'utf8');
  fs.writeFileSync(rootPath, [
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    "const path = require('node:path');",
    "const child = spawn(process.execPath, [path.join(__dirname, 'child.js')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });",
    'child.stdout.pipe(process.stdout);',
    'child.stderr.pipe(process.stderr);',
    'setInterval(() => {}, 1000);'
  ].join('\n'), 'utf8');
  return rootPath;
}

function validateCaptured(captured, exists = processExists) {
  assert.deepEqual(
    Object.keys(captured).sort(),
    ['childPid', 'grandchildPid'],
    'the fixture must expose exactly the child and grandchild PID evidence'
  );
  for (const [label, pid] of Object.entries(captured)) {
    assert.equal(Number.isSafeInteger(pid) && pid > 0, true, `${label} must be a valid captured PID`);
    assert.equal(exists(pid), false, `${label} must be gone before the bounded result resolves`);
  }
  assert.notEqual(captured.childPid, captured.grandchildPid, 'the fixture must expose two distinct descendants');
}

function auditAssertionDiscriminator() {
  assert.throws(
    () => validateCaptured({}, () => false),
    /fixture must expose exactly the child and grandchild PID evidence/,
    'an empty PID capture must be rejected before descendant assertions are iterated'
  );
}

async function assertFailedContainmentIsReported() {
  let child;
  let keepAlive;
  const result = await luna.runBoundedCommand({
    command: process.execPath,
    args: [],
    cwd: os.tmpdir(),
    timeoutMs: 10,
    outputBudgetBytes: 1_024,
    env: process.env,
    spawnImpl() {
      child = new EventEmitter();
      child.pid = 42;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      keepAlive = setInterval(() => {}, 1_000);
      return child;
    },
    terminateTree() {
      clearInterval(keepAlive);
      setImmediate(() => child.emit('close', null));
      return { requested: true, contained: false, error: 'DESCENDANT_STILL_RUNNING' };
    }
  });

  assert.equal(result.timedOut, true, 'the behavioral probe must reach termination');
  assert.equal(result.descendantsContained, false,
    'runBoundedCommand must report a failed descendant-containment check');
}

async function main() {
  auditAssertionDiscriminator();
  await assertFailedContainmentIsReported();

  if (process.platform !== 'win32') {
    console.log('SKIP: Windows-only descendant-containment regression.');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q66-descendant-containment-'));
  const repoRoot = path.join(root, 'repo');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(evidenceRoot, { recursive: true });

  try {
    const fixturePath = writeFixture(repoRoot);
    const result = await luna.runBoundedCommand({
      command: process.execPath,
      args: [fixturePath],
      cwd: repoRoot,
      timeoutMs: 1_500,
      outputBudgetBytes: 4_096,
      env: process.env
    });
    fs.writeFileSync(path.join(evidenceRoot, 'bounded-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    assert.equal(result.timedOut, true, 'the fixture must reach its bounded timeout');
    assert.equal(result.terminationRequested, true, 'timeout must request task-tree termination');
    assert.equal(result.descendantsContained, true, 'timeout must not resolve until the task tree is contained');
    assert.equal(result.terminationError, null, 'Windows task-tree termination must not report an error');

    const captured = JSON.parse(result.stdout.trim());
    validateCaptured(captured);

    console.log('Q66 descendant containment passed (Windows child and grandchild absent after timeout).');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
