#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const onboarding = require('../src/lib/agent-onboarding');

const MAX_HOOK_INPUT_BYTES = 128 * 1024;

function usage(message) {
  const error = new Error(message || 'Invalid agent-onboarding arguments.');
  error.code = 'AGENT_ONBOARDING_USAGE';
  throw error;
}

function parseArgs(argv) {
  const values = {};
  const booleans = new Set(['--hook', '--json']);
  const named = new Set([
    '--scope', '--profile', '--agent', '--role', '--provider', '--model', '--tier', '--reports-to',
    '--launch', '--directive', '--territory', '--topic', '--project', '--runtime',
    '--session', '--thread', '--tree-ancestors'
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleans.has(flag)) {
      if (Object.hasOwn(values, flag)) usage(`Duplicate ${flag}.`);
      values[flag] = true;
      continue;
    }
    if (!named.has(flag) || index + 1 >= argv.length) usage(`Unknown or incomplete option ${flag}.`);
    if (Object.hasOwn(values, flag)) usage(`Duplicate ${flag}.`);
    values[flag] = argv[++index];
  }
  if (values['--hook'] && values['--json']) usage('--hook and --json are mutually exclusive.');
  return Object.freeze(values);
}

function readHookEvent(stream = process.stdin) {
  if (stream.isTTY) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_HOOK_INPUT_BYTES) {
        const error = new Error(`Hook input exceeds ${MAX_HOOK_INPUT_BYTES} bytes.`);
        error.code = 'AGENT_ONBOARDING_HOOK_INPUT_TOO_LARGE';
        reject(error);
        stream.resume();
        return;
      }
      chunks.push(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch {
        const error = new Error('Hook input is not valid JSON.');
        error.code = 'AGENT_ONBOARDING_HOOK_INPUT_INVALID';
        reject(error);
      }
    });
  });
}

function profileFromEvent(eventAgentType, eventName) {
  const hasUnverifiedAgentType = typeof eventAgentType === 'string' && Boolean(eventAgentType.trim());
  // A hook event is not an authenticated role assignment. No agent_type name
  // may select a lighter profile; every subagent must prove the live mutation
  // context until the authoritative installed role definition is resolved.
  return eventName === 'SubagentStart' || hasUnverifiedAgentType ? 'builder' : 'agent';
}

function inputFrom(options, event = {}, environment = process.env) {
  const eventAgentType = typeof event.agent_type === 'string' ? event.agent_type : null;
  const hookMode = Boolean(options['--hook']);
  return {
    scope: options['--scope'] || (hookMode ? (event.hook_event_name === 'SubagentStart' ? 'task' : 'full') : 'full'),
    profile: options['--profile'] || (hookMode ? profileFromEvent(eventAgentType, event.hook_event_name) : 'agent'),
    agentId: options['--agent'] || event.agent_id || environment.TOOLSENABLED_AGENT_ID,
    identityBinding: hookMode ? 'hook-event-unverified' : 'cli-argument-unverified',
    role: hookMode ? undefined : options['--role'] || environment.TOOLSENABLED_AGENT_ROLE,
    provider: options['--provider'],
    model: options['--model'] || event.model || environment.TOOLSENABLED_AGENT_MODEL,
    tier: options['--tier'] || environment.TOOLSENABLED_AGENT_TIER,
    reportsTo: options['--reports-to'],
    launchId: options['--launch'] || environment.TOOLSENABLED_LAUNCH_ID,
    directiveId: options['--directive'],
    territory: options['--territory'],
    topic: options['--topic'] || eventAgentType || event.source || event.hook_event_name || 'agent onboarding',
    projectRoot: options['--project'] || event.cwd || environment.TOOLSENABLED_PROJECT_ROOT || process.cwd(),
    runtimeRoot: options['--runtime'] || environment.TOOLSENABLED_RUNTIME_ROOT,
    // The owner's R-ledger identity (src/lib/r-ledger.js). The hook event's
    // session_id names the session AND, for an interactive Claude session, the
    // thread; a product-spawned child carries its own thread id and its
    // ancestors' session ids (oldest first) in the environment its parent set.
    sessionId: options['--session'] || event.session_id || event.sessionId || environment.TOOLSENABLED_SESSION_ID || null,
    threadId: options['--thread'] || environment.TOOLSENABLED_THREAD_ID || event.session_id || event.sessionId || null,
    treeAnchors: treeAnchorsFrom(options['--tree-ancestors'] || environment.TOOLSENABLED_TREE_ANCESTORS)
  };
}

