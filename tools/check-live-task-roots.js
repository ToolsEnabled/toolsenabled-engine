'use strict';

// Read-only deployment-truth check. Raw task arguments and process command
// lines are inspected in memory but never emitted because they may contain
// credentials. Only identities, classifications, and path references leave
// this process.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadRegistry } = require('../src/lib/service-registry');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVICE_REGISTRY_PATH = path.join(REPO_ROOT, 'config', 'service-registry.json');
const POWERSHELL_TIMEOUT_MS = 60_000;
const POWERSHELL_MAX_BUFFER = 64 * 1024 * 1024;
const TREE_HINT_RE = /toolsenabled/i;
const DOUBLE_QUOTED_RE = /"([^"\r\n]+)"/g;
const SINGLE_QUOTED_RE = /'([^'\r\n]+)'/g;
const BARE_WINDOWS_PATH_RE = /(?:[a-zA-Z]:[\\/]|\\\\[^\\/\s"'<>|]+[\\/][^\\/\s"'<>|]+(?:[\\/]|$))[^\s"'<>|]*/g;

const CLASSIFICATION = Object.freeze({
  OK: 'OK',
  VIOLATION: 'VIOLATION',
  IGNORED: 'IGNORED',
  UNKNOWN: 'UNKNOWN'
});

class CheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CheckError';
    this.code = code;
  }
}

const TASKS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(
  Get-ScheduledTask -ErrorAction Stop | ForEach-Object {
    $task = $_
    [pscustomobject][ordered]@{
      TaskName = [string]$task.TaskName
      TaskPath = [string]$task.TaskPath
      State = [string]$task.State
      Actions = @(
        $task.Actions | ForEach-Object {
          [pscustomobject][ordered]@{
            Execute = $_.Execute
            Arguments = $_.Arguments
            WorkingDirectory = $_.WorkingDirectory
          }
        }
      )
    }
  }
)
ConvertTo-Json -InputObject $rows -Depth 6 -Compress
`;

const PROCESSES_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(
  Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
    ForEach-Object {
      [pscustomobject][ordered]@{
        ProcessId = [uint32]$_.ProcessId
        Name = [string]$_.Name
        CommandLine = $_.CommandLine
      }
    }
)
ConvertTo-Json -InputObject $rows -Depth 4 -Compress
`;

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function safeText(value, maxLength = 4096) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '?')
    .slice(0, maxLength);
}

function expandEnvironmentVariables(value, environment = process.env) {
  if (typeof value !== 'string' || !value) return '';
  const lookup = new Map(Object.entries(environment).map(([key, entry]) => [key.toLowerCase(), String(entry)]));
  return value.replace(/%([^%]+)%/g, (match, name) => lookup.get(String(name).toLowerCase()) || match);
}

function trimPathPunctuation(value) {
  let output = value.trim();
  while (output && '&(@{['.includes(output[0])) output = output.slice(1);
  while (output && '],;)}'.includes(output[output.length - 1])) output = output.slice(0, -1);
  return output;
}

