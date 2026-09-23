// EXECUTABLE CHANGE — testcanfail-tests-agent-tool-summary-test-js
//
// CAN-FAIL REPORT
// - Strengthened testGuidedNamesOnlyOfferedTools's collection assertion. The
//   assertion loop previously executed zero times if the produced present
//   section contained no registered tool ids. Mutation intended: make compose()
//   omit all registered ids from that section. RED output: NOT OBSERVED because
//   the required Node >=22.19 runtime is unavailable (named below).
// - Strengthened testEveryFamilySurvivesTheBudget's collection assertion. Its
//   loop previously executed zero times if Standard's allowlist became empty.
//   Mutation intended: make tierToolAllowlist('standard') return []. RED output:
//   NOT OBSERVED because the required Node >=22.19 runtime is unavailable.
// - NOT-FOUND (2): no exit-status or truthy-process-return assertion exists.
// - NOT-FOUND (3): no optional chain swallows a failure; the outer finally only
//   performs cleanup, and its nested catch can suppress cleanup failure only.
// - NOT-FOUND (4): this file installs no mocks.
// - NOT-FOUND (5): this file contains no skip or platform precondition guard.
// - NOT-FOUND (6): no expected product value is computed by the same product
//   code; the local token estimator is intentionally independent of the module.
// - UNMET PRECONDITION: the installed Node is v20.20.2 and cannot load
//   node:sqlite. `node tests/agent-tool-summary.test.js` therefore stopped with
//   `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite`.
//   Fetching Node 22 was blocked by HTTP 403 from both npm and nodejs.org, so no
//   mutation RED or restored GREEN run could honestly be quoted.

'use strict';

// THE STANDARD TOOL NOTE EVERY PRODUCT AGENT IS HANDED, PROVED AGAINST THE
// MEASURED SURFACE RATHER THAN AGAINST ITSELF.
//
// The owner's requirement, verbatim: "i have to tell agents what tools are
// called and what to do and to use this or that tool etc. so thats really hard
// on a user. We should have a really short standard file that just shares
// exactly what exists - we dont wat to eat tokens but they need to knoiw. We
// can give a specific setting to disable this but it should be standard."
//
// Three properties, each of which has already failed somewhere in this
// repository when left unproved:
//
//   TRUTH    the note may only name tools the level actually offers, and its
//            "not at this level" clause may only name tools the level actually
//            withholds. The ground truth is machine-record.tierToolAllowlist,
//            the same derivation the generated MCP configuration is written
//            from -- so the note and the servers cannot disagree.
//   BUDGET   the note is bounded in tokens, and when it is over budget it
//            sheds DETAIL, never a whole family. A family silently dropped is
//            an agent taught that a capability does not exist.
//   SETTING  agent.tool_summary off means no note at all, proven by reading a
//            settings file this test wrote -- not by trusting a default.

const assert = require('node:assert');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

// A scratch state root BEFORE the first src/lib require, per the standing
// trap: state modules decide their root at first require.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-summary-test-'));
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state');
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true });

