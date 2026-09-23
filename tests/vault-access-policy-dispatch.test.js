/* EXECUTABLE CHANGE

Assertion audit (testcanfail-tests-vault-access-policy-dispatch-test-js):
- Shape 1 NOT-FOUND: no assertion iterates a collection that could be empty.
- Shape 2 NOT-FOUND: no exit-status or truthy-return assertion. Case 1 asserts
  the refusal's own `code` equals a literal; case 2 asserts the SAME literal is
  absent AND that a refusal of some other kind did occur, so a tool that stopped
  reading the vault altogether could not satisfy it.
- Shape 3 FOUND AND CLOSED: an earlier draft ran the dispatch inside a bare
  `try { ... } catch { }` in the child, which reported "no error" identically
  whether the tool refused or the child crashed on a typo. The child now prints
  an explicit {ok|code|message} envelope and the parent asserts on the field,
  so a crashed child fails rather than passing.
- Shape 4 NOT-FOUND: the only seam supplied is the policy FILE and the state
  root, both real artifacts. The subject is the product's own executeTool.
- Shape 5 NOT-FOUND: no skip calls and no platform guard. The cases need no
  vault and no network: the refusal under test happens before either.
- Shape 6 NOT-FOUND: the expected code is an independent literal spelled here.
- Mutation: replacing `vaultReadPrincipals(context)` in src/lib/tool-registry.js
  with `[]` -- the shape a forgotten wiring would have -- produced RED:
  "not ok 1 - a denied role is refused when the real dispatcher runs the tool".
  Restoring produced GREEN: "# pass 2", "# fail 0". Outputs quoted in
  REPORT-LANED-ITEM1-20260919.md.
- Preconditions unmet: none.
*/

'use strict';

/*
 * THE TOOL, NOT THE MODULE -- FOR THE OWNER'S CREDENTIAL SWITCHES.
 *
 * tests/vault-access-policy-enforced.test.js proves the refusal itself, by
 * calling the read functions inside `withVaultPrincipal` directly. That leaves
 * the one question it cannot answer: does anything actually CALL
 * withVaultPrincipal on the path a real agent takes? A switch enforced by a
 * function nobody invokes is the exact defect this feature already shipped once
 * -- the desktop app's #/vault page wrote a policy that its own agent read path
 * never consulted, and every unit test of that policy passed the whole time.
 *
 * So these two cases drive src/lib/tool-registry.js `executeTool` -- the real
 * dispatcher, with a real registered tool that really reads a credential
 * (`github.issue_list` resolves `github_pat`) -- and assert that the identity on
 * the dispatch context reaches the vault read. Nothing here asserts HOW: the
 * context field, the transport and the check may all be rewritten, and these
 * cases keep their meaning as long as a denied role cannot read.
 *
 * EACH CASE RUNS IN ITS OWN PROCESS, because src/lib/runtime-state-root.js
 * resolves the state root once per process and memoises it -- two cases in one
 * process would share the first one's root.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/* The sentence's code, spelled here as an independent literal. */
const DENIED_CODE = 'VAULT_ACCESS_DENIED';

/* The credential github.issue_list resolves, and the role the policy closes. */
const RECORD = 'github_pat';
const DENIED_ROLE = 'builder';

/**
 * Drive executeTool in a cold child process against a fresh state root whose
 * policy denies `role` for `RECORD`, and return the child's outcome envelope.
 */
