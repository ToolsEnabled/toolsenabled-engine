// EXECUTABLE CHANGE
//
// Test-can-fail report (2026-08-26): the four collection traversals below
// previously had no independent cardinality assertion.  Their current literal
// fixtures were populated, but an accidentally emptied fixture would have made
// every assertion in the corresponding traversal disappear.  Exact cardinality
// checks now make that state fail rather than pass vacuously.
//
// Mutation: in a scratch edit to src/lib/error-taxonomy.js,
// includesCodeSegments() was changed to `return false`.  The test exited 1 and
// reported (among the failures):
//   "FAIL: ACCOUNTS_REGISTRY_MISSING -> INPUT_REQUIRED"
//   "+ 'INTERNAL_ERROR'"
//   "- 'INPUT_REQUIRED'"
// The source was restored byte-for-byte (SHA-256 before and after:
// 5f55bab02469a4fe2949248c9486a68b9e17078a4557f0935fa35d8691abba44).
// The restored run exited 0 and ended with:
//   "ok: a rescued failure still carries only the closed public fields"
//   "all checks passed"
//
// NOT-FOUND (2): no exit-status or truthy-return assertion is used as product
// evidence.  The final process exit only aggregates direct value assertions.
// NOT-FOUND (3): no product failure is swallowed; check() records caught
// assertion failures and the aggregate forces a non-zero exit.
// NOT-FOUND (4): the taxonomy under test is required directly; it is not mocked.
// NOT-FOUND (5): there are no skips or platform/precondition guards.
// NOT-FOUND (6): expected classifications are fixed independent fixtures, not
// values computed by the taxonomy implementation.
// Preconditions unmet: none.

'use strict';

// THE BLANKET OVER 65 HONEST REFUSALS, MEASURED 2026-08-19.
//
// The 272-tool sweep (tools/agent-tool-sweep-qa.mjs in the app repo; evidence
// reports/agent-tools/sweep-unrestricted.jsonl and sweep-guided.jsonl) found 65
// gate refusals at Unrestricted and 33 at Guided whose structured error carried
// a perfectly honest source code -- VAULT_SECRET_UNAVAILABLE,
// JARVIS_CONTROL_RUN_NOT_FOUND, MODEL_PROVIDER_NOT_CONFIGURED and 18 more --
// while the agent-visible taxonomy sentence said "The operation stopped safely
// because of an internal error." The cause is mapSource()'s `includesCode`,
// which matched a policy value only as the code's HEAD (`VALUE` or `VALUE_`
// prefix), while this tree composes codes as `<subsystem>_<condition>` with the
// condition phrase at the TAIL. Every suffix-coded refusal fell through to
// INTERNAL_ERROR. The file's own comments record two prior one-code patches
// (2026-08-11, the OWNER_PROMPT_* pair); this table is the class fix's proof,
// built from the sweep's blanketed codes rather than from new examples.
//
// The fix is the two-pass whole-segment containment rule documented above
// `includesCode` in src/lib/error-taxonomy.js. Its contract, asserted here:
//   1. every code the sweep measured under the blanket maps to its honest
//      platform classification;
//   2. every code that classified before the change keeps its classification
//      (pass 1 is byte-for-byte the old semantics and always wins);
//   3. an unknown code still falls through to INTERNAL_ERROR, and a partial
//      word can never match a policy value (fail-closed stays fail-closed);
//   4. mapping consumes the structured `code` field only -- prose in `message`
//      never classifies anything.

const assert = require('node:assert/strict');
const errorTaxonomy = require('../src/lib/error-taxonomy');

function mapped(code) {
  return errorTaxonomy.publicFailure({ code, message: 'irrelevant provider prose' }).code;
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); }
  catch (error) {
    failures += 1;
    console.error(`  FAIL: ${label}\n    ${error.message}`);
  }
}

console.log('error taxonomy: sweep-measured refusals escape the INTERNAL_ERROR blanket');

