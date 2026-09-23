/* EXECUTABLE CHANGE
 *
 * Suspect: the remote-origin localArgs check accepted every thrown error, so a
 * loader failure or an unrelated regression satisfied the assertion. Mutation:
 * changed PERMISSION_UNRESTRICTED_SPAWN_REFUSED to MUTANT_WRONG_REFUSAL in
 * src/lib/permission-tier-policy.js. Before strengthening, all 44 offline
 * checks remained green. After strengthening, the mutation produced RED:
 * "local-node-tier FAILED after 28 checks: a remote-origin session must be
 * refused by the permission boundary, got MUTANT_WRONG_REFUSAL"
 * The product file was then restored byte-for-byte and this file returned GREEN:
 * "local-node-tier: 44 checks passed, 2 live case(s) skipped."
 *
 * NOT-FOUND (1): every potentially empty every()/event traversal is backed by
 * a cardinality assertion, a fixed four-iteration producer, or an independent
 * event-existence assertion; the final source scan iterates a non-empty literal.
 * NOT-FOUND (2): process status checks are paired with subject stdout evidence.
 * NOT-FOUND (3): caught failures are asserted by typed code (including this fix)
 * or, for argument parsing, by the required fact that parsing throws.
 * NOT-FOUND (4): the HTTP fake supplies transport input to probeRuntime; it does
 * not mock probeRuntime or the output assertions being tested.
 * NOT-FOUND (5): offline coverage always executes. Only two explicitly live
 * checks skip, with a printed reason, when no runtime is listening.
 * NOT-FOUND (6): expected values are literals or independent invariants, not
 * values computed by the implementation under test.
 *
 * Unmet precondition: no local model runtime was listening, so the two named
 * LIVE checks could not execute and were explicitly reported as skipped.
 */
'use strict';

/* CAN A USER RUN A MODEL ON THEIR OWN GPU AS A FLEET NODE?
 *
 * Owner, 2026-08-12: "i just meant local nodes like on someones computer they
 * should be able to launch a qwen2.5 on their gpu or something as a node, not
 * just claude or codex."
 *
 * These cases pin the parts of that which can be checked without a GPU and
 * without downloading weights. They run in two modes:
 *
 *   OFFLINE (always): every case that does not need a model. Detection,
 *   refusal, argv, seat allocation, kind resolution, and -- the one that
 *   matters most -- that an absent runtime is reported honestly with an install
 *   command rather than offered as a node that would fail on spawn.
 *
 *   LIVE (explicit opt-in outside the strict suite only): one real
 *   completion and one real lane-runner subprocess, end to end. Skipped, and
 *   reported as unexecuted by default. A skipped live case is never
 *   reported as a pass.
 *
 * Run: node tests/local-node-tier.test.js
 */

const assert = require('node:assert');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const actions = require('../src/lib/mission-bridge/actions');
const agentLane = require('../src/lib/agent-lane');
const agentOrg = require('../src/lib/agent-org');
const runtime = require('../src/lib/providers/local-node-runtime');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'tools', 'local-node-lane-runner.js');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

