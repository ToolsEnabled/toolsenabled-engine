'use strict';

// THE STANDARD TOOL NOTE A PRODUCT AGENT IS HANDED AT THE START OF ITS SESSION.
//
// THE PROBLEM, IN THE OWNER'S WORDS: "i have to tell agents what tools are
// called and what to do and to use this or that tool etc. so thats really hard
// on a user. We should have a really short standard file that just shares
// exactly what exists - we dont wat to eat tokens but they need to knoiw. We
// can give a specific setting to disable this but it should be standard."
//
// And the first outside user's version of the same failure: their agents
// "weren't able to use credential manager or vault" -- on a default (Guided)
// install, where the credential requester is deliberately withheld. Nothing
// told the agent that, so the agent could not tell the person, so the limit
// read as a breakage. The note this module writes is where that silence ends:
// what exists is named, and what this level withholds is named too.
//
// DERIVED, NEVER LISTED. The tool names come from the caller -- in the product,
// from src/lib/setup/machine-record.js tierToolAllowlist(), the same derivation
// the generated MCP configuration is written from -- so the note and the
// running servers cannot disagree. The only hand-written prose here is the
// one-clause purpose a family carries; an unmapped family still appears by
// name, so a new tool family cannot silently vanish from the note.
//
// TOKEN-LEAN IS A CONTRACT, NOT AN ASPIRATION. The note carries a budget
// (DEFAULT_BUDGET_TOKENS, estimated at four characters per token) and when a
// composition is over budget it sheds DETAIL -- purpose clauses, then exact
// ids, then sentence trim -- and never a family: a family dropped to save
// tokens is an agent taught that a capability does not exist.
//
// THE SETTING IS REAL. agent.tool_summary (config/settings-registry.json,
// default on) is read through src/lib/settings.js with its provenance rules;
// off means briefToolSummary() answers { enabled: false, text: null } and the
// caller injects nothing. This module is the row's named enforcer.
//
// FAIL CLOSED TO SILENCE, NEVER TO A WRONG NOTE. An unreadable registry, an
// unrecognised tier, or an empty surface produces no note and a named code. A
// session must never fail to start over its own introduction, and an agent
// must never be handed a note about a surface nobody measured.

const TOOL_SUMMARY_SETTING_ID = 'agent.tool_summary';
const DEFAULT_BUDGET_TOKENS = 450;

// Required lazily. The tool registry pulls in every provider; a caller asking
// only whether the setting is on has no reason to pay for that.
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

/* The ids an agent reaches for constantly -- the ones the owner found himself
 * teaching by hand, session after session. Only the ones the level actually
 * offers are printed. */
const REACH_FOR = Object.freeze([
  ['agent_comms.send_local', 'message another agent on this tree'],
  ['memory.set', 'save a durable note'],
  ['memory.get', 'read one back'],
  ['memory.search', 'find saved notes'],
  ['web.search', 'search the public web'],
  ['web.fetch', 'read a page'],
  ['system.doctor', 'what is configured here'],
  ['settings.read', 'this installation\'s settings'],
  ['browser.playwright_tools', 'browser schemas and navigation help'],
  ['screen.status', 'your screen-access grant']
]);

/* One clause per family, attached when the budget allows. An absent entry is
 * not an absent family: unmapped families still appear by name. */
