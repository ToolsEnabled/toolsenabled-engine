// EXECUTABLE CHANGE
// CAN-FAIL REPORT: The three default/fallback log-path assertions below used
// hook.LOG_FILE as their oracle. Mutating the product's LOG_FILE from
// logs/no-blocking-prompt-hook.log to logs/MUTATED-no-blocking-prompt-hook.log
// left the original suite GREEN: "no-blocking-prompt-hook tests passed (93
// checks; ... )". They now use the independently constructed REAL_LOG_FILE.
// Under that same mutation the strengthened suite was RED:
// "AssertionError [ERR_ASSERTION]: a test-only log override must not apply
// outside NODE_ENV=test" with actual
// "/workspace/engine/logs/MUTATED-no-blocking-prompt-hook.log" and expected
// "/workspace/engine/logs/no-blocking-prompt-hook.log".
// NOT-FOUND (1): no product-derived collection can make an assertion loop
// empty; all six table-driven collections are non-empty literals in this test.
// NOT-FOUND (2): no exit-status assertion stands alone as product evidence;
// spawn success, a numeric status, and decision logs/output distinguish each
// subject result from a load/spawn failure.
// NOT-FOUND (3): no try/catch or optional chain swallows an assertion failure;
// catches are confined to best-effort scratch cleanup.
// NOT-FOUND (4): this test does not mock the hook or its dependencies.
// NOT-FOUND (5): there is no platform skip or whole-file precondition guard;
// the real-log absence branch still inspects the log if the suite creates it.
// FOUND (6): hook.LOG_FILE was the same-code expected value, fixed above.
// PRECONDITIONS NOT MET: none. The product mutation was restored byte-for-byte;
// the restored run was GREEN: "no-blocking-prompt-hook tests passed (93 checks;
// 7 blocked-tool red cases, 14 non-gated green controls, 8 deny-list boundary
// cases, 11 config fail-closed cases, user setting proven to beat the config
// file in both directions, plumbing proven to fail open while every validation
// failure fails closed)".

'use strict';

// Contract tests for tools/no-blocking-prompt-hook.js -- the NO-BLOCKING-PROMPT
// PreToolUse gate for the owner's 2026-08-13 directive ("do not ever pop up
// question boxes that stop your workflow ... it should be mechanically enforced
// in the program as our programs a harness").
//
// Same discipline as tests/clarify-gate.test.js: every process-level assertion
// is checked by EXIT CODE read directly off spawnSync's own `status` field,
// never through a shell pipe (STANDING-ORDERS.md Class SYNC, rule 2), and every
// red case is paired with a same-shape green control in the same run so a
// harness that cannot tell them apart fails loudly here.
//
// ABSENCE IS NOT CONSENT, and that is tested first: an absent config, a
// malformed config, a missing or non-boolean `enabled` field, an unreadable
// settings file, and a value nobody chose all leave the GATE ON. Only a literal
// boolean false -- from a person, or from the machine-local mirror -- turns it
// off, and every such withhold must be logged, never silent. The one thing that
// fails OPEN is plumbing: stdin that cannot be parsed.
//
// ISOLATION, and one deliberate divergence from the clarify-gate suite.
// tests/clarify-gate.test.js asserts an exact line count against the REAL
// shared logs/clarify-gate-hook.log and therefore flakes whenever another live
// session appends to it. This hook ships a test-only log override
// (NO_BLOCKING_PROMPT_TEST_LOG_FILE), so this suite reads its own log file
// whole, truncating it before each run and asserting exactly one decision line
// per invocation. Section 9 then proves the real logs/no-blocking-prompt-hook.log
// was never touched by this suite at all.
//
// Every child also gets TOOLSENABLED_SETTINGS_PATH pointed inside this suite's
// scratch directory. That is not decoration: without it the hook would read the
// live %LOCALAPPDATA%\ToolsEnabled\settings.json, and a real user value for
// agent.blocking_prompt_gate would silently rewrite these expectations.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Loaded here rather than at first use: requiring the hook does not run it
// (main() is guarded by require.main === module), and several path-resolution
// facts are cheaper and safer to assert in-process than through a subprocess
// that would write to the shared production log.
const hook = require('../tools/no-blocking-prompt-hook.js');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'tools', 'no-blocking-prompt-hook.js');
const REAL_LOG_FILE = path.join(ROOT, 'logs', 'no-blocking-prompt-hook.log');
const SCRATCH = path.join(ROOT, 'scratch', `no-blocking-prompt-test-${process.pid}`);
const CONFIG_FILE = path.join(SCRATCH, 'no-blocking-prompt-gate.json');
const ABSENT_CONFIG_FILE = path.join(SCRATCH, 'no-such-gate-config.json');
const LOG_FILE = path.join(SCRATCH, 'no-blocking-prompt-hook.log');
const SETTINGS_FILE = path.join(SCRATCH, 'settings.json');
const ABSENT_SETTINGS_FILE = path.join(SCRATCH, 'no-such-settings.json');
const SETTINGS_DIR = path.join(SCRATCH, 'settings-is-a-directory');
const SESSION = 'test-session-no-blocking-prompt';
const SETTING_ID = 'agent.blocking_prompt_gate';

