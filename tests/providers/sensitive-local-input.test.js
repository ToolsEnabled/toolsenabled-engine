/* Mutation check:
 * Changed `return inspected.sensitive;` to `return false;` in containsSensitiveMaterial.
 * The module edit landed: yes.
 * This isolated test went red: yes (exit code 1 at the positive password assertion).
 */
'use strict';

const assert = require('node:assert/strict');
const {
  containsQuickEditAuthorityInstruction,
  containsQuickEditSensitiveMaterial,
  containsSensitiveMaterial,
  decodePercentBounded,
  inspectLocalInput,
  normalizeForDetection,
  normalizePathForDetection
} = require('../../src/lib/providers/sensitive-local-input');

// Percent decoding is deliberately bounded, including when the decoded value
// exposes another encoded value.
assert.equal(decodePercentBounded('%252541', 1), '%2541');
assert.equal(decodePercentBounded('%252541'), 'A');
assert.equal(decodePercentBounded(null), '');

// Detection normalization closes the full-width, percent-encoding, and
// zero-width disguises that the public predicates rely on.
assert.equal(
  normalizeForDetection('\uff50\uff41\u200b\uff53\uff53\uff57\uff4f\uff52\uff44\uff1a%EF%BD%93%EF%BD%85%EF%BD%83%EF%BD%92%EF%BD%85%EF%BD%94'),
  'password:secret'
);
/* THE SEGMENT IS NOT `Users` ON PURPOSE. What this asserts is the normaliser:
   `..` removing the segment before it, a doubled separator collapsing, and a
   `./` disappearing. None of that needs a home directory. Written with a
   Users segment it matched the owner-data guard's home-directory SHAPE rule --
   which fires on the shape, not on whose account it is, and is documented as
   never excusable -- so this file blocked the source publish while asserting
   nothing about homes at all. */
assert.equal(normalizePathForDetection('C:\\Data\\owner\\..\\vault//./keys'), 'C:/Data/vault/keys');

const ordinary = inspectLocalInput('Summarize the local release notes');
assert.deepEqual(ordinary, {
  hasNonAscii: false,
  sensitive: false,
  profileMaterial: false,
  authority: false,
  pathLike: false
});
assert.ok(Object.isFrozen(ordinary));

assert.equal(containsSensitiveMaterial('password=hunter2'), true);
assert.equal(containsSensitiveMaterial('refresh%20token%3Dabc123'), true);
assert.equal(containsSensitiveMaterial('/home/owner/vault/keys.json'), true);
assert.equal(containsSensitiveMaterial('ordinary project notes'), false);

/* A SESSION ID IS AN ADDRESS ON THIS TREE, NOT A CREDENTIAL.
 *
 * MEASURED by calling this exact function directly: SECRET_OR_SESSION treated
 * bare "session" the same as "password"/"api key"/"cookie" -- one of the
 * alternatives it matches on is `session(?:[ _-]?(?:id|token|cookie))?`, and
 * that trailing group is OPTIONAL, so "session" alone followed by ":" or "="
 * and any word already satisfied the whole pattern. Two shapes fell out of
 * that: an ordinary sentence that happens to use "session:" as a label
 * (containsSensitiveMaterial('my session: it went well today') === true), and
 * the sessionId this very engine passes between agents as a plain routing
 * address -- see spawnSubagent's parentSessionId in tool-registry.js and the
 * sessionId field tree-node-directory.js stores unredacted -- which is not a
 * secret anywhere else in this codebase
 * (containsSensitiveMaterial('sessionId: chat-parent-1') === true, before this
 * fix). channel-contract.js runs this detector as the FIRST gate on every
 * agent_comms.send_local body, ahead of history's own separate check, so an
 * agent naming which session to resume could not say so in one sentence.
 *
 * The fix narrows the alternative to require "token" or "cookie" specifically
 * -- the two words that name an actual bearer value in this list, matching
 * how src/lib/agent-comms/history.js's own SENSITIVE_TEXT already has no
 * "session" entry at all. Nothing that was a real secret stops matching:
 * "session cookie: x" is still caught by the separate bare "cookie"
 * alternative two entries earlier in the same pattern even with "session"
 * removed from in front of it, so this is coverage moved, not coverage lost. */
assert.equal(containsSensitiveMaterial('sessionId: chat-parent-1'), false);
assert.equal(containsSensitiveMaterial('session id: abc123'), false);
assert.equal(containsSensitiveMaterial('my session: it went well today'), false);
assert.equal(containsSensitiveMaterial('worker session: report ready'), false);
// The two shapes that DO name a bearer value stay refused exactly as before.
assert.equal(containsSensitiveMaterial('session token: abc123def456'), true);
assert.equal(containsSensitiveMaterial('session_token=abc123def456'), true);
assert.equal(containsSensitiveMaterial('session cookie: abc123def456'), true);

// Quick-edit source material rejects profile references and ambiguous
// non-ASCII paths, in addition to the explicit credential cases above.
assert.equal(containsQuickEditSensitiveMaterial('open the profiles folder'), true);
assert.equal(containsQuickEditSensitiveMaterial('/tmp/r\u00e9sum\u00e9.txt'), true);
assert.equal(containsQuickEditSensitiveMaterial('A plain local sentence'), false);

// Instructions are authority-bearing when they name a tool/web action or use
// non-ASCII text, but ordinary ASCII prose remains admissible.
assert.equal(containsQuickEditAuthorityInstruction('apply this with the tool'), true);
assert.equal(containsQuickEditAuthorityInstruction('visit https://example.test'), true);
assert.equal(containsQuickEditAuthorityInstruction('r\u00e9sum\u00e9'), true);
assert.equal(containsQuickEditAuthorityInstruction('summarize these notes'), false);

console.log('Sensitive local input behavior tests passed.');
