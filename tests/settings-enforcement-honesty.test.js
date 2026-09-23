'use strict';

// R1260 T4.3 / R1248 -- THE SETTINGS CATALOGUE MUST NOT GROW ANOTHER CONTROL
// THAT ENFORCES NOTHING, AND MUST BE HONEST ABOUT THE ONES IT ALREADY HAS.
//
// THE DEFECT, MEASURED AT BASE SHA ceae7e7f.
//   * config/settings-registry.json declares 51 user settings.
//   * 41 of them carry `enforcedBy: ""` and 11 carry `derivedFrom: ""`.
//   * src/lib/settings-registry.js validated both fields with
//     `typeof entry.enforcedBy !== 'string'`, and "" IS a string, so an entry
//     that names nothing at all validated exactly like one that names both.
//   * tests/settings-registry.test.js asserted the same `typeof`, so the only
//     test covering those two fields could never go red for the property they
//     exist to guarantee -- a guard that cannot fail.
//   * In the SHIPPED capability payload (release/win-unpacked/resources/
//     capability) exactly 3 of the 51 ids -- model.provider, model.endpoint,
//     model.name -- appear in any executable file. The other 48 are strings in
//     a JSON catalogue that nothing reads.
//
// Owner, 2026-08-11: "every failure which there exists a system for or to
// prevent; that doesnt do its job according to user settings, is vieweed as
// software fialure". A settings row that enforces nothing is that failure, and
// an empty `enforcedBy` accepted as valid is absence read as consent.
//
// WHY A RATCHET AND NOT A REJECTION. Making validateEntry refuse an empty
// enforcedBy would fail loadRegistry() on 41 shipped entries and take the whole
// settings surface down; paying that debt down is a build-queue slice. What
// this file does is stop the debt GROWING: the unenforced set must equal the
// recorded baseline EXACTLY, so a 42nd unenforced setting cannot be added in
// silence, and a paid-down one cannot quietly reappear.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const registry = require('../src/lib/settings-registry');
const settings = require('../src/lib/settings');

// The debt as it stood when this instrument was written. Every id here is a
// control a person can be shown that changes nothing at runtime. Shrinking this
// list is the work; growing it is the regression.
const UNENFORCED_BASELINE = [
  // ask.away_channel and ask.agent_relay_fallback left with the outside-
  // messaging capability they purported to control. The debt is 38.
  'ask.check_before_pausing', 'ask.primary_channel', 'ask.stop_cadence',
  'autonomy.assumption_narration', 'autonomy.intake_questions',
  'autonomy.rule_check_narration', 'autonomy.scope_widening', 'autonomy.wait_for_me',
  'fleet.browser_driver', 'fleet.checkpoint_cadence',
  'fleet.coordination_board', 'fleet.lead_does_work', 'fleet.review_cadence',
  'fleet.reviewer_may_fix', 'fleet.supervision_spend', 'fleet.worker_reset_after_task',
  'ide.attach_mode', 'ide.available_surfaces', 'ide.imported_surfaces',
  'machines.mode', 'machines.peers', 'machines.transport',
  'outward.adoption_scope', 'outward.gate_strictness', 'outward.gates',
  'outward.naming_conventions', 'outward.presend_card', 'outward.unattended_sends',
  'outward.verify_destination',
  'rules.active_instructions', 'rules.agent_proposals', 'rules.auto_management',
  'rules.captured_list',
  /* THREE ROWS JOINED THIS LIST 2026-09-03, AND NONE OF THEM IS NEW DEBT.
     All three were always inert; what changed is that they stopped claiming
     otherwise. Each declared an enforcer, and opening every named file found
     that none of them mentions the row -- so the row was hidden from the count
     above by the very field that was supposed to prove it was wired.
     tests/settings-rows-inert.test.js is the instrument that found them and now
     refuses to let a fourth appear; the entries below are the debt it made
     visible, recorded here in the place this repo keeps its debt.

       machines.direct_link_setup      tools/direct-link.ps1 reads no settings
                                       file at all -- `Get-Setting` and
                                       `settings.json` appear nowhere in it. The
                                       link is turned on and off by that script's
                                       own -On/-Off flags. Wiring the row means
                                       teaching direct-link.ps1 to read
                                       settings.json the way tools/lib/
                                       StartupPolicy.ps1 already reads
                                       startup.services_at_logon, which is an
                                       elevated-setup change and not this one.
       model.api_key                   a readback whose real state is the vault
                                       entry `user_model_api_key`. Wiring it
                                       means projecting src/lib/runtime.js
                                       secretExists() into the readback, which
                                       puts a vault call on every loadSettings()
                                       and was left alone for that reason. It is
                                       now at least READ-ONLY: see
                                       tests/settings-rows-inert.test.js.
       outward.identity_authorization  the authority is the record
                                       config/owner-authorization.json, and a
                                       two-option seg cannot be one --
                                       src/lib/owner-authorization.js rejects a
                                       grant that reserves nothing, and this row
                                       has no field for a reservation. Wiring it
                                       means making it a readback projected from
                                       readAuthorization(), the shape
                                       capability.tier already has. */
  'machines.direct_link_setup', 'model.api_key', 'outward.identity_authorization',
  /* fleet.concurrency_limits JOINED THIS LIST 2026-09-08. commit 3a131311
     added it as a readback beside fleet.max_declared_agents (which IS
     enforced -- src/lib/agent-org.js resolveMaxAgents; src/lib/agent-org-
     store.js write admission -- and stays out of this list), and declared
     `enforcedBy: "src/lib/mission-bridge/actions.js BRIDGE_ALL_SEATS_BUSY;
     src/lib/agent-resource-admission.js maxConcurrentStarts and the
     processor headroom slots; src/lib/controller-launch-record.js
     MAX_FAN_OUT"`. All three files are real and each bounds concurrency in
     its own way, but none of them mentions the id `fleet.concurrency_limits`
     -- there is no such setting VALUE for them to read, because this row is
     `control: "readback"` with a fixed default string, not a value a person
     chooses. tests/settings-rows-inert.test.js's tree walk confirmed the id
     appears in no source file outside tests. The row's own text already says
     this ("Those checks are separate from the declared organisation size");
     the `enforcedBy` field was the one place still claiming otherwise. Fixed
     by emptying `enforcedBy` and folding the same three citations into
     `readOnlyReason`, which is where an explanatory-only row's provenance
     belongs -- see model.api_key for the identical shape. */
  'fleet.concurrency_limits'
  // rules.capture_spoken left this list 2026-08-19 (O7): its enforcer is
  // src/lib/r-ledger-agent-gate.js, read by the r_ledger.* tools and the host's
  // contract paragraph. The two machine-boundary readbacks left this list in
  // the capability-settings honesty change. The duration, restart, and shared-
  // write controls left in the elevation/shared-write change. The debt is 35.
];

