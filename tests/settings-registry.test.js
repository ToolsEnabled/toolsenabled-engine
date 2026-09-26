// EXECUTABLE CHANGE
'use strict';

/* Test-can-fail report (testcanfail-tests-settings-registry-test-js)
 *
 * MUTATIONS AND RED EVIDENCE
 * - Made loadRegistry() return an empty entries array. Before this change, the
 *   schema walk, unique-id check, and shipped-explanation check stayed green.
 *   With the new population assertions they report:
 *     "AssertionError: the registry is empty; no entries were schema checked"
 *     "AssertionError: the registry is empty; no ids were checked for duplicates"
 *     "AssertionError: the registry is empty; no explanations were checked"
 * - Filtered every depth-4 entry out of loadRegistry()'s result. The warning
 *   walk formerly stayed green; it now reports:
 *     "AssertionError: no depth-4 entries were checked for warning text"
 * - Filtered every seg/select entry out of loadRegistry()'s result. The options
 *   walk formerly stayed green; it now reports:
 *     "AssertionError: no seg or select controls were checked"
 * - Filtered every toggle entry out of loadRegistry()'s result. The boolean
 *   default walk formerly stayed green; it now reports:
 *     "AssertionError: no toggle controls were checked"
 *
 * NOT-FOUND: exit-status/truthy-return assertions; swallowed failures via
 * try/catch or optional chaining; assertions against a mock of the subject;
 * file-wide skips or platform precondition guards; expected values computed by
 * the same subject code. PRECONDITIONS: none unmet. After every mutation,
 * src/lib/settings-registry.js was restored byte-for-byte. The restored run is
 * green: "# pass 13", "# fail 0".
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadRegistry, validateEntry, validateExternalStep,
  explanationDeclared, unexplainedIds, externalStepIds, externalStepFor,
} = require('../src/lib/settings-registry');

test('the registry entries satisfy the pinned schema', () => {
  const { entries } = loadRegistry();
  const required = ['id', 'section', 'depth', 'control', 'default', 'consequence', 'derivedFrom', 'enforcedBy'];

  assert.ok(entries.length > 0, 'the registry is empty; no entries were schema checked');
  for (const entry of entries) {
    for (const field of required) assert.ok(Object.hasOwn(entry, field), `${entry.id} lacks ${field}`);
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.section, 'string');
    assert.equal(typeof entry.depth, 'number');
    assert.equal(typeof entry.control, 'string');
    assert.equal(typeof entry.consequence, 'string');
    assert.equal(typeof entry.derivedFrom, 'string');
    assert.equal(typeof entry.enforcedBy, 'string');
    assert.deepEqual(validateEntry(entry), { ok: true, errors: [] }, entry.id);
  }
});

test('ids are unique', () => {
  const { entries } = loadRegistry();
  assert.ok(entries.length > 0, 'the registry is empty; no ids were checked for duplicates');
  const seen = new Set();
  const duplicates = entries.map(({ id }) => id).filter((id) => seen.has(id) || !seen.add(id));
  assert.deepEqual(duplicates, []);
});

test('depth-4 entries carry warning text', () => {
  const { entries } = loadRegistry();
  const depthFourEntries = entries.filter(({ depth }) => depth === 4);
  assert.ok(depthFourEntries.length > 0, 'no depth-4 entries were checked for warning text');
  for (const entry of depthFourEntries) {
    assert.equal(typeof entry.warningText, 'string');
    assert.notEqual(entry.warningText.trim(), '');
  }
});

test('seg and select controls have options containing their defaults', () => {
  const { entries } = loadRegistry();
  const optionControls = entries.filter(({ control }) => control === 'seg' || control === 'select');
  assert.ok(optionControls.length > 0, 'no seg or select controls were checked');
  for (const entry of optionControls) {
    assert.ok(Array.isArray(entry.options) && entry.options.length > 0, entry.id);
    assert.ok(entry.options.includes(entry.default), entry.id);
  }
});

test('toggle defaults are booleans', () => {
  const { entries } = loadRegistry();
  const toggles = entries.filter(({ control }) => control === 'toggle');
  assert.ok(toggles.length > 0, 'no toggle controls were checked');
  for (const entry of toggles) {
    assert.equal(typeof entry.default, 'boolean', entry.id);
  }
});

test('the registry has the required size and depth histogram after customer model settings', () => {
  const { entries } = loadRegistry();
  const histogram = entries.reduce((counts, { depth }) => {
    counts[depth] = (counts[depth] || 0) + 1;
    return counts;
  }, {});

  // R1221 adds worker reset to the document's 34 entries and 7/14/11/2 histogram,
  // taking it to 35 entries at 7/15/11/2. Product rule (machine
  // A / machine B questions must not surface; record them as user settings)
  // adds three machines.* rows (mode at depth 2, transport and
  // peers at depth 3), taking it to 38 entries at 7/16/13/2. The same-day
  // directive behind ide-session-consent.js (sessions that are not native are
  // imported only when the person chooses to, never shown automatically)
  // adds ide.imported_surfaces (depth 2) and ide.available_surfaces (depth 3),
  // taking it to 40 entries at 7/17/14/2. R1228 then adds the four customer
  // model controls -- model.provider (depth 1), model.endpoint and model.name
  // (depth 2), model.api_key (depth 3) -- taking it to 44 at 8/19/15/2.
  // Product rule, answering the two questions the two-path agent
  // connection work escalated (each is a user setting; what an agent does when
  // it needs to ask a question is a user preference),
  // adds ide.attach_mode (depth 2, what happens to an editor session when it is
  // brought into the tree: watch / take over / branch), agent.blocked_question
  // (depth 1, what an agent does when it must ask: stop / other work / decide)
  // and agent.blocked_question_per_node (depth 3, whether a single node may
  // answer that differently), taking it to 47 at 9/20/16/2.
  // Product rule (agents must read the owner's authorization
  // clearly from settings: act under their authorized name, with only a short
  // reserved list, such as accepting the purchase list and pressing post on a
  // social post, left waiting on them) adds the two
  // rows that make acting-as-the-user a setting instead of something agents
  // re-derive from conversation: outward.identity_authorization (depth 1,
  // whether assistants may act as you at all) and outward.reserved_from_agents
  // (depth 1, the list of things they must still hand back to you). Both are
  // depth 1 because they are the first thing a new user has to decide about
  // agents using their name, taking it to 49 at 11/20/16/2.
  // R1232 (instead of relying on agents to check status such as usage and CPU,
  // push it to them occasionally as data in a prompt, as an opt-in setting,
  // possibly per node) adds agent.status_injection
  // (depth 1, the owner-opt-in toggle, default off so absence is never
  // consent) and agent.status_injection_overrides (depth 3, the per-node
  // exception list), taking it to 51 at 12/20/17/2.
  // R1246 (unified honest retrieval) adds the five controls that decide whether
  // an assistant may look anything up before it starts, and in what:
  // retrieval.unified_search (depth 1, the master switch, default off so
  // absence is never consent), retrieval.search_documents,
  // retrieval.search_request_ledger and retrieval.search_coordination_board
  // (depth 2, one per knowledge source, because the owner's own verbatims and
  // the agents' notes are separate decisions from project documents), and
  // retrieval.meaning_search (depth 3, the seam a meaning-matching backend
  // plugs into post-launch). Taking it to 56 at 13/23/18/2.
  // R1160 (per-project research enablement, not a single global switch) adds
  // the four controls that decide whether research projects may run work on
  // this computer at all: research.pipeline (depth 1, the master switch,
  // default off so absence is never consent) and research.runner_agent,
  // research.runner_process and research.runner_http (depth 2, one per kind of
  // work a job may do, because launching an assistant, running a program and
  // calling an outside service are three separate decisions). Taking it to 60
  // at 14/26/18/2.
  // The next three were added without extending this chain, so they are
  // reconstructed here rather than left as an unexplained jump: accounts.failover
  // (depth 2, what happens when an account stops answering) took it to 61 at
  // 14/27/18/2, which is the figure at HEAD; then startup.services_at_logon
  // (depth 1, whether this product's services start with Windows -- product
  // rule that it must not hijack a customer's machine beyond
  // at most one pass at system start) took it to 62 at 15/27/18/2, and
  // agent.blocking_prompt_gate (depth 1, whether an agent may stop and block on
  // a question) took it to 63 at 16/27/18/2. Those last two and both rows below
  // are uncommitted in this shared checkout; see the note in
  // settings-enforcement-honesty.test.js about what that means for the pin.
  // Product rule (the user decides, with a reasonable default:
  // time or number of events, with forever available, and the system load of
  // each choice stated clearly where it is set) adds audit.retention (depth 1: how
  // much of the audit record stays in the live ledger, as a number of events or
  // a span of time, with forever available and the load of each choice stated
  // where it is chosen). Depth 1 because it is the cost of the product's own
  // record-keeping and every user pays it. Taking it to 64 at 17/27/18/2.
  // Product rule (the setup and walkthrough belong in ToolsEnabled
  // settings) adds machines.direct_link_setup (depth 3:
  // preparing this computer for the cable to another of your own, carrying the
  // guided step for the parts that are physical -- the cable itself and the
  // fixed address on each end -- which no software can do for you). Depth 3 to
  // match machines.transport and machines.peers, the settings it sits between;
  // depth 4 is for settings that remove a safety property and this adds one.
  // Taking it to 65 at 17/27/19/2.
  // Product rule (a really short standard file that shares exactly
  // what exists, standard, with a setting that can disable it) adds
  // agent.tool_summary at depth 1
  // -- depth 1 because it is on by default for every agent this program starts,
  // not a sub-option of anything. Taking it to 62 at 15/27/18/2. The row is
  // enforced: src/lib/agent-tool-summary.js is its named enforcer and, since app
  // an earlier commit declared it in the manifest, that module is actually IN the
  // shipped payload -- before then it was named here and absent from the bytes.
  //
  // FOUND RED 2026-08-22: the two pins above (65 at 17/27/19/2, then 62 at
  // 15/27/18/2) were each written against a different lane's working tree and
  // neither matched the catalogue as committed (66 at 18/27/19/2 before this
  // change; tests/settings-enforcement-honesty.test.js records the same
  // finding). The O7 improvements (product rule: a user setting, default
  // off, nested below its parent) add rules.ask_when_unsure
  // at depth 3 directly under rules.capture_spoken -- a sub-option of that one
  // switch, enforced by the same module -- taking it to 67 at 18/27/20/2.
  // That is the live count; the two stale pairs were folded into this one.
  //
  // ADOPTING capability-recall (product decision to incorporate it)
  // adds agent.capability_recall at depth 1, directly after agent.tool_summary,
  // taking it to 68 at 19/27/20/2. Depth 1 and not a sub-option of the note
  // above it: the two are independent -- one is a session-start description of
  // the toolkit, the other is a per-message shortlist -- and either can be off
  // while the other is on. It is enforced: src/lib/capability-recall/index.js
  // reads the row before it opens the index, and tests/capability-recall.test.js
  // drives both sides of the switch.
  //
  // Telegram's removal also removed the product's outside-messaging route.
  // ask.away_channel (depth 2) and ask.agent_relay_fallback (depth 3) cannot
  // gate capabilities that no longer exist, taking the catalogue to 66.
  //
  // THE AGENT API (product rule, B9: a setting that decides whether
  // an agent may use its native tools or only ours, shipped on by default)
  // adds agent.agent_api at depth 1, directly after agent.tool_summary, taking
  // it to 67 at 20/26/19/2. Depth 1 and not a sub-option of the note above it,
  // for the same reason capability_recall is not: the note DESCRIBES the
  // toolkit at session start, this one DECIDES which toolkit exists, and either
  // can be off while the other is on. It is enforced on both spawn paths --
  // src/lib/agent-engine/claude-cli-adapter.js for an agent thread and
  // src/lib/mission-bridge/actions.js for a dispatched lane -- from one module,
  // src/lib/agent-api-policy.js, and tests/agent-api-policy.test.js drives both
  // sides of the switch through a real settings file.
  //
  // TOOL APPROVALS AS A PERSON'S OWN CHOICE (product rule: a person may set
  // their own settings to never ask and just proceed; tool approvals exist
  // mostly for newer AI users and businesses)
  // adds
  // agent.tool_approvals at depth 1, taking it to 68 at 21/26/19/2. Depth 1
  // because it decides whether this product interrupts its owner at all, which
  // is not a sub-option of anything above it. Until this row existed the only
  // ways to say "stop asking" were to hand-edit config/toolsenabled.policy.json
  // -- which the next install overwrites -- or to widen approvals.enabled or
  // approvals.externalWrites for EVERY installation, including the ones that
  // want the gate; that is why the 2026-08-27 directive was answered with a
  // single-action exception (approvals.autoApproveCloudLaunch) rather than an
  // answer. It ships ON, because someone new to agents should meet the question
  // before the consequence, and only an explicit `false` carrying user or
  // installer provenance opens the gate, so flipping a default in shipped JSON
  // cannot ungate a customer's machine. Enforced by src/lib/policy.js
  // requiresApproval() through approvalsTurnedOffByOwner().
  //
  // ONE LEDGER, APPROVED BEFORE IT COUNTS (product rule) adds
  // rules.agent_filed_needs_approval at depth 3 directly after
  // rules.ask_when_unsure -- a second sub-option of the one filing switch --
  // taking it to 69 at 21/26/20/2. Default off with the same three-rule read
  // (only the person's own true turns it on); enforced by
  // src/lib/owner-request-store.js, which files an agent's rule as 'proposed'
  // when it is on, and tests/r-ledger-agent-gate.test.js drives both sides.
  // RECOUNTED 2026-09-02 for OUTSIDE CONTROL (product rule: an
  // agent may touch the app's buttons from the outside, as a setting rather
  // than a standard): ONE depth-3 row, app.outside_control, shipped OFF and enforced
  // by src/lib/outside-control.js outsideControlPolicy() under the same
  // provenance rule as agent.tool_approvals.
  // Both 2026-09-02 rows landed together: 70 rows at 21/26/21/2.
  // RECOUNTED 2026-09-02 for THE SUBAGENT ROUTE (product rule:
  // an assistant may start another through the ToolsEnabled API as a non-tree
  // agent or as a full user-toggled agent, decided in settings): ONE depth-1 row,
  // agent.subagent_route, enforced by src/lib/agent-subagent-route.js
  // subagentRoute(). It sits BESIDE agent.agent_api rather than under it: that
  // row decides whether an assistant also keeps its own built-in tool for this,
  // and turning it off does not stop agent.spawn, so a nested row would have
  // been greyed out while it still decided something.
  //
  // Product rule (checks that slow agents down, such as the
  // message credential check, become user settings with sliders and a
  // reasonable default) adds
  // agent.message_screening at depth 1: how strictly a message between two
  // agents is screened for credentials, at Refuse look-alikes / Allow code
  // names / Off, shipped at the middle. Depth 1 because it decides whether a
  // message the person's agents meant to send is delivered at all, and the
  // measurement behind it is theirs: seven refusals in one day, every one a
  // message quoting this product's own error codes. Taking it to 72 at
  // 23/26/21/2.
  // 73: tools.throughput added 2026-09-03 (product rule: tool calls must not slow
  // down with a thousand assistants; fast/strict as a setting).
  // Local agent/tool defaults and Ollama runtime controls add six rows.
  // Product rule (any maximum must be user-configurable, with no
  // hidden fixed ceiling such as 64; expose the setting and distinguish user
  // choice from unavoidable provider/account limits) adds two rows at depth 4.
  // fleet.max_declared_agents (number, shipped 64) is the choice: how many
  // agents the declared organisation may LIST. It was a bare literal in
  // agent-org.js normalizeOrg with no constant, env var or config key, so the
  // only way past it was to edit the product and rebuild -- which made an
  // arbitrary validator bound look like an account limit from outside.
  // fleet.concurrency_limits (readback) is the counterpart the directive asks
  // for by name: the limits that actually decide how many run at once --
  // provider seats, concurrent starts, processor headroom -- shown where they
  // cannot be edited, because they are not ours to give. Both at depth 4:
  // raising the first without reading the second is precisely the mistake the
  // pair exists to prevent. Taking it to 81 at 23/31/23/4.
  // Tool mode, three scheduling/credential controls, scoped policy,
  // purchase approval, and Ask closure add seven enforced rows.
  // Optional activity summaries add one depth-1 choice; required audit remains enforced.
  // Agent message delivery adds two visible depth-1 controls.
  // Complete per-turn rules delivery adds one enforced depth-1 choice.
  // "Who adds standing rules" (rules.filing_from, product rule: the ledger
  // page only, the ledger page and /request, or agents as well, as today) adds
  // one depth-2 choice beside the switch it
  // supersedes; the two nested sub-settings keep their depth. 94 at 29/34/26/5.
  // "Letting agents edit ToolsEnabled source in checkouts"
  // (agent.product_source_writes: with tool sets on Only the host write fence
  // blocked every agent's checkout edit, so this became a switch in settings) adds one enforced depth-2 toggle beside
  // Available tool sets. 95 at 29/35/26/5.
  // an earlier change added two delegation controls. Basic setup adds two explicit
  // runtime switches and one diagnostic retention choice. Pin their identities
  // and depths as well as the old population: unrelated rows cannot satisfy
  // this count or silently replace an accepted control.
  // Task difficulty grading (each task carries one of three grades)
  // adds one depth-1 toggle, off by default.
  // Task-only delegation and the agent comms switch (agent comms ships
  // with its own on/off setting)
  // add two depth-1 toggles: task-only off and comms on by default.
  // Metrics history without the signed audit (kept behind its own
  // setting, on by default) adds one depth-1 toggle, on.
  const additions = { 'fleet.tree_width': 4, 'fleet.tree_depth': 4,
    'audit.enabled': 2, 'ledger.verify_history': 2, 'diagnostics.retention': 1,
    'agent.task_difficulty_enabled': 1, 'agent.task_only_delegation': 1, 'agent.comms_enabled': 1,
    'metrics.local_history': 1 };
  for (const [id, depth] of Object.entries(additions)) {
    assert.equal(entries.filter(entry => entry.id === id).length, 1, id);
    assert.equal(entries.find(entry => entry.id === id).depth, depth, id);
  }
  const earlier = entries.filter(entry => !Object.hasOwn(additions, entry.id));
  assert.equal(earlier.length, 95);
  assert.deepEqual(earlier.reduce((counts, { depth }) => { counts[depth] = (counts[depth] || 0) + 1; return counts; }, {}), { 1: 29, 2: 35, 3: 26, 4: 5 });
  assert.equal(entries.length, 104);
  assert.deepEqual(histogram, { 1: 34, 2: 37, 3: 26, 4: 7 });
});

test('loadRegistry rejects duplicate ids and invalid JSON', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const duplicatePath = path.join(directory, 'duplicate.json');
  const invalidPath = path.join(directory, 'invalid.json');
  const malformedTitlesPath = path.join(directory, 'malformed-titles.json');
  const entry = loadRegistry().entries[0];
  fs.writeFileSync(duplicatePath, JSON.stringify({ entries: [entry, entry] }));
  fs.writeFileSync(invalidPath, '{ definitely not JSON');
  fs.writeFileSync(malformedTitlesPath, JSON.stringify({ entries: [entry], titles: [] }));

  assert.throws(() => loadRegistry({ registryPath: duplicatePath }), /duplicate settings registry id/);
  assert.throws(() => loadRegistry({ registryPath: invalidPath }), SyntaxError);
  assert.throws(
    () => loadRegistry({ registryPath: malformedTitlesPath }),
    /settings registry titles must be an object when present/,
  );
});

/* ---------- R1529: capabilities and risks, stated separately ----------
 *
 * The owner asked for two things about every setting in this product -- what it
 * grants, and what it risks -- and asked for them AS TWO THINGS. `consequence`
 * blends them into one paragraph, so it cannot answer either question on its
 * own. These tests pin the separated form.
 *
 * THE ABSENCE CASES COME FIRST, deliberately, because this codebase's recurring
 * defect is absence read as consent: an entry with no risk statement must be
 * NAMEABLE as unexplained, not quietly rendered as a setting with no risks. */

