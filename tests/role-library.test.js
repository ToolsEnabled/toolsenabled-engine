// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-role-library-test-js):
// - SAME-CODE EXPECTATION: ROLE_LIBRARY ids and agentOrg.ROLES both originate
//   in agent-org.js. Mutation: rename the declared `builder` role to `maker`
//   and rename its definition to match. Before this change the suite remained
//   green: "role library passed (9 shipped roles, 90 text fields scanned, 10
//   owner-data patterns, 144 assertions)." The independent vocabulary below
//   makes that mutant RED: "AssertionError [ERR_ASSERTION]: the declared role
//   vocabulary changed ... actual ... 'maker' ... expected ... 'builder'".
// - NOT-FOUND empty loop: every product-derived loop is protected by an exact
//   non-empty vocabulary check, a non-empty rules check, or the scan-size check.
// - NOT-FOUND exit status/truthy process result: this file spawns no process.
// - NOT-FOUND swallowed failure: the sole catch rethrows every unexpected
//   error and its observed-result assertion is pinned independently below.
// - NOT-FOUND subject mock: this file installs no mocks.
// - NOT-FOUND skip/platform guard: this file has no skip or platform branch.
// - RESTORE: both mutated source files were restored byte-for-byte with `cmp`.
//   The restored suite was GREEN: "role library passed (9 shipped roles, 90
//   text fields scanned, 10 owner-data patterns, 145 assertions)."
// - PRECONDITION: the default Node 20 lacks node:sqlite; mutation and restored
//   runs therefore use the repository-installed Node 22.22.2 binary.

'use strict';

// THE SHIPPED DEFAULT ROLE LIBRARY, held to the two properties that matter.
//
// 1. It carries no owner-identifying text. These definitions are not a comment
//    in a source file: they are rendered into the onboarding packet handed to a
//    stranger's agent and presented there as instructions. Personal data in a
//    default role library is on screen, in someone else's product.
//
// 2. What a role SAYS about its own permissions matches what the product
//    actually grants it. A definition claiming a restriction the code does not
//    implement is worse than no definition, because it is relied upon.
//
// EVERY CHECK DERIVES ITS SUBJECT FROM THE SOURCE OF TRUTH. Nothing here is a
// hand-written list of role names, and nothing quotes a sentence of role text.
// A hand-maintained list stops following the code, silently, and then reports
// green about a set that no longer exists -- so roles come from agentOrg.ROLES,
// the text to scan comes from every field of every definition, and the
// permission expectations are compared against the real functions rather than
// restated. Add a role or a rule and it is covered without editing this file;
// add a role without a definition and the library refuses to load at all.

const assert = require('node:assert/strict');

const agentOrg = require('../src/lib/agent-org');
const { ROLE_LIBRARY, roleDefinition, roleRules, storedRoleDefinition } = require('../src/lib/agent-roles');
const onboarding = require('../src/lib/agent-onboarding');
const customRoles = require('../src/lib/custom-role-store');

let assertions = 0;
function pass() { assertions += 1; }

// --- 1. The library covers exactly the declared role vocabulary -------------

// This list is intentionally independent of agentOrg.ROLES. ROLE_LIBRARY is
// constructed by mapping agentOrg.ROLES, so comparing only those two values is
// incapable of detecting a coordinated rename: both sides change together.
const EXPECTED_ROLE_IDS = [
  'controller', 'shadow-manager', 'planner', 'manager',
  'coordinator-assistant', 'builder', 'reviewer', 'worker', 'observer'
];
assert.deepEqual([...agentOrg.ROLES], EXPECTED_ROLE_IDS,
  'the declared role vocabulary changed; role ids are a shipped compatibility contract');
pass();

assert.deepEqual(ROLE_LIBRARY.map(role => role.id), [...agentOrg.ROLES],
  'the default role library must define exactly the declared roles, in the declared order');
pass();

for (const id of agentOrg.ROLES) {
  assert.ok(roleDefinition(id), `roleDefinition(${id}) must resolve`);
  assert.ok(roleRules(id), `roleRules(${id}) must resolve`);
  pass();
}
assert.equal(roleDefinition('not-a-declared-role'), null, 'an undeclared role must resolve to null, not a guess');
pass();