const UNPROVENANCED_BASELINE = [
  'ask.check_before_pausing', 'ask.stop_cadence', 'autonomy.rule_check_narration',
  'capability.elevation_duration', 'capability.elevation_survives_restart',
  'fleet.concurrent_shared_writes',
  'outward.gate_strictness', 'rules.active_instructions', 'rules.agent_proposals',
  'rules.captured_list'
];

// ---------------------------------------------------------------------------
// 1. THE ABSENCE CASE, FIRST. An empty, whitespace-only, missing or wrongly
//    typed declaration is NOTHING, and must read as nothing.
// ---------------------------------------------------------------------------
test('an empty, blank, absent or mistyped enforcedBy declares no enforcer', () => {
  for (const value of ['', '   ', '\t\n', undefined, null, 0, false, [], {}]) {
    assert.equal(registry.enforcementDeclared({ id: 'x.y', enforcedBy: value }), false,
      `enforcedBy: ${JSON.stringify(value)} was accepted as a declared enforcer`);
    assert.equal(registry.provenanceDeclared({ id: 'x.y', derivedFrom: value }), false,
      `derivedFrom: ${JSON.stringify(value)} was accepted as declared provenance`);
  }
  assert.equal(registry.enforcementDeclared({ id: 'x.y' }), false, 'a missing field declares nothing');
  assert.equal(registry.enforcementDeclared(undefined), false, 'a missing entry declares nothing');
});

test('only a non-empty string declares one', () => {
  assert.equal(registry.enforcementDeclared({ id: 'x.y', enforcedBy: 'src/lib/thing.js' }), true);
  assert.equal(registry.provenanceDeclared({ id: 'x.y', derivedFrom: 'R1248' }), true);
});