function treeAnchorsFrom(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map(part => part.trim()).filter(Boolean).slice(0, 32);
}

function hookEnvelope(eventName, additionalContext, extra = {}) {
  const supported = eventName === 'SubagentStart' ? 'SubagentStart' : 'SessionStart';
  return {
    continue: extra.continue !== false,
    ...(extra.stopReason ? { stopReason: extra.stopReason } : {}),
    hookSpecificOutput: { hookEventName: supported, additionalContext }
  };
}

function verifiedSuppression(environment, dependencies = {}) {
  if (environment.TOOLSENABLED_ONBOARDING_ALREADY_INJECTED !== '1'
      || environment.TOOLSENABLED_ONBOARDING_PACKET_VERSION !== onboarding.PACKET_VERSION
      || !/^[a-f0-9]{64}$/.test(String(environment.TOOLSENABLED_ONBOARDING_PACKET_HASH || ''))
      || environment.TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE !== 'verified-launch') return false;
  const auditSequence = Number(environment.TOOLSENABLED_LAUNCH_AUDIT_SEQUENCE);
  const receipt = {
    launchId: environment.TOOLSENABLED_LAUNCH_ID,
    recordHash: environment.TOOLSENABLED_LAUNCH_RECORD_HASH,
    auditSequence,
    auditEventHash: environment.TOOLSENABLED_LAUNCH_AUDIT_EVENT_HASH
  };
  if (typeof receipt.launchId !== 'string' || !/^[a-f0-9]{64}$/.test(String(receipt.recordHash || ''))
      || !Number.isSafeInteger(auditSequence) || auditSequence < 1
      || !/^[a-f0-9]{64}$/.test(String(receipt.auditEventHash || ''))) return false;
  try {
    const verify = dependencies.verifyLaunchReceipt
      || require('../src/lib/fleet-supervisor/luna-executor.js').verifyLaunchReceipt;
    const verified = verify(receipt);
    return verified && verified.launchId === receipt.launchId && verified.recordHash === receipt.recordHash
      && verified.auditSequence === receipt.auditSequence && verified.auditEventHash === receipt.auditEventHash;
  } catch { return false; }
}

/* Put this launch into the canonical signed ledger, without becoming part of
 * whether onboarding succeeds.
 *
 * WHY HERE. This script is the SessionStart and SubagentStart hook, so it is
 * the one place that already sees every agent launch on this machine. It was
 * previously the place that saw them and wrote nothing signed: measured
 * 2026-08-12, the newest `controller.agent.launch` in state/audit.sqlite3 was
 * four days old while six agents were running. The chain was intact -- 26,527
 * entries, audit.verify valid -- and simply had no writer for these paths.
 *
 * `.claude/settings.json` is write-protected (src/lib/providers/repo-files.js
 * WRITE_PROTECTED_FILES), so the recorder is invoked from inside the hook that
 * is already registered rather than by registering a second one.
 *
 * IT MUST NOT CHANGE WHAT THIS FILE DOES. Onboarding fails CLOSED -- an error
 * here stops the agent with continue:false -- and a ledger write must never be
 * able to cause that. So the spawn is detached, its result is never awaited,
 * and every failure is swallowed HERE and logged THERE
 * (logs/agent-launch-audit.log). The recorder itself always exits 0.
 *
 * Fired before the suppression return above deliberately: a launch that
 * suppresses duplicate onboarding context is still a launch. */
function recordLaunchInBackground(event, dependencies = {}) {
  if (dependencies.recordLaunch) { try { dependencies.recordLaunch(event); } catch { /* never fatal */ } return; }
  try {
    const { spawn } = require('node:child_process');
    const path = require('node:path');
    // The child is Node running our own recorder, and a Node child can go on to
    // launch a provider CLI -- which is exactly the leak class the spawn-env
    // gate exists for. Measured on this machine 2026-08-10 through a real
    // spawned child: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, AWS_ACCESS_KEY_ID
    // and OPENAI_API_KEY all arrived SET. Inheriting ambient env here shipped
    // that leak; safeLaunchEnvironment is the one shared scrub, and it refuses
    // the launch rather than leaking silently.
    const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
    const child = spawn(process.execPath, [path.join(__dirname, 'record-agent-launch.js')], {
      cwd: path.join(__dirname, '..'), detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
      env: safeLaunchEnvironment(process.env, { context: 'agent-onboarding launch recorder' })
    });
    child.on('error', () => { /* logged by the recorder; never fatal here */ });
    try { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(event)); } catch { /* nothing to record */ }
    child.unref();
  } catch {
    // A ledger that cannot be written must not stop the agent from starting.
    // The gap is visible in the ledger itself, which is the honest outcome.
  }
}