const summaryModule = require('../src/lib/agent-tool-summary');
const machineRecord = require('../src/lib/setup/machine-record');
const { registeredTools } = require('../src/lib/tool-registry');

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// The names a tool id is made of, so an assertion can find "system.credential_request"
// as a whole id and not as a substring of something else.
function namesIn(text) {
  return new Set(text.match(/[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+/g) || []);
}

function testGuidedNamesOnlyOfferedTools() {
  console.log('🧪 The Guided note names only tools Guided actually offers...');
  const allowed = machineRecord.tierToolAllowlist('guided');
  const total = registeredTools().map(tool => tool.name);
  const reading = summaryModule.briefToolSummary({
    tier: 'guided', allowedNames: allowed, totalNames: total, enabled: true,
  });
  assert.equal(reading.enabled, true);
  assert.equal(typeof reading.text, 'string');
  const allowedSet = new Set(allowed);
  const totalSet = new Set(total);
  const absentSection = reading.text.slice(reading.text.indexOf('Not at this level'));
  const presentSection = reading.text.slice(0, reading.text.indexOf('Not at this level'));
  const presentToolNames = [...namesIn(presentSection)].filter(name => totalSet.has(name));
  assert.ok(presentToolNames.length > 0,
    'the Guided present section names no registered tool ids, so its truth cannot be checked');
  for (const name of presentToolNames) {
    assert.ok(allowedSet.has(name),
      `the note offers "${name}" which Guided does not carry -- the note is lying in the dangerous direction`);
  }
  // The friend's exact confusion, killed at the source: the read-only level
  // SAYS it has no credential requester, by name, and says where that starts.
  assert.ok(!allowedSet.has('system.credential_request'),
    'precondition: Guided must not carry system.credential_request or this test asserts nothing');
  assert.ok(namesIn(absentSection).has('system.credential_request'),
    'the Guided note does not tell the agent that credential requests are withheld at this level');
  assert.match(reading.text, /read[- ]only/i,
    'the Guided note does not say the toolkit is read-only');
  console.log(`  ✅ Guided note: ${reading.estimatedTokens} tokens, names only offered tools, absence clause present.`);
}

function testStandardCarriesCredentialFlow() {
  console.log('🧪 The Standard note teaches the credential flow it actually has...');
  const allowed = machineRecord.tierToolAllowlist('standard');
  const total = registeredTools().map(tool => tool.name);
  const reading = summaryModule.briefToolSummary({
    tier: 'standard', allowedNames: allowed, totalNames: total, enabled: true,
  });
  assert.ok(new Set(allowed).has('system.credential_request'),
    'precondition: Standard must carry system.credential_request');
  const named = namesIn(reading.text);
  assert.ok(named.has('system.credential_request'),
    'the Standard note never names the credential requester the level carries');
  assert.ok(named.has('agent_comms.send_local'),
    'the Standard note never names the local messenger, the tool the owner most has to teach by hand');
  assert.ok(named.has('memory.set') && named.has('memory.get'),
    'the Standard note never names the memory basics');
  console.log(`  ✅ Standard note: ${reading.estimatedTokens} tokens, credential flow and reach-for ids present.`);
}

function testEveryFamilySurvivesTheBudget() {
  console.log('🧪 Over budget the note sheds detail, never a family...');
  const allowed = machineRecord.tierToolAllowlist('standard');
  const total = registeredTools().map(tool => tool.name);
  const roomy = summaryModule.briefToolSummary({
    tier: 'standard', allowedNames: allowed, totalNames: total, enabled: true, budgetTokens: 100000,
  });
  const tight = summaryModule.briefToolSummary({
    tier: 'standard', allowedNames: allowed, totalNames: total, enabled: true, budgetTokens: 220,
  });
  assert.ok(estimateTokens(tight.text) <= 220,
    `the tight note is ${estimateTokens(tight.text)} tokens against a budget of 220 -- the budget is not enforced`);
  assert.match(tight.text, /Native tools \(children too\): unmeasured/,
    'budget trimming must retain uncertainty about provider-native child tools');
  assert.match(tight.text, /ToolsEnabled execution: sandbox\.exec in a leased sandbox/);
  const families = new Set(allowed.map(name => name.split('.')[0]));
  assert.ok(families.size > 0,
    'precondition: Standard must carry at least one tool family or the family-survival assertions execute zero times');
  for (const family of families) {
    assert.ok(tight.text.includes(family),
      `the family "${family}" vanished from the note under budget pressure -- shedding must drop detail, not families`);
  }
  assert.ok(estimateTokens(roomy.text) >= estimateTokens(tight.text),
    'a tighter budget produced a longer note');
  // FINDING 2, evidence/controller5-tool-summary-review-20260908/REVIEW.md:
  // this is the ONLY place an agent is ever told (a) that a missing tool is a
  // deliberate permission-level choice, not a bug, and (b) that the person can
  // change the level in Settings -- tests/mcp-initialize-instructions.test.js
  // proves this exact text is what a real agent receives as the MCP
  // `initialize` handshake's `instructions` field. Packed mode (engaged here,
  // since Standard's floor composition does not fit a 220-token budget
  // unpacked) must compress that guidance, never drop it. Matched on stable
  // words rather than the exact sentence, since packed's phrasing differs from
  // the unpacked sentence by design.
  assert.equal(tight.detailLevel, -1,
    'precondition: this assertion only proves something if the floor level actually ran');
  assert.match(tight.text, /permission/i,
    'the packed note lost the "missing tool = permission-level choice" guidance -- a real regression, not a cosmetic trim');
  assert.match(tight.text, /Settings/,
    'the packed note lost the pointer telling the person they can change the level in Settings');
  console.log(`  ✅ roomy ${estimateTokens(roomy.text)} tokens -> tight ${estimateTokens(tight.text)} tokens, all ${families.size} families intact, permission/Settings guidance survives packing.`);
}

function testDefaultBudgetIsAFewHundredTokens() {
  console.log('🧪 The default note is token-lean at every level...');
  const total = registeredTools().map(tool => tool.name);
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const allowed = machineRecord.tierToolAllowlist(tier) || total;
    const reading = summaryModule.briefToolSummary({ tier, allowedNames: allowed, totalNames: total, enabled: true });
    const tokens = estimateTokens(reading.text);
    assert.ok(tokens <= summaryModule.DEFAULT_BUDGET_TOKENS,
      `${tier}: ${tokens} tokens exceeds the default budget of ${summaryModule.DEFAULT_BUDGET_TOKENS}`);
    assert.equal(reading.estimatedTokens, tokens, `${tier}: the reported estimate disagrees with the text`);
    console.log(`  ${tier}: ${tokens} tokens (${allowed.length} of ${total.length} tools)`);
  }
  console.log('  ✅ every level fits the default budget.');
}

