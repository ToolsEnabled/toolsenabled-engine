// EXECUTABLE CHANGE
'use strict';

/* TEST-CAN-FAIL REPORT (testcanfail-tests-agent-api-policy-test-js)
 *
 * SUSPECT: the reviewed keep/drop decision was compared with values derived by
 * the same module (`keptNativeTools()`, `KEPT`, and `REPLACED`). Mutation:
 * AskUserQuestion keep false -> true and TodoWrite keep true -> false. Before
 * strengthening, the independently runnable first 12 checks stayed green:
 *   "agent-api-policy mutation probe: 12 checks passed"
 * After adding the exact decision assertions below, the same mutation went red:
 *   "AssertionError [ERR_ASSERTION]: the kept tools must be exactly the reviewed keep-list."
 *   "actual: [ 'AskUserQuestion', ... ]; expected: [ 'Edit', ... ]"
 * The source was then restored byte-for-byte (`sha256sum -c`):
 *   "src/lib/agent-api-policy.js: OK"
 * The restored first 12 checks are green again:
 *   "agent-api-policy mutation probe: 12 checks passed"
 *
 * NOT-FOUND (1): no vacuous assertion over a possibly-empty collection. The
 * two policy-derived loops are backed by the fixed 30-name measured census;
 * emptying that census is already rejected by the unreviewed-name assertion.
 * The other loops iterate non-empty literals owned by this test.
 * NOT-FOUND (2): no exit-status or truthy-process-result assertion.
 * NOT-FOUND (3): no try/catch or optional chain that swallows a failure.
 * NOT-FOUND (4): no mock of the subject under test.
 * NOT-FOUND (5): no skip or platform precondition guard.
 * NOT-FOUND (6), after the fix: no remaining expected value computed by the
 * same code it checks without an independent assertion fixing that value.
 *
 * UNMET PRECONDITION / EXISTING WRONG ASSERTION: the complete file is not green
 * on this checkout. `briefToolSummary` returns `text: null` when the summary's
 * own setting is off, but the final check dereferences `off.text.includes`.
 * The unmodified baseline reports:
 *   "TypeError: Cannot read properties of null (reading 'includes')"
 * at this file's off-state assertion. The contract forbids deleting or
 * weakening an existing assertion, so this is reported rather than changed.
 */

// THE AGENT API, PROVED ON BOTH SIDES OF ITS OWN SWITCH.
//
// The owner's directive (B9, 2026-08-24): a setting deciding whether an agent
// may use its native tools or only ours, shipped on by default.
//
// A gate that is only ever exercised in the direction it is expected to take is
// not a gate; this repository has paid for that shape more than once. So every
// property below is asserted in BOTH states, and the two argv builders that
// spawn a `claude` child are both driven, because a setting enforced on one of
// two spawn paths is a setting that is true half the time.
//
// FOUR PROPERTIES:
//
//   OFF IS BYTE-IDENTICAL   With the row false, neither argv builder emits a
//                           `--tools` flag at all. This is the property that
//                           lets the switch ship on by default: turning it off
//                           returns the exact command line this product has
//                           always produced, not a differently-shaped one.
//   SKILL SURVIVES          `Skill` is on the keep-list. Measured A/B on
//                           2026-08-13 and recorded in
//                           src/lib/mission-bridge/actions.js: a `--tools` list
//                           without it removed all 27 project skills and the
//                           child reported that no skills exist. That is the
//                           regression this list exists not to repeat.
//   NOTHING WITH EGRESS,
//   EXECUTION OR A DURABLE
//   SIDE EFFECT IS KEPT     Bash, PowerShell, Task, WebFetch, WebSearch,
//                           SendMessage, PushNotification, RemoteTrigger, the
//                           three Cron tools, ScheduleWakeup and the two
//                           worktree tools must all be replaced. Those are the
//                           acts the ToolsEnabled door exists to record.
//   THE CENSUS IS CLOSED    A built-in this file has not reviewed is reported
//                           as unreviewed rather than silently kept or silently
//                           dropped, exactly as an unclassified ToolsEnabled
//                           tool is refused by confined-tool-surface.js.
//
// THE MEASUREMENT BEHIND THE LIST, so a future reader can re-take it rather
// than trust it. claude 2.1.186, `--print`, `--permission-mode acceptEdits`,
// reading the `tools` array off the `system/init` event:
//     no --tools flag        30 built-in tools
//     --tools <KEPT>         10 built-in tools
// and in the same run, with an MCP server and `--strict-mcp-config`, the child
// called `mcp__probe__te_marker` and got its answer back with is_error false
// and zero permission denials -- so the flag narrows the built-in axis only.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./lib/isolated-environment').activate('agent-api-policy');