test('an entry with no capabilities or no risks is reported as unexplained, not as safe', () => {
  assert.equal(explanationDeclared({ id: 'a.b', capabilities: ['x'], risks: ['y'] }), true);
  assert.equal(explanationDeclared({ id: 'a.b', capabilities: ['x'] }), false, 'risks missing must not read as declared');
  assert.equal(explanationDeclared({ id: 'a.b', risks: ['y'] }), false, 'capabilities missing must not read as declared');
  assert.equal(explanationDeclared({ id: 'a.b', capabilities: [], risks: [] }), false, 'empty arrays are an absence, not a statement that there are none');
  assert.equal(explanationDeclared({ id: 'a.b', capabilities: ['   '], risks: ['y'] }), false, 'blank text is an absence');
  assert.equal(explanationDeclared(null), false);
  assert.equal(explanationDeclared(undefined), false);

  assert.throws(
    () => unexplainedIds(null),
    /settings registry entries must be an array/,
    'an unmeasured registry must not be reported as having zero unexplained entries',
  );
  assert.deepEqual(
    unexplainedIds([{ id: 'z.z' }, { id: 'a.a', capabilities: ['x'], risks: ['y'] }, { id: 'b.b', risks: ['y'] }]),
    ['b.b', 'z.z'],
  );
});