check('an invalid HTTP response is reported as rejected provider output without permitting automatic replay', () => {
  const failure = errorTaxonomy.publicFailure({
    code: 'HTTP_RESPONSE_DECODE_FAILED', message: 'private response bytes must not be repeated'
  });
  assert.equal(failure.code, 'MALFORMED_OUTPUT');
  assert.equal(failure.retryable, false);
  assert.equal(failure.safeSummary, 'The service returned an invalid response and the result was not accepted.');
  assert.doesNotMatch(JSON.stringify(failure), /private response bytes/);
});

// --- 1. THE SWEEP TABLE -----------------------------------------------------
// Every distinct source code the 2026-08-19 sweep measured under the
// INTERNAL_ERROR blanket (misleadingSummary rows), with the platform code its
// composition honestly states. The tool counts are the unrestricted sweep's.
const SWEEP_BLANKETED = Object.freeze({
  ACCOUNTS_REGISTRY_MISSING: 'INPUT_REQUIRED',            // cloud.* (3 tools)
  AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE: 'AUTH_EXPIRED', // agent_comms.* (3)
  EGRESS_GATES_REQUIRED: 'INPUT_REQUIRED',                // drive.upload (1)
  HERMES_NO_GPU_PEER_CONFIGURED: 'INPUT_REQUIRED',        // research.hermes_complete (1)
  MODEL_NO_GPU_PEER_CONFIGURED: 'INPUT_REQUIRED',         // model.*/research.* (4)
  MODEL_PROVIDER_NOT_CONFIGURED: 'INPUT_REQUIRED',        // model.customer_complete (1)
  OVERNIGHT_ADVISORY_TASK_NOT_FOUND: 'INVALID_REQUEST',   // overnight_advisory.status (1)
  PADDLE_WEBHOOK_SIGNATURE_INVALID: 'VERIFICATION_FAILED',// paddle.webhook_verify (1)
  // A retained browser connection can disappear AFTER a click has taken
  // effect. Recovery now requires inspection, never an automatic replay.
  PLAYWRIGHT_CALL_TRANSPORT_CLOSED: 'EXTERNAL_CHANGE',
  PURCHASE_NOT_AUTHORIZED: 'APPROVAL_REQUIRED',           // pay.record (1)
  RESEARCH_INPUT_INVALID: 'INVALID_REQUEST',              // research.session_assign (1)
  RESEARCH_PIPELINE_DISABLED: 'POLICY_DENIED',            // research.run_submit (1)
  RESEARCH_PROJECT_NOT_FOUND: 'INVALID_REQUEST',          // research.finding_save (1)
  TASK_NOT_FOUND: 'INVALID_REQUEST',                      // task.cancel (1)
  TOOL_DISABLED_BY_OWNER_DECISION: 'POLICY_DENIED',       // registry switch; no shipped tool carries it since Discord left (2026-08-22)
  VAULT_SECRET_UNAVAILABLE: 'AUTH_EXPIRED',               // generic provider-safety vault reads
  WEB_EXTRACT_UNPROVISIONED: 'INPUT_REQUIRED',            // web.extract/web.expand (2)
  WORKSPACE_FRA_CONTEXT_REQUIRED: 'INPUT_REQUIRED',       // workspace.* (2)
  WORKSTATION_ROOT_INVALID: 'INVALID_REQUEST',            // workstation.status (1)
});

// The historical sweep included retired integrations. Commit 81b14e1 removed
// DIGITALOCEAN_GOOGLE_ACCOUNT_INVALID and reconciled 21 -> 20. Commit fe64032
// then removed JARVIS_CONTROL_RUN_NOT_FOUND with that integration, but left the
// 20-count assertion behind. These are the 19 retained cases, not a newly
// measured sweep. Keep a fixed independent count; never derive it from mapping.
check('the retained sweep refusal fixture contains all 19 source cases', () => {
  assert.equal(Object.keys(SWEEP_BLANKETED).length, 19);
});
for (const [source, expected] of Object.entries(SWEEP_BLANKETED)) {
  check(`${source} -> ${expected}`, () => {
    assert.equal(mapped(source), expected,
      `${source} must classify as ${expected}, not hide behind the internal-error blanket`);
  });
}