function testSettingOffMeansNoNote() {
  console.log('🧪 agent.tool_summary off means no note, read from a real settings file...');
  const servicesRoot = path.join(SCRATCH, 'local', 'ToolsEnabled');
  fs.mkdirSync(servicesRoot, { recursive: true });
  const valuesPath = path.join(servicesRoot, 'settings.json');

  // Off, by the person: the note must not be produced.
  fs.writeFileSync(valuesPath, JSON.stringify({
    revision: 1,
    values: { 'agent.tool_summary': false },
    provenance: { 'agent.tool_summary': { source: 'user', atMs: Date.now() } },
  }, null, 2), 'utf8');
  const off = summaryModule.briefToolSummary({
    tier: 'standard', allowedNames: ['memory.get'], totalNames: ['memory.get'], valuesPath,
  });
  assert.equal(off.enabled, false, 'the note was produced with the setting off');
  assert.equal(off.text, null, 'the disabled reading still carries text');

  // On, by the person: produced.
  fs.writeFileSync(valuesPath, JSON.stringify({
    revision: 2,
    values: { 'agent.tool_summary': true },
    provenance: { 'agent.tool_summary': { source: 'user', atMs: Date.now() } },
  }, null, 2), 'utf8');
  const on = summaryModule.briefToolSummary({
    tier: 'standard', allowedNames: ['memory.get'], totalNames: ['memory.get'], valuesPath,
  });
  assert.equal(on.enabled, true);
  assert.equal(typeof on.text, 'string');

  // Absent file: the registry default (true) decides, which is "standard" in
  // the owner's words.
  fs.rmSync(valuesPath);
  const absent = summaryModule.briefToolSummary({
    tier: 'standard', allowedNames: ['memory.get'], totalNames: ['memory.get'], valuesPath,
  });
  assert.equal(absent.enabled, true, 'with no settings file the default-on registry row must decide');
  console.log('  ✅ off -> no note; on -> note; absent -> the default-on row decides.');
}