const customManager = storedRoleDefinition({
  id: 'release-captain',
  baseDefaultRole: 'manager',
  rules: {
    owns: 'Own the bounded release train.',
    mustNot: 'Change work outside the declared release.',
    handoff: 'Return reviewed release evidence to the controller.'
  }
});
assert.equal(customManager.name, 'Release Captain');
assert.equal(customManager.owns, 'Own the bounded release train.');
assert.deepEqual(customManager.rules, roleDefinition('manager').rules,
  'a custom role inherits learned rules from its declared base, not special Shadow instructions');
assert.ok(!Object.hasOwn(customManager, 'enforced'), 'an onboarding directions sheet does not advertise enforcement bookkeeping');
pass();

const freeform = storedRoleDefinition({
  id: 'read-only-auditor',
  baseDefaultRole: null,
  rules: {
    owns: 'Inspect one bounded artifact.',
    mustNot: 'Change the artifact.',
    handoff: 'Return observations to the dispatcher.'
  }
});
assert.deepEqual(freeform.rules, [], 'a no-base custom role inherits no implicit operating authority or instructions');
assert.match(freeform.summary, /read-only/i);
pass();

for (const malformedCapabilities of [null, { mayClaimWork: true }, {
  orgRoot: false,
  singleSeat: false,
  mayClaimWork: 'yes',
  mayWakeReports: false,
  requiresMutationContext: false
}]) {
  assert.equal(storedRoleDefinition({
    id: 'forged-role',
    baseDefaultRole: 'manager',
    rules: {
      owns: 'Own one bounded task.',
      mustNot: 'Cross the task boundary.',
      handoff: 'Return evidence to the dispatcher.'
    },
    capabilities: malformedCapabilities
  }), null, 'an explicit malformed capability record is not replaced by inherited authority');
}
pass();

// --- 2. Every definition is usable by someone who has never seen this fleet --
//
// A role a stranger can pick needs a plain name, one sentence saying what it is
// for, what it may do, what it refuses, and how it connects to the other roles.
// A definition missing any of those is not shippable, whatever else it says.

const TEXT_FIELDS = ['name', 'summary', 'owns', 'mustNot', 'handoff'];
// The editable-rule fields are bounded by the custom-role store, which refuses
// anything longer. Asserting the bound here fails with a sentence naming the
// role instead of crashing that module at load time. Read from the store rather
// than repeated, and required rather than defaulted: a `?? 1500` fallback would
// keep this check reporting green if the export were ever removed, which is the
// check-passes-because-it-was-given-nothing failure.
const MAX_RULE_TEXT = customRoles.MAX_RULE_TEXT;
assert.equal(typeof MAX_RULE_TEXT, 'number', 'the custom-role store must export the rule-text bound this check enforces');
pass();

for (const role of ROLE_LIBRARY) {
  for (const field of TEXT_FIELDS) {
    const value = role[field];
    assert.equal(typeof value, 'string', `${role.id}.${field} must be a string`);
    assert.ok(value.length > 0 && value === value.trim(), `${role.id}.${field} must be non-empty and trimmed`);
    pass();
  }

  assert.ok(role.summary.endsWith('.'), `${role.id}.summary must be a complete sentence`);
  assert.ok(!/\.\s/.test(role.summary), `${role.id}.summary must be ONE sentence -- it is what a chooser reads instead of everything else`);
  pass();

  assert.ok(Array.isArray(role.rules) && role.rules.length > 0,
    `${role.id}.rules must carry at least one operating rule; a role with no learned rules has had its substance deleted`);
  for (const rule of role.rules) {
    assert.equal(typeof rule, 'string');
    assert.ok(rule.length > 0 && rule === rule.trim(), `${role.id} has a blank or untrimmed rule`);
    assert.ok(rule.endsWith('.'), `${role.id} rules are complete sentences: ${JSON.stringify(rule)}`);
  }
  pass();

  for (const field of ['owns', 'mustNot', 'handoff']) {
    assert.ok(role[field].length <= MAX_RULE_TEXT,
      `${role.id}.${field} exceeds the ${MAX_RULE_TEXT}-character bound the custom-role store enforces`);
    pass();
  }
}