const policy = require('../src/lib/agent-api-policy');
const adapter = require('../src/lib/agent-engine/claude-cli-adapter');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

/* A settings document in the shape src/lib/settings.js actually parses:
   `revision`, `values` and a `provenance` entry whose source is one this
   product recognises. Written rather than mocked, so this proves the row is
   readable through the real loader and not merely that a boolean flows. */
function settingsFileWith(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    revision: 1,
    values: { [policy.AGENT_API_SETTING_ID]: value },
    provenance: { [policy.AGENT_API_SETTING_ID]: { source: 'user', atMs: 1, directive: null } }
  }), 'utf8');
  return file;
}

// --- the row exists and defaults on -----------------------------------------

check('the setting is a real registry row, defaulting on', () => {
  const registry = require('../src/lib/settings-registry').loadRegistry();
  assert.ok(registry.byId.has(policy.AGENT_API_SETTING_ID),
    'agent.agent_api must be a real row in config/settings-registry.json; a setting with no row is a hardcoded behaviour wearing a switch.');
  const entry = registry.byId.get(policy.AGENT_API_SETTING_ID);
  assert.strictEqual(entry.control, 'seg');
  // T1031 adds an opt-in choice; the existing default and explicit choices
  // remain authoritative under the installation-wide T1028 contract.
  assert.deepStrictEqual(entry.options, ['Only', 'Optimized', 'Enabled', 'Disabled']);
  assert.strictEqual(entry.default, 'Only');
  assert.ok(typeof entry.enforcedBy === 'string' && entry.enforcedBy.includes('agent-api-policy'),
    'the row must name its enforcer, or nothing connects the switch to the behaviour.');
});

// --- both states, through the real settings reader ---------------------------

check('legacy off preserves native tools, ToolsEnabled-only removes native tools', () => {
  const off = settingsFileWith(false);
  assert.deepStrictEqual(policy.agentApiArgs({ valuesPath: off }), [],
    'with the row false the Agent API must add nothing to the argv.');

  const on = settingsFileWith(true);
  assert.deepStrictEqual(policy.agentApiArgs({ valuesPath: on }),
    ['--tools', '', '--setting-sources', '', '--disable-slash-commands']);
});

check('a missing settings file keeps the registry default, which is on', () => {
  const absent = path.join(os.tmpdir(), 'agent-api-absent', 'settings.json');
  assert.strictEqual(policy.agentApiEnabled({ valuesPath: absent }), true,
    'an unwritten settings file must resolve to the registry default, the same rule settings.js itself applies.');
});

check('a settings read failure refuses instead of inventing an enabled answer', () => {
  const settings = require('../src/lib/settings');
  const originalLoadSettings = settings.loadSettings;
  settings.loadSettings = () => { throw new Error('settings read failed'); };
  try {
    assert.throws(
      () => policy.agentApiEnabled(),
      /settings read failed/,
      'an unreadable settings input is not evidence that the Agent API is enabled; session construction must stop.'
    );
  } finally {
    settings.loadSettings = originalLoadSettings;
  }
});

// --- the keep-list is the reviewed one ---------------------------------------

