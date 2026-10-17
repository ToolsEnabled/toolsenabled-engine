'use strict';

// Summarize the measured Fleet tool surface for an agent session. The tool
// names come from the registry and tier policy; family descriptions are hints.
// An unreadable setting or surface suppresses the note rather than guessing.

const TOOL_SUMMARY_SETTING_ID = 'agent.tool_summary';
const DEFAULT_BUDGET_TOKENS = 450;

// Require policy and registry lazily so a settings-only check does not load
// the runtime tool catalogue.
function permissionTierPolicy() { return require('./permission-tier-policy'); }
function machineRecordModule() { return require('./setup/machine-record'); }
function toolRegistryModule() { return require('./tool-registry'); }
function settingsModule() { return require('./settings'); }
function settingsRegistryModule() { return require('./settings-registry'); }
function agentApiPolicyModule() { return require('./agent-api-policy'); }

const TIER_NAMES = Object.freeze({
  guided: 'Guided',
  standard: 'Standard',
  unrestricted: 'Unrestricted'
});

/* The ids an agent reaches for constantly -- the ones a person would otherwise
 * teach by hand, session after session. Only the ones the level actually
 * offers are printed. */
const REACH_FOR = Object.freeze([
  ['agent_comms.send_local', 'message another agent on this tree'],
  ['memory.set', 'save a durable note'],
  ['memory.get', 'read one back'],
  ['memory.search', 'find saved notes'],
  ['system.doctor', 'what is configured here'],
  ['settings.read', 'this installation\'s settings']
]);

/* One clause per family, attached when the budget allows. An absent entry is
 * not an absent family: unmapped families still appear by name. */
const FAMILY_PURPOSES = Object.freeze({
  memory: 'durable notes',
  agent_comms: 'agent-to-agent messages',
  task: 'the durable task queue',
  system: 'runtime status and diagnostics',
  r_ledger: 'the person\'s standing rules (propose or file one only when they allow it)',
  ledger: 'read saved rules, tasks, asks and answers, and purchase records',
  t_ledger: 'file, complete or remove task records; read them with ledger.read',
  a_ledger: 'file or settle durable asks; check answers with ledger.read',
  search: 'the local search index',
  audit: 'the local audit ledger',
  settings: 'read settings'
});

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function refusal(code, reason) {
  return Object.freeze({ enabled: false, text: null, code, estimatedTokens: 0,
    ...(reason ? { reason } : {}) });
}

function settingWasNotMeasured(resolved, settingId) {
  return !resolved || !Array.isArray(resolved.rejected) || resolved.rejected.some(rejection =>
    rejection && (rejection.id === '*' || rejection.id === settingId));
}

/**
 * Is the note switched on for this installation?
 *
 * The registry default (on) decides when the settings file is absent; only a
 * readable settings document with the row set false turns it off. A present
 * but unreadable or invalid settings layer returns null, preserving that the
 * switch was not measured so the caller can refuse to write a note.
 */
function toolSummaryEnabled({ valuesPath, env } = {}) {
  try {
    const registry = settingsRegistryModule().loadRegistry();
    if (!registry.byId.has(TOOL_SUMMARY_SETTING_ID)) return false;
    const resolved = settingsModule().loadSettings({ registry, valuesPath, env });
    if (settingWasNotMeasured(resolved, TOOL_SUMMARY_SETTING_ID)) return null;
    return resolved.values[TOOL_SUMMARY_SETTING_ID] !== false;
  } catch {
    return null;
  }
}

/* Keep an unavailable setting distinct from a selected mode so the summary
 * can report missing evidence without throwing a session-policy exception. */
function measuredAgentApiEnabled({ valuesPath, env } = {}) {
  try {
    const policy = agentApiPolicyModule();
    const registry = settingsRegistryModule().loadRegistry();
    if (!registry.byId.has(policy.AGENT_API_SETTING_ID)) return 'Enabled';
    const resolved = settingsModule().loadSettings({ registry, valuesPath, env });
    if (settingWasNotMeasured(resolved, policy.AGENT_API_SETTING_ID)) return null;
    return require('./agent-api-mode').normalizeAgentApiMode(resolved.values[policy.AGENT_API_SETTING_ID]);
  } catch {
    return null;
  }
}