// --- 3. No owner-identifying text anywhere in what ships --------------------
//
// Applied to every text field of every role, so a rule or a role added later is
// scanned without this list being touched. These are structural shapes, not a
// roster of one person's details: a guard that only knows the current builder's
// name protects exactly one person and passes clean for the next one.

const FORBIDDEN = [
  { label: 'a drive-rooted filesystem path', regex: /[A-Za-z]:[\\/]/ },
  { label: 'a home-directory path', regex: /users[\\/]/i },
  { label: 'an email address', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { label: 'an IP address', regex: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { label: 'an internal directive or gate reference', regex: /\b[RQ]\d{2,4}\b/ },
  { label: 'a machine designation', regex: /\bmachine[ -][ab]\b/i },
  { label: 'a dated incident reference', regex: /\b20\d{2}-\d{2}-\d{2}\b/ },
  // Assembled from parts on purpose. This entry is a DETECTOR for the private
  // tree name, so spelling it out here would make the file it guards against
  // fail the owner-data guard -- the same bind tools/check-no-owner-data.mjs
  // documents for its own comments. Splitting it keeps the check working while
  // the literal never appears.
  { label: 'the internal repository tree name', regex: new RegExp(['toolsenabled', 'current'].join('-'), 'i') },
  { label: 'a superseded product name', regex: /mission\s*control/i },
  // A role belongs to a session, never to a vendor, a model or a pricing tier.
  // One of these names inside a role definition turns a shipped default into an
  // instruction about somebody else's account.
  {
    label: 'a provider, model or internal service name',
    regex: /\b(?:anthropic|openai|codex|claude|gemini|vertex|opus|sonnet|haiku|fable|luna|terra|sol|hermes|telegram)\b/i
  }
];

const scanned = [];
for (const role of ROLE_LIBRARY) {
  for (const field of TEXT_FIELDS) scanned.push({ role: role.id, field, text: role[field] });
  role.rules.forEach((rule, index) => scanned.push({ role: role.id, field: `rules[${index}]`, text: rule }));
}

assert.ok(scanned.length >= ROLE_LIBRARY.length * (TEXT_FIELDS.length + 1),
  'the scan must cover every field of every role; an empty or short scan is the absence-as-emptiness failure');
pass();

for (const entry of scanned) {
  for (const pattern of FORBIDDEN) {
    const match = entry.text.match(pattern.regex);
    assert.equal(match, null,
      `${entry.role}.${entry.field} carries ${pattern.label}: ${JSON.stringify(match && match[0])} in ${JSON.stringify(entry.text)}`);
  }
  // Non-ASCII is refused because this text is scanned in shipped binaries in
  // both single-byte and UTF-16 form, and because a smart quote pasted from a
  // chat log is the usual way personal prose re-enters a product surface.
  assert.doesNotMatch(entry.text, /[^\x20-\x7e]/,
    `${entry.role}.${entry.field} must be plain ASCII: ${JSON.stringify(entry.text)}`);
}
pass();

// --- 4. Stated permissions match what the product actually grants -----------
//
// Compared against the real functions, never restated. If the product starts or
// stops enforcing something, this fails rather than letting the library become
// a confident description of a system that no longer behaves that way.

function seat(id, role) {
  return { id, displayName: id, role, provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] };
}

function orgOf(agents) {
  return agentOrg.normalizeOrg({ schemaVersion: agentOrg.SCHEMA_VERSION, revision: 1, agents, relationships: [] });
}

// Exactly one controller is required, so every org built here carries one: for
// the controller case the subject IS that seat.
function withController(agents, subjectRole) {
  return subjectRole === 'controller' ? agents : [...agents, seat('seat-controller', 'controller')];
}

for (const role of ROLE_LIBRARY) {
  const org = orgOf(withController([seat('subject', role.id)], role.id));
  assert.equal(agentOrg.mayClaim(org, 'subject', 'Q1'), role.enforced.mayClaimWork,
    `${role.id}.enforced.mayClaimWork disagrees with mayClaim(); the library is describing a permission the product does not implement`);
  pass();

  // singleSeat: does the org actually refuse a second agent in this role?
  let refused = false;
  try {
    orgOf(withController([seat('subject-a', role.id), seat('subject-b', role.id)], role.id));
  } catch (error) {
    if (!(error instanceof agentOrg.AgentOrgError)) throw error;
    refused = true;
  }
  assert.equal(refused, role.enforced.singleSeat,
    `${role.id}.enforced.singleSeat disagrees with what the declared org accepts`);
  pass();
}

// WHICH ROLES ARE STOPPED FROM CLAIMING WORK, BY NAME.
//
// This assertion used to read `length, 1` and record a gap: only
// coordinator-assistant was mechanically blocked, and shadow-manager, planner,
// reviewer and observer were held to their own `mustNot` by wording alone. That
// was honest while a role could only be changed by hand-editing
// config/agent-org.json. Once a person can assign a role from the product's own
// interface, a described restriction the code does not implement is a lie a
// customer can act on, so all five are enforced and this pins the set.
//
// Asserting the exact NAMES rather than a count is deliberately stricter than
// what was here before: a count of five would also be satisfied by blocking
// `builder` and unblocking `observer`, which would be a serious regression that
// still counted to five.
const mechanicallyBlocked = ROLE_LIBRARY.filter(role => !role.enforced.mayClaimWork).map(role => role.id);
assert.deepEqual([...mechanicallyBlocked].sort(),
  ['coordinator-assistant', 'observer', 'planner', 'reviewer', 'shadow-manager'],
  `the set of mechanically claim-blocked roles changed; found: ${mechanicallyBlocked.join(', ')}`);
pass();

// The library and the enforcing list must name the same roles. Without this, a
// role could be added to NON_CLAIMING_ROLES and never described as read-only,
// or described as read-only and never added -- the exact drift between prose
// and behaviour that the `enforced` field exists to make impossible.
assert.deepEqual([...agentOrg.NON_CLAIMING_ROLES].sort(), [...mechanicallyBlocked].sort(),
  'agent-org.js NON_CLAIMING_ROLES and the role library disagree about which roles may not claim work');
pass();

const singleSeatRoles = ROLE_LIBRARY.filter(role => role.enforced.singleSeat);
assert.equal(singleSeatRoles.length, 1,
  `expected exactly one single-seat role, found ${singleSeatRoles.length}: ${singleSeatRoles.map(r => r.id).join(', ')}`);
pass();

// --- 5. One library, not three ---------------------------------------------
//
// Both consumers must project this file rather than restate it. This is the
// check that would have caught the original defect: two modules describing the
// same nine roles in different words, with nothing comparing them.

for (const role of ROLE_LIBRARY) {
  const shipped = onboarding.ROLE_DEFINITIONS[role.id];
  assert.ok(shipped, `the onboarding packet has no definition for ${role.id}`);
  for (const field of TEXT_FIELDS) {
    assert.equal(shipped[field], role[field],
      `onboarding packet ${role.id}.${field} says something different from the role library`);
  }
  assert.deepEqual(shipped.rules, role.rules, `onboarding packet ${role.id}.rules diverged from the role library`);
  assert.ok(!Object.hasOwn(shipped, 'enforced'),
    `${role.id}: enforcement bookkeeping must not be projected into an agent's packet`);
  pass();
}

const storedById = new Map(customRoles.DEFAULT_ROLE_DEFINITIONS.map(definition => [definition.id, definition]));
assert.deepEqual([...storedById.keys()], [...agentOrg.ROLES],
  'the editable default set must cover exactly the declared roles');
pass();

for (const role of ROLE_LIBRARY) {
  assert.deepEqual(storedById.get(role.id).rules, roleRules(role.id),
    `editable default ${role.id} says something different from the role library`);
  assert.equal(storedById.get(role.id).baseDefaultRole, null, `${role.id} is a default, not a derivative of one`);
  pass();
}

console.log(`role library passed (${ROLE_LIBRARY.length} shipped roles, ${scanned.length} text fields scanned, ${FORBIDDEN.length} owner-data patterns, ${assertions} assertions).`);
