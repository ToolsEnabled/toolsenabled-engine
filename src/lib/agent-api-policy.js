'use strict';

// One saved mode governs new agent sessions. Only restricts native actions,
// Enabled offers both tool sets, and Disabled withholds the ToolsEnabled API.
// The historical native-tool census remains exported for compatibility; it
// no longer supplies exceptions to Only.

const { AGENT_API_SETTING_ID, AGENT_API_MODES, normalizeAgentApiMode } = require('./agent-api-mode');

// Required lazily, for the reason src/lib/agent-tool-summary.js gives: a caller
// asking only whether a switch is on has no business loading the settings graph
// at module load time.
function settingsModule() { return require('./settings'); }
function settingsRegistryModule() { return require('./settings-registry'); }

/* THE BUILT-IN CENSUS, MEASURED. Thirty names, exactly as claude 2.1.186's
 * `system/init` event reported them with no `--tools` flag. It is written out
 * in full rather than derived, because a list this file cannot see cannot be
 * decided: a built-in added by a CLI upgrade must appear as an UNREVIEWED name
 * in nativeToolCensus() rather than be silently kept or silently dropped.
 *
 * `keep` is the decision. `why` is the reason it can be re-argued on. */
const BUILT_IN_CENSUS = Object.freeze([
  Object.freeze({ name: 'AskUserQuestion', keep: false, why: 'system.ask and the blocked-question gate own asking the person; a built-in that halts to ask bypasses agent.blocked_question.' }),
  Object.freeze({ name: 'Bash', keep: false, why: 'host.exec is the same reach at the same privilege, written to the signed audit log and refused by the kill switch -- AT UNRESTRICTED ONLY. Measured: guided carries neither host.exec nor sandbox.exec, so with this setting on that level has NO way to run a command at all; standard carries sandbox.exec, a leased container, and not host.exec. Removing the built-in shell is a REPLACEMENT only at the top level and a REMOVAL at the other two, and the session note states which.' }),
  Object.freeze({ name: 'CronCreate', keep: false, why: 'scheduler.* owns durable schedules. Measured 2026-08-13: a lane that cannot run Bash calls CronCreate instead and registers a job that OUTLIVES the lane.' }),
  Object.freeze({ name: 'CronDelete', keep: false, why: 'scheduler.* owns durable schedules; a deletion that leaves no audit record is the half of that pair nobody notices.' }),
  Object.freeze({ name: 'CronList', keep: false, why: 'scheduler.list. Measured executing under --permission-mode plan, the level whose declared meaning is read-only.' }),
  Object.freeze({ name: 'DesignSync', keep: false, why: 'no ToolsEnabled equivalent and no ToolsEnabled purpose; it writes to a surface this product does not own.' }),
  Object.freeze({ name: 'Edit', keep: true, why: 'DEBT: host.patch_file and repo.patch_file replace one exact unique span of a file the session has read, byte-mediated against concurrent writers, but there is no multi-span, append or notebook edit anywhere in the surface.' }),
  Object.freeze({ name: 'EnterPlanMode', keep: false, why: 'the permission mode is set by the recorded level on the argv; a session that can re-enter plan mode by itself decides its own ceiling.' }),
  Object.freeze({ name: 'EnterWorktree', keep: false, why: 'it leaves the declared territory. No ToolsEnabled tool creates a worktree, and a lane that moves its own checkout is outside every claim it holds.' }),
  Object.freeze({ name: 'ExitPlanMode', keep: true, why: 'session-local with no side effect, and the only way out of the plan mode the guided level sets.' }),
  Object.freeze({ name: 'ExitWorktree', keep: false, why: 'the other half of EnterWorktree; kept out with it so the pair cannot be half-present.' }),
  Object.freeze({ name: 'Glob', keep: true, why: 'DEBT: host.list_dir and repo.list_dir list ONE directory. There is no pattern match and no recursion anywhere in the surface.' }),
  Object.freeze({ name: 'Grep', keep: true, why: 'DEBT: 265 tools at the Full tier carry no regex or literal content search. search.query is semantic, needs a prior index, and returns ranked snippets rather than matches.' }),
  Object.freeze({ name: 'Monitor', keep: false, why: 'task.* and agent_comms.* own waiting on other work, and they record it.' }),
  Object.freeze({ name: 'NotebookEdit', keep: true, why: 'DEBT: the same surgical edit as Edit, on a different file type, and with the same missing equivalent.' }),
  Object.freeze({ name: 'PowerShell', keep: false, why: 'host.exec, for the reason Bash is removed, and with the same per-level caveat. Two shells is two doors around one audit record.' }),
  /* THE SECOND CLAUSE OF THIS LINE USED TO SAY "and the ask.primary_channel
     setting decides where", and it decides nothing. Measured against the
     shipped catalogue: config/settings-registry.json gives that row
     `enforcedBy: ""` -- it is one of the entries recorded in
     UNENFORCED_BASELINE in tests/settings-enforcement-honesty.test.js, the set
     nothing in the product reads -- and it is a `select` whose options array
     holds a single answer, so there is nothing to pick even if something read
     it. This is the same defect the Task entry below records and for the same
     reason: a `why` is the JUSTIFICATION for removing a harness tool, and one
     argued from a control that decides nothing rests on air.
     What actually decides the destination is config/owner-delivery.json's
     `channel`, read by src/lib/owner-delivery.js, whose own header calls it
     "THE SINGLE SWITCH for owner-facing delivery ... there is no second place
     to set it." The removal stands on that: owner delivery is the recorded
     equivalent and PushNotification is not. Only the sentence needed to be
     true. tests/agent-api-census-reasons-hold.test.js holds every entry here
     to it. */
  Object.freeze({ name: 'PushNotification', keep: false, why: 'owner delivery owns reaching the person, and config/owner-delivery.json decides where it goes -- one switch, read by src/lib/owner-delivery.js, with no second place to set it.' }),
  Object.freeze({ name: 'Read', keep: true, why: 'DEBT: host.read_file reaches the owner profile tree at a 2 MiB cap and repo.read_file only this product\'s checkout. Neither reaches a project on another drive.' }),
  Object.freeze({ name: 'RemoteTrigger', keep: false, why: 'egress this product does not mediate, to a destination the outward.* settings never see.' }),
  Object.freeze({ name: 'ScheduleWakeup', keep: false, why: 'scheduler.*; the same durable-job escalation CronCreate was measured performing.' }),
  Object.freeze({ name: 'SendMessage', keep: false, why: 'agent_comms.send and agent_comms.send_local, which spool, drain and record. A message the tree cannot see did not happen as far as the tree is concerned.' }),
  Object.freeze({ name: 'Skill', keep: true, why: 'no equivalent. Measured A/B 2026-08-13: emitting a --tools list without it removed all 27 project skills and the child reported that no skills exist.' }),
  /* THE LAST CLAUSE OF THIS LINE USED TO SAY "and puts the child on the tree",
     and that was not true. It matters because this `why` is the JUSTIFICATION
     for removing the harness tool: a removal argued partly from something the
     product does not do is a removal resting on air.
     What agent.spawn actually does was measured, not assumed. It records the
     launch and it records the PARENTAGE with it -- parentLaunchId is validated
     and stored (src/lib/controller-launch-record.js:261-263, :286) -- so the
     nesting is genuinely kept. What does not happen is the drawing: nothing in
     the application reads parentLaunchId to make a node, so a spawned child
     appears on no tree. The relationship is recorded and unread.
     The removal still stands on its own: agent.spawn is the recorded, audited
     equivalent and Task is neither. Only the sentence needed to be true. */
  Object.freeze({ name: 'Task', keep: false, why: 'agent.spawn, which requires a CONTRACT/1 form, and which records the launch together with its parent. The child is not drawn on the tree today: the parentage is stored and nothing reads it.' }),
  Object.freeze({ name: 'TaskOutput', keep: false, why: 'task.get; the read half of the family whose write half is removed above it.' }),
  Object.freeze({ name: 'TaskStop', keep: false, why: 'task.cancel, which records who stopped what.' }),
  Object.freeze({ name: 'TodoWrite', keep: true, why: 'no equivalent. Session-local, no durable side effect, no egress.' }),
  Object.freeze({ name: 'ToolSearch', keep: true, why: 'a harness mechanism for loading deferred tool schemas, not a capability. Removing it makes deferred ToolsEnabled tools uncallable, which is the opposite of the point.' }),
  Object.freeze({ name: 'WebFetch', keep: false, why: 'web.fetch and web.expand, which are the fetch this product\'s policy and audit know about.' }),
  Object.freeze({ name: 'WebSearch', keep: false, why: 'web.search and web.lookup.' }),
  Object.freeze({ name: 'Write', keep: true, why: 'DEBT: host.write_file and repo.write_file are whole-file replace (host.write_file requires a current read of an existing file), and repo.write_file excludes config/ from writes entirely.' })
]);