check('none of the sweep codes still answers the internal-error sentence', () => {
  for (const source of Object.keys(SWEEP_BLANKETED)) {
    const failure = errorTaxonomy.publicFailure({ code: source });
    assert.notEqual(failure.code, 'INTERNAL_ERROR', source);
    assert.notEqual(failure.safeSummary, 'The operation stopped safely because of an internal error.', source);
  }
});

// The codes item 3 of the same directive introduces for the sweep's nine
// uncoded refusals, chosen to compose from condition phrases this ladder
// already understands -- so a new refusal never needs a taxonomy edit.
const ITEM3_CODES = Object.freeze({
  OCR_LANGUAGE_PACK_MISSING: 'INPUT_REQUIRED',
  GCLOUD_CLI_MISSING: 'INPUT_REQUIRED',
  TERRAFORM_CLI_MISSING: 'INPUT_REQUIRED',
  EXTENSION_MANIFEST_NOT_FOUND: 'INVALID_REQUEST',
  GOOGLE_ACCOUNT_NOT_CONFIGURED: 'INPUT_REQUIRED',
  GOOGLE_ACCOUNT_NOT_FOUND: 'INVALID_REQUEST',
  BILLING_WEBHOOK_SIGNATURE_INVALID: 'VERIFICATION_FAILED',
  CAPTURE_PATH_INVALID: 'INVALID_REQUEST',
  PERMISSION_LOCAL_FRA_ONLY_REFUSED: 'POLICY_DENIED',
});
check('the uncoded-refusal fixture contains all nine introduced codes', () => {
  assert.equal(Object.keys(ITEM3_CODES).length, 9);
});
for (const [source, expected] of Object.entries(ITEM3_CODES)) {
  check(`${source} -> ${expected}`, () => { assert.equal(mapped(source), expected); });
}

// --- 2. PASS 1 ALWAYS WINS: yesterday's classifications are preserved -------
// Each of these matched a rule under the old head-anchored semantics, and each
// would land somewhere ELSE if bare containment re-ran the ladder for it.
const PRESERVED = Object.freeze({
  INVALID_AUTH_KEY: 'INVALID_REQUEST',          // not stolen by AUTH containment
  SCHEDULER_STALE_INVOCATION: 'UNAVAILABLE',    // SCHEDULER_ family rule holds
  SCHEDULER_ACTION_INVALID: 'UNAVAILABLE',
  SANDBOX_AUTH_PROFILE_NOT_FOUND: 'SANDBOX_VIOLATION',
  POLICY_APPROVAL_EVIDENCE_INVALID: 'POLICY_DENIED',
  AUTH_TOKEN_INVALID: 'AUTH_EXPIRED',
  QUOTA_PROJECT_INVALID: 'QUOTA_EXHAUSTED',
});
check('the preservation fixture contains all seven historical classifications', () => {
  assert.equal(Object.keys(PRESERVED).length, 7);
});
for (const [source, expected] of Object.entries(PRESERVED)) {
  check(`preserved: ${source} -> ${expected}`, () => { assert.equal(mapped(source), expected); });
}

check('the TIMEOUT source rule stays exact: HTTP_TIMEOUT_INVALID is a bad argument, not a timeout', () => {
  assert.equal(mapped('HTTP_TIMEOUT_INVALID'), 'INVALID_REQUEST');
});

// --- 3. FAIL CLOSED, STILL --------------------------------------------------
check('an unknown code still answers INTERNAL_ERROR', () => {
  assert.equal(mapped('SOMETHING_NOBODY_EVER_NAMED'), 'INTERNAL_ERROR');
  assert.equal(mapped('XYZZY'), 'INTERNAL_ERROR');
});

