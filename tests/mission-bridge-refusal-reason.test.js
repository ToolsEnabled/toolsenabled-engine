'EXECUTABLE CHANGE';
'use strict';

/* ASSERTION CAN-FAIL AUDIT.
 * Strengthened: the two absent-registry assertions below now require the
 * refusal to exist as well as requiring it not to contain an accounts array.
 * Mutation: readAccountRegistry attached `accounts = []` to each missing-
 * registry refusal before rethrowing it. Both strengthened assertions failed
 * with "AssertionError [ERR_ASSERTION]: the checkout refusal was not mutated
 * into a zero-account reading" and "AssertionError [ERR_ASSERTION]: mutation
 * check: an absent installed registry cannot report zero accounts".
 * The source file was then restored byte-for-byte; the confirming green run
 * printed "mission-bridge-refusal-reason: 35 checks passed".
 *
 * NOT-FOUND (1): both collection loops are non-vacuous. The fixed table is a
 * literal with ten rows; the source-message sweep has a >40 cardinality guard.
 * NOT-FOUND (2): this test makes no exit-status or truthy-process assertion.
 * NOT-FOUND (3): caught refusals are retained and asserted; the async wrapper
 * has a rejecting terminal catch. The cleanup catch cannot hide the subject.
 * NOT-FOUND (4): no mock replaces typedError, publicReason, or registry load.
 * NOT-FOUND (5): there are no skips or platform precondition guards.
 * NOT-FOUND (6): explicit expected strings are independent of the scrubber.
 * Preconditions: all met; the isolated runner and writable scratch directory
 * were available on this platform.
 */

/* THE REASON A REFUSAL GIVES HAS TO BE THE REAL ONE.
 *
 * THE DEFECT. `typedError()` kept the underlying error's CODE and threw its
 * MESSAGE away, replacing every one with the literal "The audited dependency
 * refused the action." Six words that are true of every refusal in the product
 * and therefore tell nobody anything. The owner met it twice on one screen --
 * the Codex Cloud panel printed the same 47-word paragraph in two adjacent
 * places -- and again on the ledger, where "This folder's work list could not
 * be read, so Claim and Close are off." is followed by exactly that sentence.
 * The comment above cloudRefusal() in actions.js even claimed the message was
 * preserved. It was not.
 *
 * WHAT MUST BE TRUE INSTEAD, and the two halves pull against each other:
 *
 *   1. the real reason survives, so a person is told what actually happened;
 *   2. nothing a person cannot use travels with it -- no absolute path, no
 *      loopback address, no SCREAMING_SNAKE code. The renderer's own rule
 *      (src/refusal-copy.js in the dashboard tree) is that an identifier is a
 *      machine field carried on the node, never a word in the sentence, and it
 *      only strips a reason that is a bare identifier ALL BY ITSELF. An
 *      identifier embedded in an otherwise-English sentence would go straight
 *      to the glass, so the bridge is the place that has to guarantee it.
 *
 * A message that cannot satisfy (2) falls back to the old constant. That is a
 * loss, and it is the right loss: a sentence with a stranger's file path in it
 * is worse than a vague one.
 *
 * AND UNKNOWN IS NOT EMPTY. A missing registry says that this reader has no
 * account answer. It must never be converted to `accounts: []`, because that
 * sentence tells a person with a registry elsewhere that they have zero.
 *
 * Run: node tests/run-isolated.js tests/mission-bridge-refusal-reason.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const { MissionBridgeError, typedError } = require('../src/lib/mission-bridge/errors');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');

let checks = 0;
function ok(condition, message) { checks += 1; assert.ok(condition, message); }
function equal(actual, expected, message) { checks += 1; assert.strictEqual(actual, expected, message); }

const CONSTANT = 'The audited dependency refused the action.';
/* The two shapes that must never reach a person, taken from the rules the
   dashboard already enforces on its own strings. */
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/])|(?:\s\/(?:[\w.@%+-]+\/){2,})/;
const EMBEDDED_IDENTIFIER = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

/* ------------------------------------------------------------------ *
 * 1. THE REAL REASON SURVIVES.
 * ------------------------------------------------------------------ */

{
  const real = 'No configured Codex account can see that environment. A Codex Cloud environment is scoped to the account that created it.';
  const typed = typedError(new CloudAgentError('CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE', real));
  equal(typed.code, 'CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE', 'the code is still kept');
  ok(typed.message !== CONSTANT, 'the underlying reason must not be replaced by the constant');
  ok(typed.message.includes('scoped to the account that created it'),
    `the real reason must survive; got ${JSON.stringify(typed.message)}`);
}

{
  /* An error with no usable code still keeps its words. This is the shape a
     dependency that is not one of ours throws. */
  const typed = typedError(new Error('The Codex command line is not installed on this computer.'));
  equal(typed.code, 'BRIDGE_DEPENDENCY_REFUSED', 'an unrecognised code still falls to the bridge code');
  ok(typed.message.includes('not installed on this computer'),
    `an untyped error still carries its own words; got ${JSON.stringify(typed.message)}`);
}