const KEPT = Object.freeze(BUILT_IN_CENSUS.filter(entry => entry.keep).map(entry => entry.name).sort());
const REPLACED = Object.freeze(BUILT_IN_CENSUS.filter(entry => !entry.keep).map(entry => entry.name).sort());

/** Historical census helper; current session flags do not use this list. */
function keptNativeTools() {
  return KEPT.join(',');
}

/**
 * Which measured built-ins this file has and has not reviewed.
 *
 * `unreviewed` is the load-bearing field. A CLI upgrade that adds a built-in
 * puts a name here, and a name here is a name nobody decided -- which the test
 * over this module fails on, exactly as tests/confined-tool-surface.test.js
 * fails on an unclassified ToolsEnabled tool. The alternative is a keep-list
 * that silently starts dropping a new capability, or silently starts keeping
 * one with egress.
 */
function nativeToolCensus(observedNames) {
  const known = new Set(BUILT_IN_CENSUS.map(entry => entry.name));
  const observed = Array.isArray(observedNames) ? observedNames.filter(name => typeof name === 'string') : [];
  return Object.freeze({
    kept: KEPT,
    replaced: REPLACED,
    unreviewed: Object.freeze(observed.filter(name => !known.has(name)).sort()),
    missing: Object.freeze(observed.length === 0 ? [] : [...known].filter(name => !observed.includes(name)).sort())
  });
}

