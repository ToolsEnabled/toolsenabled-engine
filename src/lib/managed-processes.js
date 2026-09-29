'use strict';

// Managed process registry loader (R93 coordinator control plane, Phase 1).
//
// config/managed-processes.json is the declared description of every
// long-lived subsystem. This module parses it strictly and exposes argv
// assembly so that scheduled-task registrars never carry a hardcoded argv
// literal.
//
// Deliberately dependency-free: this module is required by the health
// observer, whose whole value proposition is that it cannot be taken down by
// an unrelated subsystem's broken require graph (incident #3). Adding a
// require here that reaches into providers/runtime would defeat that, and
// tests/health-observer.test.js enforces the cap.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_FILE = path.join(ROOT, 'config', 'managed-processes.json');

const KNOWN_KEYS = new Set([
  '$comment',
  'displayName', 'taskName', 'kind', 'owner', 'repo', 'entryPoint', 'entryPattern',
  'declaredArgv', 'cwd', 'port', 'portRange', 'logStdout', 'logStderr', 'pidLockFile', 'stateFile',
  'stopSentinel', 'registrar', 'repetitionMinutes', 'onDemand', 'ownerLaunched', 'rungs', 'correctionMode'
]);

const REQUIRED_KEYS = [
  'displayName', 'kind', 'entryPoint', 'entryPattern', 'declaredArgv', 'cwd', 'owner'
];

// These two scheduled-process identities belonged to the retired
// opposite-principal owner-host design. The installed app now owns the host in
// memory under its exact Windows principal. Ignore legacy rows observably so
// an upgrade does not poison every unrelated process record, but never return
// or launch them.
const RETIRED_PROCESS_IDS = new Set(['owner-host', 'owner-host-keeper']);

function fail(message) {
  const error = new Error(`managed-processes: ${message}`);
  error.code = 'MANAGED_PROCESS_REGISTRY_INVALID';
  return error;
}