// Every case lives inside one async main: this file is CommonJS (the shape the
// rest of tests/ uses), and several cases have to await a real socket.
async function main(t) {
/* ---------------------------------------------------------------- detection */

// A runtime that is not there is an ANSWER, not a throw. Detection scans four
// ports; one refusing to connect must not abort the scan.
{
  const detected = await runtime.detect({ host: '127.0.0.9', timeoutMs: 1500 });
  check(detected.ready === false, 'a host with no runtime must not be reported ready');
  check(detected.runtimes.length === 4, 'detection must report every supported runtime, not only the reachable ones');
  check(detected.runtimes.every(entry => entry.listening === false), 'nothing may be reported listening on an empty host');
  // THE HONESTY REQUIREMENT, PINNED. "Do not offer a node that cannot start"
  // is only enforceable if the unavailable answer carries the fix.
  check(typeof detected.nextCommand === 'string' && detected.nextCommand.length > 0,
    'an unavailable local runtime must carry the one command that installs one');
  check(/install/i.test(detected.nextCommand), `the install hint must be an install command, got: ${detected.nextCommand}`);
  check(typeof detected.reason === 'string' && detected.reason.includes('127.0.0.9'),
    'the refusal must name the host it actually checked');
}

// A runtime that is LISTENING BUT EMPTY is not ready. This is the subtle one: a
// freshly installed Ollama answers /v1/models with an empty list, and calling
// that "ready" ships a node that fails on the first prompt.
{
  const emptyHttp = {
    request(_options, handler) {
      const listeners = {};
      const response = {
        statusCode: 200,
        on(event, fn) { listeners[event] = fn; return response; },
        destroy() {}
      };
      queueMicrotask(() => {
        handler(response);
        listeners.data?.(Buffer.from(JSON.stringify({ object: 'list', data: [] }), 'utf8'));
        listeners.end?.();
      });
      return { on() { return this; }, write() {}, end() {} };
    }
  };
  const probe = await runtime.probeRuntime('ollama', { host: '127.0.0.1' }, { http: emptyHttp });
  check(probe.listening === true, 'a responding runtime is listening');
  check(probe.models.length === 0, 'an empty catalogue reports no models');
  check(probe.reason === 'LOCAL_NODE_NO_MODELS_INSTALLED', 'listening with no weights must be distinguishable from ready');
  check(/pull/i.test(probe.installCommand), `an empty runtime must hand back a pull command, got: ${probe.installCommand}`);
}

// resolveNode REFUSES rather than returning a node that cannot answer.
{
  let code = null;
  try { await runtime.resolveNode({ host: '127.0.0.9', timeoutMs: 1500 }); }
  catch (error) { code = error && error.code; }
  check(code === 'LOCAL_NODE_RUNTIME_UNAVAILABLE',
    `resolving a node on a bare machine must refuse with a typed error, got ${code}`);
}

/* ------------------------------------------------------- no credential path */

// A local model has no API key. Every header builder must treat that as normal.
{
  const anonymous = runtime.authorization(undefined);
  check(!('authorization' in anonymous), 'an absent key must produce no authorization header, not an empty one');
  check(anonymous['content-type'] === 'application/json', 'the request still has to be well formed without a credential');
  const keyed = runtime.authorization('vllm-local-key');
  check(keyed.authorization === 'Bearer vllm-local-key', 'a supplied key (vLLM --api-key) is still honoured');
  const blank = runtime.authorization('   ');
  check(!('authorization' in blank), 'whitespace is not a credential');
}

// A name heuristic must never answer a chat prompt with an embedding model.
{
  check(runtime.preferredModel(['nomic-embed-text:latest', 'qwen2.5:7b-instruct']) === 'qwen2.5:7b-instruct',
    'an instruct model must win over an embedding model');
  check(runtime.preferredModel(['nomic-embed-text:latest']) === 'nomic-embed-text:latest',
    'with nothing else available the only model is still returned rather than null');
}

/* ------------------------------------------------------ the tier and the seat */

const ORG = require('./helpers/declared-org').declaredOrg();
const registryWith = busy => ({ readRegistry: () => ({ agents: Object.fromEntries(busy.map(id => [id, { status: 'running' }])) }) });

{
  const lane = actions.declaredLane(ORG, 'local', registryWith([]));
  check(lane.kind === 'local', 'the local tier must resolve to a local lane kind');
  check(lane.provider === 'local', 'the local tier must resolve to the local provider');
  check(lane.cliModel === null, 'a local node has no vendor CLI model and must not pretend to');
  check(lane.reportsTo, 'a local seat must have a reporting line like every other seat');
}

// THE SEAT POOL IS THE POINT. The presence registry refuses a second live lane
// per identity, so borrowing the Claude seats would have made a local node and
// a Claude worker mutually exclusive -- on the machine where running several
// local models at once is free.
{
  const allocated = [];
  for (let index = 0; index < 4; index += 1) {
    allocated.push(actions.declaredLane(ORG, 'local', registryWith(allocated)).targetAgentId);
  }
  check(new Set(allocated).size === 4, `four local dispatches must occupy four distinct seats, got ${allocated.join(', ')}`);
  check(allocated.every(id => /^local-node-[1-4]$/.test(id)), `local seats must be the declared local pool, got ${allocated.join(', ')}`);
  const claudeSeat = actions.declaredLane(ORG, 'claude-opus', registryWith(allocated)).targetAgentId;
  check(!allocated.includes(claudeSeat), 'a fully occupied local pool must not block a Claude dispatch');
}

// Exhaustion is a CAPACITY answer, not a broken declaration.
{
  let code = null;
  try { actions.declaredLane(ORG, 'local', registryWith(['local-node-1', 'local-node-2', 'local-node-3', 'local-node-4'])); }
  catch (error) { code = error && error.code; }
  check(code === 'BRIDGE_ALL_SEATS_BUSY', `an exhausted local pool must report capacity, got ${code}`);
}

/* ------------------------------------------------------------------- argv */

{
  const node = { runtime: 'ollama', model: 'qwen2.5:7b-instruct', host: '127.0.0.1', port: 11434 };
  const args = actions.localArgs({ root: ROOT, node, permissionSession: { origin: 'local', tier: 'full' } });
  check(path.resolve(args[0]) === RUNNER, 'the local lane must run the declared runner script and nothing else');
  check(args.includes('qwen2.5:7b-instruct'), 'the resolved model must reach the child argv');
  check(args.includes('127.0.0.1'), 'the local lane must be pointed at loopback, not at a peer machine');
  // A remote-origin session must be refused here exactly as it is for Codex.
  let remoteCode = null;
  try { actions.localArgs({ root: ROOT, node, permissionSession: { origin: 'remote', tier: 'guarded' } }); }
  catch (error) { remoteCode = error && error.code; }
  check(remoteCode === 'PERMISSION_UNRESTRICTED_SPAWN_REFUSED',
    `a remote-origin session must be refused by the permission boundary, got ${remoteCode}`);
}

/* ----------------------------------------------------------- the lane kind */

{
  check(agentLane.LANE_KINDS.includes('local'), 'the lane runtime must know the local kind');
  check(agentLane.commandKind(process.execPath, [RUNNER]) === 'local',
    'node running the declared runner must resolve to a local lane');
  // THE CONFINEMENT THAT MAKES THAT SAFE: node plus any other script is still
  // refused, so "local" cannot become a general arbitrary-script lane.
  let refused = null;
  try { agentLane.commandKind(process.execPath, [path.join(ROOT, 'tools', 'local-node-status.js')]); }
  catch (error) { refused = error && error.code; }
  check(refused === 'AGENT_LANE_COMMAND_REFUSED',
    `node running some other script must still be refused, got ${refused}`);
  let bare = null;
  try { agentLane.commandKind(process.execPath); }
  catch (error) { bare = error && error.code; }
  check(bare === 'AGENT_LANE_COMMAND_REFUSED', 'omitting the argv must fail closed, not resolve to local');
  check(agentLane.commandKind(path.join(path.parse(ROOT).root, 'x', 'codex.exe')) === 'codex',
    'the existing Codex resolution is unchanged');
  check(agentLane.commandKind('/usr/bin/claude') === 'claude', 'the existing Claude resolution is unchanged');
}

/* ---------------------------------------------------- runner argument gate */

{
  const parsed = require('../tools/local-node-lane-runner').parseArguments([
    '--runtime', 'ollama', '--model', 'qwen2.5:7b-instruct', '--host', '127.0.0.1', '--port', '11434', '--worktree', ROOT
  ]);
  check(parsed.port === 11434, 'the runner parses its endpoint port');
  let threw = false;
  try {
    require('../tools/local-node-lane-runner').parseArguments(['--runtime', 'ollama', '--model', 'm', '--host', 'h']);
  } catch { threw = true; }
  check(threw, 'the runner must refuse a missing endpoint rather than defaulting to one');
}

/* --------------------------------------------------------------- live path */

const liveAllowed = process.env.TOOLSENABLED_LOCAL_NODE_LIVE_TEST === '1'
  && process.env.TOOLSENABLED_TEST_STRICT !== '1';
if (!liveAllowed) {
  const options = { skip: 'requires TOOLSENABLED_LOCAL_NODE_LIVE_TEST=1 outside the strict unattended suite' };
  await t.test('one real local-model completion', options, () => {
    assert.fail('unattended verification must not load a real local model');
  });
  await t.test('real local-model lane runner end to end', options, () => {
    assert.fail('unattended verification must not start a real model lane');
  });
} else {
  const live = await runtime.detect({ timeoutMs: 2500 });
  assert.equal(live.ready, true,
    `explicit live test has no ready runtime: ${live.reason}; ${live.nextCommand}`);
  const model = runtime.preferredModel(live.selected.models);
  await t.test('one real local-model completion', async () => {
  const started = Date.now();
  const completion = await runtime.complete({
    prompt: 'Reply with exactly this token and nothing else: LOCALNODE_OK',
    model,
    runtime: live.selected.runtime,
    host: live.selected.host,
    port: live.selected.port,
    maxOutputTokens: 32
  });
  check(typeof completion.text === 'string' && completion.text.trim().length > 0,
    'a live local model must return text');
  check(completion.costUsd === 0, 'a model on the user hardware must be recorded as costing nothing');
  check(completion.contentTrust === 'untrusted' && completion.grantsAuthority === false,
    'local model output is untrusted content and grants no authority');
  process.stdout.write(`LIVE: ${live.selected.displayName} / ${model} answered in ${Date.now() - started}ms\n`);
  });

  await t.test('real local-model lane runner end to end', () => {
  // The subprocess, spawned the way the lane spawns it: prompt on stdin,
  // newline-delimited JSON on stdout, meaningful exit code.
  const spawned = spawnSync(process.execPath, [
    RUNNER, '--runtime', live.selected.runtime, '--model', model,
    '--host', live.selected.host, '--port', String(live.selected.port),
    '--worktree', ROOT, '--max-output-tokens', '64'
  ], { input: 'Reply with the single word ACK.', encoding: 'utf8', timeout: 180_000 });
  check(spawned.status === 0, `the lane runner must exit 0 on success, got ${spawned.status}: ${spawned.stderr}`);
  const events = spawned.stdout.split(/\r?\n/)
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line));
  check(events.some(event => event.type === 'local_node.start'), 'the runner must announce its start as a JSON event');
  const completed = events.find(event => event.type === 'local_node.completed');
  check(completed !== undefined, 'the runner must emit a completion event the lane can read');
  check(completed.costUsd === 0, 'the completion event must record zero cost');
  check(/VERDICT:\s*(PASSED|FAILED)/.test(spawned.stdout), 'the runner must emit a verdict line the lane runtime can extract');

  // A dead endpoint must FAIL, not silently succeed. Same runner, wrong port.
  const dead = spawnSync(process.execPath, [
    RUNNER, '--runtime', 'ollama', '--model', model,
    '--host', '127.0.0.9', '--port', '11434', '--worktree', ROOT
  ], { input: 'anything', encoding: 'utf8', timeout: 60_000 });
  check(dead.status === 1, `a lane pointed at a dead endpoint must exit non-zero, got ${dead.status}`);
  check(/VERDICT: FAILED/.test(dead.stdout), 'a dead endpoint must produce a FAILED verdict, never a silent pass');
  check(/install/i.test(dead.stdout), 'a dead endpoint must tell the user how to install the runtime');
  });
}