// Optimized is a separate, deliberate selection, not the historical KEPT
// census or Enabled-all. MCP configuration and provider permissions remain
// independent: --tools controls native availability, not permission grants.
//
// DECISION (rc-0922, T1031): Optimized is Claude-only in this release. Claude
// takes an exact native allowlist (--tools). The installed Codex 0.155.1 has no
// native allowlist: its enabled_tools/disabled_tools filter MCP servers, and its
// feature switches cannot keep a small read-only set without also dropping or
// admitting the shell and apply_patch (see CODEX-W20.md). Gemini and Grok run
// over ACP with no native surface. Every non-Claude start therefore refuses with
// AGENT_OPTIMIZED_TOOLS_UNSUPPORTED instead of silently widening or narrowing,
// and every row below says so in plain words.
const OPTIMIZED_ONLY_CLAUDE = 'Optimized works with Claude only.';
const PROVIDER_NAMES = Object.freeze({ codex: 'Codex', gemini: 'Gemini', grok: 'Grok', local: 'Local' });
const OPTIMIZED_CLAUDE_TOOLS = Object.freeze(['Glob', 'Grep', 'Skill', 'TodoWrite', 'ToolSearch']);
const NO_NATIVE_TOOLS = Object.freeze([]);
function optimizedToolSupport({ provider = null, client = null, roleFunctionsOnly = false } = {}) {
  const selectedProvider = typeof provider === 'string' && provider.length ? provider : null;
  let status = 'unknown';
  let reason = selectedProvider === null
    ? `${OPTIMIZED_ONLY_CLAUDE} Each new session checks its provider when it starts.`
    : `${OPTIMIZED_ONLY_CLAUDE} Sessions on this provider do not start while it is selected.`;
  let nativeTools = NO_NATIVE_TOOLS;
  if (selectedProvider === 'claude' && (client === null || client === 'claude')) {
    status = 'supported';
    reason = roleFunctionsOnly
      ? 'This role permits ToolsEnabled functions only; native tools remain unavailable.'
      : 'Claude sessions add file search, skills, planning and tool search, within the existing role and permission limits.';
    nativeTools = roleFunctionsOnly ? NO_NATIVE_TOOLS : OPTIMIZED_CLAUDE_TOOLS;
  } else if (Object.hasOwn(PROVIDER_NAMES, selectedProvider)) {
    status = 'unsupported';
    reason = `${OPTIMIZED_ONLY_CLAUDE} ${PROVIDER_NAMES[selectedProvider]} sessions do not start while it is selected.`;
  } else if (selectedProvider === 'claude') {
    status = 'unsupported';
    reason = `${OPTIMIZED_ONLY_CLAUDE} This older Claude route cannot apply the selection, so the session does not start.`;
  }
  return Object.freeze({ provider: selectedProvider, status, reason, nativeTools });
}

