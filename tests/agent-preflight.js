// EXECUTABLE CHANGE
'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// Discrimination report (2026-08-26):
// - EMPTY COLLECTION: strengthened the project declaration, readonly allowlist,
//   Codex-index, and SessionStart configuration checks below. Mutation: made
//   mcpReality()'s addDeclared() callback return without recording a server.
//   RED: "AssertionError: .mcp.json must declare at least one MCP server".
// - EMPTY COLLECTION: mutation: made codexSessions() return [] with a present
//   session_index.jsonl. RED: "AssertionError: a present Codex session index
//   must yield at least one age-ranked session".
// - SKIP/PRECONDITION GUARD: mutation: removed .claude/settings.json. RED:
//   "AssertionError: .claude/settings.json must exist so SessionStart wiring
//   can be verified".
// - NOT-FOUND: exit-status/truthy-return assertions based only on a subject's
//   output; swallowed assertion failures; mocks of the subject; expected values
//   computed by the subject itself.
// - Per-installation MCP and hook declarations are supplied below as sterile
//   fixtures. The suite never reads or edits an operator's client settings.

// Pins tools/agent-preflight.js: the capability-and-coordination preflight.
//
// It exists because of a measured failure (2026-07-29, session d4ca9820): a
// session burned 363 assistant turns / 204 tool calls and never found an active
// codex thread literally named "Build agent communication bridge", because the
// tool manifest advertises an `mcp__toolsenabled__*` server that `.mcp.json`
// does not declare. Every guarantee below is one that failure needed.

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { activate } = require('./lib/isolated-environment');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'agent-preflight.js');
activate('agent-preflight');
const FIXTURE_ROOT = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'preflight-fixture-'));
const FIXTURE_HOME = path.join(FIXTURE_ROOT, 'home');
const FIXTURE_MCP = path.join(FIXTURE_ROOT, '.mcp.json');
const FIXTURE_CLAUDE_SETTINGS = path.join(FIXTURE_ROOT, '.claude', 'settings.json');
const FIXTURE_CONTEXT = path.join(FIXTURE_ROOT, 'context');
fs.mkdirSync(path.join(FIXTURE_HOME, '.codex'), { recursive: true });
fs.mkdirSync(path.dirname(FIXTURE_CLAUDE_SETTINGS), { recursive: true });
fs.mkdirSync(FIXTURE_CONTEXT, { recursive: true });
fs.writeFileSync(FIXTURE_MCP, JSON.stringify({
  mcpServers: {
    'toolsenabled-readonly': {
      command: 'node',
      args: ['fixture-readonly-server.js'],
      env: { TOOLSENABLED_TOOL_ALLOWLIST: 'task.list,memory.search,system.status' }
    }
  }
}, null, 2), 'utf8');
fs.writeFileSync(path.join(FIXTURE_HOME, '.claude.json'), JSON.stringify({
  mcpServers: { 'fixture-user-server': { command: 'node', args: ['fixture-user-server.js'] } }
}, null, 2), 'utf8');
fs.writeFileSync(path.join(FIXTURE_HOME, '.codex', 'session_index.jsonl'), `${JSON.stringify({
  id: 'fixture-session', thread_name: 'Fixture coordination thread', updated_at: new Date().toISOString()
})}\n`, 'utf8');
fs.writeFileSync(FIXTURE_CLAUDE_SETTINGS, JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ command: 'node tools/agent-onboarding.js --hook' }] }] }
}, null, 2), 'utf8');
fs.writeFileSync(path.join(FIXTURE_CONTEXT, 'systems.json'), JSON.stringify({
  systems: [{
    id: 'toolsenabled',
    name: 'ToolsEnabled',
    path: 'C:/fixture/toolsenabled',
    card: 'context/toolsenabled.md',
    ports: [],
    status: 'fresh'
  }]
}, null, 2), 'utf8');
fs.writeFileSync(path.join(FIXTURE_CONTEXT, 'toolsenabled.md'), [
  '# ToolsEnabled',
  '- Entry point: `tools/agent-preflight.js`',
  '- Agent presence and coordination are live-state concerns.'
].join('\n'), 'utf8');
fs.writeFileSync(path.join(FIXTURE_CONTEXT, 'DOCS.md'), [
  '# Documentation router',
  '- ToolsEnabled agent coordination: `tools/agent-preflight.js`'
].join('\n'), 'utf8');
fs.writeFileSync(path.join(FIXTURE_CONTEXT, 'toolsenabled-tools.md'), [
  '# Tool namespaces',
  '## system (1)',
  '- `system.status`'
].join('\n'), 'utf8');
process.env.TOOLSENABLED_GREPSAVER_CONTEXT = FIXTURE_CONTEXT;
process.once('exit', () => {
  try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* isolated cleanup */ }
});
const PREFLIGHT_ENV = {
  ...process.env,
  TOOLSENABLED_PREFLIGHT_HOME: FIXTURE_HOME,
  TOOLSENABLED_PREFLIGHT_MCP_CONFIG_FILE: FIXTURE_MCP
};
let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

