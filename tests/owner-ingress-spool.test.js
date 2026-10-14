// EXECUTABLE CHANGE
// testcanfail-tests-owner-ingress-spool-test-js
//
// Mutation report (2026-08-26): changing DEFAULT_INGRESS_SOURCE in
// tools/owner-ingress-spool.js from "claude-code/UserPromptSubmit" to
// "mutant/UserPromptSubmit" left the former self-referential assertion green;
// execution continued to the final wrapper check. After replacing the expected
// exported constant below with the contract literal, the same mutant went RED:
// "AssertionError [ERR_ASSERTION]: default source must stay
// claude-code/UserPromptSubmit, got mutant/UserPromptSubmit".
// The product mutation was then restored byte-for-byte (SHA-256 before/after:
// 29af3c8890b1dba7ea0129a451f1e6d3482e50f89565658848bbcb9a46946fe8).
// Restored-source run: "Owner ingress spool tests passed (56 checks)."
// Shape census: (1) empty loop/forEach NOT-FOUND; (2) bare exit-status/truthy
// evidence NOT-FOUND (the refusal status is paired with its own error code and
// no-capture evidence); (3) swallowed failure NOT-FOUND; (4) subject mocked by
// its own mock NOT-FOUND (the injected throwing spool is only failure stimulus);
// (5) skip/platform no-op guard NOT-FOUND; (6) same-code expectation FOUND and
// strengthened below. Preconditions met with Node 22.22.2 on PATH.

'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ingress = require('../tools/owner-ingress-spool');
const spool = require('../src/lib/owner-capture-spool');

const TOOL = path.resolve(__dirname, '..', 'tools', 'owner-ingress-spool.js');
const RESOLVE_NODE = path.resolve(__dirname, '..', 'tools', 'resolve-node.js');
let checks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `owner-ingress-${name}-`));
  return {
    root,
    // Deliberately absent: ingress must derive/create the spool from a ledger
    // target even before that target exists.
    ledger: path.join(root, 'nested', 'OWNER-REQUEST-LEDGER.json'),
    fallback: path.join(root, 'fallback', 'owner-ingress.jsonl')
  };
}

function event(prompt, extra = {}) {
  return {
    session_id: 'fixture-session',
    hook_event_name: 'UserPromptSubmit',
    origin: { kind: 'human' },
    prompt,
    ...extra
  };
}