check('a partial word never matches: segment boundaries are hard', () => {
  // RESOURCEFUL contains the letters of RESOURCE; UNAVAILABLEX contains
  // UNAVAILABLE. Neither shares a whole `_`-delimited segment with any value.
  assert.equal(mapped('RESOURCEFUL_OPERATION'), 'INTERNAL_ERROR');
  assert.equal(mapped('SERVICE_UNAVAILABLEX'), 'INTERNAL_ERROR');
  assert.equal(mapped('SERVICE_XUNAVAILABLE'), 'INTERNAL_ERROR');
  assert.equal(mapped('NOTAUTHORIZED'), 'INTERNAL_ERROR');
});

check('an absent or non-string code answers INTERNAL_ERROR', () => {
  assert.equal(errorTaxonomy.publicFailure({}).code, 'INTERNAL_ERROR');
  assert.equal(errorTaxonomy.publicFailure({ code: 42 }).code, 'INTERNAL_ERROR');
  assert.equal(errorTaxonomy.publicFailure(new Error('plain sentence, no code')).code, 'INTERNAL_ERROR');
});

check('prose never classifies: a code word inside message alone rescues nothing', () => {
  const failure = errorTaxonomy.publicFailure({ message: 'VAULT_SECRET_UNAVAILABLE happened' });
  assert.equal(failure.code, 'INTERNAL_ERROR');
});

// --- 4. THE PUBLIC SHAPE STAYS CLOSED ---------------------------------------
check('a rescued failure still carries only the closed public fields', () => {
  const failure = errorTaxonomy.publicFailure({ code: 'VAULT_SECRET_UNAVAILABLE', message: 'x' });
  errorTaxonomy.assertPublicFailure(failure);
  assert.equal(failure.classification, 'retry-after-input');
  assert.equal(failure.retryable, false);
});

// --- 5. THE TREE-COMMAND REFUSAL FAMILY (2026-09-07) ------------------------
// Same defect class as the OWNER_PROMPT_* pair (2026-08-11, documented above
// classifySourceCode) and the sweep's 65 blanketed refusals (2026-08-19): a
// code that names its own refusal, with no rule in this ladder recognizing
// any word in it, answers the fixed INTERNAL_ERROR sentence instead of the
// sentence the tool already worked out. Measured this time on
// node-1-11bbb999-2218-44a6-893a-9a7a3e8e6716 (an orphaned tree circle,
// parentId null): agent.remove and agent.restart both refused with "The
// operation stopped safely because of an internal error." while the real
// sentence ("...that circle is not below yours on the tree...") sat in the
// audit ledger the whole time, reachable only there -- not because the
// working "not below yours to remove" case a different node hit that same
// night took a different code path (it does not; measured directly, it maps
// to INTERNAL_ERROR identically), but because the audit write
// (auditInvocation, src/lib/tool-registry.js) captures the raw error.message
// before this classification ever runs, and toolError (src/mcp-server.js) is
// the only place the CALLING AGENT's own answer is built.
const TREE_COMMAND_REFUSALS = Object.freeze({
  MC_TREE_COMMAND_NOT_BELOW_CALLER: 'INVALID_REQUEST',
  MC_TREE_COMMAND_REMOVE_NOT_BELOW_CALLER: 'INVALID_REQUEST',
  MC_TREE_COMMAND_CALLER_UNKNOWN: 'INVALID_REQUEST',
  MC_TREE_COMMAND_REMOVE_CALLER_UNKNOWN: 'INVALID_REQUEST',
  MC_TREE_COMMAND_REMOVE_PERSON_SPOKE: 'INVALID_REQUEST',
  MC_TREE_COMMAND_REMOVE_NOT_AGENT_MADE: 'INVALID_REQUEST',
});
// MC_TREE_COMMAND_REMOVE_REFUSED and MC_TREE_COMMAND_REMOVE_UNAVAILABLE are
// deliberately absent from this fixture: measured directly, they already
// classify as INVALID_REQUEST and UNAVAILABLE respectively, via the existing
// REFUSED/UNAVAILABLE rules below -- registering them again would not be a
// minimal change, and this fixture is only the six codes that were actually
// broken.
check('the tree-command refusal fixture contains exactly the six previously-blanketed codes', () => {
  assert.equal(Object.keys(TREE_COMMAND_REFUSALS).length, 6);
});
for (const [source, expected] of Object.entries(TREE_COMMAND_REFUSALS)) {
  check(`${source} -> ${expected}`, () => { assert.equal(mapped(source), expected); });
}
check('none of the tree-command codes still answers the internal-error sentence', () => {
  for (const source of Object.keys(TREE_COMMAND_REFUSALS)) {
    const failure = errorTaxonomy.publicFailure({ code: source });
    assert.notEqual(failure.classification, 'terminal', source);
    assert.notEqual(failure.safeSummary, 'The operation stopped safely because of an internal error.', source);
  }
});
check('the sibling REMOVE codes that were never broken keep their existing classification', () => {
  assert.equal(mapped('MC_TREE_COMMAND_REMOVE_REFUSED'), 'INVALID_REQUEST');
  assert.equal(mapped('MC_TREE_COMMAND_REMOVE_UNAVAILABLE'), 'UNAVAILABLE');
});