const startedAt = Date.now();
let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

fs.mkdirSync(SCRATCH, { recursive: true });
fs.mkdirSync(SETTINGS_DIR, { recursive: true });

// The real log, measured BEFORE anything runs -- section 9 proves this suite
// never appended to it.
const realLogSizeBefore = fs.existsSync(REAL_LOG_FILE) ? fs.statSync(REAL_LOG_FILE).size : -1;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function runHookRaw(input, envOverrides = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    NO_BLOCKING_PROMPT_TEST_CONFIG_FILE: CONFIG_FILE,
    NO_BLOCKING_PROMPT_TEST_LOG_FILE: LOG_FILE,
    TOOLSENABLED_SETTINGS_PATH: ABSENT_SETTINGS_FILE
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env
  });
  assert.equal(result.error, undefined, `hook process failed to spawn: ${result.error}`);
  assert.equal(typeof result.status, 'number', 'spawnSync must report a real numeric exit code, never one read through a pipe');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Truncate the test-only log, run once, and hand back the SINGLE decision line
// that invocation appended. One line per call is part of the contract.
function runHook(payload, envOverrides = {}) {
  clearLog();
  const result = runHookRaw(JSON.stringify(payload), envOverrides);
  const lines = readLogLines();
  assert.equal(lines.length, 1, `exactly one decision line per invocation; got: ${JSON.stringify(lines)}`);
  assert.equal(lines[0].rule, 'NO-BLOCKING-PROMPT');
  return { ...result, log: lines[0] };
}

function toolCall(toolName, toolInput = {}, sessionId = SESSION) {
  return { tool_name: toolName, tool_input: toolInput, cwd: ROOT, session_id: sessionId };
}