check('Skill is kept, so the measured 27-skill regression cannot recur', () => {
  const reviewedKept = [
    'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'NotebookEdit',
    'Read', 'Skill', 'TodoWrite', 'ToolSearch', 'Write'
  ];
  const reviewedReplaced = [
    'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList',
    'DesignSync', 'EnterPlanMode', 'EnterWorktree', 'ExitWorktree', 'Monitor',
    'PowerShell', 'PushNotification', 'RemoteTrigger', 'ScheduleWakeup',
    'SendMessage', 'Task', 'TaskOutput', 'TaskStop', 'WebFetch', 'WebSearch'
  ];
  assert.deepStrictEqual(policy.KEPT, reviewedKept,
    'the kept tools must be exactly the reviewed keep-list.');
  assert.deepStrictEqual(policy.REPLACED, reviewedReplaced,
    'the replaced tools must be exactly the reviewed replacement list.');
  assert.strictEqual(policy.keptNativeTools(), reviewedKept.join(','),
    'the CLI value must serialize the independently recorded keep-list in its reviewed order.');
  assert.ok(policy.KEPT.includes('Skill'),
    'A --tools list without Skill was measured on 2026-08-13 removing every project skill from every lane.');
  assert.ok(policy.keptNativeTools().split(',').includes('Skill'));
});

check('the file-and-search built-ins are kept, because the surface cannot replace them', () => {
  // Measured against the Full tier's own registry: host.read_file/write_file
  // reach the owner profile tree and replace whole files; repo.* is bounded to
  // this product's checkout; list_dir lists one directory with no pattern; and
  // no tool anywhere performs a regex or literal content search.
  for (const name of ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']) {
    assert.ok(policy.KEPT.includes(name),
      `${name} must stay: removing it leaves an agent unable to do the thing it was dispatched to do, and the ToolsEnabled surface has no equal for it.`);
  }
});

check('everything with egress, execution or a durable side effect is replaced', () => {
  const mustReplace = [
    'Bash', 'PowerShell', 'Task',
    'WebFetch', 'WebSearch', 'RemoteTrigger', 'PushNotification', 'SendMessage',
    'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
    'EnterWorktree', 'ExitWorktree'
  ];
  for (const name of mustReplace) {
    assert.ok(policy.REPLACED.includes(name),
      `${name} must be replaced: it acts outside this session with no ToolsEnabled record, which is the whole reason the Agent API exists.`);
    assert.ok(!policy.KEPT.includes(name));
  }
});

check('every census entry carries a reason that can be re-argued', () => {
  for (const entry of policy.BUILT_IN_CENSUS) {
    assert.strictEqual(typeof entry.name, 'string');
    assert.strictEqual(typeof entry.keep, 'boolean');
    assert.ok(typeof entry.why === 'string' && entry.why.trim().length >= 20,
      `${entry.name} must state why it is kept or replaced; an undocumented entry is a decision nobody can challenge.`);
  }
  assert.strictEqual(policy.KEPT.length + policy.REPLACED.length, policy.BUILT_IN_CENSUS.length);
});

// --- the census is closed ----------------------------------------------------

check('a built-in nobody reviewed is reported, never silently kept or dropped', () => {
  const observed = policy.BUILT_IN_CENSUS.map(entry => entry.name).concat(['SomeToolAddedByACliUpgrade']);
  const census = policy.nativeToolCensus(observed);
  assert.deepStrictEqual(census.unreviewed, ['SomeToolAddedByACliUpgrade'],
    'a name the table does not carry must surface as unreviewed, exactly as an unclassified ToolsEnabled tool is refused.');
  assert.deepStrictEqual(census.missing, [],
    'nothing in the table should be absent from a census that contains it.');
});

check('the measured 2026-08-24 census is exactly the reviewed one', () => {
  // The `tools` array claude 2.1.186 reported with no --tools flag, recorded
  // verbatim so a CLI upgrade that changes the built-in set turns this red on
  // the day it happens rather than the day somebody notices a missing tool.
  const MEASURED = [
    'Task', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList',
    'DesignSync', 'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode',
    'ExitWorktree', 'Glob', 'Grep', 'Monitor', 'NotebookEdit', 'PowerShell',
    'PushNotification', 'Read', 'RemoteTrigger', 'ScheduleWakeup', 'SendMessage',
    'Skill', 'TaskOutput', 'TaskStop', 'TodoWrite', 'ToolSearch', 'WebFetch',
    'WebSearch', 'Write'
  ];
  const census = policy.nativeToolCensus(MEASURED);
  assert.deepStrictEqual(census.unreviewed, [],
    'every built-in the CLI reported must have a decision recorded against it.');
  assert.deepStrictEqual(census.missing, [],
    'the table must not carry a name the CLI does not offer.');
  assert.strictEqual(MEASURED.length, 30);
  assert.strictEqual(policy.KEPT.length, 10,
    'the measured on-state census was 10 built-in tools; a change here changes what agents can do.');
});