// THE LAUNCH RECORD FOR AGENTS NOBODY LAUNCHED THROUGH THE LAUNCHER.
//
// `controller.agent.launch` was written by exactly one thing: the enforcing
// launcher (src/lib/controller-launch-record.js, reached from the dashboard and
// tools/lane-run.js). Every agent started any other way -- and on this machine
// that is nearly all of them, because Claude-native child agents are spawned by
// the harness -- ran this hook, received a packet, did its work, and left no
// trace in the ledger at all. Measured 2026-08-12: 122 launch records, the most
// recent 2026-08-08, while six agents were running.
//
// verifiedSuppression() above is the other half of the same fact. It exists to
// recognise a launch that ALREADY carries a verified audit receipt in its
// environment. Its false branch was the unrecorded population and nothing
// looked at it.
//
// THIS RECORD IS NOT A GATE, AND THE ENFORCING LAUNCHER'S STILL IS.
// The launcher refuses to start an agent it cannot record, which is right: it
// is one process, starting one agent, and it can afford to fail. This hook is
// different in a way that matters. It runs inside a 15-second harness timeout,
// once per child agent, and a fleet wave starts dozens at once against a
// single-writer ledger that takes about a second per append. Gating here would
// mean that a burst of agents past the point where appends stop fitting in 15
// seconds does not merely go unrecorded -- it FAILS TO START, because a failed
// hook returns continue:false. Trading "some launches are missing from the
// ledger" for "the fleet stops working under load" is not a stronger guarantee,
// it is a worse product with the same gap.
//
// So the append is attempted, and when it cannot be made the packet SAYS SO in
// the text the agent reads, rather than the launch quietly vanishing the way it
// used to. A missing record that announces itself is recoverable; a silent one
// is what produced this defect.
//
// Nothing here weakens the chain: it is the same signed append the launcher
// makes, through the same writer, and a failure changes only whether the agent
// starts -- never whether the ledger is honest about what it holds.
const LAUNCH_ACTION = 'controller.agent.launch';