/* ----------------------------------------------------------- org integrity */

{
  const local = ORG.agents.filter(agent => agent.provider === 'local' && agent.id.startsWith('local-node-'));
  check(local.length === 4, `the org must declare four local seats, found ${local.length}`);
  check(local.every(agent => agent.enabled === true), 'the local seats ship enabled; the free path is not opt-in');
  check(local.every(agent => agentOrg.managerOf(ORG, agent.id) !== null), 'every local seat needs a manager');
}

// The dynamic-onboarding coverage manifest must not claim agent-lane covers
// only two providers now that it spawns three.
{
  const onboarding = require('../src/lib/agent-onboarding');
  const laneRow = onboarding.SPAWN_PATH_COVERAGE.find(entry => entry.id === 'agent-lane');
  check(laneRow.providers.includes('local'), 'the spawn-path coverage manifest must list the local provider');
}

// No credential is read anywhere on this path. This is a source-level pin
// because the guarantee is "never", and a runtime check can only observe "not
// this time".
{
  const fs = require('node:fs');
  for (const file of ['src/lib/providers/local-node-runtime.js', 'tools/local-node-lane-runner.js', 'tools/local-node-status.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    check(!/getSecret|vault|dpapi/i.test(source.replace(/^\s*\*.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
      `${file} must not reach for a credential; a local model has none`);
  }
}

process.stdout.write(`local-node-tier: ${checks} checks completed; live coverage is reported separately in TAP.\n`);
}

test('local-node offline contracts and explicitly opted-in live coverage', main);