check('ended and replaced tree sessions retain actionable lifecycle refusals', () => {
  const mcpServer = require('../src/mcp-server');
  for (const [code, expected, sentence] of [
    ['MC_TREE_COMMAND_SESSION_CHANGED', 'STALE_DATA', 'This circle has a different session now. Read its current session before trying again.'],
    ['MC_TREE_COMMAND_SESSION_ENDED', 'INVALID_REQUEST', "This circle's session has already ended. Resume or restart the circle to open a new session."],
  ]) {
    assert.equal(mapped(code), expected);
    const result = mcpServer.toolError(Object.assign(new Error(sentence), { code }));
    assert.equal(result.content[0].text, sentence);
  }
  assert.equal(mapped('MC_TREE_COMMAND_STOP_FAILED'), 'INTERNAL_ERROR', 'unclassified cleanup failure is not evidence of an ended session');
});

// (b) End to end, through the seam that actually builds what the calling
// agent reads: mcp-server.js's toolError. content[0].text is the field an
// agent's tool result renders (see toolError's own comment, "structuredContent
// is not what an agent reads") -- this is the field that must carry the named
// sentence, not just the taxonomy classification in isolation.
check('toolError surfaces the named sentence for a parentId-null node\'s agent.remove refusal, never the internal-error text', () => {
  const mcpServer = require('../src/mcp-server');
  const realSentence = 'A circle is removed by one above it. That circle is not below yours on the tree, so it is not yours to remove.';
  const error = new Error(realSentence);
  error.code = 'MC_TREE_COMMAND_REMOVE_NOT_BELOW_CALLER';
  const result = mcpServer.toolError(error);
  assert.equal(result.content[0].text, realSentence);
  assert.notEqual(result.content[0].text, 'The operation stopped safely because of an internal error.');
});
check('toolError surfaces the named sentence for the shared restart/stop/resume not-below-caller refusal', () => {
  const mcpServer = require('../src/mcp-server');
  const realSentence = 'A circle is stopped or restarted by one above it. That circle is not below yours on the tree, so it is not yours to change.';
  const error = new Error(realSentence);
  error.code = 'MC_TREE_COMMAND_NOT_BELOW_CALLER';
  const result = mcpServer.toolError(error);
  assert.equal(result.content[0].text, realSentence);
  assert.notEqual(result.content[0].text, 'The operation stopped safely because of an internal error.');
});