function normalizeWindowsPath(value) {
  if (typeof value !== 'string') return null;
  let candidate = trimPathPunctuation(value);
  if ((candidate.startsWith('"') && candidate.endsWith('"')) ||
      (candidate.startsWith("'") && candidate.endsWith("'"))) {
    candidate = candidate.slice(1, -1).trim();
  }
  if (candidate.toLowerCase().startsWith('\\\\?\\unc\\')) candidate = `\\\\${candidate.slice(8)}`;
  else if (candidate.startsWith('\\\\?\\')) candidate = candidate.slice(4);
  if (!path.win32.isAbsolute(candidate)) return null;
  let normalized = path.win32.normalize(candidate);
  const parsedRoot = path.win32.parse(normalized).root;
  while (normalized.length > parsedRoot.length && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function pathKey(value) {
  const normalized = normalizeWindowsPath(value);
  return normalized ? normalized.toLowerCase() : null;
}

function isWithinRoot(candidate, root) {
  const candidateKey = pathKey(candidate);
  const rootKey = pathKey(root);
  if (!candidateKey || !rootKey) return false;
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`);
}

function extractAbsoluteWindowsPaths(value, options = {}) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const expanded = expandEnvironmentVariables(value);
  const found = new Map();
  const add = raw => {
    const normalized = normalizeWindowsPath(raw);
    if (!normalized || !TREE_HINT_RE.test(normalized)) return;
    found.set(pathKey(normalized), normalized);
  };

  if (options.wholeField) add(expanded);
  for (const expression of [DOUBLE_QUOTED_RE, SINGLE_QUOTED_RE, BARE_WINDOWS_PATH_RE]) {
    expression.lastIndex = 0;
    for (const match of expanded.matchAll(expression)) add(match[1] || match[0]);
  }
  return [...found.values()];
}

function collectReferences(fields) {
  const references = new Map();
  for (const field of fields) {
    for (const reference of extractAbsoluteWindowsPaths(field.value, { wholeField: field.wholeField })) {
      const key = pathKey(reference);
      if (!references.has(key)) references.set(key, { path: reference, sources: [] });
      const current = references.get(key);
      if (!current.sources.includes(field.name)) current.sources.push(field.name);
    }
  }
  return [...references.values()];
}

function loadDeclaredRoots(registryPath = SERVICE_REGISTRY_PATH) {
  let registry;
  try {
    registry = loadRegistry({ registryPath, noCache: true });
  } catch (error) {
    throw new CheckError(error && error.code ? error.code : 'SERVICE_REGISTRY_UNAVAILABLE',
      'The declared roots could not be loaded from config/service-registry.json.');
  }

  const grouped = new Map();
  for (const [machineId, machine] of Object.entries(registry.machines || {})) {
    const root = normalizeWindowsPath(machine && machine.root);
    if (!root) {
      throw new CheckError('SERVICE_REGISTRY_ROOT_INVALID',
        `Registry machine ${safeText(machineId, 200)} does not declare an absolute Windows root.`);
    }
    const key = pathKey(root);
    if (!grouped.has(key)) grouped.set(key, { root, realRoot: tryRealPath(root) || root, machineIds: [] });
    grouped.get(key).machineIds.push(machineId);
  }
  if (grouped.size === 0) {
    throw new CheckError('SERVICE_REGISTRY_ROOTS_EMPTY', 'The service registry declares no machine roots.');
  }
  return [...grouped.values()]
    .sort((left, right) => right.root.length - left.root.length)
    // machineId (singular) is the primary declaring machine. It is carried
    // beside the grouped machineIds because the published report contract --
    // declaredRoots[].machineId -- predates the grouping and is what readers,
    // including tests/check-live-task-roots.test.js, assert against.
    .map(entry => ({ ...entry, machineId: entry.machineIds[0] || null }));
}

function tryRealPath(reference) {
  try {
    return normalizeWindowsPath(fs.realpathSync.native(reference));
  } catch (error) {
    // A path that is known not to exist has no real path. Any other failure
    // (access denied, I/O failure, etc.) means we did not establish where it
    // resolves and must not silently fall back to a lexical prefix comparison.
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw new CheckError('FILESYSTEM_INSPECTION_FAILED',
      `Could not resolve a filesystem path while checking live task roots: ${safeText(reference, 400)}`);
  }
}

function startingDirectory(reference) {
  try {
    const stat = fs.statSync(reference);
    return stat.isDirectory() ? reference : path.win32.dirname(reference);
  } catch (error) {
    if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      throw new CheckError('FILESYSTEM_INSPECTION_FAILED',
        `Could not inspect a filesystem path while checking live task roots: ${safeText(reference, 400)}`);
    }
    const base = path.win32.basename(reference);
    return /\.[a-zA-Z0-9_-]{1,12}$/.test(base) ? path.win32.dirname(reference) : reference;
  }
}

function walkAncestors(reference, visitor) {
  let current = startingDirectory(reference);
  for (let depth = 0; depth < 128; depth += 1) {
    const result = visitor(current);
    if (result) return result;
    const parent = path.win32.dirname(current);
    if (!parent || pathKey(parent) === pathKey(current)) break;
    current = parent;
  }
  return null;
}

function nearestPackageRoot(reference) {
  return walkAncestors(reference, directory => {
    try {
      const manifest = path.win32.join(directory, 'package.json');
      return fs.statSync(manifest).isFile() ? directory : null;
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      throw new CheckError('FILESYSTEM_INSPECTION_FAILED',
        `Could not inspect package.json while checking live task roots: ${safeText(directory, 400)}`);
    }
  });
}

function namedTreeRoot(reference) {
  return walkAncestors(reference, directory => TREE_HINT_RE.test(path.win32.basename(directory)) ? directory : null);
}

function resolveReference(reference, declaredRoots) {
  const realReference = tryRealPath(reference);
  const declaredContainer = declaredRoots.find(entry => realReference
    ? isWithinRoot(realReference, entry.realRoot || entry.root)
    : isWithinRoot(reference, entry.root));
  if (declaredContainer) {
    return {
      path: reference,
      resolvedRoot: declaredContainer.root,
      resolution: realReference && pathKey(realReference) !== pathKey(reference) ? 'real-path' : 'declared-prefix',
      declared: true,
      isTree: true,
      machineId: declaredContainer.machineIds[0] || null,
      machineIds: [...declaredContainer.machineIds]
    };
  }

  // isTree is a FILESYSTEM FACT: does this reference live in something carrying
  // a package.json? Only such a thing can execute product code, so only such a
  // thing can be a deployment claim. A path that merely has the product string
  // in its NAME -- a bare git mirror, a backup folder, an agent scratchpad slug
  // -- runs nothing, and flagging it teaches people to ignore this check. The
  // tree-name fallback below still RESOLVES those for the report, but they are
  // reported as non-trees so they cannot manufacture a violation.
  const packageRoot = nearestPackageRoot(reference);
  const resolvedRoot = packageRoot || namedTreeRoot(reference);
  const exactDeclaration = resolvedRoot
    ? declaredRoots.find(entry => pathKey(entry.root) === pathKey(resolvedRoot))
    : null;
  return {
    path: reference,
    resolvedRoot: resolvedRoot || null,
    resolution: packageRoot ? 'package-json' : (resolvedRoot ? 'tree-name' : 'unresolved'),
    declared: Boolean(exactDeclaration),
    isTree: Boolean(packageRoot),
    machineId: exactDeclaration ? (exactDeclaration.machineIds[0] || null) : null,
    machineIds: exactDeclaration ? [...exactDeclaration.machineIds] : []
  };
}

function classifyReferences(references, declaredRoots) {
  return references.map(reference => ({
    ...resolveReference(reference.path, declaredRoots),
    sources: [...reference.sources]
  }));
}

// Only references that are real source trees carry a deployment claim. An
// undeclared non-tree is noise, not evidence, so it neither proves compliance
// nor manufactures a violation.
function materialReferences(references) {
  return references.filter(reference => reference.declared || reference.isTree);
}

function classifyFrom(references) {
  const material = materialReferences(references);
  if (material.length === 0) return CLASSIFICATION.IGNORED;
  return material.every(reference => reference.declared) ? CLASSIFICATION.OK : CLASSIFICATION.VIOLATION;
}

// Path-level classification against a root list. Accepts either root shape:
// the grouped { root, machineIds } this module builds, or the flat
// { root, machineId } the report publishes and external callers pass.
function classifyPaths(paths, roots) {
  const normalized = asArray(roots).map(entry => {
    const root = normalizeWindowsPath(entry && entry.root);
    const machineIds = entry && Array.isArray(entry.machineIds)
      ? [...entry.machineIds]
      : (entry && entry.machineId ? [entry.machineId] : []);
    return { root, realRoot: (entry && entry.realRoot) || root, machineIds };
  }).filter(entry => entry.root);

  return asArray(paths).map(candidate => {
    const reference = normalizeWindowsPath(candidate);
    if (!reference) {
      return { path: String(candidate), declared: false, isTree: false, machineId: null, machineIds: [], inferredRoot: null };
    }
    const resolved = resolveReference(reference, normalized);
    return {
      path: resolved.path,
      declared: resolved.declared,
      isTree: resolved.isTree,
      machineId: resolved.machineId,
      machineIds: resolved.machineIds,
      inferredRoot: resolved.resolvedRoot
    };
  });
}

function safeActionPath(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  const expanded = expandEnvironmentVariables(String(value));
  const normalized = normalizeWindowsPath(expanded);
  if (normalized) return normalized;
  const trimmed = String(value).trim();
  return /^[a-zA-Z0-9._-]{1,260}$/.test(trimmed) ? trimmed : '[redacted]';
}

// Task rows arrive in two shapes: the nested { Actions: [...] } this module's
// own enumeration emits, and the flat { Execute, Arguments, WorkingDirectory }
// shape a per-action projection produces (the shape the fixtures use). Both
// describe the same actions, so both are read rather than one being silently
// classified as having no references at all.
function taskActionRows(row) {
  const nested = asArray(row && row.Actions).filter(action => action && typeof action === 'object');
  if (nested.length > 0) return nested;
  const hasInline = ['Execute', 'Arguments', 'WorkingDirectory'].some(field =>
    row && row[field] !== null && row[field] !== undefined && String(row[field]).trim() !== '');
  return hasInline ? [row] : [];
}

function classifyTask(row, declaredRoots, options) {
  const fields = [];
  const actions = taskActionRows(row).map((action, index) => {
    const execute = action && action.Execute;
    const argumentsValue = action && action.Arguments;
    const workingDirectory = action && action.WorkingDirectory;
    fields.push(
      { name: `Actions[${index}].Execute`, value: execute, wholeField: true },
      { name: `Actions[${index}].Arguments`, value: argumentsValue, wholeField: false },
      { name: `Actions[${index}].WorkingDirectory`, value: workingDirectory, wholeField: true }
    );
    return {
      Execute: safeActionPath(execute),
      Arguments: argumentsValue === null || argumentsValue === undefined || String(argumentsValue).trim() === ''
        ? ''
        : '[redacted: scanned in memory]',
      WorkingDirectory: safeActionPath(workingDirectory)
    };
  });

  const references = classifyReferences(collectReferences(fields), declaredRoots);
  const classification = classifyFrom(references);

  const state = safeText(row && row.State, 100) || 'Unknown';
  const disabled = state.toLowerCase() === 'disabled';
  let severity = 'none';
  if (classification === CLASSIFICATION.VIOLATION) {
    severity = disabled && options.allowDisabled && !options.strict ? 'warning' : 'failure';
  }

  return {
    TaskName: safeText(row && row.TaskName, 1024),
    TaskPath: safeText(row && row.TaskPath, 1024) || '\\',
    State: state,
    Classification: classification,
    Severity: severity,
    Actions: actions,
    References: references
  };
}

function classifyProcess(row, declaredRoots, options) {
  const commandLine = row && row.CommandLine;
  const readable = typeof commandLine === 'string' && commandLine.trim().length > 0;
  if (!readable) {
    return {
      ProcessId: Number(row && row.ProcessId) || 0,
      Name: safeText(row && row.Name, 260),
      Classification: CLASSIFICATION.UNKNOWN,
      Severity: options.strict ? 'failure' : 'warning',
      CommandLineReadable: false,
      References: []
    };
  }

  const references = classifyReferences(collectReferences([
    { name: 'CommandLine', value: commandLine, wholeField: false }
  ]), declaredRoots);
  const classification = classifyFrom(references);
  return {
    ProcessId: Number(row && row.ProcessId) || 0,
    Name: safeText(row && row.Name, 260),
    Classification: classification,
    Severity: classification === CLASSIFICATION.VIOLATION ? 'failure' : 'none',
    CommandLineReadable: true,
    References: references
  };
}

function summarize(items) {
  const classifications = {
    [CLASSIFICATION.OK]: 0,
    [CLASSIFICATION.VIOLATION]: 0,
    [CLASSIFICATION.IGNORED]: 0,
    [CLASSIFICATION.UNKNOWN]: 0
  };
  let failures = 0;
  let warnings = 0;
  for (const item of items) {
    classifications[item.Classification] += 1;
    if (item.Severity === 'failure') failures += 1;
    if (item.Severity === 'warning') warnings += 1;
  }
  return { total: items.length, classifications, failures, warnings };
}

function runPowerShell(script, label) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: POWERSHELL_MAX_BUFFER,
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
    env: safeLaunchEnvironment(process.env, { context: 'live task root PowerShell enumeration' })
  });

  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT' ? 'POWERSHELL_TIMEOUT' : 'POWERSHELL_SPAWN_FAILED';
    throw new CheckError(code, `${label} enumeration could not start or complete.`);
  }
  if (result.status !== 0) {
    throw new CheckError('POWERSHELL_EXIT_NONZERO', `${label} enumeration exited with status ${result.status}.`);
  }
  const output = String(result.stdout || '').replace(/^\uFEFF/, '').trim();
  if (!output) throw new CheckError('POWERSHELL_OUTPUT_EMPTY', `${label} enumeration returned no JSON.`);
  try {
    return asArray(JSON.parse(output));
  } catch {
    throw new CheckError('POWERSHELL_JSON_INVALID', `${label} enumeration returned invalid JSON.`);
  }
}

// The fixture seam. Reading rows from a file instead of the live system is the
// only way to drive both the green and the red path deterministically; without
// it this check can only ever be observed against whatever this machine happens
// to be running at the time, which is not a proof that it fails when it should.
// Fixture rows are parsed and classified by exactly the production path.
function readRowsFrom(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new CheckError('FIXTURE_UNREADABLE', `The ${label} fixture could not be read: ${safeText(file, 400)}`);
  }
  try {
    return asArray(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch {
    throw new CheckError('FIXTURE_JSON_INVALID', `The ${label} fixture is not valid JSON: ${safeText(file, 400)}`);
  }
}

function collectScheduledTasks() {
  return runPowerShell(TASKS_SCRIPT, 'Scheduled Task');
}

function collectRunningProcesses() {
  return runPowerShell(PROCESSES_SCRIPT, 'process');
}

function runCheck(options, dependencies = {}) {
  const declaredRoots = dependencies.declaredRoots || loadDeclaredRoots(options.registryFrom || SERVICE_REGISTRY_PATH);
  if (asArray(declaredRoots).length === 0) {
    throw new CheckError('SERVICE_REGISTRY_ROOTS_EMPTY', 'No declared roots were available to judge the live inventory.');
  }
  const taskRows = dependencies.taskRows
    || (options.tasksFrom
      ? readRowsFrom(options.tasksFrom, 'Scheduled Task')
      : (dependencies.collectScheduledTasks || collectScheduledTasks)());
  // --tasks-from implies --skip-processes. A task fixture describes some other
  // machine's world; pairing it with THIS machine's live processes would fold
  // two different worlds into a single verdict.
  const skipProcesses = options.skipProcesses || (Boolean(options.tasksFrom) && !options.processesFrom);
  const processRows = dependencies.processRows
    || (options.processesFrom
      ? readRowsFrom(options.processesFrom, 'process')
      : (skipProcesses ? [] : (dependencies.collectRunningProcesses || collectRunningProcesses)()));
  if (asArray(taskRows).length === 0) {
    throw new CheckError('SCHEDULED_TASK_INVENTORY_EMPTY',
      'Scheduled Task enumeration returned zero rows; the live-root gate refuses an unmeasured inventory.');
  }
  if (!skipProcesses && asArray(processRows).length === 0) {
    throw new CheckError('PROCESS_INVENTORY_EMPTY',
      'Process enumeration returned zero rows; the live-root gate refuses an unmeasured inventory.');
  }
  const taskItems = asArray(taskRows).map(row => classifyTask(row, declaredRoots, options));
  const processItems = asArray(processRows).map(row => classifyProcess(row, declaredRoots, options));
  const taskSummary = summarize(taskItems);
  const processSummary = summarize(processItems);
  const failures = taskSummary.failures + processSummary.failures;
  const warnings = taskSummary.warnings + processSummary.warnings;

  // counts/ is the stable headline the report has always published: how many
  // of each kind of finding, separated so a disabled violation is never read as
  // a live one.
  const taskViolations = taskItems.filter(item => item.Classification === CLASSIFICATION.VIOLATION);
  const isDisabled = item => String(item.State || '').toLowerCase() === 'disabled';
  const counts = {
    violations: taskViolations.filter(item => !isDisabled(item)).length,
    disabledViolations: taskViolations.filter(isDisabled).length,
    processViolations: processItems.filter(item => item.Classification === CLASSIFICATION.VIOLATION).length,
    unknownProcesses: processItems.filter(item => item.Classification === CLASSIFICATION.UNKNOWN).length
  };

  return {
    schemaVersion: 'live-task-roots.v1',
    generatedAt: new Date().toISOString(),
    repositoryRoot: REPO_ROOT,
    options: {
      allowDisabled: options.allowDisabled,
      strict: options.strict,
      effectiveAllowDisabled: options.allowDisabled && !options.strict,
      skipProcesses,
      registryFrom: options.registryFrom ? safeText(options.registryFrom, 400) : null,
      tasksFrom: options.tasksFrom ? safeText(options.tasksFrom, 400) : null,
      processesFrom: options.processesFrom ? safeText(options.processesFrom, 400) : null
    },
    declaredRoots,
    ok: failures === 0,
    failures,
    warnings,
    counts,
    tasks: { summary: taskSummary, items: taskItems },
    processes: { summary: processSummary, items: processItems }
  };
}

function formatReference(reference) {
  if (reference.declared) {
    return `${reference.path} -> ${reference.resolvedRoot} (declared: ${reference.machineIds.join(', ')})`;
  }
  return `${reference.path} -> ${reference.resolvedRoot || 'unresolved ToolsEnabled tree'} (NOT DECLARED)`;
}

function formatHumanReport(report) {
  const lines = ['Live ToolsEnabled task/process root check', '', 'Declared roots:'];
  for (const root of report.declaredRoots) {
    lines.push(`  ${root.machineIds.join(', ')}: ${root.root}`);
  }

  const task = report.tasks.summary;
  lines.push('', `Scheduled tasks: ${task.total} total; ${task.classifications.OK} OK; ` +
    `${task.classifications.VIOLATION} VIOLATION; ${task.classifications.IGNORED} IGNORED; ` +
    `${task.failures} failures; ${task.warnings} warnings`);
  for (const item of report.tasks.items.filter(entry => entry.Classification !== CLASSIFICATION.IGNORED)) {
    const label = item.Severity === 'failure' ? 'FAIL' : (item.Severity === 'warning' ? 'WARN' : 'OK');
    lines.push(`  [${label}] [${item.State}] ${item.TaskPath}${item.TaskName} -- ${item.Classification}`);
    for (const reference of item.References) lines.push(`      ${formatReference(reference)}`);
  }

  const processes = report.processes.summary;
  lines.push('', `Running node/PowerShell processes: ${processes.total} total; ${processes.classifications.OK} OK; ` +
    `${processes.classifications.VIOLATION} VIOLATION; ${processes.classifications.UNKNOWN} UNKNOWN; ` +
    `${processes.classifications.IGNORED} IGNORED; ${processes.failures} failures; ${processes.warnings} warnings`);
  for (const item of report.processes.items.filter(entry => entry.Classification !== CLASSIFICATION.IGNORED)) {
    const label = item.Severity === 'failure' ? 'FAIL' : (item.Severity === 'warning' ? 'WARN' : 'OK');
    lines.push(`  [${label}] pid ${item.ProcessId} (${item.Name}) -- ${item.Classification}`);
    if (item.Classification === CLASSIFICATION.UNKNOWN) {
      lines.push('      command line was empty or inaccessible; no root claim is made');
    }
    for (const reference of item.References) lines.push(`      ${formatReference(reference)}`);
  }

  // The headline verdict, listing ONLY what is actually wrong. It comes last
  // and lists nothing compliant, so "what must I fix" is answerable from the
  // bottom of the report without re-reading the full inventory above.
  const taskViolations = report.tasks.items.filter(item => item.Classification === CLASSIFICATION.VIOLATION);
  const live = taskViolations.filter(item => String(item.State || '').toLowerCase() !== 'disabled');
  const disabled = taskViolations.filter(item => String(item.State || '').toLowerCase() === 'disabled');
  const processViolations = report.processes.items.filter(item => item.Classification === CLASSIFICATION.VIOLATION);

  if (live.length) {
    lines.push('', `LIVE TASKS RUNNING FROM AN UNDECLARED ROOT  (${live.length})`);
    for (const item of live) lines.push(`  [${item.State}] ${item.TaskPath}${item.TaskName}`);
  }
  if (disabled.length) {
    lines.push('', `disabled tasks pointing at an undeclared root  (${disabled.length})` +
      `${report.options && report.options.effectiveAllowDisabled === false ? ' [FAIL]' : ' [warning]'}`);
    for (const item of disabled) lines.push(`  [${item.State}] ${item.TaskPath}${item.TaskName}`);
  }
  if (processViolations.length) {
    lines.push('', `RUNNING PROCESSES FROM AN UNDECLARED ROOT  (${processViolations.length})`);
    for (const item of processViolations) lines.push(`  pid ${item.ProcessId} (${item.Name})`);
  }

  lines.push('', report.ok
    ? `RESULT: PASS${report.warnings ? ` with ${report.warnings} warning(s)` : ''}`
    : `RESULT: FAIL -- ${report.failures} failure(s), ${report.warnings} warning(s)`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {
    json: false, strict: false, allowDisabled: true, help: false,
    skipProcesses: false, registryFrom: null, tasksFrom: null, processesFrom: null
  };
  const takeValue = (arg, index) => {
    const inline = arg.indexOf('=');
    if (inline !== -1) {
      const value = arg.slice(inline + 1);
      if (!value) {
        throw new CheckError('ARGUMENT_INVALID',
          `Option ${arg.slice(0, inline)} at position ${index + 1} needs a file path.`);
      }
      return { value, consumed: 0 };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CheckError('ARGUMENT_INVALID', `Option ${arg} at position ${index + 1} needs a file path.`);
    }
    return { value, consumed: 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--allow-disabled' || arg === '--allow-disabled=true') options.allowDisabled = true;
    else if (arg === '--no-allow-disabled' || arg === '--allow-disabled=false') options.allowDisabled = false;
    else if (arg === '--skip-processes') options.skipProcesses = true;
    else if (arg === '--registry-from' || arg.startsWith('--registry-from=')) {
      const taken = takeValue(arg, index);
      options.registryFrom = taken.value;
      index += taken.consumed;
    }
    else if (arg === '--tasks-from' || arg.startsWith('--tasks-from=')) {
      const taken = takeValue(arg, index);
      options.tasksFrom = taken.value;
      index += taken.consumed;
    } else if (arg === '--processes-from' || arg.startsWith('--processes-from=')) {
      const taken = takeValue(arg, index);
      options.processesFrom = taken.value;
      index += taken.consumed;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new CheckError('ARGUMENT_INVALID', `Unsupported command-line option at position ${index + 1}.`);
  }

  for (const [flag, value] of [
    ['--registry-from', options.registryFrom],
    ['--tasks-from', options.tasksFrom],
    ['--processes-from', options.processesFrom]
  ]) {
    if (value && !fs.existsSync(value)) {
      throw new CheckError('ARGUMENT_INVALID', `${flag} file not found: ${safeText(value, 400)}`);
    }
  }
  return options;
}

const USAGE = `Usage: node tools/check-live-task-roots.js [--json] [--allow-disabled] [--strict]\n` +
  `                                          [--skip-processes]\n` +
  `                                          [--registry-from <registry.json>]\n` +
  `                                          [--tasks-from <rows.json>]\n` +
  `                                          [--processes-from <rows.json>]\n\n` +
  `  --json                 Print the machine-readable report.\n` +
  `  --allow-disabled       Keep Disabled violations as warnings (default true).\n` +
  `  --no-allow-disabled    Treat Disabled violations as failures.\n` +
  `  --strict               Fail on Disabled violations and UNKNOWN processes.\n` +
  `  --skip-processes       Check scheduled tasks only; do not enumerate processes.\n` +
  `  --registry-from <file> Use an explicit service-registry fixture. This does not\n` +
  `                         alter the installed registry.\n` +
  `  --tasks-from <file>    Read task rows from a JSON fixture instead of the live\n` +
  `                         system. Implies --skip-processes unless\n` +
  `                         --processes-from is also given.\n` +
  `  --processes-from <f>   Read process rows from a JSON fixture.\n\n` +
  `exit 0 = every auto-started reference resolves inside a declared root\n` +
  `exit 1 = something live runs from a tree the service registry does not declare\n`;

function errorReport(error, options) {
  return {
    schemaVersion: 'live-task-roots.v1',
    generatedAt: new Date().toISOString(),
    repositoryRoot: REPO_ROOT,
    options: options ? {
      allowDisabled: options.allowDisabled,
      strict: options.strict,
      effectiveAllowDisabled: options.allowDisabled && !options.strict
    } : null,
    ok: false,
    failures: 1,
    warnings: 0,
    error: {
      code: error && error.code ? safeText(error.code, 200) : 'CHECK_FAILED',
      message: error && error.message ? safeText(error.message, 1000) : 'The live root check failed.'
    }
  };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const report = runCheck(options);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatHumanReport(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    const report = errorReport(error, options);
    if (options && options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stderr.write(`RESULT: FAIL -- ${report.error.code}: ${report.error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  CLASSIFICATION,
  asArray,
  classifyFrom,
  classifyPaths,
  classifyProcess,
  classifyReferences,
  classifyTask,
  collectReferences,
  errorReport,
  extractAbsoluteWindowsPaths,
  formatHumanReport,
  isWithinRoot,
  loadDeclaredRoots,
  main,
  materialReferences,
  nearestPackageRoot,
  normalizeWindowsPath,
  parseArgs,
  readRowsFrom,
  resolveReference,
  runCheck,
  summarize,
  taskActionRows,

  // Names this module has always published. They are kept pointing at the
  // functions that now do the work, so existing callers keep working:
  //   declaredRoots        -> loadDeclaredRoots
  //   extractCandidatePaths-> extractAbsoluteWindowsPaths (already tree-filtered)
  //   inferTreeRoot        -> nearestPackageRoot
  // (evaluateTasks/evaluateProcesses became classifyTask/classifyProcess, which
  // return per-item records rather than a findings array, so they are exported
  // under their own names above rather than aliased to a different shape.)
  declaredRoots: loadDeclaredRoots,
  extractCandidatePaths: extractAbsoluteWindowsPaths,
  inferTreeRoot: nearestPackageRoot
};
