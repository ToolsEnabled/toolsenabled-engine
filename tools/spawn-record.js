#!/usr/bin/env node
'use strict';

// Q27 (BUILD-QUEUE.md) step 4: route a spawn through the dashboard tracker in
// ONE call.
//
// The reason spawns go unattributed today is friction, not refusal. CLAUDE.md
// item 10 asks that spawning go through the launch record; nothing made that
// cheap. This is that: one command, one line of output, the launch id.
//
//   node tools/spawn-record.js --actor claude --agent luna --phase Q27 \
//       --model gpt-5.6-luna --tier cheap --turns 40
//   -> launch_9f2c...            (stdout, nothing else)
//
// or from JS:
//   const { recordSpawn } = require('./tools/spawn-record');
//   const { launchId } = recordSpawn({ requestingActor: 'claude', targetAgentId: 'luna',
//                                      objectiveRef: 'Q27', model: 'gpt-5.6-luna' });
//
// This is a CONVENTION, not a gate. Per the owner's recorded correction in
// Q27, no spawn is blocked by the absence of a launch record: incomplete
// attribution degrades gracefully, a broken spawn gate does not. This tool
// therefore never wraps, intercepts, or executes the spawn itself -- it only
// records it. It grants no authority: every policy, approval, kill-switch and
// credential gate the spawned agent was already bound by is unchanged, and
// createLaunch still refuses an unknown/disabled agent, a phase the agent may
// not claim, and a fan-out/depth cap violation.
//
// The one thing this tool will NOT do for convenience is guess the type.
// `--model` is required, because a defaulted model id would put an invented
// type into the exact record Q27 built to hold the real one. If the model
// genuinely is not known at spawn time, pass `--model unknown` and it is
// recorded as unknown -- explicitly, by the caller, on purpose.

const launchRecord = require('../src/lib/controller-launch-record');

const DEFAULT_TURNS = 40;
const DEFAULT_CAP_MS = 2 * 60 * 60 * 1000;

const USAGE = `Record a spawn with the dashboard tracker (Q27).

  node tools/spawn-record.js --actor <id> --agent <id> --phase <ref> --model <id> [options]

Required
  --actor <id>      the agent id doing the spawning (e.g. codex)
  --agent <id>      the declared agent id being spawned (config/agent-org.json)
  --phase <ref>     a queue phase id (Q27) or a short label -- never prompt text
  --model <id>      the model/tier actually being used, or the literal "unknown".
                    Never defaulted: a guessed type defeats the whole record.

Options
  --tier <t>        cheap | standard | premium   (default: cheap)
  --turns <n>       turn cap                     (default: ${DEFAULT_TURNS})
  --budget <n>      budget cap instead of a turn cap
  --cap-ms <n>      wall-clock cap in ms, used for staleness (default: ${DEFAULT_CAP_MS})
  --parent <id>     parent launch id, for a nested spawn
  --thread-id <id>  exact owner-scope thread binding
  --scope-rule <json>
                     repeatable owner-scope rule object for contextual scope.
                     Caller-supplied rules cannot activate a disabled target.
  --scope-store-revision <n>
                     durable owner-scope store revision. Required, with
                     --thread-id, to activate a disabled target from a
                     recorded owner rule; mutually exclusive with --scope-rule.
  --executor-payload-hash <hex>
                    optional lowercase SHA-256 binding for the executor payload
  --json            print the full record instead of just the launch id
  --help

Exit codes: 0 recorded, 2 bad usage, 3 refused by the launch record.
`;

const VALUE_FLAGS = new Set([
  'actor', 'agent', 'phase', 'model', 'tier', 'turns', 'budget', 'cap-ms',
  'parent', 'thread-id', 'scope-rule', 'scope-store-revision', 'executor-payload-hash'
]);
const BOOLEAN_FLAGS = new Set(['json', 'help']);
const EXECUTOR_PAYLOAD_HASH_RE = /^[a-f0-9]{64}$/;

function parseArgs(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument "${token}"`);
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) { flags.set(key, true); continue; }
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown flag "--${key}"`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    if (key === 'scope-rule') {
      const rules = flags.get(key) || [];
      rules.push(value);
      flags.set(key, rules);
    } else {
      flags.set(key, value);
    }
    index += 1;
  }
  return flags;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${label} must be a non-negative integer`);
  return parsed;
}

function scopeRules(values) {
  return values.map((value, index) => {
    let parsed;
    try { parsed = JSON.parse(value); }
    catch { throw new Error(`--scope-rule #${index + 1} must be valid JSON`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`--scope-rule #${index + 1} must be a JSON object`);
    }
    return parsed;
  });
}