function runCli(f, raw) {
  return spawnSync(process.execPath, [TOOL, '--ledger', f.ledger, '--fallback', f.fallback], {
    input: raw,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
}

function byteIdentical(actual, expected, message) {
  check(Buffer.from(actual, 'utf8').equals(Buffer.from(expected, 'utf8')), message);
}

function humanTurnIsSpooledVerbatim() {
  const f = fixture('human');
  const prompt = '  Keep EVERY word.\r\nUnicode: café — yes.\nTrailing spaces stay.  ';
  const result = runCli(f, JSON.stringify(event(prompt)));
  check(result.status === 0, `human hook exited ${result.status}: ${result.stderr}`);
  check(result.stdout === '', 'successful hook capture must be silent');
  const pending = spool.listPending(f.ledger);
  check(pending.length === 1, 'one human hook event must create one pending spool record');
  check(pending[0].mode === 'ingress' && pending[0].id === null, 'ingress must remain unclassified and carry no R-id');
  byteIdentical(pending[0].text, prompt, 'the spooled owner turn must be byte-identical to event.prompt');
}

function emptyPromptIsIgnored() {
  const f = fixture('empty');
  const result = runCli(f, JSON.stringify(event(' \r\n\t ')));
  check(result.status === 0, 'an empty prompt is a clean no-op');
  check(spool.listPending(f.ledger).length === 0, 'an empty prompt must not pollute the spool');
  check(!fs.existsSync(f.fallback), 'an empty prompt must not pollute the fallback journal');
}

function hugePromptIsNotTruncated() {
  const f = fixture('huge');
  const unit = '0123456789 café — line\r\n';
  const prompt = `${unit.repeat(50_000)}THE-END  `;
  const result = runCli(f, JSON.stringify(event(prompt)));
  check(result.status === 0, `huge hook exited ${result.status}: ${result.stderr}`);
  const pending = spool.listPending(f.ledger);
  check(pending.length === 1, 'the huge prompt must create one record');
  check(Buffer.byteLength(pending[0].text, 'utf8') === Buffer.byteLength(prompt, 'utf8'), 'the huge prompt byte length must not change');
  byteIdentical(pending[0].text, prompt, 'the huge prompt must survive byte-for-byte');
}

function relayMarkersAreExcludedMechanically() {
  const f = fixture('relay');
  const peer = event('agent traffic wearing the user role', { origin: { kind: 'peer' } });
  const sidechain = event('sidechain traffic', { isSidechain: true });
  check(runCli(f, JSON.stringify(peer)).status === 0, 'peer traffic is a clean no-op');
  check(runCli(f, JSON.stringify(sidechain)).status === 0, 'sidechain traffic is a clean no-op');
  check(spool.listPending(f.ledger).length === 0, 'agent/relay markers must never enter the owner spool');
}

function nonJsonStdinIsPreservedInFallback() {
  const f = fixture('non-json');
  const raw = 'not-json\r\nOWNER BYTES? café\n';
  const result = runCli(f, raw);
  check(result.status === 0, `malformed hook input must fail open, got ${result.status}`);
  const records = ingress.readFallbackJournal(f.fallback);
  check(records.length === 1 && records[0].reason === 'invalid-hook-json', 'non-JSON stdin must create one diagnosed fallback record');
  byteIdentical(records[0].rawStdin, raw, 'non-JSON stdin must be retained byte-for-byte for recovery');
}

function spoolFailureFallsBackWithoutChangingText() {
  const f = fixture('module-failure');
  const prompt = 'This turn survives even when the spool module throws.\r\nexactly.';
  const result = ingress.captureRawInput(JSON.stringify(event(prompt)), {
    ledgerFile: f.ledger,
    fallbackFile: f.fallback,
    spoolModule: {
      writeAhead() {
        const error = new Error('synthetic spool failure');
        error.code = 'SYNTHETIC_SPOOL_FAILURE';
        throw error;
      }
    },
    now: new Date('2026-08-11T10:00:00.000Z')
  });
  check(result.action === 'fallback', 'a spool-module exception must use the fallback journal');
  const records = ingress.readFallbackJournal(f.fallback);
  check(records.length === 1 && records[0].error.code === 'SYNTHETIC_SPOOL_FAILURE', 'fallback must diagnose the primary failure');
  byteIdentical(records[0].text, prompt, 'fallback must retain the owner prompt byte-for-byte');
}

function absentRootsAreCreatedAndStatusIsStable() {
  const f = fixture('absence');
  const first = 'first pending owner turn';
  const second = 'second pending owner turn';
  ingress.captureHookEvent(event(first), {
    ledgerFile: f.ledger,
    fallbackFile: f.fallback,
    now: new Date('2026-08-11T08:00:00.000Z')
  });
  ingress.captureHookEvent(event(second), {
    ledgerFile: f.ledger,
    fallbackFile: f.fallback,
    now: new Date('2026-08-11T09:30:00.000Z')
  });
  check(!fs.existsSync(f.ledger), 'spooling must not invent an absent ledger');
  check(fs.existsSync(spool.pendingDirectory(f.ledger)), 'the derived spool directory must be created when absent');
  const status = ingress.getStatus({
    ledgerFile: f.ledger,
    fallbackFile: f.fallback,
    now: new Date('2026-08-11T10:00:00.000Z')
  });
  check(status.count === 2, 'status must count every unclassified ingress turn');
  check(status.line === '2 owner turns spooled and unclassified, oldest 2.0h', `unexpected status line: ${status.line}`);
}

function configuredHookWrapperPreservesStdin() {
  const f = fixture('resolve-node');
  const prompt = 'the exact settings hook wrapper must preserve this\r\nturn  ';
  const result = spawnSync(process.execPath, [RESOLVE_NODE, TOOL, '--ledger', f.ledger, '--fallback', f.fallback], {
    input: JSON.stringify(event(prompt)),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  check(result.status === 0, `resolve-node hook wrapper exited ${result.status}: ${result.stderr}`);
  const pending = spool.listPending(f.ledger);
  check(pending.length === 1, 'the configured resolve-node wrapper must reach ingress capture');
  byteIdentical(pending[0].text, prompt, 'the configured wrapper must pass hook stdin byte-for-byte');
}

// PROVENANCE MUST NAME THE HARNESS THE TURN ACTUALLY ARRIVED THROUGH.
//
// `source` is written verbatim into the capture spool and is the field that
// answers "how do we know the owner said this". It was hardcoded to
// claude-code/UserPromptSubmit while Claude was the only wired harness. Codex
// -- the harness routing actually uses -- had no UserPromptSubmit registration
// at all, so its owner turns were lost entirely; wiring it without
// parameterising this field would have replaced a loss with something worse, a
// Codex turn carrying a Claude provenance string. These three cases pin all of
// it: the default is unchanged (so the Claude hook needs no edit and cannot
// regress), an explicit source is recorded verbatim, and a malformed source
// REFUSES rather than silently falling back -- because a typo in a hooks.json
// is exactly how a mislabelled provenance would otherwise enter the record.
function sourceDefaultsToClaudeHarness() {
  const f = fixture('source-default');
  const result = runCli(f, JSON.stringify(event('default harness turn')));
  check(result.status === 0, `default-source hook exited ${result.status}: ${result.stderr}`);
  const pending = spool.listPending(f.ledger);
  check(pending.length === 1, 'a default-source capture must reach the spool');
  check(
    pending[0].source === 'claude-code/UserPromptSubmit',
    `default source must stay claude-code/UserPromptSubmit, got ${pending[0].source}`
  );
}

function explicitSourceIsRecordedVerbatim() {
  const f = fixture('source-codex');
  const result = spawnSync(
    process.execPath,
    [TOOL, '--ledger', f.ledger, '--fallback', f.fallback, '--source', 'codex/UserPromptSubmit'],
    { input: JSON.stringify(event('codex harness turn')), encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  check(result.status === 0, `codex-source hook exited ${result.status}: ${result.stderr}`);
  const pending = spool.listPending(f.ledger);
  check(pending.length === 1, 'a codex-source capture must reach the spool');
  check(
    pending[0].source === 'codex/UserPromptSubmit',
    `explicit source must be recorded verbatim, got ${pending[0].source}`
  );
  byteIdentical(pending[0].text, 'codex harness turn', 'an explicit source must not disturb the captured text');
}

function malformedSourceRefusesRatherThanDefaulting() {
  const f = fixture('source-bad');
  const result = spawnSync(
    process.execPath,
    [TOOL, '--ledger', f.ledger, '--fallback', f.fallback, '--source', 'Claude Code/Bad Source'],
    { input: JSON.stringify(event('must not be captured')), encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  check(result.status !== 0, 'a malformed --source must refuse, never fall back to the default');
  check(
    /OWNER_INGRESS_SOURCE_INVALID/.test(result.stderr),
    `a malformed --source must name its own error code; got: ${result.stderr}`
  );
  check(spool.listPending(f.ledger).length === 0, 'a refused --source must capture nothing at all');
}

// Machine-injected schedule firings must never wear the owner's provenance.
// Measured 2026-08-12: an hourly in-session cron loop delivered its own prompt
// through UserPromptSubmit with no agent/relay marker, adding one fake "owner
// turn" per hour to the spool. Exclusion is two-layered: harness metadata
// (source: cron/scheduled/machine) when present, and the leading
// [machine-scheduled] sentinel that works when the harness labels nothing.
function machineScheduledPromptsAreExcluded() {
  const f = fixture('machine-scheduled');
  const sentinel = ingress.MACHINE_SCHEDULED_SENTINEL;

  const led = event(`${sentinel} shadow-manager duty cycle: run one bounded sweep`);
  check(runCli(f, JSON.stringify(led)).status === 0, 'a sentinel-led prompt is a clean no-op');
  const indented = event(`  \n${sentinel} indented firing`);
  check(runCli(f, JSON.stringify(indented)).status === 0, 'leading whitespace does not defeat the sentinel');
  const cronSource = event('scheduled firing labeled by the harness', { source: 'cron' });
  check(runCli(f, JSON.stringify(cronSource)).status === 0, 'a source:cron prompt is a clean no-op');
  check(spool.listPending(f.ledger).length === 0, 'machine-scheduled prompts must never enter the owner spool');
  check(!fs.existsSync(f.fallback), 'machine-scheduled prompts must not pollute the fallback journal either');

  // A QUOTED sentinel later in a genuine turn is the owner's words and stays.
  const quoted = `the sentinel is ${sentinel} and I want it changed`;
  check(runCli(f, JSON.stringify(event(quoted))).status === 0, 'a quoting turn captures cleanly');
  const pending = spool.listPending(f.ledger);
  check(pending.length === 1, 'a mid-prompt sentinel mention is a genuine owner turn and must spool');
  byteIdentical(pending[0].text, quoted, 'the quoting turn must be preserved byte-for-byte');

  // The classifier names the exclusion so a log reader can tell the two
  // ignore paths apart.
  const classified = ingress.classifyHookEvent(event(`${sentinel} x`));
  check(classified.action === 'ignore' && classified.reason === 'machine-scheduled-sentinel',
    'the sentinel exclusion must carry its own reason');
}

// Harness notification wrappers arrive through UserPromptSubmit with no
// source label (measured 2026-08-12: 15 of 33 pending "owner turns" were
// <task-notification> wrappers). Structural detection excludes them; a
// genuine turn quoting a wrapper mid-text still spools.
function harnessNotificationsAreExcluded() {
  const f = fixture('harness-notification');

  const task = event('<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>');
  check(runCli(f, JSON.stringify(task)).status === 0, 'a task-notification wrapper is a clean no-op');
  const system = event('[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event');
  check(runCli(f, JSON.stringify(system)).status === 0, 'a system-notification wrapper is a clean no-op');
  const indented = event('\n  <task-notification>\n<task-id>xyz</task-id>');
  check(runCli(f, JSON.stringify(indented)).status === 0, 'leading whitespace does not defeat wrapper detection');
  check(spool.listPending(f.ledger).length === 0, 'harness notifications must never enter the owner spool');
  check(!fs.existsSync(f.fallback), 'harness notifications must not pollute the fallback journal');

  const quoting = 'why did I get a <task-notification> in my spool, fix that';
  check(runCli(f, JSON.stringify(event(quoting))).status === 0, 'a quoting turn captures cleanly');
  const pending = spool.listPending(f.ledger);
  check(pending.length === 1, 'a mid-prompt wrapper mention is a genuine owner turn and must spool');
  byteIdentical(pending[0].text, quoting, 'the quoting turn must be preserved byte-for-byte');

  const classified = ingress.classifyHookEvent(event('<task-notification>\nx'));
  check(classified.action === 'ignore' && classified.reason === 'harness-notification-marker',
    'the wrapper exclusion must carry its own reason');
}

function run() {
  humanTurnIsSpooledVerbatim();
  sourceDefaultsToClaudeHarness();
  explicitSourceIsRecordedVerbatim();
  malformedSourceRefusesRatherThanDefaulting();
  emptyPromptIsIgnored();
  hugePromptIsNotTruncated();
  relayMarkersAreExcludedMechanically();
  machineScheduledPromptsAreExcluded();
  harnessNotificationsAreExcluded();
  nonJsonStdinIsPreservedInFallback();
  spoolFailureFallsBackWithoutChangingText();
  absentRootsAreCreatedAndStatusIsStable();
  configuredHookWrapperPreservesStdin();
  process.stdout.write(`Owner ingress spool tests passed (${checks} checks).\n`);
}

try { run(); }
catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