test('registry reporting helpers refuse an unmeasured entries collection', () => {
  const registry = require('../src/lib/settings-registry');
  for (const helper of [
    registry.unenforcedIds,
    registry.unprovenancedIds,
    registry.unexplainedIds,
    registry.externalStepIds,
    registry.elevationStepIds,
  ]) {
    assert.throws(() => helper(undefined), /settings registry entries must be an array/);
  }
});

test('every shipped entry states its capabilities and its risks', () => {
  const { entries } = loadRegistry();
  // THE RATCHET. This is 0 today because every one of the 56 was written. It is
  // asserted here rather than in validateEntry() for the reason the file's own
  // note about enforcedBy gives: a missing explanation must not be able to take
  // the whole settings surface down at load time, but the 57th entry must not
  // be able to arrive without one either. If you are here because you added a
  // setting: write its capabilities and its risks. If the risk is genuinely
  // negligible, say that plainly -- an invented hazard is worse than none.
  assert.ok(entries.length > 0, 'the registry is empty; no explanations were checked');
  assert.deepEqual(unexplainedIds(entries), []);
});

test('no capability or risk statement is boilerplate, and none names a mechanism', () => {
  const { entries } = loadRegistry();
  // Two failure modes, both of which produce text that LOOKS like an
  // explanation: copy pasted between rows until it means nothing, and copy that
  // explains the implementation to a person who does not have one.
  const mechanism = /\b(localStorage|sessionStorage|JSON|schema|boolean|null|undefined|serialize|serialise|registry entry|config\.toml|machine\.json)\b/i;
  const seen = new Map();
  let checked = 0;
  for (const entry of entries) {
    for (const statement of [...entry.capabilities, ...entry.risks]) {
      checked += 1;
      assert.doesNotMatch(statement, mechanism, `${entry.id} explains a mechanism rather than an outcome: "${statement}"`);
      assert.ok(statement.trim().length >= 40, `${entry.id} has a statement too short to be one: "${statement}"`);
      const previous = seen.get(statement);
      assert.equal(previous, undefined, `${entry.id} repeats a statement verbatim from ${previous}; a risk line reused across rows is one nobody reads`);
      seen.set(statement, entry.id);
    }
  }
  assert.ok(checked >= 112, `only ${checked} statements were examined across ${entries.length} entries; the walk went inert`);
});