function executorPayloadHash(value) {
  if (typeof value !== 'string' || !EXECUTOR_PAYLOAD_HASH_RE.test(value)) {
    throw new Error('--executor-payload-hash must be a lowercase SHA-256 digest');
  }
  return value;
}

/**
 * Record one spawn. Thin: it assembles a launch request from friendly option
 * names and hands it to createLaunch, which owns every validation and refusal.
 * Returns createLaunch's result unchanged.
 */
function recordSpawn(options = {}, dependencies = {}) {
  const model = options.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('model is required -- pass the model/tier actually in use, or the literal "unknown". It is never defaulted.');
  }
  const cap = options.budget !== undefined && options.budget !== null
    ? { kind: 'budget', value: options.budget, capMs: options.capMs ?? DEFAULT_CAP_MS }
    : { kind: 'turns', value: options.turns ?? DEFAULT_TURNS, capMs: options.capMs ?? DEFAULT_CAP_MS };
  const request = {
    requestingActor: options.requestingActor,
    targetAgentId: options.targetAgentId,
    tier: options.tier || launchRecord.DEFAULT_TIER,
    model,
    objectiveRef: options.objectiveRef,
    cap,
    parentLaunchId: options.parentLaunchId ?? null
  };
  // Q64: scope is explicit input, never inferred from the helper's caller.
  // Keep the old request shape byte-for-byte equivalent when no optional fields
  // are supplied, while allowing dashboard/JS callers to carry the
  // resolved owner packet into the launch record.
  if (options.threadId !== undefined) request.threadId = options.threadId;
  if (options.scopeRules !== undefined) request.scopeRules = options.scopeRules;
  if (options.scopeStoreRevision !== undefined) request.scopeStoreRevision = options.scopeStoreRevision;
  if (options.executorPayloadHash !== undefined) request.executorPayloadHash = options.executorPayloadHash;
  const createLaunch = dependencies.createLaunch || launchRecord.createLaunch;
  return createLaunch(request, dependencies);
}

function main(argv, dependencies = {}) {
  let flags;
  try { flags = parseArgs(argv); }
  catch (error) { process.stderr.write(`${error.message}\n\n${USAGE}`); return 2; }
  if (flags.get('help') || argv.length === 0) { process.stdout.write(USAGE); return flags.get('help') ? 0 : 2; }

  let options;
  try {
    options = {
      requestingActor: flags.get('actor'),
      targetAgentId: flags.get('agent'),
      objectiveRef: flags.get('phase'),
      model: flags.get('model'),
      tier: flags.get('tier'),
      turns: flags.has('turns') ? positiveInteger(flags.get('turns'), 'turns') : undefined,
      budget: flags.has('budget') ? positiveInteger(flags.get('budget'), 'budget') : undefined,
      capMs: flags.has('cap-ms') ? positiveInteger(flags.get('cap-ms'), 'cap-ms') : undefined,
      parentLaunchId: flags.get('parent') ?? null,
      threadId: flags.has('thread-id') ? flags.get('thread-id') : undefined,
      scopeRules: flags.has('scope-rule') ? scopeRules(flags.get('scope-rule')) : undefined,
      scopeStoreRevision: flags.has('scope-store-revision')
        ? nonNegativeInteger(flags.get('scope-store-revision'), 'scope-store-revision')
        : undefined,
      executorPayloadHash: flags.has('executor-payload-hash')
        ? executorPayloadHash(flags.get('executor-payload-hash'))
        : undefined
    };
    for (const [key, flag] of [['requestingActor', 'actor'], ['targetAgentId', 'agent'], ['objectiveRef', 'phase'], ['model', 'model']]) {
      if (!options[key]) throw new Error(`--${flag} is required`);
    }
  } catch (error) { process.stderr.write(`${error.message}\n\n${USAGE}`); return 2; }

  let result;
  try { result = recordSpawn(options, dependencies); }
  catch (error) {
    // A refusal is the tracker working, not a tool failure -- report the code
    // the launch record chose rather than a stack trace.
    const code = error && error.code ? error.code : 'SPAWN_RECORD_FAILED';
    process.stderr.write(`${code}: ${error && error.message ? error.message : String(error)}\n`);
    return 3;
  }

  if (flags.get('json')) {
    process.stdout.write(`${JSON.stringify({
      launchId: result.launchId,
      record: result.record,
      // The dispatcher-facing brief carries the resolved owner scope as
      // informational context only. Keep it separate from the durable launch
      // record so it cannot be mistaken for authority or executor policy.
      dispatchBrief: result.dispatchBrief,
      auditSequence: result.auditSequence,
      auditEventHash: result.auditEventHash
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.launchId}\n`);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { recordSpawn, main, parseArgs, executorPayloadHash, scopeRules, DEFAULT_TURNS, DEFAULT_CAP_MS, USAGE };