function optimizedApiSupport() {
  return Object.freeze({
    scope: 'installation',
    appliesTo: 'new-sessions',
    providers: Object.freeze(['claude', 'codex', 'gemini', 'grok', 'local']
      .map(provider => optimizedToolSupport({ provider })))
  });
}

/** Resolve one mode, accepting the former boolean values without rewriting them. */
function agentApiMode({ valuesPath, env } = {}) {
  const registry = settingsRegistryModule().loadRegistry();
  if (!registry.byId.has(AGENT_API_SETTING_ID)) return 'Enabled';
  const resolved = settingsModule().loadSettings({ registry, valuesPath, env });
  const mode = normalizeAgentApiMode(resolved.values[AGENT_API_SETTING_ID]);
  if (!mode || resolved.rejected?.some(item => item.id === '*' || item.id === AGENT_API_SETTING_ID)) {
    const error = new Error('The agent API mode could not be read. The session was not started.');
    error.code = 'AGENT_API_MODE_UNAVAILABLE';
    throw error;
  }
  return mode;
}

// Compatibility name for callers asking whether native tools are restricted.
function agentApiEnabled(options = {}) {
  return agentApiMode(options) === 'Only';
}

/** Native-tool arguments; the session plan separately controls API availability. */
function agentApiArgs({ enabled = null, mode = null, valuesPath, env } = {}) {
  const selected = mode !== null ? normalizeAgentApiMode(mode)
    : enabled !== null ? normalizeAgentApiMode(enabled) : agentApiMode({ valuesPath, env });
  if (!selected) throw new Error('Unknown agent API mode.');
  if (selected === 'Only') return ['--tools', '', '--setting-sources', '', '--disable-slash-commands'];
  if (selected === 'Optimized') return ['--tools', optimizedToolSupport({ provider: 'claude' }).nativeTools.join(',')];
  return [];
}

module.exports = Object.freeze({
  AGENT_API_SETTING_ID,
  AGENT_API_MODES,
  normalizeAgentApiMode,
  agentApiMode,
  BUILT_IN_CENSUS,
  KEPT,
  REPLACED,
  keptNativeTools,
  nativeToolCensus,
  optimizedToolSupport,
  optimizedApiSupport,
  agentApiEnabled,
  agentApiArgs
});