test('a guided step is optional by construction and is never performed for the person', () => {
  const { entries, byId } = loadRegistry();
  const ids = externalStepIds(entries);
  assert.ok(ids.length > 0, 'no setting declares an outside step; the walk found nothing to check');

  for (const id of ids) {
    const step = externalStepFor(byId.get(id));
    // The three properties the owner's directive turns on, encoded as data so
    // they cannot be edited away in prose without failing here.
    assert.equal(step.required, false, `${id} makes an outside step required`);
    assert.equal(step.neverPerformedForYou, true, `${id} does not declare that this product never performs the step`);
    assert.ok(step.withoutIt.trim().length > 40, `${id} does not say what still works without the step`);
    assert.ok(step.verify.trim().length > 20, `${id} does not say how the person knows it worked`);
    assert.ok(step.capabilitiesGained.length > 0 && step.risks.length > 0, `${id} states a gain or a cost but not both`);
    assert.ok(step.steps.length > 0);
  }

  // At least one of them is an elevated, machine-level step, because that is
  // the case the owner named and the case this product must never take itself.
  const elevated = ids.filter((id) => externalStepFor(byId.get(id)).elevation === true);
  assert.ok(elevated.length > 0, 'no elevated step is declared, so the case the directive is about is untested');
});

test('externalStepFor answers null for an entry that has none, rather than an empty walkthrough', () => {
  const { byId } = loadRegistry();
  assert.equal(externalStepFor(byId.get('outward.presend_card')), null);
  assert.equal(externalStepFor(undefined), null);
  assert.equal(externalStepFor(null), null);
  assert.throws(() => externalStepIds(null), /settings registry entries must be an array/);
});