check('standing-rule settings refusals retain their deciding sentence', () => {
  const mcpServer = require('../src/mcp-server');
  for (const code of ['R_LEDGER_AGENT_FILING_OFF', 'R_LEDGER_AGENT_FILING_PROPOSE_ONLY']) {
    const sentence = 'Turning something you said into a standing rule is off in Settings.';
    const error = Object.assign(new Error(sentence), { code });
    assert.equal(mapped(code), 'POLICY_DENIED');
    assert.equal(mcpServer.toolError(error).content[0].text, sentence);
  }
});

check('missing platform backends require intervention without blaming valid input or automatic retry', () => {
  const mcpServer = require('../src/mcp-server');
  for (const [code, sentence] of [
    ['DESKTOP_PLATFORM_UNSUPPORTED', 'This desktop operation does not yet have a native Linux backend.'],
    ['WORKSTATION_PLATFORM_UNSUPPORTED', 'Workstation setup and inventory currently require Windows.'],
    ['SCHEDULER_PLATFORM_UNSUPPORTED', 'Scheduled jobs require Windows Task Scheduler; this platform has no scheduler adapter.'],
    ['SECRET_VAULT_PLATFORM_UNSUPPORTED', 'This credential management operation requires Windows.'],
    ['DUO_DESKTOP_PLATFORM_UNSUPPORTED', 'Duo Desktop status and authentication are available only on Windows.'],
    ['OVERNIGHT_ADVISORY_WORKER_PLATFORM_UNSUPPORTED', 'Overnight advisory worker lifecycle control is available only on Windows.'],
  ]) {
    const result = mcpServer.toolError(Object.assign(new Error(sentence), { code }));
    assert.equal(result.content[0].text, sentence);
    assert.equal(result.structuredContent.error.taxonomy.code, 'INPUT_REQUIRED');
    assert.equal(result.structuredContent.error.taxonomy.retryable, false);
  }
  assert.equal(mapped('DESKTOP_ACTION_UNSUPPORTED'), 'INVALID_REQUEST');
  assert.equal(mapped('WORKSTATION_OPTION_UNSUPPORTED'), 'INVALID_REQUEST');
});

check('known cloud visibility prerequisites retain recovery instructions without exposing unknown CLI errors', () => {
  const mcpServer = require('../src/mcp-server');
  for (const code of ['CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE', 'CODEX_CLI_TASK_NOT_VISIBLE']) {
    const sentence = 'Check the selected account and the requested cloud resource.';
    const packet = mcpServer.toolError(Object.assign(new Error(sentence), { code }));
    assert.equal(packet.structuredContent.error.taxonomy.code, 'INPUT_REQUIRED');
    assert.equal(packet.structuredContent.error.taxonomy.retryable, false);
    assert.equal(packet.content[0].text, sentence);
  }
  const unknown = mcpServer.toolError(Object.assign(new Error('private-provider-failure-canary'), { code: 'CODEX_CLI_REPORTED_ERROR' }));
  assert.equal(unknown.structuredContent.error.taxonomy.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(unknown), /private-provider-failure-canary/);
});

check('disabled Accessibility preserves the explicit enablement prerequisite', () => {
  const mcpServer = require('../src/mcp-server');
  const sentence = 'Accessibility is off for this agent. The person must explicitly enable it.';
  const result = mcpServer.toolError(Object.assign(new Error(sentence), { code: 'ACCESSIBILITY_OFF' }));
  assert.equal(result.content[0].text, sentence);
  assert.equal(result.structuredContent.error.taxonomy.code, 'INPUT_REQUIRED');
  assert.equal(result.structuredContent.error.taxonomy.retryable, false);
  assert.equal(mapped('ACCESSIBILITY_UNCLASSIFIED_FAILURE'), 'INTERNAL_ERROR');
});