// --- the enforcement point ---------------------------------------------------

check('the agent-thread argv carries the flag on and omits it off', () => {
  const base = {
    threadId: '11111111-1111-4111-8111-111111111111',
    threadOptions: { sandbox: 'danger-full-access', model: 'claude/opus' }
  };
  const on = adapter.claudeArgs({ ...base, agentApi: true });
  const off = adapter.claudeArgs({ ...base, agentApi: false });

  const at = on.indexOf('--tools');
  assert.ok(at >= 0, 'the Agent API must reach the command line, or the setting is a note in a file.');
  assert.strictEqual(on[at + 1], '');
  assert.ok(!off.includes('--tools'),
    'off must produce the argv this engine has always produced -- no flag, not an empty one.');
  assert.deepStrictEqual(off.filter(argument => argument !== '--tools' && argument !== policy.keptNativeTools()), off,
    'the off argv must be free of both halves of the flag.');
  assert.deepStrictEqual(
    on.filter(a => !['--tools', '', '--setting-sources', '--disable-slash-commands'].includes(a)),
    off,
    'the flag must be the ONLY difference between the two states; anything else means the switch is changing something it was never asked to change.');
});

check('a resumed conversation keeps the same bound', () => {
  const base = {
    threadId: '11111111-1111-4111-8111-111111111111',
    threadOptions: { sandbox: 'workspace-write', model: 'claude/sonnet' }
  };
  const resumed = adapter.claudeResumeArgs({ ...base, agentApi: true });
  assert.ok(resumed.includes('--tools'),
    'a session whose tool bound vanished between turns of one conversation is the defect the mcp-config note already names.');
  assert.strictEqual(resumed[resumed.indexOf('--tools') + 1], '');
});

check('the dispatched-lane argv reads the same answer, at both levels', () => {
  const lane = require('../src/lib/mission-bridge/actions');
  const tiers = require('../src/lib/permission-tier-policy');
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const args = lane.claudeArgs({ root: path.join(os.tmpdir(), 'api-lane-fixture'),
      tier: { cliModel: 'sonnet' }, permissionSession: tiers.installTierSession(tier) });
    assert.ok(args.includes('--tools'), tier);
    assert.equal(args[args.indexOf('--tools') + 1], '', tier + ' keeps the Only bound');
  }
});

// --- the note an agent is handed must not lie about this ------------------