function loadRegistry(registryFile = REGISTRY_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(registryFile, 'utf8');
  } catch (error) {
    throw fail(`registry file unreadable at ${registryFile}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw fail(`registry file is not valid JSON: ${error.message}`);
  }

  if (parsed.schemaVersion !== 1) {
    throw fail(`unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)} (expected 1)`);
  }
  if (!parsed.processes || typeof parsed.processes !== 'object') {
    throw fail('registry is missing a "processes" object');
  }

  const processes = {};
  const retiredProcessIds = [];
  for (const [id, entry] of Object.entries(parsed.processes)) {
    if (!entry || typeof entry !== 'object') throw fail(`process ${id} is not an object`);
    if (RETIRED_PROCESS_IDS.has(id)) {
      retiredProcessIds.push(id);
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (!KNOWN_KEYS.has(key)) {
        throw fail(`process ${id} has unknown key ${JSON.stringify(key)}`);
      }
    }
    for (const key of REQUIRED_KEYS) {
      if (entry[key] === undefined) throw fail(`process ${id} is missing required key ${key}`);
    }
    if (!Array.isArray(entry.declaredArgv)) {
      throw fail(`process ${id} declaredArgv must be an array`);
    }
    if (entry.declaredArgv.some(value => typeof value !== 'string')) {
      throw fail(`process ${id} declaredArgv must contain only strings`);
    }
    if (entry.correctionMode !== undefined
        && !['direct-node', 'report-only'].includes(entry.correctionMode)) {
      throw fail(`process ${id} correctionMode must be "direct-node" or "report-only"`);
    }

    const hasFixedPort = entry.port !== undefined && entry.port !== null;
    const hasPortRange = entry.portRange !== undefined && entry.portRange !== null;
    if (hasFixedPort && (!Number.isSafeInteger(entry.port) || entry.port < 1 || entry.port > 65_535)) {
      throw fail(`process ${id} port must be an integer from 1 through 65535`);
    }
    if (hasFixedPort && hasPortRange) {
      throw fail(`process ${id} may declare either port or portRange, not both`);
    }
    if (hasPortRange) {
      const range = entry.portRange;
      if (!range || typeof range !== 'object' || Array.isArray(range)
          || Object.getPrototypeOf(range) !== Object.prototype
          || Reflect.ownKeys(range).some(key => !['first', 'last'].includes(key))
          || !Object.hasOwn(range, 'first') || !Object.hasOwn(range, 'last')
          || !Number.isSafeInteger(range.first) || !Number.isSafeInteger(range.last)
          || range.first < 1 || range.last > 65_535 || range.first > range.last) {
        throw fail(`process ${id} portRange must contain only integer first/last bounds within 1 through 65535, in ascending order`);
      }
    }

    processes[id] = Object.freeze({
      id,
      ...entry,
      declaredArgv: Object.freeze([...entry.declaredArgv]),
      ...(hasPortRange ? { portRange: Object.freeze({ first: entry.portRange.first, last: entry.portRange.last }) } : {})
    });
  }

  if (Object.keys(processes).length === 0) throw fail('registry declares zero processes');
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    processes: Object.freeze(processes),
    retiredProcessIds: Object.freeze(retiredProcessIds.sort())
  });
}

function getProcess(id, registryFile) {
  const registry = loadRegistry(registryFile);
  const entry = registry.processes[id];
  if (!entry) {
    if (registry.retiredProcessIds.includes(id)) {
      throw fail(`process id ${JSON.stringify(id)} is retired; the installed app owns the agent-session host in memory`);
    }
    const known = Object.keys(registry.processes).join(', ');
    throw fail(`unknown process id ${JSON.stringify(id)} (known: ${known})`);
  }
  return entry;
}

function listProcesses(registryFile) {
  return Object.values(loadRegistry(registryFile).processes);
}

// Resolved argv for spawning a subsystem: entry point first, then the declared
// arguments. Registrars call this (via --argv) so the argv in Task Scheduler
// and the argv the control plane checks against are the same string by
// construction, not by two people remembering to edit two files.
function resolveArgv(id, { registryFile, absolute = true } = {}) {
  const entry = getProcess(id, registryFile);
  if (typeof entry.entryPoint === 'string' && entry.entryPoint.trim() === '') {
    const error = new Error(`managed-processes: process ${id} is unavailable because it declares no installed entry point`);
    error.code = 'MANAGED_PROCESS_UNAVAILABLE';
    throw error;
  }
  const entryPoint = absolute ? path.resolve(ROOT, entry.entryPoint) : entry.entryPoint;
  return [entryPoint, ...entry.declaredArgv];
}

// Preconditions that must hold before a correction may spawn this subsystem.
// Incident #5: the fleet supervisor was restarted without --project, which
// instantly failed 9 lanes and falsely parked 8 queue items. A restart that
// cannot satisfy its declared preconditions must be REPORTED, never attempted.
const REQUIRED_FLAGS = Object.freeze({
  'fleet-supervisor': Object.freeze(['--project', '--backend'])
});

// A background registrar must also select the long-lived action explicitly.
// tools/fleet-supervisor.js has several one-shot actions; merely supplying its
// provider values does not make it a service. Keep this beside REQUIRED_FLAGS
// so every correction and registrar consults one canonical contract.
const REQUIRED_ACTION_MODES = Object.freeze({
  'fleet-supervisor': '--serve'
});
const CONFLICTING_ACTION_MODES = Object.freeze({
  'fleet-supervisor': Object.freeze([
    '--help', '--status', '--plan', '--once', '--stop', '--clear-stop', '--prune-worktrees', '--dry-run'
  ])
});

function checkArgvPreconditions(id, argv) {
  const required = REQUIRED_FLAGS[id] || [];
  const actionMode = REQUIRED_ACTION_MODES[id] || null;
  const conflictingModes = CONFLICTING_ACTION_MODES[id] || [];
  // Do not let String.prototype.includes/indexOf impersonate an argv scan.
  // A string (or an array containing non-strings) is not a measured argument
  // vector, so reporting that it satisfies the preconditions would turn an
  // invalid input into a definite answer about the command.
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    return {
      ok: false,
      code: 'CORRECTION_PRECONDITION_FAILED',
      missing: [...(actionMode ? [actionMode] : []), ...required],
      reason: `resolved argv for ${id} is not an array containing only strings`
    };
  }
  const missing = [];
  if (actionMode) {
    const actionCount = argv.filter(value => value === actionMode).length;
    if (actionCount !== 1 || conflictingModes.some(value => argv.includes(value))) missing.push(actionMode);
  }
  for (const flag of required) {
    const indexes = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === flag) indexes.push(index);
    }
    // Duplicate value-bearing flags are ambiguous and must not be silently
    // resolved by choosing the first or last occurrence.
    if (indexes.length !== 1) {
      missing.push(flag);
      continue;
    }
    const value = argv[indexes[0] + 1];
    if (!value || value.startsWith('-')) missing.push(flag);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'CORRECTION_PRECONDITION_FAILED',
      missing,
      reason: `resolved argv for ${id} lacks an exact unattended action mode or one unambiguous value after each required flag: ${missing.join(', ')}`
    };
  }
  return {
    ok: true,
    code: 'OK',
    missing: [],
    reason: `resolved argv for ${id} selects ${actionMode || 'its declared action'} and satisfies ${required.length} value precondition(s)`
  };
}

function correctionMode(id, registryFile) {
  return getProcess(id, registryFile).correctionMode || 'direct-node';
}

module.exports = Object.freeze({
  REGISTRY_FILE,
  CONFLICTING_ACTION_MODES,
  REQUIRED_ACTION_MODES,
  REQUIRED_FLAGS,
  RETIRED_PROCESS_IDS,
  ROOT,
  checkArgvPreconditions,
  correctionMode,
  getProcess,
  listProcesses,
  loadRegistry,
  resolveArgv
});