function setConfig(value) {
  fs.writeFileSync(CONFIG_FILE, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}
function clearLog() {
  try { fs.rmSync(LOG_FILE, { force: true }); } catch { /* best effort */ }
}
function readLogLines() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function writeSettings(value, source, { file = SETTINGS_FILE, directive = 'owner 2026-08-13' } = {}) {
  fs.writeFileSync(file, JSON.stringify({
    revision: 1,
    values: { [SETTING_ID]: value },
    provenance: { [SETTING_ID]: { source, atMs: 1, directive } }
  }), 'utf8');
  return file;
}

// The five exact names plus the alias regex -- every one of these halts the
// caller on a human answer, which is the whole definition of the deny set.
const BLOCKED_TOOLS = [
  ['harness option box', toolCall('AskUserQuestion', { questions: [{ question: 'which?', options: ['a', 'b'] }] }), 'harness'],
  ['MCP system_ask (general)', toolCall('mcp__toolsenabled__system_ask', { title: 'x', message: 'y' }), 'general'],
  ['MCP system_ask_remote', toolCall('mcp__toolsenabled__system_ask_remote', { message: 'y' }), 'general'],
  ['bare system.ask', toolCall('system.ask', { message: 'y' }), 'general'],
  ['bare system.ask_remote', toolCall('system.ask_remote', { message: 'y' }), 'general'],
  ['alias regex: another MCP server', toolCall('mcp__other__system_ask', { message: 'y' }), 'general'],
  ['alias regex: another MCP server, remote', toolCall('mcp__some-server__system_ask_remote', { message: 'y' }), 'general']
];

// The substitute behaviour the refusal points at: these ENQUEUE or NOTIFY and
// return in milliseconds, so gating them would leave an agent no route to the
// owner at all. Plus ordinary read/write work, which must never pay for this
// gate.
const ALLOWED_TOOLS = [
  ['owner_prompts_start', toolCall('mcp__toolsenabled__owner_prompts_start', { title: 'q' })],
  ['owner_prompts_status', toolCall('mcp__toolsenabled__owner_prompts_status', {})],
  ['owner_prompts_events', toolCall('mcp__toolsenabled__owner_prompts_events', {})],
  ['owner_prompts_cancel', toolCall('mcp__toolsenabled__owner_prompts_cancel', {})],
  ['system_credential_request', toolCall('mcp__toolsenabled__system_credential_request', {})],
  ['purchase_request', toolCall('mcp__toolsenabled__purchase_request', {})],
  ['purchase_decision', toolCall('mcp__toolsenabled__purchase_decision', {})],
  ['system_notify', toolCall('mcp__toolsenabled__system_notify', { message: 'done' })],
  ['Read', toolCall('Read', { file_path: path.join(ROOT, 'README.md') })],
  ['Bash (read-only)', toolCall('Bash', { command: 'git status' })],
  ['Bash (read-only, cat)', toolCall('Bash', { command: 'cat README.md' })],
  ['Write', toolCall('Write', { file_path: path.join(SCRATCH, 'out.txt'), content: 'x' })],
  ['Grep', toolCall('Grep', { pattern: 'system_ask' })]
];

// ---------------------------------------------------------------------------
// 1. RED FIRST: with the gate standing, every blocking prompt is REFUSED, and
//    the refusal text is the remedy.
// ---------------------------------------------------------------------------

setConfig({ enabled: true });

for (const [label, payload, expectedMode] of BLOCKED_TOOLS) {
  check(`RED: ${label} is refused (exit 2) and told what to do instead`, () => {
    const result = runHook(payload);
    assert.equal(result.status, 2, `${label} must be refused: stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /NO-BLOCKING-PROMPT \(owner 2026-08-13\)/);
    assert.match(result.stderr, /halts your turn waiting for a human answer/);
    assert.match(result.stderr, /STATE the question/);
    assert.match(result.stderr, /keep working/);
    assert.match(result.stderr, /owner_prompts_start/, 'the refusal must name a non-blocking route that stays open');
    assert.match(result.stderr, /VERDICT: NEEDS_INPUT/);
    assert.match(result.stderr, /agent\.blocking_prompt_gate/, 'the refusal must name the user setting that governs it');
    assert.equal(result.log.decision, 'block-blocking-prompt');
    assert.equal(result.log.mode, expectedMode);
    assert.equal(result.log.sessionId, SESSION);
    assert.equal(result.log.gateState, 'config-enabled');
    assert.equal(result.log.source, 'config-file');
  });
}

check('RED: system_ask in AUTHORIZATION mode is refused too, and the cost is stated, not discovered', () => {
  const result = runHook(toolCall('mcp__toolsenabled__system_ask', { action: 'host.exec', arguments: {} }));
  assert.equal(result.status, 2, `authorization mode must be refused: stderr=${result.stderr}`);
  assert.equal(result.log.mode, 'authorization', 'the authorization-mode cost must be visible in the log, under its own mode');
  assert.match(result.stderr, /one-time approval token/);
  assert.match(result.stderr, /blocked capability/);
});

check('RED: a blank action string is NOT authorization mode (it is general), and still blocks', () => {
  const result = runHook(toolCall('mcp__toolsenabled__system_ask', { action: '   ', message: 'y' }));
  assert.equal(result.status, 2);
  assert.equal(result.log.mode, 'general');
});

check('RED: a payload with NO session_id is still refused, logged against the fallback name', () => {
  const result = runHook({ tool_name: 'AskUserQuestion', tool_input: {}, cwd: ROOT });
  assert.equal(result.status, 2, 'a missing session id must not become consent');
  assert.equal(result.log.sessionId, 'unknown-session');
});

// ---------------------------------------------------------------------------
// 2. GREEN CONTROL, identical state: the notify/enqueue tools and ordinary work
//    pass untouched and SILENTLY.
// ---------------------------------------------------------------------------

for (const [label, payload] of ALLOWED_TOOLS) {
  check(`GREEN (same gate ON state): ${label} passes (exit 0)`, () => {
    const result = runHook(payload);
    assert.equal(result.status, 0, `${label} must pass: stderr=${result.stderr}`);
    assert.equal(result.stderr, '', 'an ungated allow must be silent to the model');
    assert.equal(result.log.decision, 'allow-not-gated-tool');
  });
}

check('GREEN: an ungated tool is decided BEFORE any config or settings read (a broken config cannot affect it)', () => {
  setConfig('{ not json at all');
  const result = runHook(toolCall('Read', { file_path: path.join(ROOT, 'README.md') }), {
    TOOLSENABLED_SETTINGS_PATH: SETTINGS_DIR
  });
  assert.equal(result.status, 0, 'an ungated tool must not pay for a settings or config failure');
  assert.equal(result.log.decision, 'allow-not-gated-tool');
  assert.equal(result.log.gateState, undefined, 'no gate was resolved, so no gate state may be reported');
  setConfig({ enabled: true });
});

// ---------------------------------------------------------------------------
// 3. THE DENY-LIST EXTENSION POINT: the alias regex admits any MCP server
//    re-exporting the same two tools, and NOTHING else. Each near-miss below is
//    the same string one character away from a blocked one.
// ---------------------------------------------------------------------------

const NEAR_MISSES = [
  'mcp__toolsenabled__system_asker',
  'mcp__toolsenabled__system_ask_remotely',
  'mcp__toolsenabled__system_ask_remote_v2',
  'mcp__toolsenabled__ask',
  'mcp____system_ask',
  'system_ask',
  'system.asked',
  'Xmcp__toolsenabled__system_ask'
];

for (const name of NEAR_MISSES) {
  check(`EXTENSION POINT: "${name}" is NOT in the deny set and passes (exit 0)`, () => {
    const result = runHook(toolCall(name, { message: 'y' }));
    assert.equal(result.status, 0, `${name} must not be swept up by the alias regex: stderr=${result.stderr}`);
    assert.equal(result.log.decision, 'allow-not-gated-tool');
  });
}

check('paired RED/GREEN in one breath: mcp__other__system_ask blocks, mcp__other__system_asker does not', () => {
  const red = runHook(toolCall('mcp__other__system_ask', { message: 'y' }));
  const green = runHook(toolCall('mcp__other__system_asker', { message: 'y' }));
  assert.equal(red.status, 2, 'the alias regex must reach a re-exporting server');
  assert.equal(green.status, 0, 'and must stop at the exact tool name');
});

// ---------------------------------------------------------------------------
// 4. THE USER SETTING BEATS THE CONFIG FILE. This is the proof that the
//    registry row agent.blocking_prompt_gate is a live control and not a dead
//    catalogue entry: the config file still says enabled:true throughout.
// ---------------------------------------------------------------------------

setConfig({ enabled: true });

check('WITHHELD: a person setting agent.blocking_prompt_gate=false allows the call the config file would refuse', () => {
  const blockedFirst = runHook(toolCall('AskUserQuestion', {}));
  assert.equal(blockedFirst.status, 2, 'must be refused before the disabled direction is proven');

  writeSettings(false, 'user');
  const allowed = runHook(toolCall('AskUserQuestion', {}), { TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(allowed.status, 0, `a user value of false must allow: stderr=${allowed.stderr}`);
  assert.equal(allowed.stderr, '', 'a withheld allow must not also refuse');
  assert.equal(allowed.log.decision, 'allow-withheld-disabled');
  assert.equal(allowed.log.gateState, 'setting-user');
  assert.equal(allowed.log.source, SETTING_ID);
  assert.match(allowed.log.note, /DISABLED by user setting/, 'a disabled gate must be logged, never silent');
});

check('WITHHELD: an installer value of false does the same, and says so', () => {
  writeSettings(false, 'installer');
  const result = runHook(toolCall('mcp__toolsenabled__system_ask', { message: 'y' }), { TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(result.status, 0, `an installer value of false must allow: stderr=${result.stderr}`);
  assert.equal(result.log.decision, 'allow-withheld-disabled');
  assert.equal(result.log.gateState, 'setting-installer');
});

check('RED: a value NOBODY CHOSE is not consent -- provenance "default" cannot disable the gate', () => {
  writeSettings(false, 'default');
  const result = runHook(toolCall('AskUserQuestion', {}), { TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(result.status, 2, 'a default-provenance false must not disable the gate');
  assert.equal(result.log.gateState, 'config-enabled', 'the config file decides when nobody has chosen');
});

check('RED: a user value of TRUE keeps the gate on even when the config file says disabled', () => {
  setConfig({ enabled: false });
  writeSettings(true, 'user');
  const result = runHook(toolCall('AskUserQuestion', {}), { TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(result.status, 2, 'the chosen value must win in BOTH directions, not only the permissive one');
  assert.equal(result.log.gateState, 'setting-user');
  setConfig({ enabled: true });
});

check('RED: a mistyped user value ("false" as a string) is rejected and the gate stands', () => {
  writeSettings('false', 'user');
  const result = runHook(toolCall('AskUserQuestion', {}), { TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(result.status, 2, 'a non-boolean value must not disable a toggle');
});

check('RED: a user value with NO provenance at all is rejected and the gate stands', () => {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ revision: 1, values: { [SETTING_ID]: false } }), 'utf8');
  const result = runHook(toolCall('AskUserQuestion', {}), { TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(result.status, 2, 'an unprovenanced hand-edit must not disable the gate');
});

check('RED: a structurally invalid settings file leaves the gate ON', () => {
  fs.writeFileSync(SETTINGS_FILE, '{ not json', 'utf8');
  const result = runHook(toolCall('AskUserQuestion', {}), { TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(result.status, 2, 'a malformed settings file must fail closed');
});

check('RED: an UNREADABLE settings path (a directory) leaves the gate ON', () => {
  const result = runHook(toolCall('AskUserQuestion', {}), { TOOLSENABLED_SETTINGS_PATH: SETTINGS_DIR });
  assert.equal(result.status, 2, 'an unreadable settings file must fail closed');
  assert.equal(result.log.decision, 'block-blocking-prompt');
});

// ---------------------------------------------------------------------------
// 5. THE CONFIG FILE: absence, malformation, and a missing or non-boolean
//    `enabled` field ALL mean GATE ON. Only a literal boolean false disables,
//    and that is logged.
// ---------------------------------------------------------------------------

const CONFIG_FAIL_CLOSED = [
  ['ABSENT file', undefined],
  ['malformed JSON', '{ definitely not JSON'],
  ['empty file', ''],
  ['a JSON array', '[]'],
  ['null', 'null'],
  ['missing enabled field', { _comment: 'no enabled field here' }],
  ['enabled as the STRING "false"', { enabled: 'false' }],
  ['enabled as the STRING "true"', { enabled: 'true' }],
  ['enabled as 0', { enabled: 0 }],
  ['enabled as 1', { enabled: 1 }],
  ['enabled as null', { enabled: null }]
];

for (const [label, value] of CONFIG_FAIL_CLOSED) {
  check(`RED (fail closed): config ${label} => GATE ON, blocking prompt refused (exit 2)`, () => {
    const env = {};
    if (value === undefined) env.NO_BLOCKING_PROMPT_TEST_CONFIG_FILE = ABSENT_CONFIG_FILE;
    else setConfig(value);
    const result = runHook(toolCall('AskUserQuestion', {}), env);
    assert.equal(result.status, 2, `config ${label} must mean gate ON: stderr=${result.stderr}`);
    assert.equal(result.log.decision, 'block-blocking-prompt');
    assert.match(result.stderr, /NO-BLOCKING-PROMPT \(owner 2026-08-13\)/);
    // NOTE, measured not assumed: the resolved gateState here is
    // 'setting-default', NOT the loadGateConfig state ('config-absent-gate-on'
    // etc.). resolveGate consults the registry default before falling through
    // to fail-closed, and that default is `true`. Both mean GATE ON, which is
    // the load-bearing claim; the loadGateConfig states themselves are asserted
    // directly in section 8.
    assert.equal(result.log.gateState, 'setting-default');
    setConfig({ enabled: true });
  });
}

check('WITHHELD: config enabled:false allows the same call, and the log says so', () => {
  setConfig({ enabled: true });
  const refused = runHook(toolCall('AskUserQuestion', {}));
  assert.equal(refused.status, 2, 'must be refused before the disabled direction is proven');

  setConfig({ enabled: false });
  const allowed = runHook(toolCall('AskUserQuestion', {}));
  assert.equal(allowed.status, 0, `config enabled:false must allow: stderr=${allowed.stderr}`);
  assert.equal(allowed.stderr, '', 'a withheld allow must not also refuse');
  assert.equal(allowed.log.decision, 'allow-withheld-disabled');
  assert.equal(allowed.log.gateState, 'config-disabled');
  assert.equal(allowed.log.source, 'config-file');
  assert.match(allowed.log.note, /DISABLED by user setting/);
  setConfig({ enabled: true });
});

check('GREEN: a disabled gate does not change the ungated path -- an ordinary tool is still just allowed', () => {
  setConfig({ enabled: false });
  const result = runHook(toolCall('Bash', { command: 'git status' }));
  assert.equal(result.status, 0);
  assert.equal(result.log.decision, 'allow-not-gated-tool');
  setConfig({ enabled: true });
});

// ---------------------------------------------------------------------------
// 6. PLUMBING FAILS OPEN -- and only plumbing. A hook that cannot read its own
//    input must not wedge the harness; a hook that cannot read its CONFIG must
//    still refuse (section 5 proved that).
// ---------------------------------------------------------------------------

check('FAIL OPEN: unparseable stdin => exit 0, logged distinctly as fail-open', () => {
  clearLog();
  const result = runHookRaw('{ not json');
  assert.equal(result.status, 0, `a plumbing failure must not wedge the harness: stderr=${result.stderr}`);
  const lines = readLogLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, 'fail-open');
  assert.equal(lines[0].context, 'stdin-parse');
  assert.ok(typeof lines[0].error === 'string' && lines[0].error.length > 0, 'a fail-open must record why');
});

check('FAIL OPEN: a JSON array as stdin still decides rather than crashing', () => {
  clearLog();
  const result = runHookRaw('[1,2,3]');
  assert.equal(result.status, 0);
  const lines = readLogLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, 'allow-not-gated-tool', 'an array has no tool_name, so it is simply not gated');
});

check('EMPTY stdin => allowed as an ungated call, not a crash', () => {
  clearLog();
  const result = runHookRaw('');
  assert.equal(result.status, 0);
  const lines = readLogLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, 'allow-not-gated-tool');
});

check('BOM-prefixed stdin still DECIDES (it must not degrade into a fail-open allow)', () => {
  clearLog();
  // Constructed by code point, never typed as a literal BOM character: this
  // file stays ASCII, and a raw BOM in the middle of a source file is
  // invisible in review.
  const BOM = String.fromCharCode(0xfeff);
  const result = runHookRaw(`${BOM}${JSON.stringify(toolCall('AskUserQuestion', {}))}`);
  assert.equal(result.status, 2, `a leading BOM must not become a silent allow: stderr=${result.stderr}`);
  const lines = readLogLines();
  assert.equal(lines[0].decision, 'block-blocking-prompt');
  assert.notEqual(lines[0].decision, 'fail-open');
});

check('EXIT CODES: only 0 and 2 are ever used -- 1 never appears', () => {
  const seen = new Set();
  seen.add(runHook(toolCall('AskUserQuestion', {})).status);
  seen.add(runHook(toolCall('Read', { file_path: 'x' })).status);
  clearLog();
  seen.add(runHookRaw('{ not json').status);
  assert.deepEqual([...seen].sort(), [0, 2], `unexpected exit codes: ${[...seen].join(',')}`);
});

// ---------------------------------------------------------------------------
// 7. LOG ISOLATION: the test-only override is honored ONLY under NODE_ENV=test
//    and ONLY inside <repo>/scratch. A path outside scratch must fall back to
//    the real log rather than write where a test pointed it.
// ---------------------------------------------------------------------------

// Asserted in-process, deliberately. Proving this through a subprocess would
// mean running the hook with NODE_ENV unset, which by definition writes a line
// to the REAL logs/no-blocking-prompt-hook.log -- so the check that proves the
// overrides are test-only would itself be the thing that leaked out of the
// test sandbox. Section 9's isolation claim is worth more than a subprocess
// here, and configFile()/logFile() are the exact functions the subprocess would
// have exercised.
check('OVERRIDE: both path overrides are IGNORED when NODE_ENV is not "test"', () => {
  const env = {
    NODE_ENV: 'production',
    NO_BLOCKING_PROMPT_TEST_CONFIG_FILE: CONFIG_FILE,
    NO_BLOCKING_PROMPT_TEST_LOG_FILE: LOG_FILE
  };
  assert.equal(hook.configFile(env), hook.DEFAULT_CONFIG_FILE, 'a test-only config override must not apply outside NODE_ENV=test');
  assert.equal(hook.logFile(env), REAL_LOG_FILE, 'a test-only log override must not apply outside NODE_ENV=test');
  assert.equal(hook.configFile({ NODE_ENV: 'test' }), hook.DEFAULT_CONFIG_FILE, 'with no override set, the shipped path stands');
  assert.equal(hook.logFile({ NODE_ENV: 'test' }), REAL_LOG_FILE, 'with no override set, the shipped log path stands');
});

check('OVERRIDE: an out-of-scratch LOG override falls back to the real log rather than writing where it was pointed', () => {
  const outside = path.join(ROOT, 'logs', 'somewhere-else.log');
  assert.equal(
    hook.logFile({ NODE_ENV: 'test', NO_BLOCKING_PROMPT_TEST_LOG_FILE: outside }),
    REAL_LOG_FILE,
    'the scratch fence applies to the log override too'
  );
});

// MEASURED, not assumed. A config override pointing OUTSIDE <repo>/scratch is
// never obeyed -- overriddenPath() throws instead of returning the path, which
// is the guard doing its job. That throw surfaces inside evaluate(), so the
// hook takes its plumbing branch and fails OPEN (exit 0) with the reason
// recorded. This is the ONE config-path failure that does not fail closed, and
// it is reachable only under NODE_ENV=test with a deliberately bad override --
// in production the override is not consulted at all, so nothing here weakens
// the shipped gate. It is inherited behaviour: tools/clarify-gate-hook.js has
// the identical overriddenPath()/relativePathInside() pair. Pinned here so that
// if it ever changes, it changes visibly.
check('OVERRIDE: a config override OUTSIDE <repo>/scratch is REFUSED, never obeyed, and the refusal is recorded', () => {
  const outside = path.join(ROOT, 'config', 'no-blocking-prompt-gate.json');
  clearLog();
  const result = runHookRaw(JSON.stringify(toolCall('AskUserQuestion', {})), {
    NO_BLOCKING_PROMPT_TEST_CONFIG_FILE: outside
  });
  assert.equal(result.status, 0, 'an unusable override takes the plumbing branch');
  const lines = readLogLines();
  assert.equal(lines.length, 1, 'the refusal must be recorded, never silent');
  assert.equal(lines[0].decision, 'fail-open');
  assert.equal(lines[0].context, 'evaluate');
  assert.match(lines[0].error, /did not resolve inside/, 'the log must say the override was rejected, not that the config was read');
});

// ---------------------------------------------------------------------------
// 8. UNIT LEVEL: the exported matchers and resolvers, no subprocess needed.
//    This is where the loadGateConfig states are pinned directly, since
//    resolveGate's registry-default fallback means they never surface as a
//    final gateState while the registry loads (see the note in section 5).
// ---------------------------------------------------------------------------

const IS_BLOCKING_CASES = [
  ['AskUserQuestion', true],
  ['mcp__toolsenabled__system_ask', true],
  ['mcp__toolsenabled__system_ask_remote', true],
  ['system.ask', true],
  ['system.ask_remote', true],
  ['mcp__x__system_ask', true],
  ['mcp__x__system_ask_remote', true],
  ['Bash', false],
  ['Read', false],
  ['mcp__toolsenabled__system_notify', false],
  ['mcp__toolsenabled__owner_prompts_start', false],
  ['mcp__toolsenabled__system_asker', false],
  ['', false]
];

for (const [name, expected] of IS_BLOCKING_CASES) {
  check(`unit: isBlockingTool(${JSON.stringify(name)}) === ${expected}`, () => {
    assert.equal(hook.isBlockingTool(name), expected, name);
  });
}

check('unit: the deny set is exactly the five documented names', () => {
  assert.deepEqual([...hook.BLOCKING_TOOL_NAMES].sort(), [
    'AskUserQuestion',
    'mcp__toolsenabled__system_ask',
    'mcp__toolsenabled__system_ask_remote',
    'system.ask',
    'system.ask_remote'
  ]);
});

const GATE_CONFIG_STATES = [
  ['absent file', undefined, 'config-absent-gate-on', true],
  ['malformed JSON', '{ definitely not JSON', 'config-malformed-gate-on', true],
  ['a JSON array', '[]', 'config-malformed-gate-on', true],
  ['null', 'null', 'config-malformed-gate-on', true],
  ['missing enabled', { _comment: 'x' }, 'config-enabled-field-invalid-gate-on', true],
  ['non-boolean enabled', { enabled: 'false' }, 'config-enabled-field-invalid-gate-on', true],
  ['enabled:true', { enabled: true }, 'config-enabled', true],
  ['enabled:false', { enabled: false }, 'config-disabled', false]
];

for (const [label, value, state, enabled] of GATE_CONFIG_STATES) {
  check(`unit: loadGateConfig with ${label} => state "${state}", enabled=${enabled}`, () => {
    const env = { NODE_ENV: 'test', NO_BLOCKING_PROMPT_TEST_CONFIG_FILE: CONFIG_FILE };
    if (value === undefined) env.NO_BLOCKING_PROMPT_TEST_CONFIG_FILE = ABSENT_CONFIG_FILE;
    else setConfig(value);
    const result = hook.loadGateConfig(env);
    assert.equal(result.state, state, label);
    assert.equal(result.enabled, enabled, label);
  });
}

check('unit: resolveGate precedence -- a chosen value beats the config file, a default value does not', () => {
  setConfig({ enabled: true });
  const base = { NODE_ENV: 'test', NO_BLOCKING_PROMPT_TEST_CONFIG_FILE: CONFIG_FILE };

  writeSettings(false, 'user');
  const chosen = hook.resolveGate({ ...base, TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(chosen.enabled, false);
  assert.equal(chosen.state, 'setting-user');
  assert.equal(chosen.source, SETTING_ID);

  writeSettings(false, 'default');
  const unchosen = hook.resolveGate({ ...base, TOOLSENABLED_SETTINGS_PATH: SETTINGS_FILE });
  assert.equal(unchosen.enabled, true, 'a value nobody chose is not consent');
  assert.equal(unchosen.state, 'config-enabled');

  const noSettings = hook.resolveGate({ ...base, TOOLSENABLED_SETTINGS_PATH: ABSENT_SETTINGS_FILE });
  assert.equal(noSettings.enabled, true);
});

check('unit: readSettingValue reports the registry default honestly when no file exists', () => {
  const value = hook.readSettingValue({ TOOLSENABLED_SETTINGS_PATH: ABSENT_SETTINGS_FILE });
  assert.equal(value.available, true);
  assert.equal(value.value, true, 'the registry default for agent.blocking_prompt_gate must be ON');
  assert.equal(value.source, 'default');
});

check('unit: evaluate() short-circuits an ungated tool without resolving a gate at all', () => {
  const outcome = hook.evaluate({ tool_name: 'Read', tool_input: {} }, { NODE_ENV: 'test' });
  assert.equal(outcome.decision, 'allow-not-gated-tool');
  assert.equal(outcome.gateState, undefined);
  assert.equal(outcome.source, undefined);
});

check('unit: refusalMessage carries the remedy, the owner quote, and the setting id', () => {
  const message = hook.refusalMessage('AskUserQuestion', 'harness', { file: hook.DEFAULT_CONFIG_FILE });
  assert.match(message, /do not ever pop up question boxes/, 'the owner directive must be quoted verbatim');
  assert.match(message, /DO THIS INSTEAD/);
  assert.match(message, /STATE the assumption/);
  assert.match(message, /Do not wait for an answer/);
  assert.match(message, new RegExp(SETTING_ID.replace('.', '\\.')));
  assert.ok(!/one-time approval token/.test(message), 'the authorization NOTE must appear only in authorization mode');
  assert.match(hook.refusalMessage('mcp__toolsenabled__system_ask', 'authorization', {}), /one-time approval token/);
});

check('unit: sessionIdFrom refuses a path-traversal session id', () => {
  assert.equal(hook.sessionIdFrom({ session_id: '../../etc/passwd' }), hook.FALLBACK_SESSION_ID);
  assert.equal(hook.sessionIdFrom({ session_id: 'ok-session-01' }), 'ok-session-01');
  assert.equal(hook.sessionIdFrom({}), hook.FALLBACK_SESSION_ID);
});

check('unit: the setting id the hook reads is the id the registry declares it enforces', () => {
  const { loadRegistry } = require('../src/lib/settings-registry');
  const entry = loadRegistry().byId.get(hook.SETTING_ID);
  assert.ok(entry, `the registry must carry ${hook.SETTING_ID}, or this hook enforces nothing`);
  assert.equal(entry.control, 'toggle');
  assert.equal(entry.default, true, 'absence is not consent: the shipped default must be gate ON');
  assert.equal(entry.enforcedBy, 'tools/no-blocking-prompt-hook.js', 'the row must name THIS file, or the claim is a phantom');
});

// ---------------------------------------------------------------------------
// 9. THIS SUITE NEVER TOUCHED THE SHARED LOG. (tests/clarify-gate.test.js has
//    no way to make this claim, which is why it flakes.)
// ---------------------------------------------------------------------------

// Byte equality is deliberately NOT the assertion: a live session running the
// real gate may legitimately append to this file while the suite runs, and
// asserting an exact size would reproduce precisely the flake this suite exists
// not to repeat. What must be true is narrower and stronger -- nothing THIS
// SUITE decided may appear there.
check('ISOLATION: nothing this suite ran appears in the real logs/no-blocking-prompt-hook.log', () => {
  if (realLogSizeBefore < 0 && !fs.existsSync(REAL_LOG_FILE)) return;
  const text = fs.existsSync(REAL_LOG_FILE) ? fs.readFileSync(REAL_LOG_FILE, 'utf8') : '';
  const tail = text.slice(Math.max(realLogSizeBefore, 0));
  const leaked = tail.split('\n').filter(Boolean).filter(line => line.includes(SESSION) || line.includes(SCRATCH));
  assert.deepEqual(leaked, [], 'a test-only log override that leaks into the shared log is not an override');
});

check('ISOLATION: the shipped config/no-blocking-prompt-gate.json still says enabled:true', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'no-blocking-prompt-gate.json'), 'utf8'));
  assert.equal(shipped.enabled, true, 'this suite must never have rewritten the real gate config');
});

// --- cleanup: this suite's own scratch dir only. ---
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

const durationMs = Date.now() - startedAt;
console.log(`no-blocking-prompt-hook tests passed (${checks} checks; ${BLOCKED_TOOLS.length} blocked-tool red cases, ${ALLOWED_TOOLS.length} non-gated green controls, ${NEAR_MISSES.length} deny-list boundary cases, ${CONFIG_FAIL_CLOSED.length} config fail-closed cases, user setting proven to beat the config file in both directions, plumbing proven to fail open while every validation failure fails closed) in ${durationMs}ms`);