function testRegistryRowIsDeclaredAndEnforced() {
  console.log('🧪 The setting is a real registry row that names its enforcer...');
  const registry = require('../src/lib/settings-registry').loadRegistry();
  const entry = registry.byId.get(summaryModule.TOOL_SUMMARY_SETTING_ID);
  assert.ok(entry, `"${summaryModule.TOOL_SUMMARY_SETTING_ID}" is not in the settings registry -- a control with no row is a lie`);
  assert.equal(entry.control, 'toggle');
  assert.equal(entry.default, true, 'the owner said it should be standard, which is default on');
  assert.ok(typeof entry.enforcedBy === 'string' && entry.enforcedBy.includes('agent-tool-summary'),
    'the row does not name src/lib/agent-tool-summary.js as its enforcer');
  console.log('  ✅ row present, toggle, default on, enforcer named.');
}

function testUseToolsEnabledConventionRides() {
  console.log('🧪 The note carries the "use ToolsEnabled" convention at every level\'s default note...');
  // The owner's ask, verbatim: "make sure the agents know when the user says
  // that they should dive into our program". The user-side half is the setup
  // card's tip ("ask the agent to use ToolsEnabled!"); this is the agent-side
  // half, and it rides the SAME note the session already gets -- one line,
  // inside the same token budget, never a second injection.
  const total = registeredTools().map(tool => tool.name);
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const allowed = machineRecord.tierToolAllowlist(tier) || total;
    const reading = summaryModule.briefToolSummary({ tier, allowedNames: allowed, totalNames: total, enabled: true });
    assert.ok(reading.text.includes('"use ToolsEnabled"'),
      `${tier}: the note never tells the agent what "use ToolsEnabled" means, so the person's convention falls on deaf ears`);
    assert.ok(estimateTokens(reading.text) <= summaryModule.DEFAULT_BUDGET_TOKENS,
      `${tier}: the convention line pushed the note over its own budget`);
  }
  // Under hard budget pressure the line sheds WITH THE OTHER DETAIL -- the
  // budget stays enforced (testEveryFamilySurvivesTheBudget) and a minimal
  // note is still a true note. What must never happen is the line costing a
  // family its place.
  console.log('  ✅ the convention line rides the default note at every level, inside budget.');
}

function testUnknownTierFailsClosedToNoNote() {
  console.log('🧪 A tier this module does not recognise produces no note rather than a wrong one...');
  const reading = summaryModule.briefToolSummary({
    tier: 'week-old-nonsense', allowedNames: ['memory.get'], totalNames: ['memory.get'], enabled: true,
  });
  assert.equal(reading.enabled, false);
  assert.equal(reading.text, null);
  assert.ok(typeof reading.code === 'string' && reading.code.length > 0, 'the refusal carries no code');
  console.log('  ✅ unknown level -> no note, named refusal.');
}