function recordUnenforcedLaunch(input, event, dependencies = {}) {
  const audit = dependencies.audit || require('../src/lib/audit');
  // WHICH AGENT THIS WAS, through every name the payload might use for it.
  //
  // The first version of this read only `input.agentId` and `event.session_id`
  // and a REAL harness-spawned subagent landed in the chain as `unattributed`
  // (sequence 26621, an observer, 2026-08-13T02:13:17Z) because it carried
  // neither. A launch record that cannot say which agent launched still proves
  // that something did -- each row is its own event, so the COUNT stays honest
  // -- but correlating a running process to its record is most of why the
  // record exists, so falling back to one shared literal was throwing away the
  // part that matters.
  //
  // The transcript path is included because it is the one field that is always
  // distinct per child agent even when every id is absent. Only its basename
  // is taken: the ledger must not carry a filesystem path.
  const candidates = [
    input.agentId, event.agent_id, event.agentId,
    event.session_id, event.sessionId,
    typeof event.transcript_path === 'string' ? event.transcript_path.split(/[\\/]/).pop() : null
  ];
  const identity = candidates.find(value => typeof value === 'string' && value.trim().length > 0);
  // A target the ledger will accept and a human can correlate. Never a path and
  // never free-form prose from the event. When nothing identifies the agent the
  // target is still made UNIQUE, so two unattributable launches are two rows a
  // reader can tell apart rather than one name that hides how many there were.
  const cleaned = identity
    ? String(identity).trim().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 180)
    : `unattributed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const target = cleaned.length >= 8 ? cleaned : `agent:${cleaned}`;
  try {
    const status = audit.record(LAUNCH_ACTION, target, {
      // Stated plainly, because this is the whole point of the record: nothing
      // verified this launch. The attribution projection must not read it as
      // equivalent to a launcher-issued one.
      provenance: 'harness-unenforced',
      // Stated so a reader never mistakes a minted placeholder for a real id.
      attributed: Boolean(identity),
      identityBinding: input.identityBinding,
      scope: input.scope,
      profile: input.profile,
      model: input.model || null,
      agentType: typeof event.agent_type === 'string' ? event.agent_type : null,
      hookEvent: typeof event.hook_event_name === 'string' ? event.hook_event_name : null
    });
    // `durable` without the ledger position is not enough evidence for the
    // definite "recorded at sequence N" statement emitted below. Treat a
    // malformed/incomplete writer response as unmeasured instead of rendering
    // (for example) "sequence undefined" as a fact.
    if (status && status.durable) {
      if (Number.isSafeInteger(status.sequence) && status.sequence >= 1) {
        return { ok: true, sequence: status.sequence };
      }
      return { ok: false, code: 'AUDIT_SEQUENCE_UNAVAILABLE' };
    }
    return { ok: false, code: 'AUDIT_NOT_DURABLE' };
  } catch (error) {
    return { ok: false, code: String((error && error.code) || 'AUDIT_UNAVAILABLE') };
  }
}

async function run(argv = process.argv, dependencies = {}) {
  const options = parseArgs(argv);
  const environment = dependencies.environment || process.env;
  const event = options['--hook'] ? await readHookEvent(dependencies.stdin || process.stdin) : {};
  if (options['--hook']) recordLaunchInBackground(event, dependencies);
  try {
    if (options['--hook'] && verifiedSuppression(environment, dependencies)) {
      return `${JSON.stringify(hookEnvelope(event.hook_event_name, 'ToolsEnabled dynamic onboarding was already injected by the enforcing launcher; duplicate hook context suppressed.'))}\n`;
    }
    const input = inputFrom(options, event, environment);
    const packet = onboarding.buildPacket(input, dependencies.onboardingDependencies || {});
    if (options['--json']) return `${JSON.stringify(packet, null, 2)}\n`;
    const prependStatus = dependencies.prependStatusInjection
      || require('../src/lib/status-injection').prependStatusInjection;
    const rendered = await prependStatus(onboarding.renderPacket(packet), { input }, {
      environment,
      ...(dependencies.statusInjectionDependencies || {})
    });
    if (options['--hook']) {
      // Recorded here rather than at the top of run(): a launch that never got
      // a packet never became an agent, and the suppression branch above has
      // already been recorded by the launcher that set those variables.
      const record = (dependencies.recordUnenforcedLaunch || recordUnenforcedLaunch)(input, event, dependencies);
      const note = record.ok
        ? `LAUNCH RECORDED: this start is in the signed ledger at sequence ${record.sequence} as ${LAUNCH_ACTION} (provenance: harness-unenforced -- no launcher receipt backs it).`
        : `LAUNCH RECORD NOT ESTABLISHED (${record.code}): the audit writer did not return enough evidence to establish whether this start is in the signed ledger. Report it as a coverage gap; do not treat the ledger as a complete account of who is running.`;
      return `${JSON.stringify(hookEnvelope(event.hook_event_name, `${note}\n\n${rendered}`))}\n`;
    }
    return rendered;
  } catch (error) {
    if (options['--hook'] && error && typeof error === 'object') error.hookEventName = event.hook_event_name;
    throw error;
  }
}

async function main() {
  try { process.stdout.write(await run()); }
  catch (error) {
    const code = String(error && error.code || 'AGENT_ONBOARDING_FAILED');
    const message = String(error && error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 500);
    if (process.argv.includes('--hook')) {
      process.stdout.write(`${JSON.stringify(hookEnvelope(error.hookEventName, `ONBOARDING FAILED CLOSED: ${code}: ${message}`, {
        continue: false,
        stopReason: `ToolsEnabled onboarding failed: ${code}`
      }))}\n`);
    } else process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({ LAUNCH_ACTION, MAX_HOOK_INPUT_BYTES, hookEnvelope, inputFrom, parseArgs, profileFromEvent, readHookEvent, recordUnenforcedLaunch, run, verifiedSuppression });