function familiesOf(names) {
  const families = new Map();
  for (const name of names) {
    const family = String(name).split('.')[0];
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(name);
  }
  return families;
}

/* One composition at one level of detail. Levels shed detail, never families:
 *   2  purpose clauses on mapped families, full reach-for list
 *   1  purposes only on the families agents use constantly
 *   0  family names only, reach-for capped
 *  -1  family names only, no reach-for line, one-clause discipline
 */
/* Name only execution offered by this API surface. A missing API runner is
 * not a measurement of the provider's native tools. Keep that distinction at
 * every detail level, including when the note sheds other prose for budget. */
function shellReplacement(allowedSet) {
  if (allowedSet.has('host.exec')) return 'ToolsEnabled execution: host.exec.';
  if (allowedSet.has('sandbox.exec')) return 'ToolsEnabled execution: sandbox.exec in a leased sandbox.';
  return 'ToolsEnabled offers no shell at this level.';
}

function builtInClause(agentApiOn, level, allowedSet) {
  // Neither MCP initialize nor the desktop injection supplies a verified
  // provider-native census. Claude's enforced keep-list is not evidence about
  // Codex (or a child using another provider). Even routing OFF is not evidence
  // that another session policy has enabled native shell/file tools.
  const native = level < 0
    ? 'Native tools (children too): unmeasured.'
    : 'Native tools vary by provider/session, including children; this API list does not measure them.';
  return `Agent API mode: ${agentApiOn}. ${native} ${shellReplacement(allowedSet)}`;
}