function dispatchAs(roleId) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-dispatch-'));
  fs.mkdirSync(path.join(stateRoot, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, 'state', 'vault-access-policy.json'),
    JSON.stringify({ version: 1, records: { [RECORD]: { access: { [DENIED_ROLE]: false } } } }),
    'utf8'
  );
  /* The child prints one JSON envelope on its last line. It NEVER swallows an
     outcome: a throw is reported with its code, a success is reported as such,
     and a crash leaves no envelope at all, which fails the parse below rather
     than reading as "no error". */
  const source = `
    const policy = require('./src/lib/permission-tier-policy');
    const session = policy.INSTALL_TIER_SESSIONS[policy.INSTALL_TIERS[policy.INSTALL_TIERS.length - 1]];
    /* A dispatch carrying an agentPrincipal must also carry the role's bound
       function policy -- executeTool refuses with ROLE_POLICY_REQUIRED
       otherwise. Built the same way src/owner-host.js boundRoleFunctionPolicy
       builds it, so this is the shape a real session presents. */
    const roleFunctions = require('./src/lib/role-functions');
    const agentRole = roleFunctions.normalizeFunctionPolicy(
      {}, roleFunctions.defaultFunctionPolicy(${JSON.stringify(roleId)}));
    const { executeTool } = require('./src/lib/tool-registry');
    executeTool('github.issue_list', { owner: 'toolsenabled', repo: 'toolsenabled', limit: 1 }, {
      permissionSession: session,
      agentRole,
      agentPrincipal: {
        kind: 'agent-session', sessionId: 'session-under-test',
        agentId: 'node-under-test', provider: 'claude', roleId: ${JSON.stringify(roleId)}
      }
    }).then(
      () => console.log(JSON.stringify({ ok: true })),
      error => console.log(JSON.stringify({ ok: false, code: error && error.code, message: error && error.message }))
    );`;
  const out = execFileSync(process.execPath, ['-e', source], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      TOOLSENABLED_STATE_ROOT: stateRoot,
      /* TOOLSENABLED_VAULT_PATH IS WHAT ACTUALLY ISOLATES THE VAULT, and it is
         required rather than tidy. A state root alone does NOT redirect the
         store: src/lib/runtime.js `vaultFilePath` honours this variable first,
         so without it a developer machine's real vault answers, the unruled
         control case below resolves the owner's real github_pat, and the test
         makes a live API call with it. That is exactly what the first run of
         this file did -- it returned HTTP 404 from api.github.com -- which is
         how the omission was found. */
      TOOLSENABLED_VAULT_PATH: path.join(stateRoot, 'vault', 'secrets.json'),
      /* The owner must not be asked to type a credential during a test run, and
         a queued owner prompt is not the outcome under test. */
      TOOLSENABLED_DEFER_CREDENTIAL_PROMPTS: '1'
    }
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('a denied role is refused when the real dispatcher runs the tool', () => {
  const answer = dispatchAs(DENIED_ROLE);
  assert.equal(answer.ok, false, 'a denied role must not complete the call');
  assert.equal(answer.code, DENIED_CODE,
    `the dispatcher did not carry the caller's identity to the vault read; got ${answer.code}: ${answer.message}`);
});

test('a role the owner has not closed is not refused by the policy', () => {
  /* The control. Without it, a dispatcher that refused EVERY credential read
     would satisfy the case above and look like a working switch.
     The isolated vault holds nothing, so the honest expected outcome is the
     vault's own "not configured" -- a DIFFERENT refusal, from a different
     subject, which is the whole point. */
  const answer = dispatchAs('reviewer');
  assert.notEqual(answer.code, DENIED_CODE,
    'a role the owner never closed was refused by the owner policy');
  /* NON-VACUITY WITHOUT PINNING A LOAD-SENSITIVE OUTCOME. The call must have got
     PAST the dispatcher and reached the vault -- otherwise a gate failing early
     for an unrelated reason would satisfy the line above and this case would
     prove nothing. What it must NOT do is require one exact vault answer: with
     the store empty the honest answer is SECRET_NOT_CONFIGURED, but under
     machine load the same read degrades to the vault's generic "could not be
     read", and asserting the former made this case red on a busy machine while
     the product behaved correctly. Measured here: a concurrent run of the
     sibling suite produced exactly that false red. So the assertion is that the
     refusal is not one of the pre-vault dispatch refusals. */
  assert.equal(
    ['ROLE_POLICY_REQUIRED', 'PERMISSION_SESSION_REQUIRED', 'PERMISSION_EFFECT_REFUSED',
      'TOOL_NOT_REGISTERED', 'ROLE_DIRECT_USER_REQUEST_REQUIRED'].includes(answer.code), false,
    `the call never reached the vault; it was refused earlier by ${answer.code}: ${answer.message}`
  );
});