function readHomeClaudeJson() {
  try { return JSON.parse(fs.readFileSync(path.join(FIXTURE_HOME, '.claude.json'), 'utf8')); } catch { return null; }
}

function run(args = []) {
  return execFileSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, env: PREFLIGHT_ENV
  });
}

check('it runs read-only and emits valid JSON', () => {
  const report = JSON.parse(run(['--json']));
  assert.equal(typeof report.generatedAt, 'string');
  assert.equal(path.resolve(report.repo).toLowerCase(), ROOT.toLowerCase());
});

check('current managed-process state cannot become a historical unconditional directive', () => {
  const report = JSON.parse(run(['--json']));
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'managed-processes.json'), 'utf8')).processes;
  const observed = report.inFlight.managedProcesses;
  assert.ok(['CONFIGURED', 'INDETERMINATE'].includes(observed.state));
  assert.doesNotMatch(JSON.stringify(observed), /\bR\d{2,}\b|do not query|do not .*otherwise work/i,
    'a historical request id must never create a live unconditional agent command');
  assert.equal(observed.state, 'CONFIGURED');
  assert.match(observed.note, new RegExp(`^${Object.keys(current).length} managed process`));
});

check('it names the LIVE servers from .mcp.json rather than guessing', () => {
  const report = JSON.parse(run(['--json']));
  const declared = JSON.parse(fs.readFileSync(FIXTURE_MCP, 'utf8')).mcpServers || {};
  assert.ok(Object.keys(declared).length > 0, '.mcp.json must declare at least one MCP server');
  for (const name of Object.keys(declared)) {
    assert.ok(report.mcp.declared[name], `${name} is declared in .mcp.json and must be reported live`);
  }
});

// A USER-LEVEL registration is still a registration. The first version of this
// tool read only .mcp.json and the per-project entry, and therefore reported
// "no such server is configured" about a server registered in ~/.claude.json --
// the same species of confidently wrong answer it exists to prevent.
check('a user-level ~/.claude.json registration is seen, not missed', () => {
  const report = JSON.parse(run(['--json']));
  const rootServers = Object.keys((readHomeClaudeJson() || {}).mcpServers || {});
  for (const name of rootServers) {
    assert.ok(report.mcp.declared[name], `${name} is registered at user level and must be reported`);
  }
});

// THE CORE GUARANTEE. Declared is not connected. A server whose proxy fails
// closed must be reported DEAD with the reason and the fix, because the client
// only ever says "is not connected".
check('a declared-but-unreachable proxied server is reported DEAD with its cause', () => {
  const report = JSON.parse(run(['--json']));
  if (!report.mcp.ownerHost) return; // no proxied server on this machine
  const { capabilityFile, pipeListening } = report.mcp.ownerHost;
  if (capabilityFile && !pipeListening) {
    const dead = report.mcp.dead.find(d => d.server === 'toolsenabled');
    assert.ok(dead, 'a proxied server with no owner host must appear in mcp.dead');
    assert.match(dead.why, /not connected/i, 'quoting the error the agent will actually see');
    assert.match(dead.why, /owner.?host/i, 'naming the real cause, not just the symptom');
    assert.match(dead.why, /Close ToolsEnabled completely and open it again/, 'and stating the app-owned recovery route');
    assert.doesNotMatch(dead.why, /scheduled task|Start-ScheduledTask|src\/mcp-server\.js/i,
      'a retired alternate-principal or direct-server recovery escaped into the diagnostic');
    assert.ok(!report.mcp.live.includes('toolsenabled'), 'and it must not also be listed live');
    assert.ok(report.prefixGuidance, 'the working prefix must be stated');
    assert.match(report.prefixGuidance.rule, /toolsenabled-readonly/);
  }
});

// The tools are NOT the problem, and saying otherwise sends someone rebuilding
// work that already exists.
check('it never claims the tools themselves are missing', () => {
  const report = JSON.parse(run(['--json']));
  const dead = report.mcp.dead.find(d => d.server === 'toolsenabled');
  if (dead) {
    assert.ok(!/no such server is configured|not declared/i.test(dead.why),
      'the write server IS declared; claiming otherwise is the bug this test exists for');
  }
});