check('the session-start tool note tells the truth about the built-ins, in both states', () => {
  // Neither universal native-shell availability nor universal absence follows
  // from this setting: the enforced census above is Claude-specific.
  const summary = require('../src/lib/agent-tool-summary');
  const on = summary.briefToolSummary({ tier: 'unrestricted', enabled: true, valuesPath: settingsFileWith(true) });
  const off = summary.briefToolSummary({ tier: 'unrestricted', enabled: true, valuesPath: settingsFileWith(false) });

  assert.ok(off.text.includes('Agent API mode: Enabled.'),
    'the disabled routing setting must be reported without asserting native availability.');
  assert.ok(!on.text.includes('separate and unaffected'),
    'the note cannot infer a native shell census from this setting.');
  for (const note of [on, off]) {
    assert.match(note.text, /Native tools vary by provider\/session, including children; this API list does not measure them/);
    assert.doesNotMatch(note.text, /Your (?:own )?built-in|switched off for this session|shell, web and messaging are off/);
    assert.ok(note.estimatedTokens <= summary.DEFAULT_BUDGET_TOKENS);
  }
  assert.ok(on.text.includes('Agent API mode: Only.'));
  /* NAMING THE REPLACEMENT, not gesturing at it. MEASURED over 18 real agent
   * runs on a Standard install: with the Agent API on, the FIRST ToolSearch an
   * agent issued was `select:Bash` in 4 of 9 runs -- a search spent trying to
   * retrieve the tool this setting had just removed, because nothing told the
   * agent what replaced it. The clause said "use these", which names nothing.
   * `host.exec` is the one built-in whose absence was measured costing a turn,
   * so it is the one the note spells out.
   *
   * STATED HONESTLY: this is a hypothesis aimed at a measured behaviour, NOT a
   * proven fix. Nobody has re-run the 18 with the new wording. It is defensible
   * because it is strictly more information at one token, not because it is
   * known to work. */
  assert.ok(on.text.includes('host.exec'),
    'the note must name the tool that replaces the built-in shell; "use these" sent 4 of 9 measured runs searching for Bash.');

  /* AND IT MUST NAME THE RIGHT ONE PER LEVEL, which is where the first attempt
   * was wrong. host.exec is PERMANENTLY excluded at both confined levels, so a
   * flat "use host.exec" offered Guided and Standard a tool they do not carry.
   * agent-tool-summary's own suite caught it. Measured on the registry:
   *   guided        no host.exec, no sandbox.exec  -> no ToolsEnabled shell
   *   standard      no host.exec, sandbox.exec     -> a leased container only
   *   unrestricted  host.exec                      -> the real thing
   * This describes ToolsEnabled execution only, not a native tool census. */
  const on2 = summary.briefToolSummary({ tier: 'standard', enabled: true, valuesPath: settingsFileWith(true) });
  const on3 = summary.briefToolSummary({ tier: 'guided', enabled: true, valuesPath: settingsFileWith(true) });
  assert.ok(!on2.text.includes('host.exec') && on2.text.includes('sandbox.exec'),
    'Standard must be told about sandbox.exec, and must NOT be offered host.exec, which its tier permanently refuses.');
  assert.ok(!on3.text.includes('host.exec') && !on3.text.includes('sandbox.exec'),
    'Guided carries neither runner; offering it either is the note lying in the dangerous direction.');
  assert.ok(/ToolsEnabled offers no shell at this level/.test(on3.text),
    'Guided must scope its absent execution runner to ToolsEnabled.');
  assert.strictEqual(on.detailLevel, off.detailLevel,
    'the honest clause must not cost the note a whole detail level; the budget contract says it sheds detail, not families.');
});


check('Optimized selects complementary native tools and preserves legacy choices', () => {
  const selected = ['Glob', 'Grep', 'Skill', 'TodoWrite', 'ToolSearch'];
  const file = settingsFileWith('Optimized');
  const original = fs.readFileSync(file, 'utf8');
  assert.equal(policy.agentApiMode({ valuesPath: file }), 'Optimized');
  assert.deepEqual(policy.agentApiArgs({ valuesPath: file }), ['--tools', selected.join(',')]);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'policy reads cannot rewrite choice or provenance');
  for (const mode of ['Enabled', 'Disabled']) assert.deepEqual(policy.agentApiArgs({ mode }), []);
  assert.deepEqual(policy.agentApiArgs({ mode: 'Only' }),
    ['--tools', '', '--setting-sources', '', '--disable-slash-commands']);
  for (const build of [adapter.claudeArgs, adapter.claudeResumeArgs]) {
    for (const permissionMode of ['plan', 'default', 'bypassPermissions']) {
      const args = build({ threadId: '11111111-1111-4111-8111-111111111111',
        agentApi: 'Optimized', permissionMode,
        mcpConfig: path.join(os.tmpdir(), 'optimized-fixture', '.mcp.json') });
      assert.equal(args[args.indexOf('--tools') + 1], selected.join(','));
      assert.equal(args[args.indexOf('--permission-mode') + 1], permissionMode);
      assert.ok(args.includes('--strict-mcp-config'));
      assert.equal(args.filter(value => value === '--tools').length, 1);
      assert.throws(() => build({ threadId: 'fixture', agentApi: 'Optimized',
        extraArgs: ['--tools', 'default'] }), { code: 'CLAUDE_ROLE_TOOLS_INVALID' });
    }
    const roleArgs = build({ threadId: '11111111-1111-4111-8111-111111111111',
      agentApi: 'Optimized', roleFunctionsOnly: true });
    assert.equal(roleArgs[roleArgs.indexOf('--tools') + 1], '', 'role functions never acquire native tools');
  }
});