function compose({ tierName, readOnly, allowed, allowedSet, families, absentFamilies, agentApiOn,
  level, packed = false, openShell = false, setupKind }) {
  const lines = [];
  const availability = packed
    ? `${allowed.length} ToolsEnabled tools; "${tierName}" permissions${readOnly ? ' (read-only)' : ''}. Use exact ids.`
    : `This computer offers you ${allowed.length} ToolsEnabled tools at its "${tierName}" permission level${readOnly ? ' (a read-only toolkit)' : ''}. Call them by exact id.`;
  lines.push(`${availability} ${builtInClause(agentApiOn, level, allowedSet)}`);

  /* THE OWNER'S CONVENTION, agent-side half. The setup card teaches the person
   * to say "use ToolsEnabled" to point their agent here; this line is what
   * makes those words land. It sheds with the other level-0 detail under hard
   * budget pressure (standard's minimal note has ~13 tokens of headroom, so a
   * line that rode at level -1 would break the budget contract instead). */
  if (level >= 0) {
    lines.push('When the person says "use ToolsEnabled", they mean this toolkit: reach for the matching tool by exact id.');
  }

  const reach = REACH_FOR.filter(([name]) => allowedSet.has(name));
  const reachShown = level >= 1 ? reach : reach.slice(0, 3);
  if (level >= 0 && reachShown.length > 0) {
    lines.push(`Reach for these first: ${reachShown.map(([name, why]) => (level >= 1 ? `${name} (${why})` : name)).join(', ')}.`);
  }

  const keyFamilies = new Set(['memory', 'agent_comms', 'system', 'task']);
  const familyNames = [...families.keys()].sort();
  const familyLine = familyNames.map(family => {
    const purpose = FAMILY_PURPOSES[family];
    if (level >= 2 && purpose) return `${family} (${purpose})`;
    if (level >= 1 && purpose && keyFamilies.has(family)) return `${family} (${purpose})`;
    return family;
  }).join(', ');
  lines.push(`Tool families here: ${familyLine}.`);

  const withheld = [];
  if (readOnly) {
    withheld.push('every tool that changes anything -- this toolkit only reads');
  }
  if (absentFamilies.length > 0) {
    withheld.push(`the ${absentFamilies.join(', ')} ${absentFamilies.length === 1 ? 'family' : 'families'}`);
  }
  /* INSIDE AN OPENSHELL SANDBOX THE LEVEL IS NOT WHAT WITHHOLDS A FAMILY.
   * The sandbox offers a reviewed tool list (src/lib/openshell-surface.js):
   * OpenShell holds credentials and enforces files and network, and desktop
   * tools cannot run there. Saying "not at this level" would send the person
   * to raise a level that would change nothing, so the line says why instead. */
  if (openShell) {
    const levelLimits = readOnly ? ['every tool that changes anything -- this toolkit only reads'] : [];
    lines.push(`Not offered in this OpenShell sandbox: ${[
      ...levelLimits,
      absentFamilies.length > 0 ? `the ${absentFamilies.join(', ')} ${absentFamilies.length === 1 ? 'family' : 'families'}` : null
    ].filter(Boolean).join('; ') || 'nothing'}. OpenShell holds credentials and enforces files and network here.`);
  } else {
    lines.push(withheld.length === 0
      ? 'Not at this level: nothing -- every registered tool is offered.'
      : `Not at this level: ${withheld.join('; ')}.`);
  }

  // Keep the missing-tool guidance even when the note is compressed.
  if (openShell) {
    lines.push(setupKind === 'plugin'
      ? (packed
        ? 'Missing tools: say so. Setup: /tefleet setup in Claude Code. Inspect with settings.read and ledger.read.'
        : 'If a tool is absent, say so. The person configures this Claude plugin with /tefleet setup in the current project. Inspect saved settings and ledger records with settings.read and ledger.read.')
      : packed
      ? 'Missing tools: not offered here; say so. Level: toolsenabled setup --tier. Settings = toolsenabled settings; Ledger page = toolsenabled ledger; system.ask answers = toolsenabled approvals.'
      : 'If a tool you expect is not offered, say so plainly instead of looking for another route. The person changes the level from the terminal with `toolsenabled setup --tier unrestricted|standard|guided`. Where a tool or refusal mentions Settings or the Ledger page, in this sandbox the person uses `toolsenabled settings` and `toolsenabled ledger` in the terminal, and answers system.ask with `toolsenabled approvals`.');
  } else {
    lines.push(packed
      ? 'Missing tools: permissions; change in Settings.'
      : (level >= 0
        ? 'If a tool you expect is not offered, this permission level withholds it: say so plainly instead of looking for another route. The person can change the level in Settings.'
        : 'If a tool is not offered here, say so; the person can change the level in Settings.'));
  }

  return lines.join('\n');
}

/**
 * The note for one session, or a named refusal to write one.
 *
 * `allowedNames` / `totalNames` default to the same derivation the generated
 * MCP configuration uses, so the product path needs to pass only the tier.
 * Tests and other callers inject names to stay hermetic.
 */
