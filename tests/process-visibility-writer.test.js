// EXECUTABLE CHANGE
// Non-vacuity guards below make both assertion loops fail closed.
//
// Discrimination report (testcanfail-tests-process-visibility-writer-test-js):
// - EMPTY-COLLECTION: FOUND in the forbidden-control-action loop and static
//   target mutation loop. Their corpora are test-owned, so no product mutation
//   can empty them without changing how the product checks are defined; that
//   requested precondition could not be met. The closest valid mutations were
//   temporary empty-corpus edits in this test. Both formerly made the loop
//   vacuous. With the guards below they exited 1 with, respectively:
//   "AssertionError [ERR_ASSERTION]: collector forbidden-control-action corpus must not be empty"
//   "AssertionError [ERR_ASSERTION]: static target guard mutation corpus must not be empty"
// - EXIT-STATUS-ONLY: NOT-FOUND; this file does not spawn a process or assert
//   on an exit status/truthy process result.
// - SWALLOWED-FAILURE: NOT-FOUND; the sole try/finally restores fs.renameSync
//   but has no catch or optional chain that can absorb the asserted failure.
// - MOCK-OF-SUBJECT: NOT-FOUND; fs.renameSync is a fault-injection boundary,
//   while the asserted writer error and temporary-file cleanup are real.
// - SKIP/PRECONDITION-GUARD: NOT-FOUND; every check runs on this platform.
// - SAME-CODE-EXPECTED-VALUE: NOT-FOUND; dynamic target expectations are also
//   pinned independently by the generated PowerShell declaration, and the
//   receipt assertions are checked against parsed persisted output.
// - RESTORE: sha256 before/after each temporary mutation was
//   a5274fb53f24a8a001087d313ee47a6224093783de42eacc25eb1a29ed41aed9.
//   The restored run exited 0 with
//   "process-visibility-writer: 7 checks passed".
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const managedProcesses = require('../src/lib/managed-processes.js');
const targets = require('../src/lib/supervision/process-visibility-targets.js');
const writer = require('../src/lib/supervision/process-visibility-writer.js');
const uac = require('../src/lib/uac-delegation.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function fixture(overrides = {}) {
  return {
    capturedAtMs: 1785360000000,
    tasks: targets.TASK_NAMES.map(taskName => ({
      taskName,
      state: 'Running',
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\ToolsEnabled\\tools\\worker.js', '--serve'],
      workingDirectory: 'C:\\ToolsEnabled'
    })),
    processes: [{
      pid: 4812,
      imageName: 'node.exe',
      startedAtMs: 1785359900000,
      argv: ['C:\\ToolsEnabled\\tools\\worker.js', '--serve']
    }],
    ...overrides
  };
}

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-visibility-writer-'));
  return { directory, file: path.join(directory, 'process-visibility.json') };
}

