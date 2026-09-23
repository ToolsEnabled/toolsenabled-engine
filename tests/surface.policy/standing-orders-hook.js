// EXECUTABLE CHANGE — testcanfail-tests-surface-policy-standing-orders-hook-js
'use strict';

/*
 * CAN-FAIL AUDIT (2026-08-26)
 *
 * STRENGTHENED: "the hook never touches the real production ledger during
 * this suite" formerly asserted only that the ledger existed.  That assertion
 * stayed green if the hook mutated the ledger, so it supplied no evidence for
 * the property named by the check.  The test now snapshots the production
 * ledger before any hook invocation and compares its bytes and mtime afterward.
 *
 * Mutation: temporarily added an fs.writeFileSync() of the production ledger
 * to tools/standing-orders-hook.js.  The focused scratch replay went RED with:
 *   AssertionError [ERR_ASSERTION]: the hook changed the real production ledger's bytes
 *   + actual - expected
 *   + '{"mutated":true}'
 * The mutation was restored byte-for-byte.  A final full-file green run could
 * The old suite also read this checkout's private `.codex/hooks.json`. That
 * file is client-owned project state, not a shipped engine artifact, so those
 * three registration-wrapper checks were retired. The shipped policy script's
 * allow/refusal/advisory behavior remains exercised directly below.
 *
 * NOT-FOUND (1): no assertion is guarded only by an empty loop; the sole
 * assertion loop is preceded by an exact, non-empty roster assertion.
 * NOT-FOUND (2): refusal exit assertions also pin the hook's own stderr; allow
 * exits pin silence, advisory output, or records except where allowance itself
 * is the contract.
 * NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure;
 * catches are confined to log/file parsing helpers and cleanup.
 * NOT-FOUND (4): no mock substitutes for the standing-orders hook.
 * NOT-FOUND (5): no skip or platform precondition guard turns the file into a
 * no-op (the missing Windows/config preconditions fail loudly instead).
 * NOT-FOUND (6): expected values are contract literals, not results computed
 * by the production classifier under test.
 */

// Contract tests for the STANDING-ORDERS.md PreToolUse hook
// (tools/standing-orders-hook.js). This drives the hook exactly the way
// Claude Code and Codex do: spawn it, write the tool-call JSON to stdin, and
// read its exit code + stderr/stdout back. Both clients treat exit 2 + stderr
// as "block before execution" and exit 0 as "allow"; Codex also consumes the
// same hookSpecificOutput.additionalContext advisory shape.
//
// Anchor cases: the exact incident strings (McNair filename, the delegation
// bypass, the grep-drift reminder) are pinned so a regression that reopens
// any of the three real incidents this hook exists to prevent fails loudly.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'tools', 'standing-orders-hook.js');
const HOOK_LOG = path.join(ROOT, 'logs', 'standing-orders-hook.log');
const REAL_LEDGER = path.join(ROOT, 'reports', 'OWNER-REQUEST-LEDGER.json');
const realLedgerBefore = fs.existsSync(REAL_LEDGER)
  ? { contents: fs.readFileSync(REAL_LEDGER), mtimeMs: fs.statSync(REAL_LEDGER).mtimeMs }
  : null;

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