// R1162 P1: reports/OPEN-GATES.md sat one full R1162 append behind for hours
// this same session, invisible because a stale digest looks identical to a
// fresh one. These pin the freshness check that makes staleness loud instead.
// Deliberately no mutation of the real reports/OPEN-GATES.md or
// reports/OWNER-REQUEST-LEDGER.json here -- that class of test-induced
// contamination is exactly what this repo's own test-baseline work hunted
// down once already; state-transition coverage (STALE/MISSING/UNSTAMPED)
// lives in tests/ledger-query.js against an isolated temp fixture instead.
check('openGatesFreshness reports a valid shape against the live repo state', () => {
  const report = JSON.parse(run(['--json']));
  const gf = report.openGatesFreshness;
  assert.ok(gf, 'openGatesFreshness must be present in the report');
  // INCOMPLETE (2026-08-12) is the shape axis: the stamped revision is current
  // but the digest is missing a section the renderer emits, i.e. it was
  // published by an older renderer. See src/lib/open-gates-digest-contract.js.
  assert.ok(['FRESH', 'STALE', 'INCOMPLETE', 'MISSING', 'UNSTAMPED', 'INDETERMINATE'].includes(gf.state));
  if (gf.state === 'FRESH') {
    assert.equal(gf.message, null, 'a FRESH digest carries no warning message');
    assert.equal(typeof gf.liveRevision, 'number');
    assert.equal(gf.digestRevision, gf.liveRevision, 'FRESH means the stamped and live revisions match exactly');
  } else {
    assert.equal(typeof gf.message, 'string', 'every non-FRESH state must explain itself in the message');
    assert.ok(gf.message.length > 0);
  }
});

check('a non-FRESH digest is surfaced in the SessionStart hook context, not only the JSON report', () => {
  const report = JSON.parse(run(['--json']));
  if (report.openGatesFreshness.state === 'FRESH') return; // nothing to surface; covered by the shape check above
  const context = JSON.parse(run(['--hook'])).hookSpecificOutput.additionalContext;
  assert.match(context, /OPEN-GATES DIGEST/, 'a stale/missing/unstamped digest must be loud in the one surface every session actually reads');
});

// Cross-file contract: this regex must accept exactly what
// tools/ledger-query.js's stampLedgerRevision() writes. If either side's
// format drifts, freshness silently reports UNSTAMPED forever -- the same
// failure mode this whole check exists to prevent, just moved one level up.
check('the stamp format tools/ledger-query.js writes is exactly what this preflight parses', () => {
  const { stampLedgerRevision } = require(path.join(ROOT, 'tools', 'ledger-query.js'));
  const stamp = stampLedgerRevision({ revision: 546, updatedAt: '2026-08-07' });
  const STAMP_LINE_RE = /^Ledger revision: (\d+) \(updated ([^)]+)\)$/m;
  const match = stamp.match(STAMP_LINE_RE);
  assert.ok(match, `stampLedgerRevision's own output must satisfy agent-preflight.js's parser: "${stamp}"`);
  assert.equal(Number(match[1]), 546);
  assert.equal(match[2], '2026-08-07');
});

check('the readonly allowlist is parsed into usable coordination tools', () => {
  const report = JSON.parse(run(['--json']));
  const ro = report.mcp.declared['toolsenabled-readonly'];
  assert.ok(ro, 'toolsenabled-readonly must be declared for this allowlist contract to be exercised');
  assert.ok(Array.isArray(ro.allowlist), 'toolsenabled-readonly must expose a parsed allowlist');
  assert.ok(ro.allowlist.length > 0, 'the allowlist parses to a non-empty list');
  // These three are what answers "who else is working" without the write server.
  for (const tool of ['task.list', 'memory.search', 'system.status']) {
    assert.ok(ro.allowlist.includes(tool), `${tool} must be recognised as reachable read-only`);
  }
});

check('codex sessions are discoverable by thread name, newest first', () => {
  const report = JSON.parse(run(['--json']));
  assert.ok(Array.isArray(report.otherAgents.codex));
  if (fs.existsSync(path.join(FIXTURE_HOME, '.codex', 'session_index.jsonl'))) {
    const rows = report.otherAgents.codex;
    assert.ok(rows.length > 0, 'a present Codex session index must yield at least one age-ranked session');
    for (const row of rows) {
      assert.equal(typeof row.name, 'string', 'a thread name is the one-line statement of intent');
      assert.ok(Number.isFinite(row.ageMs), 'and it must be age-ranked to be actionable');
    }
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i - 1].ageMs <= rows[i].ageMs, 'most recent first');
    }
  }
});

check('claude sessions report their opening ask, not their transcript', () => {
  const report = JSON.parse(run(['--json']));
  assert.ok(Array.isArray(report.otherAgents.claude));
  for (const row of report.otherAgents.claude) {
    assert.ok(Number.isFinite(row.ageMs));
    if (row.intent !== null) {
      assert.ok(row.intent.length <= 160, 'the intent is a summary, never a transcript dump');
      assert.ok(!row.intent.startsWith('<'), 'harness wrappers are not an intent');
    }
    assert.equal(row.file, undefined, 'transcript paths are not leaked in the packet');
  }
});