// --- 6. THE FILE-WRITE PROTECTION FAMILY (2026-09-12) -----------------------
// Same defect class as OWNER_PROMPT_ATTRIBUTION_REQUIRED (2026-08-11) and the
// tree-command family above (2026-09-07): host-control.js's
// checkContainmentAndExclusions and repo-files.js's write guard both already
// throw a named, actionable refusal -- "path is an integrity anchor and is
// never writable through this surface", "has a dedicated writer and cannot be
// patched through this tool" -- for host.write_file/host.patch_file and
// repo.write_file/repo.patch_file against a protected directory such as
// src/lib/. Neither HOST_PATH_WRITE_PROTECTED nor REPO_FILE_WRITE_PROTECTED
// was recognized by any rule in this ladder, so both fell through to
// INTERNAL_ERROR and every caller read "The operation stopped safely because
// of an internal error." instead of the sentence the tool had already worked
// out -- indistinguishable from a genuine unread-content refusal on the same
// path. Measured directly: host.patch_file on an unread src/lib/*.js file
// answered the opaque sentence while the identical unread-content probe on a
// tests/*.js file (not protected) correctly named HOST_FILE_READ_REQUIRED.
// Both codes are permanent, deliberate write-protection decisions -- the same
// category as FORBIDDEN/DENIED/DISABLED already on the POLICY_DENIED rule --
// so they belong beside PROTECTED there, not in a new rule of their own.
const WRITE_PROTECTION_REFUSALS = Object.freeze({
  HOST_PATH_WRITE_PROTECTED: 'POLICY_DENIED',
  REPO_FILE_WRITE_PROTECTED: 'POLICY_DENIED',
});
check('the file-write-protection fixture contains exactly the two previously-blanketed codes', () => {
  assert.equal(Object.keys(WRITE_PROTECTION_REFUSALS).length, 2);
});
for (const [source, expected] of Object.entries(WRITE_PROTECTION_REFUSALS)) {
  check(`${source} -> ${expected}`, () => { assert.equal(mapped(source), expected); });
}
check('neither write-protection code still answers the internal-error sentence', () => {
  for (const source of Object.keys(WRITE_PROTECTION_REFUSALS)) {
    const failure = errorTaxonomy.publicFailure({ code: source });
    // POLICY_DENIED is correctly 'terminal' (a permanent decision, not a
    // fault to retry) -- unlike the tree-command family above, classified
    // INVALID_REQUEST, terminal here is the right answer, not a regression.
    assert.notEqual(failure.code, 'INTERNAL_ERROR', source);
    assert.notEqual(failure.safeSummary, 'The operation stopped safely because of an internal error.', source);
  }
});
check('toolError surfaces the named sentence for a protected host.patch_file target, never the internal-error text', () => {
  const mcpServer = require('../src/mcp-server');
  const realSentence = 'path is an integrity anchor and is never writable through this surface.';
  const error = Object.assign(new Error(realSentence), { code: 'HOST_PATH_WRITE_PROTECTED' });
  const result = mcpServer.toolError(error);
  assert.equal(result.content[0].text, realSentence);
  assert.notEqual(result.content[0].text, 'The operation stopped safely because of an internal error.');
});
check('toolError surfaces the named sentence for a protected repo.patch_file target, never the internal-error text', () => {
  const mcpServer = require('../src/mcp-server');
  const realSentence = 'src/lib/runtime.js has a dedicated writer and cannot be patched through this tool.';
  const error = Object.assign(new Error(realSentence), { code: 'REPO_FILE_WRITE_PROTECTED' });
  const result = mcpServer.toolError(error);
  assert.equal(result.content[0].text, realSentence);
  assert.notEqual(result.content[0].text, 'The operation stopped safely because of an internal error.');
});
// Confirms the fix rides the existing POLICY_DENIED rule (PROTECTED joins
// FORBIDDEN/DENIED/DISABLED) rather than adding a one-off exact-code branch,
// and that segment-boundary discipline still holds for the new word: a code
// that merely contains the letters must not match.
check('a partial match on PROTECTED never fires: segment boundaries still hold for the new word', () => {
  assert.equal(mapped('UNPROTECTED_RESOURCE'), 'RESOURCE_PRESSURE', 'RESOURCE still wins on its own segment');
  assert.equal(mapped('PROTECTEDX_STATE'), 'INTERNAL_ERROR');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