// ---------------------------------------------------------------------------
// 2. THE RATCHET. Exact-set equality in BOTH directions: a new unenforced
//    setting fails, and so does a baseline entry that vanishes without this
//    file being updated to record the win.
// ---------------------------------------------------------------------------
test('no settings row may be added that enforces nothing', () => {
  const { entries } = registry.loadRegistry();
  const actual = registry.unenforcedIds(entries);
  const added = actual.filter(id => !UNENFORCED_BASELINE.includes(id));
  const removed = UNENFORCED_BASELINE.filter(id => !actual.includes(id));
  assert.deepEqual(added, [],
    `these settings were added to the catalogue with no enforcedBy, so they are controls that change nothing: ${added.join(', ')}`);
  assert.deepEqual(removed, [],
    `these settings are now enforced -- a real win. Remove them from UNENFORCED_BASELINE in this file so the ratchet holds the new floor: ${removed.join(', ')}`);
});

test('no settings row may be added whose value has no traceable origin', () => {
  const { entries } = registry.loadRegistry();
  const actual = registry.unprovenancedIds(entries);
  const added = actual.filter(id => !UNPROVENANCED_BASELINE.includes(id));
  const removed = UNPROVENANCED_BASELINE.filter(id => !actual.includes(id));
  assert.deepEqual(added, [],
    `these settings carry no derivedFrom, so the value in force traces to nobody and would be enforced as though the user had chosen it: ${added.join(', ')}`);
  assert.deepEqual(removed, [], `provenance was added for: ${removed.join(', ')} -- record the win in UNPROVENANCED_BASELINE`);
});

// ---------------------------------------------------------------------------
// 3. THE BEHAVIOURAL HALF. A resolved settings document must carry the
//    enforcement fact, so a surface can be honest instead of drawing a control
//    that looks live. Asserted through loadSettings against real files.
// ---------------------------------------------------------------------------
function temporaryPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-enforcement-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'settings.json');
}

test('a resolved settings document says which of its rows enforce nothing', (t) => {
  const entries = [
    { id: 'wired.thing', control: 'toggle', default: false, enforcedBy: 'src/lib/wired.js', derivedFrom: 'R1' },
    { id: 'decorative.thing', control: 'toggle', default: true, enforcedBy: '', derivedFrom: '' },
    { id: 'blank.thing', control: 'toggle', default: true, enforcedBy: '   ', derivedFrom: 'R2' }
  ];
  const fixture = { entries, byId: new Map(entries.map(entry => [entry.id, entry])) };
  const result = settings.loadSettings({ registry: fixture, valuesPath: temporaryPath(t) });

  assert.equal(result.enforcement['decorative.thing'].declared, false,
    'a row with an empty enforcedBy was reported as enforced');
  assert.equal(result.enforcement['decorative.thing'].enforcedBy, null);
  assert.equal(result.enforcement['decorative.thing'].provenanceDeclared, false,
    'a row with an empty derivedFrom was reported as having provenance');
  assert.equal(result.enforcement['blank.thing'].declared, false,
    'whitespace is not a declaration');
  assert.equal(result.enforcement['wired.thing'].declared, true);
  assert.equal(result.enforcement['wired.thing'].enforcedBy, 'src/lib/wired.js');
  assert.equal(result.enforcement['wired.thing'].derivedFrom, 'R1');
});

test('the enforcement fact survives every early return, including an unreadable settings file', (t) => {
  const entries = [{ id: 'decorative.thing', control: 'toggle', default: true, enforcedBy: '', derivedFrom: '' }];
  const fixture = { entries, byId: new Map(entries.map(entry => [entry.id, entry])) };

  // (a) missing file
  const missing = settings.loadSettings({ registry: fixture, valuesPath: temporaryPath(t) });
  assert.equal(missing.enforcement['decorative.thing'].declared, false);

  // (b) unreadable path (a directory)
  const directoryPath = path.dirname(temporaryPath(t));
  const unreadable = settings.loadSettings({ registry: fixture, valuesPath: directoryPath });
  assert.deepEqual(unreadable.rejected.map(({ id }) => id), ['*']);
  assert.equal(unreadable.enforcement['decorative.thing'].declared, false,
    'the honest-about-enforcement fact must not disappear on the failure paths, which are exactly when a surface is most likely to guess');

  // (c) structurally invalid document
  const invalidPath = temporaryPath(t);
  fs.writeFileSync(invalidPath, JSON.stringify({ nope: true }));
  const invalid = settings.loadSettings({ registry: fixture, valuesPath: invalidPath });
  assert.deepEqual(invalid.rejected.map(({ id }) => id), ['*']);
  assert.equal(invalid.enforcement['decorative.thing'].declared, false);

  // (d) a valid document
  const validPath = temporaryPath(t);
  fs.writeFileSync(validPath, JSON.stringify({
    revision: 1,
    values: { 'decorative.thing': false },
    provenance: { 'decorative.thing': { source: 'user', atMs: 1, directive: 'R1248' } }
  }));
  const valid = settings.loadSettings({ registry: fixture, valuesPath: validPath });
  assert.equal(valid.values['decorative.thing'], false);
  assert.equal(valid.provenance['decorative.thing'].source, 'user',
    'the value is the user\'s');
  assert.equal(valid.enforcement['decorative.thing'].declared, false,
    'and NOTHING enforces it -- the two facts are independent and both must be reportable');
});