function staticTargetDeclarations(source) {
  return [...source.matchAll(
    /^[ \t]*\$TargetTaskNames[ \t]*=[ \t]*@\([ \t]*\r?\n([\s\S]*?)^[ \t]*\)[ \t]*(?:#[^\r\n]*)?$/gmi
  )];
}

function extractStaticTargetTaskNames(source) {
  const declarations = staticTargetDeclarations(source);
  assert.equal(declarations.length, 1,
    'collector must contain exactly one initial static $TargetTaskNames assignment');
  const declaration = declarations[0];

  const consumers = [...source.matchAll(
    /^[ \t]*foreach[ \t]*\([ \t]*\$taskName[ \t]+in[ \t]+\$TargetTaskNames[ \t]*\)[ \t]*\{[ \t]*(?:#[^\r\n]*)?$/gmi
  )];
  assert.equal(consumers.length, 1,
    'collector must consume $TargetTaskNames exactly once through the fixed foreach');

  const references = [...source.matchAll(
    /\$(?:\{(?:script:|local:|global:|private:)?TargetTaskNames\}|(?:script:|local:|global:|private:)?TargetTaskNames\b)/gi
  )];
  const declarationReference = declaration.index + declaration[0].indexOf('$TargetTaskNames');
  const consumerReference = consumers[0].index + consumers[0][0].indexOf('$TargetTaskNames');
  // Until 2026-08-22 a single fixed conditional append (the Discord bridge
  // task) was allowed between declaration and use. Discord is gone, so the
  // list is now declared once and consumed once, with nothing in between.
  assert.deepEqual(references.map(reference => reference.index), [declarationReference, consumerReference],
    'collector must not reference $TargetTaskNames outside its declaration and use');

  const beforeUse = source.slice(declaration.index + declaration[0].length, consumers[0].index);
  assert.equal(/\bTargetTaskNames\b/i.test(beforeUse), false,
    'collector must not dynamically mutate TargetTaskNames');

  const names = [];
  for (const line of declaration[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const name = trimmed.match(/^'([^']+)'\s*,?\s*(?:#.*)?$/);
    assert.ok(name, `collector target list contains a non-static entry: ${trimmed}`);
    names.push(name[1]);
  }
  return names;
}

process.stdout.write('process-visibility-writer\n');

check('writes only a parser-validated minimized snapshot and returns a safe receipt', () => {
  const { directory, file } = tempFile();
  const receipt = writer.writeProcessVisibilitySnapshot(fixture(), { file });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(receipt.file, file);
  assert.equal(receipt.taskCount, targets.TASK_NAMES.length);
  assert.equal(receipt.processCount, 1);
  assert.equal(stored.reader.kind, 'toolsenabled-uac-process-reader');
  assert.equal(stored.tasks.length, targets.TASK_NAMES.length);
  assert.equal(Object.hasOwn(stored, 'commandLine'), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

check('refuses a malformed producer input before creating or replacing a snapshot', () => {
  const { directory, file } = tempFile();
  const unsafe = fixture();
  unsafe.processes[0].argv.push('--token=must-not-persist');
  assert.throws(
    () => writer.writeProcessVisibilitySnapshot(unsafe, { file }),
    error => error && error.code === 'PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED'
  );
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

check('refuses an empty snapshot filename before writing or spawning', () => {
  const { directory } = tempFile();
  const before = fs.readdirSync(directory);
  let writes = 0;
  let spawns = 0;
  const originalWriteFileSync = fs.writeFileSync;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  fs.writeFileSync = (...args) => {
    writes += 1;
    return originalWriteFileSync(...args);
  };
  childProcess.spawnSync = (...args) => {
    spawns += 1;
    return originalSpawnSync(...args);
  };
  childProcess.spawn = (...args) => {
    spawns += 1;
    return originalSpawn(...args);
  };
  try {
    assert.throws(
      () => writer.writeFileAtomically('{}', { file: '' }),
      error => error &&
        error.code === 'PROCESS_VISIBILITY_WRITER_FILE_INVALID' &&
        error.message === 'process-visibility-writer: snapshot file must be a non-empty string'
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.equal(writes, 0);
  assert.equal(spawns, 0);
  assert.deepEqual(fs.readdirSync(directory), before);
  fs.rmSync(directory, { recursive: true, force: true });
});

check('refuses an oversized serialized snapshot before writing or spawning', () => {
  const { directory, file } = tempFile();
  const largeArgument = 'x'.repeat(4096);
  const processes = Array.from({ length: 6 }, (_, index) => ({
    pid: index + 1,
    imageName: 'node.exe',
    startedAtMs: 1785359900000,
    argv: Array.from({ length: 96 }, () => largeArgument)
  }));
  let writes = 0;
  let spawns = 0;
  const originalWriteFileSync = fs.writeFileSync;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  fs.writeFileSync = (...args) => {
    writes += 1;
    return originalWriteFileSync(...args);
  };
  childProcess.spawnSync = (...args) => {
    spawns += 1;
    return originalSpawnSync(...args);
  };
  childProcess.spawn = (...args) => {
    spawns += 1;
    return originalSpawn(...args);
  };
  try {
    assert.throws(
      () => writer.writeProcessVisibilitySnapshot(fixture({ processes }), { file }),
      error => error &&
        error.code === 'PROCESS_VISIBILITY_WRITER_OVERSIZE' &&
        error.message === `process-visibility-writer: serialized snapshot exceeds ${writer.MAX_SERIALIZED_BYTES} bytes`
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.equal(writes, 0);
  assert.equal(spawns, 0);
  assert.deepEqual(fs.readdirSync(directory), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

check('removes the unique temporary snapshot when the atomic rename fails', () => {
  const { directory, file } = tempFile();
  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error('injected rename failure');
    error.code = 'EACCES';
    throw error;
  };
  try {
    assert.throws(
      () => writer.writeFileAtomically('{}', { file }),
      error => error && error.code === 'PROCESS_VISIBILITY_WRITER_WRITE_FAILED'
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.deepEqual(fs.readdirSync(directory), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

check('the fixed target list matches every active scheduled process and observably retires legacy owner-host', () => {
  // The installed app owns its agent-session host in memory. A preserved
  // legacy scheduled owner-host row must be reported as retired, never returned
  // as an active process or included in the elevated collector's task inputs.
  const collectorSource = fs.readFileSync(path.join(__dirname, '..', 'tools', 'collect-process-visibility.ps1'), 'utf8');
  const declaredTaskNames = extractStaticTargetTaskNames(collectorSource);
  const { directory, file } = tempFile();
  const registryFile = path.join(directory, 'managed-processes.json');
  const processes = Object.fromEntries(declaredTaskNames.map((taskName, index) => [
    `fixture-${index + 1}`,
    {
      displayName: `Fixture process ${index + 1}`,
      taskName,
      kind: 'scheduled-task',
      owner: 'fixture',
      entryPoint: 'tools\\fixture-worker.js',
      entryPattern: 'fixture-worker\\.js',
      declaredArgv: ['--fixture'],
      cwd: '.'
    }
  ]));
  processes['owner-host'] = {
    displayName: 'Fixture owner-session host',
    taskName: 'Fixture Owner Session Host',
    kind: 'scheduled-task',
    owner: 'fixture',
    entryPoint: 'tools\\fixture-owner-host.js',
    entryPattern: 'fixture-owner-host\\.js',
    declaredArgv: [],
    cwd: '.',
    ownerPrincipal: 'FIXTURE\\Operator',
    clientPrincipal: 'FIXTURE\\Runtime'
  };
  fs.writeFileSync(registryFile, `${JSON.stringify({ schemaVersion: 1, processes }, null, 2)}\n`, 'utf8');
  try {
    const original = fs.readFileSync(registryFile, 'utf8');
    assert.equal(Object.hasOwn(JSON.parse(original).processes, 'owner-host'), true,
      'the persisted disposable registry must actually contain the legacy row');
    const registry = managedProcesses.loadRegistry(registryFile);
    assert.deepEqual(registry.retiredProcessIds, ['owner-host'],
      'legacy retirement must remain observable, not disappear silently');
    const active = managedProcesses.listProcesses(registryFile);
    assert.equal(active.some(item => item.id === 'owner-host'), false,
      'a retired owner-session record is not an executable managed process');
    assert.throws(() => managedProcesses.getProcess('owner-host', registryFile),
      error => error.code === 'MANAGED_PROCESS_REGISTRY_INVALID' && /retired/.test(error.message));
    const scheduled = active
      .filter(item => item.taskName)
      .map(item => item.taskName)
      .sort();
    assert.deepEqual([...targets.TASK_NAMES].sort(), scheduled);
    assert.equal(fs.readFileSync(registryFile, 'utf8'), original,
      'reading the current process list must not rewrite legacy evidence');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('the elevated collector is fixed-argv, exactly matches Q39 targets, and invokes no control action', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'collect-process-visibility.ps1'), 'utf8');
  assert.match(source, /\[CmdletBinding\(\)\]\s*\r?\nparam\(\)/);
  const staticTaskNames = extractStaticTargetTaskNames(source);
  assert.equal(new Set(staticTaskNames).size, staticTaskNames.length,
    'collector target list must not contain duplicates');
  // COMPARE THE STATIC BLOCK TO WHAT IS ACTUALLY GENERATED INTO IT.
  //
  // tools/generate-mirrors.js emits BASE_TASK_NAMES here. Until 2026-08-22 the
  // .ps1 also appended a conditional Discord entry outside the generated
  // block, so the block was compared to BASE_TASK_NAMES rather than
  // TASK_NAMES (which folded the append in). Discord is gone; the two lists
  // are identical and the static block must be the whole of it.
  assert.equal(staticTaskNames.length, targets.BASE_TASK_NAMES.length,
    'collector static target list must not add or omit targets');
  assert.deepEqual(staticTaskNames, [...targets.BASE_TASK_NAMES],
    'collector static target list must exactly match the generated BASE_TASK_NAMES order');
  assert.deepEqual([...targets.TASK_NAMES], [...targets.BASE_TASK_NAMES],
    'nothing is appended to the collector list outside the generated block any more');
  assert.equal(/discord/i.test(source), false,
    'the collector must not carry a Discord gate; the product has no Discord bridge');
  const forbiddenControlActions = [
    'Start-ScheduledTask',
    'Stop-ScheduledTask',
    'Register-ScheduledTask',
    'Unregister-ScheduledTask',
    'Start-Process',
    'Invoke-WebRequest',
    'curl ',
    'wget '
  ];
  assert.ok(forbiddenControlActions.length > 0,
    'collector forbidden-control-action corpus must not be empty');
  for (const forbidden of forbiddenControlActions) {
    assert.equal(source.includes(forbidden), false, `collector must not contain ${forbidden}`);
  }
  assert.equal(source.includes('Get-Command node'), false,
    'an elevated collector must use the fixed Program Files node path, not PATH resolution');
  assert.match(source, /\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::ProgramFiles\)/,
    'an elevated collector must resolve Program Files through the OS special-folder API');
  assert.equal(/\$\{?env:|GetEnvironmentVariable\s*\(/i.test(source), false,
    'an elevated collector must not derive executable paths from environment variables');
  assert.match(source, /process-visibility-snapshot-writer\.js/);
  assert.match(source, /ConvertTo-SafeArgv/);
});

check('the static target guard rejects every post-array reassignment or expansion before use', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'collect-process-visibility.ps1'), 'utf8');
  const declarations = staticTargetDeclarations(source);
  assert.equal(declarations.length, 1);
  const declarationEnd = declarations[0].index + declarations[0][0].length;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const mutations = [
    "$TargetTaskNames += 'Injected Extra'",
    "$TargetTaskNames += 'ToolsEnabled Dashboard'",
    "$TargetTaskNames = @('Injected Extra')",
    "$TargetTaskNames.Add('Injected Extra')",
    "$TargetTaskNames.Insert(0, 'Injected Extra')",
    "$TargetTaskNames[0] = 'Injected Extra'",
    "Set-Variable -Name TargetTaskNames -Value @('Injected Extra')"
  ];

  assert.ok(mutations.length > 0,
    'static target guard mutation corpus must not be empty');
  for (const mutation of mutations) {
    const injected = `${source.slice(0, declarationEnd)}${newline}${mutation}${source.slice(declarationEnd)}`;
    assert.throws(
      () => extractStaticTargetTaskNames(injected),
      { name: 'AssertionError' },
      `static target guard must reject: ${mutation}`
    );
  }
});

check('the allowlist exposes one fixed no-argument collector operation, not a shell passthrough', () => {
  const { directory } = tempFile();
  const allowlistFile = path.join(directory, 'uac-delegation-allowlist.json');
  const fixedArgs = [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', 'tools\\collect-process-visibility.ps1'
  ];
  fs.writeFileSync(allowlistFile, `${JSON.stringify({
    schemaVersion: 1,
    operations: [{
      id: 'collect-process-visibility',
      description: 'Disposable bounded process visibility collector',
      steps: [{ exec: 'powershell.exe', args: fixedArgs }]
    }]
  }, null, 2)}\n`, 'utf8');
  try {
    const allowlist = uac.loadAllowlist({
      allowlistFile,
      ownerPrincipal: 'FIXTURE\\Operator'
    });
    const operation = uac.resolveOperation(allowlist, 'collect-process-visibility');
    assert.equal(operation.steps.length, 1);
    assert.match(operation.steps[0].executable,
      /[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    assert.deepEqual(operation.steps[0].args, fixedArgs);
    assert.throws(() => uac.resolveOperation(allowlist, 'arbitrary-shell-command'),
      error => error && error.code === 'UAC_NOT_ALLOWED');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

process.stdout.write(`\nprocess-visibility-writer: ${passed} checks passed\n`);