check('global support metadata is the same provider resolver used for plans', () => {
  const matrix = policy.optimizedApiSupport();
  assert.equal(matrix.scope, 'installation');
  assert.equal(matrix.appliesTo, 'new-sessions');
  assert.deepEqual(matrix.providers.map(row => row.provider), ['claude', 'codex', 'gemini', 'grok', 'local']);
  for (const row of matrix.providers) assert.deepEqual(row, policy.optimizedToolSupport({ provider: row.provider }));
  const claude = policy.optimizedToolSupport({ provider: 'claude' });
  assert.equal(claude.status, 'supported');
  assert.deepEqual(claude.nativeTools, ['Glob', 'Grep', 'Skill', 'TodoWrite', 'ToolSearch']);
  const role = policy.optimizedToolSupport({ provider: 'claude', roleFunctionsOnly: true });
  assert.equal(role.status, 'supported');
  assert.deepEqual(role.nativeTools, []);
  assert.ok(role.reason.length > 0);
  for (const provider of ['codex', 'gemini', 'grok', 'local']) {
    const row = policy.optimizedToolSupport({ provider });
    assert.equal(row.status, 'unsupported');
    assert.ok(row.reason.length > 0);
    assert.deepEqual(row.nativeTools, []);
  }
  assert.equal(policy.optimizedToolSupport({ provider: 'gemini', client: 'antigravity' }).status, 'unsupported');
  for (const provider of [null, 'unrecognized-provider']) {
    assert.equal(policy.optimizedToolSupport({ provider }).status, 'unknown');
    assert.deepEqual(policy.optimizedToolSupport({ provider }).nativeTools, []);
  }
});

check('Optimized says plainly that it works with Claude only (rc-0922 Codex decision)', () => {
  // The installed Codex has no native-tool allowlist, so this release keeps
  // Optimized Claude-only. The setting and every refusal row must say that in
  // plain words instead of promising "supported providers" that do not exist.
  const matrix = policy.optimizedApiSupport();
  assert.deepEqual(matrix.providers.filter(row => row.status === 'supported').map(row => row.provider), ['claude']);
  for (const [provider, name] of [['codex', 'Codex'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['local', 'Local']]) {
    const row = policy.optimizedToolSupport({ provider });
    assert.equal(row.reason, `Optimized works with Claude only. ${name} sessions do not start while it is selected.`, provider);
  }
  for (const provider of [null, 'unrecognized-provider']) {
    assert.match(policy.optimizedToolSupport({ provider }).reason, /^Optimized works with Claude only\. /);
  }
  assert.match(policy.optimizedToolSupport({ provider: 'claude' }).reason,
    /^Claude sessions add file search, skills, planning and tool search/);
  const registry = require('../src/lib/settings-registry').loadRegistry();
  const entry = registry.byId.get(policy.AGENT_API_SETTING_ID);
  assert.ok(entry.consequence.includes('Optimized works with Claude only'), entry.consequence);
  assert.ok(entry.consequence.includes('Sessions on other providers do not start while Optimized is selected.'), entry.consequence);
  assert.ok(!/supported providers|complementary/.test(entry.consequence), 'no vague provider promise may remain');
  assert.ok(entry.risks.some(risk => risk.startsWith('Optimized works with Claude only. Codex, Gemini, Grok and local sessions do not start')),
    JSON.stringify(entry.risks));
  const alias = registry.byId.get('agent.tool_mode');
  assert.ok(alias.consequence.includes('(Claude only)'), alias.consequence);
});

console.log(`agent-api-policy: ${checks} checks passed`);