function runHook(payload, extraEnv) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv }
  });
  assert.equal(result.error, undefined, `hook process failed to spawn: ${result.error}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/* WHAT THE HOOK RECORDED WHILE THIS CALL WENT THROUGH.
 *
 * Needed because STANDING-ORDERS.md class BROWSER rule 1 no longer BLOCKS
 * (retired by the owner on 2026-08-10, commit 49263c2). Its enforcement now
 * lives entirely in the record: the hook still recognises a browser-driving
 * command and writes `allow-rule1-retired`, or `allow-delegated` when the
 * caller marked itself. Asserting only "exit 0" after the retirement would be
 * a check that cannot fail -- exit 0 is what EVERY unmatched command returns --
 * so the log line is the observable, and it is the one the retirement commit
 * deliberately kept ("retiring a rule is not a reason to go blind to the
 * surface it watched").
 *
 * Read by byte offset rather than by truncating the file: this is the real
 * production log and other lanes' hook invocations append to it concurrently.
 */
function hookLogSize() {
  try { return fs.statSync(HOOK_LOG).size; } catch { return 0; }
}

function hookLogSince(offset) {
  let text = '';
  try {
    const handle = fs.openSync(HOOK_LOG, 'r');
    try {
      const size = fs.fstatSync(handle).size;
      const length = Math.max(0, size - offset);
      const buffer = Buffer.alloc(length);
      if (length > 0) fs.readSync(handle, buffer, 0, length, offset);
      text = buffer.toString('utf8');
    } finally { fs.closeSync(handle); }
  } catch { return []; }
  return text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function runHookRecorded(payload, extraEnv) {
  const offset = hookLogSize();
  const result = runHook(payload, extraEnv);
  return Object.assign({}, result, { log: hookLogSince(offset) });
}

function browserEntry(result) {
  return result.log.filter((entry) => entry && entry.rule === 'BROWSER').pop() || null;
}

function advisoryContext(result) {
  if (!result.stdout) return '';
  const output = JSON.parse(result.stdout);
  return output && output.hookSpecificOutput && output.hookSpecificOutput.additionalContext || '';
}

function bashCall(command, cwd) {
  return { tool_name: 'Bash', tool_input: { command }, cwd: cwd || ROOT };
}

function powershellCall(command, cwd) {
  return { tool_name: 'PowerShell', tool_input: { command }, cwd: cwd || ROOT };
}

// Isolated scratch tree *inside* the repo: the hook mirrors mcp-call.js's own
// containment rule (an --input path must resolve inside ROOT), so a fixture
// under the OS temp dir would silently fail to be read -- that would make
// this test pass for the wrong reason. scratch/ already holds this kind of
// throwaway fixture for other tools (see .gitignore) and this suite cleans up
// after itself in every case, including a thrown assertion.
fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });
const scratchRoot = fs.mkdtempSync(path.join(ROOT, 'scratch', 'standing-orders-hook-test-'));

function writeJson(name, data) {
  const file = path.join(scratchRoot, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

function relFromRoot(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

try {
  // `.codex/hooks.json` belongs to the client/project installation and is not
  // part of the engine payload. Registration composition is covered with
  // disposable client fixtures in tests/agent-onboarding-hook-contract.js;
  // this suite begins at the shipped standing-orders policy boundary itself.

  // --- pass-through: tool/rule that shouldn't ever match --------------------

  check('an ordinary harmless bash command is allowed silently', () => {
    const result = runHook(bashCall('npm test'));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  check('a non-Bash/PowerShell tool call is allowed without inspection', () => {
    const result = runHook({ tool_name: 'Read', tool_input: { file_path: 'x.js' }, cwd: ROOT });
    assert.equal(result.status, 0);
  });

  check('an empty/missing command is allowed', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: {}, cwd: ROOT });
    assert.equal(result.status, 0);
  });

  // --- fail-open --------------------------------------------------------

  check('malformed JSON on stdin fails open (exit 0, not a crash)', () => {
    const result = runHook('{not valid json');
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  check('empty stdin fails open', () => {
    const result = runHook('');
    assert.equal(result.status, 0);
  });

  // --- the live BOM bug (Q31 build item 4) -----------------------------------
  //
  // Live, non-synthetic bug found in this session's own adversarial replay:
  // Claude Code wrote a leading UTF-8 BOM on stdin for 14/107 (~13%) of this
  // session's real PreToolUse invocations. JSON.parse('\uFEFF{...}') throws,
  // which previously fell straight into the stdin-parse fail-open path --
  // this hook silently had no opinion on those calls. These two checks prove
  // the fix by driving an otherwise-blocking payload through a BOM prefix and
  // confirming it still blocks (i.e. it was actually parsed, not silently
  // skipped).

  check('a BOM-prefixed harmless command still parses and is allowed (not a crash)', () => {
    const result = runHook(`\uFEFF${JSON.stringify(bashCall('npm test'))}`);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  check('a BOM-prefixed payload that would otherwise be BLOCKED is still blocked, not fail-open', () => {
    const input = writeJson('req-bom-mcnair.json', {
      tool: 'gmail.send',
      arguments: { filePath: 'C:/Users/owner/Desktop/McNair Draft 7.28 (agent-reviewed).pdf', to: 'advisor@example.edu' }
    });
    const payload = `\uFEFF${JSON.stringify(bashCall(`node tools/mcp-call.js --input "${relFromRoot(input)}"`))}`;
    const result = runHook(payload);
    assert.equal(result.status, 2, 'a BOM before the JSON payload must not cause this hook to silently fail open on a real leak');
    assert.match(result.stderr, /Class OUTWARD, rule 3/);
    assert.match(result.stderr, /AGENT_PROVENANCE/);
  });

  check('stripBom() is a no-op on text with no BOM and strips exactly one leading BOM', () => {
    const { stripBom } = require('../../tools/standing-orders-hook');
    assert.equal(stripBom('{"a":1}'), '{"a":1}');
    assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
    assert.equal(stripBom('\uFEFF\uFEFF{"a":1}'), '\uFEFF{"a":1}');
    assert.equal(stripBom(''), '');
    assert.equal(stripBom(undefined), undefined);
  });

  /* --- BROWSER class ------------------------------------------------------
     RECONCILED 2026-08-11 AGAINST THE CURRENT ORDERS, which is what these
     checks had drifted from rather than a bug in the hook.

     STANDING-ORDERS.md class BROWSER rule 1 was RETIRED by the owner on
     2026-08-10 in his own words -- "literally you can drive the browsers as
     needed that was a thread specific rule and needs to be cleaned up" -- and
     tools/standing-orders-hook.js was changed to match at commit 49263c2. The
     three checks below still demanded exit 2 and the literal "Class BROWSER,
     rule 1", so they asserted a rule the product had deliberately removed.
     Reading them as a regression would have argued for putting back the block
     that now refuses exactly what the owner requires (signing in as a user
     through a real browser). A test that outlives its rule does not protect
     anything; it manufactures a defect.

     WHAT SURVIVED THE RETIREMENT, and is therefore what is asserted now:
       * the hook still RECOGNISES a browser-driving command (isBrowserDriving),
       * it still RECORDS every one to logs/standing-orders-hook.log, which is
         the half the retirement commit kept on purpose, and
       * it still tells a DELEGATED caller from an undelegated one --
         `allow-delegated` vs `allow-rule1-retired`.
     Each check therefore asserts the recorded decision, not merely exit 0.
     Exit 0 is what every unmatched command returns, so an exit-code-only check
     here would pass with the whole BROWSER classifier deleted.

     Class BROWSER *rule 2* -- never copy the owned browser profile, cookies or
     CDP endpoint into a container -- is untouched, still enforced, and covered
     by tests/surface.policy/action-guards.js, not here. */

  check('a controller command driving the browser via CDP is allowed and recorded', () => {
    const command = 'node -e "require(\'playwright\').chromium.connectOverCDP(\'http://localhost:9222\')"';
    const result = runHookRecorded(bashCall(command));
    assert.equal(result.status, 0, `the retired rule 1 must not block: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stderr, /Class BROWSER/, 'rule 1 has been retired and must not be re-raised');
    const entry = browserEntry(result);
    assert.ok(entry, 'a CDP command left no BROWSER entry in the hook log, so the surface the retirement kept watching has gone blind');
    assert.equal(entry.decision, 'allow-rule1-retired');
    assert.match(String(entry.command), /connectOverCDP/);
  });

  check('playwright-call.js without delegation is allowed and recorded as undelegated', () => {
    const result = runHookRecorded(bashCall('node tools/playwright-call.js --action browser_navigate'));
    assert.equal(result.status, 0, result.stderr);
    const entry = browserEntry(result);
    assert.ok(entry, 'the playwright gateway left no BROWSER entry in the hook log');
    assert.equal(entry.decision, 'allow-rule1-retired');
  });

  check('a raw --remote-debugging-port CDP launch is allowed and recorded', () => {
    const result = runHookRecorded(bashCall('chrome.exe --remote-debugging-port=9222'));
    assert.equal(result.status, 0, result.stderr);
    const entry = browserEntry(result);
    assert.ok(entry, 'a raw --remote-debugging-port launch left no BROWSER entry in the hook log');
    assert.equal(entry.decision, 'allow-rule1-retired');
  });

  /* The three delegation checks below used to assert only `status === 0`.
     Since the retirement that is true of every command on this machine, so
     they had become checks that cannot fail -- the exact shape the owner
     called out. They now assert the DISTINCTION the delegation signal exists
     to make, which is the only thing that can still regress here. */
  check('the same command with the bash CONTROLLER_DELEGATED=1 marker is recorded as delegated', () => {
    const result = runHookRecorded(bashCall('CONTROLLER_DELEGATED=1 node tools/playwright-call.js --action browser_navigate'));
    assert.equal(result.status, 0);
    const entry = browserEntry(result);
    assert.ok(entry, 'a delegated browser command left no BROWSER entry in the hook log');
    assert.equal(entry.decision, 'allow-delegated');
  });

  check('the same command with the powershell $env: marker is recorded as delegated', () => {
    const result = runHookRecorded(powershellCall('$env:CONTROLLER_DELEGATED="1"; node tools/playwright-call.js --action browser_navigate'));
    assert.equal(result.status, 0);
    const entry = browserEntry(result);
    assert.ok(entry, 'a delegated browser command left no BROWSER entry in the hook log');
    assert.equal(entry.decision, 'allow-delegated');
  });

  check('the delegation env var itself (session-level, not inline) is recorded as delegated', () => {
    const result = runHookRecorded(bashCall('node tools/playwright-call.js --action browser_navigate'), { CONTROLLER_DELEGATED: '1' });
    assert.equal(result.status, 0);
    const entry = browserEntry(result);
    assert.ok(entry, 'a session-delegated browser command left no BROWSER entry in the hook log');
    assert.equal(entry.decision, 'allow-delegated');
  });

  /* The carve-outs. `status === 0` cannot distinguish "carved out" from
     "allowed like everything else" now that rule 1 is retired, so each asserts
     the absence of a BROWSER record: isBrowserDriving() must return false, not
     merely reach a decision that happens to allow. */
  check('running this repo\'s own browser test suite is NOT treated as driving a browser', () => {
    const result = runHookRecorded(bashCall('npm run test:browser'));
    assert.equal(result.status, 0);
    assert.equal(browserEntry(result), null, 'the repo\'s own browser suite was classified as driving a browser');
  });

  check('npx playwright install is NOT treated as driving a browser', () => {
    const result = runHookRecorded(bashCall('npx playwright install chromium'));
    assert.equal(result.status, 0);
    assert.equal(browserEntry(result), null, 'a package download was classified as driving a browser');
  });

  check('an unrelated command that merely mentions "playwright" in a path under tests/ is allowed', () => {
    const result = runHookRecorded(bashCall('node tests/playwright-gateway.js'));
    assert.equal(result.status, 0);
    assert.equal(browserEntry(result), null, 'a path under tests/ was classified as driving a browser');
  });

  // --- OUTWARD class: filename/metadata provenance -------------------------

  check('the real incident filename, submitted via mcp-call.js gmail.send, is BLOCKED', () => {
    const input = writeJson('req-mcnair-leak.json', {
      tool: 'gmail.send',
      arguments: { filePath: 'C:/Users/owner/Desktop/McNair Draft 7.28 (agent-reviewed).pdf', to: 'advisor@example.edu' }
    });
    const result = runHook(bashCall(`node tools/mcp-call.js --input "${relFromRoot(input)}"`));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Class OUTWARD, rule 3/);
    assert.match(result.stderr, /AGENT_PROVENANCE/);
  });

  check('a clean filename via mcp-call.js is ALLOWED', () => {
    const input = writeJson('req-clean.json', {
      tool: 'gmail.send',
      arguments: { filePath: 'C:/Users/owner/Desktop/McNair Current.pdf', to: 'advisor@example.edu' }
    });
    const result = runHook(bashCall(`node tools/mcp-call.js --input "${relFromRoot(input)}"`));
    assert.equal(result.status, 0);
  });

  check('dirty document metadata (clean filename) via mcp-call.js is BLOCKED', () => {
    const input = writeJson('req-dirty-metadata.json', {
      tool: 'drive.upload',
      arguments: { filePath: 'C:/Users/owner/Desktop/McNair Current.pdf', metadata: { author: 'Claude' } }
    });
    const result = runHook(bashCall(`node tools/mcp-call.js --input "${relFromRoot(input)}"`));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /AGENT_PROVENANCE|MODEL_NAME/);
  });

  check('a non-outward mcp-call.js tool (e.g. system.status) is NOT inspected', () => {
    const input = writeJson('req-not-outward.json', {
      tool: 'system.status',
      arguments: { filePath: 'C:/Users/owner/Desktop/anything (agent-reviewed).pdf' }
    });
    const result = runHook(bashCall(`node tools/mcp-call.js --input "${relFromRoot(input)}"`));
    assert.equal(result.status, 0);
  });

  check('a direct curl upload with a dirty filename (spaces + parens) to an external host is BLOCKED', () => {
    const command = 'curl -X POST https://canvas.university.edu/upload -F "file=@C:/Users/owner/Desktop/McNair Draft 7.28 (agent-reviewed).pdf"';
    const result = runHook(bashCall(command));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /AGENT_PROVENANCE/);
  });

  check('a direct curl POST to localhost is not treated as an outward candidate', () => {
    const command = 'curl -X POST http://localhost:3000/upload -F "file=@C:/Users/owner/Desktop/x (agent-reviewed).pdf"';
    const result = runHook(bashCall(command));
    assert.equal(result.status, 0);
  });

  check('Invoke-RestMethod -InFile upload with a dirty filename to an external host is BLOCKED', () => {
    const command = 'Invoke-RestMethod -Uri https://canvas.university.edu/upload -Method Post -InFile "C:/Users/owner/Desktop/Essay (ai-generated).docx"';
    const result = runHook(powershellCall(command));
    assert.equal(result.status, 2);
  });

  // --- OUTWARD class: owner-instruction gates -------------------------------

  check('an unmet gate on the request is BLOCKED, naming the unmet instruction', () => {
    const ledger = writeJson('ledger-unmet.json', {
      requests: [{
        id: 'R-TEST-UNMET',
        gates: [{ instruction: 'pull the previous week submission and check', met: false, evidence: '' }]
      }]
    });
    const input = writeJson('req-gated-unmet.json', {
      tool: 'gmail.send',
      arguments: { filePath: 'C:/Users/owner/Desktop/McNair Current.pdf', requestId: 'R-TEST-UNMET' }
    });
    const result = runHook(
      bashCall(`node tools/mcp-call.js --input "${relFromRoot(input)}"`),
      { STANDING_ORDERS_HOOK_LEDGER_FILE: ledger }
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Class OUTWARD, rule 4/);
    assert.match(result.stderr, /pull the previous week submission and check/);
  });

  check('a met gate (with evidence) on the request is ALLOWED', () => {
    const ledger = writeJson('ledger-met.json', {
      requests: [{
        id: 'R-TEST-MET',
        gates: [{ instruction: 'pull the previous week submission and check', met: true, evidence: 'verified against rweb 2026-07-28' }]
      }]
    });
    const input = writeJson('req-gated-met.json', {
      tool: 'gmail.send',
      arguments: { filePath: 'C:/Users/owner/Desktop/McNair Current.pdf', requestId: 'R-TEST-MET' }
    });
    const result = runHook(
      bashCall(`node tools/mcp-call.js --input "${relFromRoot(input)}"`),
      { STANDING_ORDERS_HOOK_LEDGER_FILE: ledger }
    );
    assert.equal(result.status, 0);
  });

  check('a requestId unknown to the ledger fails open (advisory hook, not the sole gate) rather than blocking unrelated calls', () => {
    const ledger = writeJson('ledger-empty.json', { requests: [] });
    const input = writeJson('req-unknown-id.json', {
      tool: 'gmail.send',
      arguments: { filePath: 'C:/Users/owner/Desktop/McNair Current.pdf', requestId: 'R-DOES-NOT-EXIST' }
    });
    const result = runHook(
      bashCall(`node tools/mcp-call.js --input "${relFromRoot(input)}"`),
      { STANDING_ORDERS_HOOK_LEDGER_FILE: ledger }
    );
    assert.equal(result.status, 0);
  });

  check('the hook never touches the real production ledger during this suite', () => {
    // Guard against a future edit accidentally dropping the env override:
    // every gate-bearing case above passed STANDING_ORDERS_HOOK_LEDGER_FILE,
    // so the real reports/OWNER-REQUEST-LEDGER.json's mtime should be
    // untouched by this file.
    if (realLedgerBefore === null) {
      assert.equal(fs.existsSync(REAL_LEDGER), false,
        'the hook must not create a production ledger when the customer has none');
      return;
    }
    assert.ok(fs.existsSync(REAL_LEDGER), 'the hook must not remove the real production ledger');
    assert.deepEqual(
      fs.readFileSync(REAL_LEDGER),
      realLedgerBefore.contents,
      "the hook changed the real production ledger's bytes"
    );
    assert.equal(
      fs.statSync(REAL_LEDGER).mtimeMs,
      realLedgerBefore.mtimeMs,
      "the hook changed the real production ledger's mtime"
    );
  });

  // --- LOCAL-WORK advisory (rule 0): never blocks ---------------------------

  check('a symbol-shaped grep against src/ gets an advisory reminder, exit 0', () => {
    const result = runHook(bashCall('grep -rn assertGatesMet src/lib'));
    const context = advisoryContext(result);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /LOCAL-WORK lookup ladder reminder/);
    assert.match(result.stdout, /assertGatesMet/);
    assert.match(context, /If code\.\* is unreachable or absent in this session, report that limitation instead of silently falling back to grep; otherwise use the ladder above\./);
    assert.doesNotMatch(context, /(?:^|\n)code\.\* is (?:unreachable|absent|missing) in this session/i);
    assert.match(result.stdout, /advisory only and does not block/);
  });

  check('a symbol-shaped rg call gets the same reminder', () => {
    const result = runHook(bashCall('rg checkOutward tests'));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /LOCAL-WORK lookup ladder reminder/);
  });

  check('PowerShell Select-String on a symbol-shaped pattern gets the reminder', () => {
    const result = runHook(powershellCall('Select-String -Pattern "isBrowserDriving" -Path tools/*.js'));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /LOCAL-WORK lookup ladder reminder/);
  });

  check('the advisory output is valid for Codex and carries the dense-symbol byte caveat', () => {
    const result = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: "rg -n 'isBrowserDriving' tools/standing-orders-hook.js" },
      cwd: ROOT,
      turn_id: 'turn-contract',
      permission_mode: 'default'
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined,
      'an advisory must not claim a Codex permission decision');
    assert.match(output.hookSpecificOutput.additionalContext, /document_symbols saves bytes/);
    assert.match(output.hookSpecificOutput.additionalContext, /inspect its measurement/);
  });

  check('grepping prose (README.md, no code extension) gets no reminder', () => {
    const result = runHook(bashCall('grep -n TODO README.md'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stdout, /If code\.\* is unreachable or absent in this session/);
  });

  check('grepping a plain English word (not symbol-shaped) gets no reminder', () => {
    const result = runHook(bashCall('grep -rn error src'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stdout, /If code\.\* is unreachable or absent in this session/);
  });

  check('a bare npm/test command with no grep tool present gets no reminder', () => {
    const result = runHook(bashCall('npm run test:state'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  check('the exact replay command -- a quoted multi-word grep pattern -- now gets the reminder', () => {
    // Live bug found in this session's own adversarial replay: isSymbolShaped()
    // rejected any pattern containing a space, so a quoted multi-word grep
    // pattern got no lookup-ladder nudge even though it names a real symbol.
    const result = runHook(bashCall("grep -n 'function assertGatesMet' src/lib/tool-registry.js"));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /LOCAL-WORK lookup ladder reminder/);
    assert.match(result.stdout, /function assertGatesMet/);
  });

  check('a quoted multi-word pattern with no identifier-shaped word still gets no reminder', () => {
    const result = runHook(bashCall("grep -n 'the quick fox' src/lib/tool-registry.js"));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  check('a PowerShell Select-String call is recognized without private standing-order state', () => {
    // A customer is not required to install a private standing-orders mirror
    // for the shipped lookup-ladder advisory to remain active.
    const result = runHook(powershellCall('Select-String -Pattern "checkOutward" -Path tools/*.js'));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /LOCAL-WORK lookup ladder reminder/);
  });

  // --- fail-open under real conditions --------------------------------------

  check('an mcp-call.js --input pointing outside the repo root is ignored, not blocked', () => {
    const outside = path.join(os.tmpdir(), 'standing-orders-hook-outside.json');
    fs.writeFileSync(outside, JSON.stringify({ tool: 'gmail.send', arguments: { filePath: 'x (agent-reviewed).pdf' } }));
    try {
      const result = runHook(bashCall(`node tools/mcp-call.js --input "${outside}"`));
      assert.equal(result.status, 0);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  check('an mcp-call.js --input pointing at a nonexistent file is ignored, not blocked', () => {
    const result = runHook(bashCall('node tools/mcp-call.js --input "scratch/does-not-exist-9d3f.json"'));
    assert.equal(result.status, 0);
  });

  console.log(`Standing-orders hook tests passed (${checks} checks; the McNair filename still blocks at the shipped policy boundary, and BROWSER rule 1's retirement is pinned by its RECORD -- allow-rule1-retired vs allow-delegated -- rather than by an exit code that no longer distinguishes anything).`);
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