function briefToolSummary({
  tier,
  allowedNames,
  totalNames,
  budgetTokens = DEFAULT_BUDGET_TOKENS,
  enabled,
  valuesPath,
  env,
  setupKind
} = {}) {
  const isOn = typeof enabled === 'boolean' ? enabled : toolSummaryEnabled({ valuesPath, env });
  if (isOn === null) return refusal('TOOL_SUMMARY_SETTING_UNAVAILABLE');
  if (!isOn) return refusal('TOOL_SUMMARY_DISABLED');

  let validated;
  let session;
  try {
    validated = permissionTierPolicy().installTier(tier);
    session = permissionTierPolicy().installTierSession(validated);
  } catch (error) {
    /* installTier() has exactly one answer that means the supplied value is
     * genuinely absent/unknown. A failed lazy require (EMFILE, EAGAIN, EIO,
     * EBUSY, etc.) and an unreadable policy are not evidence about the value.
     * Keep those failures distinct and uncached so a later call can retry. */
    if (error && error.code === 'PERMISSION_INSTALL_TIER_REFUSED') {
      return refusal('TOOL_SUMMARY_TIER_UNKNOWN');
    }
    return refusal('TOOL_SUMMARY_TIER_UNAVAILABLE',
      'The permission level could not be checked; this is not a claim that the level is absent or unknown.');
  }

  let allowed;
  let total;
  try {
    const registered = toolRegistryModule().registeredTools();
    // The denominator is the build's full catalogue. A process-level allowlist
    // may narrow registeredTools(), so it only supplies the offered numerator.
    total = Array.isArray(totalNames)
      ? totalNames.slice()
      : toolRegistryModule().TOOL_REGISTRY.map(tool => tool.name);
    const declared = allowedNames === undefined ? machineRecordModule().tierToolAllowlist(validated) : allowedNames;
    // A null allowlist still follows the same policy as the dispatcher.
    allowed = declared === null
      ? [...permissionTierPolicy().allowedToolNames(registered, session)]
      : Array.isArray(declared) ? declared.slice() : null;
  } catch {
    return refusal('TOOL_SUMMARY_SURFACE_UNAVAILABLE');
  }
  if (!Array.isArray(allowed) || allowed.length === 0) return refusal('TOOL_SUMMARY_SURFACE_EMPTY');
  if (!Array.isArray(total) || total.length === 0) return refusal('TOOL_SUMMARY_TOTAL_SURFACE_EMPTY');
  if (!allowed.every(name => typeof name === 'string' && name.length > 0)
      || !total.every(name => typeof name === 'string' && name.length > 0)) {
    return refusal('TOOL_SUMMARY_SURFACE_INVALID');
  }

  const allowedSet = new Set(allowed);
  const totalSet = new Set(total);
  if ([...allowedSet].some(name => !totalSet.has(name))) {
    return refusal('TOOL_SUMMARY_SURFACE_MISMATCH');
  }
  const families = familiesOf(allowed);
  const absentFamilies = [...familiesOf(total).keys()].filter(family => !families.has(family)).sort();
  const readOnly = session.profile === 'read-only';
  /* Read once, here, rather than inside compose(): the note is composed up to
     four times while it sheds detail, and a settings read per composition would
     make the note's own cost depend on how long it took to fit. An unreadable
     settings layer is not evidence for either built-in-tools clause, so it
     refuses the note below rather than converting the failed read to false. */
  const agentApiOn = measuredAgentApiEnabled({ valuesPath, env });
  if (agentApiOn === null) return refusal('TOOL_SUMMARY_AGENT_API_UNAVAILABLE');

  const shape = {
    openShell: require('./openshell-inside').isInsideOpenShellSandbox(env || process.env),
    tierName: TIER_NAMES[validated] || validated,
    readOnly,
    allowed,
    allowedSet,
    families,
    absentFamilies,
    agentApiOn,
    setupKind
  };

  for (const level of [2, 1, 0, -1]) {
    let text = compose({ ...shape, level });
    let tokens = estimateTokens(text);
    // Compress the final guidance before returning an honest overBudget result.
    if (level === -1 && tokens > budgetTokens) {
      const packedText = compose({ ...shape, level, packed: true });
      const packedTokens = estimateTokens(packedText);
      if (packedTokens < tokens) {
        text = packedText;
        tokens = packedTokens;
      }
    }
    if (tokens <= budgetTokens || level === -1) {
      return Object.freeze({
        enabled: true,
        tier: validated,
        text,
        estimatedTokens: tokens,
        allowedCount: allowed.length,
        totalCount: total.length,
        detailLevel: level,
        overBudget: tokens > budgetTokens
      });
    }
  }
  /* istanbul ignore next -- the loop above always returns at level -1. */
  return refusal('TOOL_SUMMARY_UNWRITABLE');
}

module.exports = Object.freeze({
  TOOL_SUMMARY_SETTING_ID,
  DEFAULT_BUDGET_TOKENS,
  toolSummaryEnabled,
  briefToolSummary,
  estimateTokens
});