function testBusyPolicyLoadIsNotReportedOrLatchedAsUnknown() {
  console.log('🧪 A busy policy load stays could-not-tell and is retried...');
  const originalLoad = Module._load;
  let failedOnce = false;
  try {
    Module._load = function(request, parent, isMain) {
      if (!failedOnce && request === './permission-tier-policy'
          && parent && /agent-tool-summary\.js$/.test(parent.filename)) {
        failedOnce = true;
        const error = new Error('file table temporarily busy');
        error.code = 'EMFILE';
        throw error;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const unavailable = summaryModule.briefToolSummary({
      tier: 'standard', allowedNames: ['memory.get'], totalNames: ['memory.get'], enabled: true,
    });
    assert.equal(unavailable.code, 'TOOL_SUMMARY_TIER_UNAVAILABLE');
    assert.match(unavailable.reason, /not a claim.*absent or unknown/i);

    const retried = summaryModule.briefToolSummary({
      tier: 'standard', allowedNames: ['memory.get'], totalNames: ['memory.get'], enabled: true,
    });
    assert.equal(retried.enabled, true,
      'the transient could-not-tell result was latched instead of retrying the policy load');

    // CONTROL: successful CommonJS loads retain their legitimate cache. A fix
    // that disables all caching would pass the retry assertion at needless cost.
    const policyPath = require.resolve('../src/lib/permission-tier-policy');
    const cachedPolicy = require.cache[policyPath] && require.cache[policyPath].exports;
    assert.ok(cachedPolicy, 'the successful retry did not populate the normal module cache');
    assert.strictEqual(require('../src/lib/permission-tier-policy'), cachedPolicy,
      'the successful policy module was not reused from the legitimate require cache');
  } finally {
    Module._load = originalLoad;
  }
  console.log('  ✅ EMFILE -> unavailable, retry -> note, successful module -> cached.');
}

/* THE DENOMINATOR MUST SURVIVE A PROCESS-GLOBAL TOOL ALLOWLIST.
 *
 * This is the mutation the rest of this suite could not catch, and the reason
 * it could not is worth stating: every other test here runs in a process with
 * no TOOLSENABLED_TOOL_ALLOWLIST, so the narrowed and un-narrowed registry
 * reads return the same 268 names and the bug is invisible. Inside a generated
 * MCP server -- which sets that variable to the tier's own catalogue -- they
 * differ, the denominator collapses onto the numerator, and the note stops
 * naming anything as withheld. Both sides look self-consistent, which is
 * exactly why it shipped.
 *
 * Measured 2026-08-25 on a guided catalogue: registeredTools() answered 106
 * with the variable set and 268 without it, and system.credential_request was
 * absent from the 106.
 *
 * The variable is read per call by tool-registry.js parseToolAllowlist()
 * (its default argument is process.env[...]), with no caching anywhere, so
 * setting it here reproduces the server's condition exactly without a child
 * process. It is restored in a finally, because a leaked allowlist would
 * silently narrow every test that runs after this one. */
function testDenominatorSurvivesAProcessAllowlist() {
  console.log('🧪 The withheld clause survives a process-global tool allowlist...');
  const registry = require('../src/lib/tool-registry');
  const machineRecord = require('../src/lib/setup/machine-record');
  const previous = process.env[registry.TOOL_ALLOWLIST_ENV];
  try {
    const catalogue = machineRecord.tierToolAllowlist('guided');
    process.env[registry.TOOL_ALLOWLIST_ENV] = catalogue.join(',');

    // The precondition. If this ever stops being true the test below proves
    // nothing, so it is asserted rather than assumed.
    const narrowed = registry.registeredTools().map(tool => tool.name);
    assert.ok(narrowed.length < registry.TOOL_REGISTRY.length,
      'precondition failed: the allowlist did not narrow registeredTools(), so this test cannot detect the defect');
    assert.ok(!narrowed.includes('system.credential_request'),
      'precondition failed: the guided catalogue is expected to withhold system.credential_request');

    const reading = summaryModule.briefToolSummary({ tier: 'guided', allowedNames: narrowed, enabled: true });
    assert.equal(reading.enabled, true, 'the note must still be produced');
    assert.equal(reading.totalCount, registry.TOOL_REGISTRY.length,
      'the denominator came from the narrowed registry: the note is describing this PROCESS, not this PRODUCT');
    assert.ok(reading.totalCount > reading.allowedCount,
      'denominator collapsed onto the numerator, so nothing can read as withheld');
    assert.ok(reading.text.includes('system.credential_request'),
      'the withheld credential tool went unnamed -- the exact failure this module was written for');
    assert.ok(/Not at this level:/.test(reading.text) && !/Not at this level: nothing/.test(reading.text),
      'the note claimed nothing is withheld while withholding 162 tools');
  } finally {
    if (previous === undefined) delete process.env[registry.TOOL_ALLOWLIST_ENV];
    else process.env[registry.TOOL_ALLOWLIST_ENV] = previous;
  }
  console.log('  ✅ denominator is the whole registry, credential tool still named as withheld.');
}

try {
  testGuidedNamesOnlyOfferedTools();
  testStandardCarriesCredentialFlow();
  testEveryFamilySurvivesTheBudget();
  testDefaultBudgetIsAFewHundredTokens();
  testSettingOffMeansNoNote();
  testRegistryRowIsDeclaredAndEnforced();
  testUseToolsEnabledConventionRides();
  testUnknownTierFailsClosedToNoNote();
  testBusyPolicyLoadIsNotReportedOrLatchedAsUnknown();
  testDenominatorSurvivesAProcessAllowlist();
  console.log('\n✅ agent-tool-summary: all tests passed');
} finally {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5 }); } catch { /* scratch outlives the run */ }
}