/* ------------------------------------------------------------------ *
 * 2. NOTHING A PERSON CANNOT USE TRAVELS WITH IT.
 * ------------------------------------------------------------------ */

{
  /* The registry's real sentence, kept in step with
     src/lib/multi-account/registry.js. Its remedy used to be "Create it before
     switching accounts" -- an instruction to hand-author JSON, which was the
     only on-ramp the product had until registry-write.js existed. The half a
     person can act on is now an action rather than a filename, and it is that
     half this asserts survives the scrub. */
  const withPath = new CloudAgentError('ACCOUNTS_REGISTRY_MISSING',
    'No account registry at C:\\Users\\someone\\AppData\\Local\\ToolsEnabled\\config\\accounts.json. Add an account in ToolsEnabled and it will be written; nobody has to create this file by hand.');
  const typed = typedError(withPath);
  ok(!ABSOLUTE_PATH.test(typed.message), `a file path reached the glass: ${JSON.stringify(typed.message)}`);
  ok(typed.message.includes('Add an account in ToolsEnabled'),
    `the half a person can act on must survive the scrub; got ${JSON.stringify(typed.message)}`);
  ok(!/create it/i.test(typed.message),
    `the refusal still tells a person to create a file: ${JSON.stringify(typed.message)}`);
}

{
  const withLoopback = new CloudAgentError('BRIDGE_DEPENDENCY_REFUSED',
    'The capability layer at http://127.0.0.1:4610/v1/actions did not answer.');
  const typed = typedError(withLoopback);
  ok(!/127\.0\.0\.1|localhost/.test(typed.message), `an address reached the glass: ${JSON.stringify(typed.message)}`);
}

{
  const withCode = new CloudAgentError('ACCOUNT_PROBE_FAILED',
    'This account could not be checked (ACCOUNT_PROFILE_UNAVAILABLE). That says nothing about its allowance.');
  const typed = typedError(withCode);
  ok(!EMBEDDED_IDENTIFIER.test(typed.message), `an identifier reached the glass: ${JSON.stringify(typed.message)}`);
  ok(typed.message.includes('says nothing about its allowance'),
    `the sentence should survive with only the code removed; got ${JSON.stringify(typed.message)}`);
}

{
  /* Nothing usable is left after the scrub, so the honest fallback is the old
     constant rather than a fragment. */
  const typed = typedError(new Error('C:\\Users\\someone\\state\\accounts.json'));
  equal(typed.message, CONSTANT, 'a message that is nothing but machine detail falls back to the constant');
}

{
  /* A Node errno error leads with its own code. The prefix goes; the English
     stays. */
  const errno = new Error("ENOENT: no such file or directory, open 'C:\\Users\\someone\\config\\accounts.json'");
  errno.code = 'ENOENT';
  const typed = typedError(errno);
  ok(!/ENOENT/.test(typed.message), `a Node error code reached the glass: ${JSON.stringify(typed.message)}`);
  ok(!ABSOLUTE_PATH.test(typed.message), `a file path reached the glass: ${JSON.stringify(typed.message)}`);
  ok(/no such file or directory/i.test(typed.message),
    `the reason should survive the errno prefix; got ${JSON.stringify(typed.message)}`);
}

{
  /* A MissionBridgeError is already the product's own sentence and is returned
     untouched -- this is the path every refuse() in actions.js takes, and
     changing it would rewrite ~70 curated messages. */
  const own = new MissionBridgeError('BRIDGE_INPUT_INVALID', 'reason is invalid.', { status: 400 });
  equal(typedError(own), own, 'the bridge\u2019s own errors are returned unchanged');
}

{
  const typed = typedError({ code: 'CLOUD_UNAUTHORIZED_THING' });
  equal(typed.status, 401, 'the unauthorised status rule is unchanged');
  equal(typed.message, CONSTANT, 'an error with no message at all still gets the constant');
}

/* ------------------------------------------------------------------ *
 * 2b. THE TEN MESSAGES THIS TREE REALLY THROWS, EACH WITH THE SENTENCE A
 *     PERSON SHOULD END UP READING. Written out rather than asserted by
 *     pattern, because "no path survived" is satisfied by returning nothing,
 *     and what has to survive is the ENGLISH.
 * ------------------------------------------------------------------ */