// ---------------------------------------------------------------------------
// 4. The shipped catalogue, through the real loader, agrees with the ratchet.
// ---------------------------------------------------------------------------
test('the shipped catalogue reports the recorded number of unenforced rows', () => {
  const resolved = settings.loadSettings({ valuesPath: path.join(os.tmpdir(), 'definitely-absent-settings.json') });
  const ids = Object.keys(resolved.enforcement);
  const unenforced = ids.filter(id => resolved.enforcement[id].declared === false).sort();
  /* 67 rows. This pin was found red on arrival (it asserted 65 and then,
     in a second stale assertion, 62 -- two numbers left behind by two lanes
     each counting its own working tree). Recounted 2026-08-19 (O7) against
     the catalogue as it stands; the O7 change adds NO row (it rewrites
     rules.capture_spoken in place) and shrinks the unenforced set by one,
     which the deepEqual below is the real guard for. The O7 improvements
     (owner 2026-08-22) add ONE row, rules.ask_when_unsure, nested under
     rules.capture_spoken and enforced by the same module, so the size is 67
     and the unenforced baseline above is unchanged. If your commit carries
     a different set of rows, recompute this for what YOUR commit contains.

     RECOUNTED 2026-08-22 for the capability-recall adoption: it adds ONE row,
     agent.capability_recall, and that row is ENFORCED --
     src/lib/capability-recall/index.js reads it before it opens the index and
     answers { text: '', outcome: 'disabled' } when it is off. So the size is 68
     and UNENFORCED_BASELINE is deliberately unchanged: the debt this ratchet
     counts did not move, which is the whole point of raising the size pin by
     hand rather than deriving it.

     RECOUNTED 2026-08-24 after the outside-messaging capability was removed:
     ask.away_channel and ask.agent_relay_fallback were unenforced controls for
     that absent capability. Removing both makes 66 rows and pays down two
     entries in the unenforced baseline.

     RECOUNTED 2026-08-24 for the AGENT API (owner directive B9): it adds ONE
     row, agent.agent_api, and that row is ENFORCED -- src/lib/agent-api-policy.js
     holds the decision and both `claude` spawn paths emit its answer as the
     CLI's `--tools` flag (src/lib/agent-engine/claude-cli-adapter.js for an
     agent thread, src/lib/mission-bridge/actions.js for a dispatched lane), with
     tests/agent-api-policy.test.js driving both sides of the switch through a
     real settings file. So the size is 67 and UNENFORCED_BASELINE is
     deliberately unchanged: the debt this ratchet counts did not move, which is
     the whole point of raising the size pin by hand rather than deriving it.

     RECOUNTED 2026-08-29 for OWNER APPROVALS (owner directives 2026-08-27 and
     2026-08-29): it adds ONE row, agent.tool_approvals, and that row is
     ENFORCED -- src/lib/policy.js requiresApproval() reads it through
     approvalsTurnedOffByOwner(), which opens the gate only for an explicit
     `false` classified in the person's own settings file with user or installer
     provenance, and leaves the policy file's answer standing when settings
     cannot be read. So the size is 68 and UNENFORCED_BASELINE is again
     deliberately unchanged: this row arrives with its enforcer, so the debt this
     ratchet counts did not move.

     RECOUNTED 2026-09-02 for ONE LEDGER (owner directive 2026-09-02): it adds
     ONE row, rules.agent_filed_needs_approval, and that row is ENFORCED --
     src/lib/owner-request-store.js files an agent's rule as 'proposed' when the
     person's own true is stored, read through
     src/lib/r-ledger-agent-gate.js agentFiledNeedsApprovalOf by the same three
     rules as its sibling rules.ask_when_unsure. So the size is 69 and
     RECOUNTED 2026-09-02 for OUTSIDE CONTROL (owner directive 2026-09-02: an
     agent may touch the app's buttons from the outside, "a setting not a
     standard"): it adds ONE row, app.outside_control, shipped OFF, and that
     row is ENFORCED -- src/lib/outside-control.js outsideControlPolicy() opens
     the port only for an explicit `true` classified in the person's own
     settings file with user or installer provenance, and the desktop shell
     asks it before Electron is ready. So the size is 69 and
     UNENFORCED_BASELINE is again deliberately unchanged. Both rows landed the same
     day, so the size is 70. */
  /* RECOUNTED 2026-09-02 for THE SUBAGENT ROUTE: it adds ONE row,
     agent.subagent_route, and that row is ENFORCED --
     src/lib/agent-subagent-route.js subagentRoute() returns the single route a
     spawn may take and the spawn tool obeys it, under the same provenance
     rule the rest of this catalogue uses. So the size is 71 and
     UNENFORCED_BASELINE is deliberately unchanged. */
  /* RECOUNTED 2026-09-03 for THE INERT-ROW AUDIT: it adds NO row and removes
     none, so the size is still 71. What it changes is which of them count as
     unenforced. `enforcementDeclared` only ever asked whether the catalogue had
     written a non-empty string, so a row naming a file that never mentions it
     passed as enforced; opening every named file found four such rows.
     accounts.failover is now genuinely wired (src/lib/multi-account/
     failover-setting.js, read by rotation.js) and stays out of the list; the
     other three are honest about being inert and join it, which is why
     UNENFORCED_BASELINE grew by three above while the debt itself did not. */
  /* RECOUNTED 2026-09-03 for MESSAGE SCREENING (owner directive: a check that
     refuses agent messages "should become user settings with sliders and a
     reasonable default"): it adds ONE row, agent.message_screening, shipped
     at its middle option, and that row is ENFORCED --
     src/lib/agent-comms/history.js resolves it once when the durable history
     is constructed and applies it to every message on the write path, and
     tests/agent-comms/identifiers-are-not-credentials.test.js drives all
     three levels. So the size is 72 and UNENFORCED_BASELINE is deliberately
     unchanged. */
  /* The two recounts above are independent: the inert-row audit changed WHICH
     rows count as unenforced without changing the size, and message screening
     adds one row. 71 + 1 = 72. */
  // 73 since 2026-09-03: tools.throughput (fast/strict), enforced by
  // src/lib/throughput-mode.js and named in the registry's enforcedBy.
  // RECOUNTED 2026-09-08. Measured against the shipped catalogue this pin was
  // stale at 79 vs an actual 81 -- a gap that predates this change and was not
  // narrated here row by row. Of the rows added since the 73 note above, this
  // change can account for two by name: commit 3a131311 (org size as a user
  // setting) added fleet.max_declared_agents, which IS enforced (see
  // UNENFORCED_BASELINE above) and fleet.concurrency_limits, which is not
  // (joined UNENFORCED_BASELINE above). The remaining growth from 73 to 79 is
  // not re-derived here; this line is corrected to the measured size, 81,
  // rather than left red for an unrelated gap.
  // Source18 already has 88 rows (the old 81 pin is retained as a reproduced
  // baseline failure). Tool activity audit adds one enforced choice. Preserve
  // the independently asserted list of unenforced rows below.
  // 90 since a83338f4 (2026-09-10) added exactly one row,
  // agent.persistent_continuation -- verified by diffing that commit's registry
  // change, which adds one "id" and removes none. It is ENFORCED
  // (src/lib/agent-ledger-continuation.js), so UNENFORCED_BASELINE below is
  // unchanged and is still asserted independently of this count.
  // Message delivery adds agent.message_delivery and agent.message_queue_seconds.
  // Both are read by src/lib/agent-message-delivery.js; the unenforced set is unchanged.
  // Per-turn complete rules delivery is enforced by rules-turn-snapshot and the desktop host.
  // "Who adds standing rules" (rules.filing_from, owner 2026-09-15) adds one
  // enforced depth-2 choice, read by src/lib/r-ledger-agent-gate.js; the
  // unenforced set is unchanged.
  // "Letting agents edit ToolsEnabled source in checkouts"
  // (agent.product_source_writes, owner 2026-09-19) adds one enforced toggle,
  // read by src/lib/product-source-writes.js for src/lib/providers/host-control.js;
  // the unenforced set is unchanged.
  assert.equal(ids.length, 95, 'the catalogue size changed; update this file deliberately');
  assert.deepEqual(unenforced, [...UNENFORCED_BASELINE].sort());
});