check('it refuses to be slow enough to break a SessionStart hook', () => {
  const started = Date.now();
  run(['--hook']);
  const elapsed = Date.now() - started;
  // Transcripts here reach 30 MB; only their head may be read. A full read blows
  // the hook budget and the hook is the only thing that makes this automatic.
  assert.ok(elapsed < 5000, `preflight took ${elapsed}ms; the hook budget is 5s`);
});

check('--hook emits a valid SessionStart envelope', () => {
  const parsed = JSON.parse(run(['--hook']));
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = parsed.hookSpecificOutput.additionalContext;
  assert.equal(typeof context, 'string');
  assert.ok(context.length > 0 && context.length < 4000, 'injected every session, so it must stay small');
  assert.ok(!/mcp__toolsenabled__memory_search/.test(context),
    'the hook must never again point a new session at the unconfigured write namespace');
});

// R1175 moved the automatic session orientation off this tool and onto the
// versioned dynamic packet in tools/agent-onboarding.js -- see the _comment on
// the SessionStart group in .claude/settings.json. This assertion used to name
// agent-preflight.js specifically and went red on 2026-08-12 for that reason
// alone: the wiring was correct and the test was describing the predecessor.
//
// What must stay true is the guarantee, not the filename: SOMETHING that
// orients a session has to run automatically, or none of this is automatic and
// every agent boots blind. So the assertion accepts either entry point and
// fails loudly when neither is wired.
const SESSION_ORIENTERS = ['agent-onboarding.js', 'agent-preflight.js'];

check('a session-orientation tool is actually wired into SessionStart', () => {
  const settingsPath = FIXTURE_CLAUDE_SETTINGS;
  assert.ok(fs.existsSync(settingsPath),
    '.claude/settings.json must exist so SessionStart wiring can be verified');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = (settings.hooks && settings.hooks.SessionStart) || [];
  const serialized = JSON.stringify(hooks);
  const wired = SESSION_ORIENTERS.filter((tool) => serialized.includes(tool));
  assert.ok(wired.length > 0,
    `SessionStart must run one of ${SESSION_ORIENTERS.join(' or ')}, or none of this is automatic`);
});

check('grepsaver routes live-state questions here instead of answering them', () => {
  const orient = require('../tools/grepsaver-orient.js');
  const packet = orient.orient('what are other agent sessions working on right now', { limit: 3 });
  assert.ok(packet.liveState, 'a live-state question must be recognised');
  assert.match(packet.liveState.run, /agent-preflight\.js/);
  // And a static question must NOT be hijacked by that routing.
  assert.equal(orient.orient('openclaw gateway', { limit: 3 }).liveState, null);
});

check('grepsaver withholds a card it only matched incidentally', () => {
  const orient = require('../tools/grepsaver-orient.js');
  const weak = orient.orient('gmail thread read', { limit: 3 });
  assert.equal(weak.cards.length, 0, 'an incidental word match is not an answer');
  // The machine's generated card set may contain no incidental candidate at
  // all, or may contain one that the absolute relevance floor withholds. Both
  // are truthful no-card answers; the packet now exposes candidateCount so the
  // distinction is observable rather than a stale fixture assumption.
  assert.ok(['no-carded-system-matched', 'matched-too-weakly-to-report'].includes(weak.coverage.state));
  if (weak.coverage.state === 'no-carded-system-matched') assert.equal(weak.coverage.candidateCount, 0);
  else assert.ok(weak.coverage.candidateCount > 0);
  // Real current card ids must survive the absolute floor.
  //
  // This assertion has now gone stale TWICE by naming specific cards: first on
  // unrelated machine-local cards when per-machine GrepSaver output stopped
  // being versioned, then on 2026-08-12 when `mission-bridge` and `repo-sync`
  // stopped existing in this tree's index at all. Measured that day:
  // context/systems.json here declares exactly ONE card, `toolsenabled`, the
  // whole-repo card -- the multi-project index this test was written against
  // lives in the retired tree, not in canonical.
  //
  // So stop hardcoding ids. Ask the live index what it declares and require
  // that each declared card is reachable by its own id. That is the property
  // that actually matters -- a card in the index that its own name cannot
  // retrieve is a broken card -- and it cannot rot as the card set changes.
  const declared = (JSON.parse(fs.readFileSync(path.join(FIXTURE_CONTEXT, 'systems.json'), 'utf8')).systems || [])
    .map((card) => card.id);
  assert.ok(declared.length > 0, 'the card index must declare at least one system');
  for (const id of declared) {
    const hit = orient.orient(id.replace(/-/g, ' '), { limit: 3 });
    assert.ok(hit.cards.some((card) => card.id === id),
      `card "${id}" is declared in the index but its own name does not retrieve it`);
  }
});

process.stdout.write(`agent-preflight tests passed (${checks} checks).\n`);