{
  const P = String.raw`C:\Users\someone\AppData\Local\ToolsEnabled\config\accounts.json`;
  const table = [
    [`The account registry at ${P} is not valid JSON, so no account can be selected.`,
      'The account registry is not valid JSON, so no account can be selected.'],
    [`The account registry at ${P} has no "accounts" array.`,
      'The account registry has no "accounts" array.'],
    [`No account registry at ${P}. Add an account in ToolsEnabled and it will be written; nobody has to create this file by hand.`,
      'No account registry. Add an account in ToolsEnabled and it will be written; nobody has to create this file by hand.'],
    ['The account registry lists no accounts.',
      'The account registry lists no accounts.'],
    /* The address in this one is a page a person is meant to VISIT, and it has
       to survive: it is the whole of the instruction. */
    ['environment must be a 32-character Codex Cloud environment id (for example the id in the chatgpt.com/codex/cloud/settings/environment/<id> URL), not the "Owner/repo" display label.',
      'environment must be a 32-character Codex Cloud environment id (for example the id in the chatgpt.com/codex/cloud/settings/environment/<id> URL), not the "Owner/repo" display label.'],
    ['No configured Codex account can serve this launch right now.',
      'No configured Codex account can serve this launch right now.'],
    ['BUILD-QUEUE.md was not found in that folder, so its work list could not be read.',
      'BUILD-QUEUE.md was not found in that folder, so its work list could not be read.'],
    ['This account could not be checked (ACCOUNT_PROFILE_UNAVAILABLE). That says nothing about its allowance.',
      'This account could not be checked. That says nothing about its allowance.'],
    [String.raw`ENOENT: no such file or directory, open 'C:\Users\someone\config\accounts.json'`,
      'no such file or directory.'],
    /* A path with a SPACE in it. Stopping at whitespace used to leave
       "Files\nodejs\codex.cmd" sitting in the middle of the sentence. */
    [String.raw`The Codex command line could not be started from C:\Program Files\nodejs\codex.cmd.`,
      'The Codex command line could not be started.'],
  ];
  for (const [input, expected] of table) {
    equal(typedError(new CloudAgentError('CLOUD_SOMETHING_REFUSED', input)).message, expected,
      `scrubbed wrong: ${JSON.stringify(input.slice(0, 60))}`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. THE WHOLE ENGINE CORPUS, SWEPT.
 *
 * Every message this repository can throw into typedError, run through it, and
 * checked for the two shapes above. A rule proved on six hand-written examples
 * is a rule proved on six hand-written examples.
 * ------------------------------------------------------------------ */

{
  const roots = [
    path.join(__dirname, '..', 'src', 'lib', 'cloud-agent'),
    path.join(__dirname, '..', 'src', 'lib', 'multi-account'),
  ];
  const messages = [];
  for (const root of roots) {
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(root, entry), 'utf8');
      for (const match of source.matchAll(/'((?:[^'\\\n]|\\.){20,400})'/g)) messages.push(match[1]);
      for (const match of source.matchAll(/`((?:[^`\\]|\\.){20,400})`/g)) messages.push(match[1].replace(/\$\{[^}]*\}/g, 'x'));
    }
  }
  ok(messages.length > 40, `the sweep found only ${messages.length} candidate messages; the extractor has gone blind`);
  const offenders = [];
  for (const message of messages) {
    const typed = typedError(new CloudAgentError('CLOUD_SOMETHING_REFUSED', message));
    if (ABSOLUTE_PATH.test(typed.message) || EMBEDDED_IDENTIFIER.test(typed.message)) {
      offenders.push(`${JSON.stringify(message.slice(0, 80))} -> ${JSON.stringify(typed.message.slice(0, 80))}`);
    }
  }
  equal(offenders.length, 0, `machine detail survived the scrub:\n  ${offenders.join('\n  ')}`);
}

/* ------------------------------------------------------------------ *
 * 4. ABSENT LOCATION AND ABSENT FILE ARE NAMED, NEVER EMPTY.
 * ------------------------------------------------------------------ */

(async () => {
  // The Dev account's TEMP may be exposed through an ambiguous 8.3 alias. The
  // product must refuse that spelling before it can claim an installed-account
  // result, so this installed-identity fixture uses the canonical owner root.
  const scratch = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'refusal-reason-'));
  const previous = process.env.TOOLSENABLED_STATE_ROOT;
  try {
    delete require.cache[require.resolve('../src/lib/cloud-agent/codex-cloud-launch')];
    const { listCloudAccounts } = require('../src/lib/cloud-agent/codex-cloud-launch');
    delete process.env.TOOLSENABLED_STATE_ROOT;
    let checkoutRefusal = null;
    try { await listCloudAccounts({}, {}); } catch (error) { checkoutRefusal = error; }
    equal(checkoutRefusal && checkoutRefusal.code, 'ACCOUNTS_REGISTRY_NOT_PRESENT_HERE',
      'a checkout has a named installation-location refusal');
    ok(/not present in this source checkout/i.test(checkoutRefusal && checkoutRefusal.message),
      'the refusal says why this process has no registry answer');
    ok(checkoutRefusal && !Array.isArray(checkoutRefusal.accounts),
      'the checkout refusal was not mutated into a zero-account reading');

    process.env.TOOLSENABLED_STATE_ROOT = path.join(scratch, 'installed-capability');
    let absentFileRefusal = null;
    try { await listCloudAccounts({}, {}); } catch (error) { absentFileRefusal = error; }
    equal(absentFileRefusal && absentFileRefusal.code, 'ACCOUNTS_REGISTRY_MISSING',
      'an installed identity with no file preserves the loader\'s named missing refusal');
    ok(absentFileRefusal && !Array.isArray(absentFileRefusal.accounts),
      'mutation check: an absent installed registry cannot report zero accounts');
  } finally {
    if (previous === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previous;
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* scratch */ }
  }

  console.log(`mission-bridge-refusal-reason: ${checks} checks passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