const FAMILY_PURPOSES = Object.freeze({
  memory: 'durable notes',
  agent_comms: 'agent-to-agent messages',
  web: 'public web search and fetch',
  screen: 'use the screen, mouse and keyboard with temporary access',
  window: 'list and focus windows',
  task: 'the durable task queue',
  system: 'status, notifications, credential requests',
  owner_prompts: 'guarded owner-input forms',
  owner_forms: 'the forms\' public directions',
  payment_method: 'guarded card record',
  pay: 'the capped spend ledger',
  purchase: 'the owner\'s shopping list',
  browser: 'the product-owned browser',
  http: 'allowlisted HTTPS requests',
  sandbox: 'disposable work sandboxes',
  research: 'the research pipeline',
  r_ledger: 'the person\'s standing rules (propose or file one only when they allow it)',
  ledger: 'read saved rules, tasks, asks and answers, and purchase records',
  t_ledger: 'file, complete or remove task records; read them with ledger.read',
  a_ledger: 'file or settle durable asks; check answers with ledger.read',
  p_ledger: 'settle purchase records; records do not grant spend permission',
  scheduler: 'recurring scheduled actions',
  model: 'bounded model completions',
  search: 'the local search index',
  audit: 'the local audit ledger',
  calendar: 'Google Calendar',
  personal_calendar: 'the personal calendar',
  gmail: 'Gmail',
  drive: 'Google Drive',
  github: 'GitHub',
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

function compose({ tierName, readOnly, allowed, allowedSet, families, absentFamilies, credentialWithheld, agentApiOn, level, packed = false }) {
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

  const keyFamilies = new Set(['memory', 'agent_comms', 'web', 'system', 'owner_prompts', 'task']);
  const familyNames = [...families.keys()].sort();
  const familyLine = familyNames.map(family => {
    const purpose = FAMILY_PURPOSES[family];
    if (level >= 2 && purpose) return `${family} (${purpose})`;
    if (level >= 1 && purpose && keyFamilies.has(family)) return `${family} (${purpose})`;
    return family;
  }).join(', ');
  lines.push(`Tool families here: ${familyLine}.`);

  /* THE LINE NAMES THE STORES IT IS NOT, BECAUSE THAT IS THE HALF THAT FAILED.
   *
   * A live pre-beta report, 2026-08-25: agents "come back having used Google's
   * or Windows' credential manager instead of ours." The previous line said
   * where secrets live and how to ask for one, and never said what NOT to
   * reach for -- and an agent that has three plausible credential stores in
   * front of it and no steer picks the one it has seen most often, which is
   * never ours. So the two wrong stores are named by name.
   *
   * IT RIDES AT EVERY LEVEL THIS LINE EXISTS AT (level >= 0), and it was
   * costed to keep it there. Measured against today's surface: this line is 56
   * estimated tokens against the 53 it replaced, and the Standard note -- the
   * tightest of the three, 443 tokens against a 450 budget -- lands at 446 and
   * stays at the same detail level it was at before. If a later lane's new
   * family does push Standard down a level, the shedding contract still holds
   * for the part that matters: detail around this line goes, this line does
   * not. Do not spend the remaining headroom without re-measuring
   * tests/agent-tool-summary.test.js's per-level token report. */
  if (allowedSet.has('system.credential_request') && level >= 0) {
    lines.push('Credentials: the owner\'s encrypted vault, not Windows\' or Google\'s manager, is the only store ToolsEnabled tools read; values are never shown to you. Add or update one: owner_forms.describe, then system.credential_request.');
  }

  const withheld = [];
  if (credentialWithheld) {
    withheld.push('asking for or storing credentials (system.credential_request and the vault-writing tools start at the Standard level)');
  }
  if (readOnly) {
    withheld.push('every tool that changes anything -- this toolkit only reads');
  }
  if (absentFamilies.length > 0) {
    withheld.push(`the ${absentFamilies.join(', ')} ${absentFamilies.length === 1 ? 'family' : 'families'}`);
  }
  lines.push(withheld.length === 0
    ? 'Not at this level: nothing -- every registered tool is offered.'
    : `Not at this level: ${withheld.join('; ')}.`);

  /* PACKED COMPRESSES THIS SENTENCE, IT NEVER DROPS IT. The full sentence
   * carries two halves an agent needs, and this module's own review history
   * (evidence/controller5-tool-summary-review-20260908/REVIEW.md, Finding 2)
   * found that this line is the ONLY copy of that guidance actually delivered
   * to an agent anywhere in the codebase -- tests/mcp-initialize-instructions
   * .test.js proves this text is handed to a real agent verbatim as the MCP
   * `initialize` handshake's `instructions` field, so there is no other place
   * a session that hits `packed` mode can learn either half from:
   *   (a) a missing tool is a deliberate permission-level choice, not a bug;
   *   (b) the person can go change the level in Settings.
   * An earlier version of this fix dropped the line outright under packed
   * mode to buy back tokens. That was a guidance loss, not a harmless trim --
   * so packed instead emits a compressed form that keeps both halves in
   * roughly a third of the tokens. Every family name still lives on the
   * "Tool families here" / "Not at this level" lines above, which `packed`
   * never touches: the budget contract sheds detail, never a family, and
   * now never this sentence's two facts either, all the way to the last
   * token. */
  lines.push(packed
    ? 'Missing tools: permissions; change in Settings.'
    : (level >= 0
      ? 'If a tool you expect is not offered, this permission level withholds it: say so plainly instead of looking for another route. The person can change the level in Settings.'
      : 'If a tool is not offered here, say so; the person can change the level in Settings.'));

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
  env
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
    /* THE DENOMINATOR IS A FACT ABOUT THE BUILD, NOT ABOUT THIS PROCESS.
     *
     * THE DEFECT THIS CLOSES, measured 2026-08-25 inside a generated MCP server
     * process. `total` used to default to registeredTools(), and that call
     * applies TOOLSENABLED_TOOL_ALLOWLIST -- a process-global environment
     * variable the server sets to the tier's own catalogue. So in the server
     * the denominator WAS the numerator: registeredTools() returned 106, not
     * 268, and `system.credential_request` was not among them.
     *
     * The consequence was silent and it was the worst available one. `withheld`
     * came out empty and `credentialWithheld` came out false -- because the
     * totals set did not carry the name either -- so a GUIDED install served:
     *
     *   "Not at this level: every tool that changes anything -- this toolkit
     *    only reads."
     *
     * where the truth is:
     *
     *   "Not at this level: asking for or storing credentials
     *    (system.credential_request and the vault-writing tools start at the
     *    Standard level); every tool that changes anything ...; the agent,
     *    clipboard, code, http, owner_host, r_ledger, repo, sound, stripe, tts,
     *    workspace families."
     *
     * The dropped sentence is the one this module's own header says it exists
     * for -- the first outside user whose agents "weren't able to use
     * credential manager or vault". A note that silently stops naming the
     * withheld credential tool is this file's founding failure, reinstated.
     *
     * TWO DIFFERENT QUESTIONS, AND ONLY ONE OF THEM IS ABOUT THIS PROCESS.
     * The NUMERATOR is "what does this session actually offer", and it must
     * stay narrowed: tool-registry.js states that an operator's env filter may
     * legitimately be NARROWER than the tier ("the tier is a ceiling over
     * whatever survives it"), and a note naming tools this process refuses
     * would be the same lie pointed the other way. The DENOMINATOR is "what
     * does this product have", which no process-local filter can change. So
     * `registered` still feeds the numerator below and TOOL_REGISTRY feeds the
     * total.
     *
     * An explicit `totalNames` still wins, unchanged -- that is the seam the
     * tests and any caller holding a better answer already use. */
    total = Array.isArray(totalNames)
      ? totalNames.slice()
      : toolRegistryModule().TOOL_REGISTRY.map(tool => tool.name);
    const declared = allowedNames === undefined ? machineRecordModule().tierToolAllowlist(validated) : allowedNames;
    /* A null allowlist means "no configured narrowing", which has never meant
     * "every registered name works here": the Full tier still refuses the
     * fra-only tools (workspace.list/read work only between connected
     * computers). Derive the offered set through the same policy the
     * dispatcher enforces, so this note cannot advertise a tool the session
     * would refuse -- the exact silence-reads-as-capability shape this module
     * exists to end. */
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
  const credentialWithheld = totalSet.has('system.credential_request') && !allowedSet.has('system.credential_request');
  const readOnly = session.profile === 'read-only';
  /* Read once, here, rather than inside compose(): the note is composed up to
     four times while it sheds detail, and a settings read per composition would
     make the note's own cost depend on how long it took to fit. An unreadable
     settings layer is not evidence for either built-in-tools clause, so it
     refuses the note below rather than converting the failed read to false. */
  const agentApiOn = measuredAgentApiEnabled({ valuesPath, env });
  if (agentApiOn === null) return refusal('TOOL_SUMMARY_AGENT_API_UNAVAILABLE');

  const shape = {
    tierName: TIER_NAMES[validated] || validated,
    readOnly,
    allowed,
    allowedSet,
    families,
    absentFamilies,
    credentialWithheld,
    agentApiOn
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