test('a malformed guided step is refused, and a required one hardest of all', () => {
  const good = {
    whatItDoes: 'Lets your other computer reach this one.',
    capabilitiesGained: ['Your other computer can start a connection to this one.'],
    risks: ['Any device on the same network can attempt a connection to that port.'],
    required: false,
    elevation: true,
    // R1536 added these two and made them mandatory for any step that can need
    // an administrator. The fixture carries them because the rule is real, not
    // because the assertions below were relaxed to accommodate it.
    frequency: 'sometimes',
    frequencyBecause: 'Creating a firewall rule needs an administrator on every Windows machine at its default settings, but a rule is only needed at all when the other computer is the one starting the connection.',
    neverPerformedForYou: true,
    steps: [{ do: 'Open Windows PowerShell as an administrator.', why: 'Creating a firewall rule is an administrator action.' }],
    verify: 'The computers page shows this one as reachable.',
    withoutIt: 'The setting stays on; connections the other computer starts are refused, and it says so.',
  };
  assert.deepEqual(validateExternalStep(good), []);

  // The two that matter most are literals, so "true-ish" cannot pass for them.
  assert.match(validateExternalStep({ ...good, required: true }).join(';'), /may never be a precondition/);
  assert.match(validateExternalStep({ ...good, required: undefined }).join(';'), /may never be a precondition/);
  assert.match(validateExternalStep({ ...good, neverPerformedForYou: false }).join(';'), /never performs it/);
  assert.match(validateExternalStep({ ...good, neverPerformedForYou: 'yes' }).join(';'), /never performs it/);

  assert.match(validateExternalStep({ ...good, withoutIt: '' }).join(';'), /what still works/);
  assert.match(validateExternalStep({ ...good, steps: [] }).join(';'), /non-empty array/);
  assert.match(validateExternalStep({ ...good, risks: [] }).join(';'), /risks must be a non-empty array/);
  assert.match(validateExternalStep({ ...good, elevation: 'yes' }).join(';'), /must be a boolean/);
  assert.match(validateExternalStep({ ...good, surprise: 1 }).join(';'), /not a recognized field/);

  // R1534/R1536: how often a step asks something of you is part of the offer,
  // and the reasoning behind that claim has to be written down so a later
  // reader can argue with it. The finding this corrected -- "no setting needs
  // elevation" -- survived because nobody had recorded what it rested on.
  const { frequency, frequencyBecause, ...noLabel } = good;
  assert.match(validateExternalStep(noLabel).join(';'), /frequency is required when elevation is true/);
  assert.match(validateExternalStep({ ...good, frequency: 'occasionally' }).join(';'), /frequency must be one of/);
  assert.match(validateExternalStep({ ...noLabel, frequency }).join(';'), /requires frequencyBecause/);
  assert.match(validateExternalStep({ ...good, frequencyBecause: '   ' }).join(';'), /frequencyBecause must be non-empty/);
  // A step that needs no administrator is offered the label and not made to
  // carry one, which is what keeps the requirement pointed at the real cases.
  assert.deepEqual(validateExternalStep({ ...noLabel, elevation: false }), []);
  assert.match(validateExternalStep(null).join(';'), /must be an object/);

  // And the whole entry is refused rather than loaded with a broken step.
  const { entries } = loadRegistry();
  const base = entries.find((entry) => entry.id === 'machines.transport');
  const broken = { ...base, externalStep: { ...base.externalStep, required: true } };
  assert.equal(validateEntry(broken).ok, false);
});
