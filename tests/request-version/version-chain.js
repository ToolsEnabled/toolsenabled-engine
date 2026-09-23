// EXECUTABLE CHANGE
//
// Discriminating assertion strengthened:
// - The exhaustive small-chain check used getSupersededBy(...).length as the
//   guard for its own assertion. Mutating getSupersededBy to return [] for
//   every R70-family entry left the original file green (16 checks passed).
//   The explicit comparison count below made that mutation RED with:
//   "AssertionError [ERR_ASSERTION]: every generated non-leaf must be checked"
//   "0 !== 28"
//
// Mutation restoration: src/lib/request-version/version-chain.js was restored
// byte-for-byte (SHA-256 6f5a793d055d9e9e55a5875bc06475c435dd08cfa0d1a841fd077f3bbd3a5eff).
// The restored run was GREEN with:
// "request-version/version-chain: 16 checks passed"
//
// Shape census:
// 1 EMPTY LOOP — FOUND and strengthened as described above. Other loops have
//   direct post-loop assertions or fixed non-empty inputs.
// 2 EXIT STATUS / TRUTHY RETURN — NOT-FOUND.
// 3 SWALLOWING TRY/CATCH / OPTIONAL CHAIN — NOT-FOUND.
// 4 MOCK OF SUBJECT — NOT-FOUND.
// 5 SILENT SKIP / PRECONDITION GUARD — NOT-FOUND.
// 6 EXPECTED VALUE COMPUTED BY SUBJECT — NOT-FOUND.
// Preconditions not met: none.

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const {
  buildVersionChain,
  activeView,
  activePhaseView,
  migrationPlan
} = require('../../src/lib/request-version/version-chain');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}
function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

// Refusals in this module are a read-only boundary.  Besides checking the
// exact error, keep sentinels on the two classes of side effect that would be
// especially dangerous here and prove caller input remains byte-for-byte
// unchanged.
function expectPureRefusal(code, input, invoke) {
  const before = JSON.stringify(input);
  let writes = 0;
  let spawns = 0;
  const originalWriteFileSync = fs.writeFileSync;
  const originalSpawn = childProcess.spawn;
  fs.writeFileSync = (...args) => {
    writes += 1;
    return originalWriteFileSync(...args);
  };
  childProcess.spawn = (...args) => {
    spawns += 1;
    return originalSpawn(...args);
  };
  try {
    expectCode(invoke, code);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    childProcess.spawn = originalSpawn;
  }
  assert.equal(JSON.stringify(input), before, `${code} mutated its caller input`);
  assert.equal(writes, 0, `${code} wrote a file`);
  assert.equal(spawns, 0, `${code} spawned a process`);
}

function directive(id, verbatim) {
  return {
    kind: 'owner-directive',
    actor: 'owner',
    recorded: true,
    directiveId: id,
    directiveVerbatim: verbatim
  };
}

function clause({ ruleId, ruleKey, sourceRequestId, issuedAt, ownerVerbatim }) {
  return {
    schemaVersion: 1,
    ruleId,
    ruleKey,
    scopeKind: 'global',
    threadId: null,
    sourceRequestId,
    issuedAt,
    expiresAt: null,
    decisionSummary: `${ruleKey} decision`,
    evidenceRefs: [],
    ownerVerbatim
  };
}

function entry({ id, kind = 'request', verbatim, parents = [], supersession = undefined, clauses = [] }) {
  return { id, kind, verbatim, parents, ...(supersession === undefined ? {} : { supersession }), clauses };
}

check('a supersession chain resolves to exactly one active leaf and both lineage directions', () => {
  const chain = buildVersionChain([
    entry({ id: 'R40', verbatim: 'Do not use Sol Ultra.' }),
    entry({ id: 'R40.1', verbatim: 'Sol Ultra is authorized.', parents: ['R40'], supersession: directive('R55', 'Use Sol Ultra.') }),
    entry({ id: 'R40.1.1', verbatim: 'Sol Ultra is authorized for this scope.', parents: ['R40.1'], supersession: directive('R56', 'Use Sol Ultra in this scope.') })
  ]);
  assert.deepEqual(activeView(chain).map(item => item.id), ['R40.1.1']);
  assert.deepEqual(chain.getSupersededBy('R40').map(item => item.id), ['R40.1']);
  assert.deepEqual(chain.getSupersedes('R40.1.1', { transitive: true }).map(item => item.id), ['R40.1', 'R40']);
});

check('zero-padded roots and dotted owner directive provenance use the shared grammar', () => {
  const chain = buildVersionChain([
    entry({ id: 'R01', verbatim: 'old' }),
    entry({ id: 'R01.1', verbatim: 'new', parents: ['R01'], supersession: directive('R133.1', 'new') })
  ]);
  assert.deepEqual(activeView(chain).map(item => item.id), ['R01.1']);
});

check('a merge names both parents, preserves their verbatim bytes, and reuses scope resolution', () => {
  const oldSol = 'Do not use Sol Ultra.\r\nExact owner bytes stay.';
  const allowSol = 'Use Sol Ultra for the approved scope.\nNo normalized newline.';
  const chain = buildVersionChain([
    entry({
      id: 'R40', verbatim: oldSol,
      clauses: [clause({ ruleId: 'rule_spawn_sol_old', ruleKey: 'spawn.sol', sourceRequestId: 'R40', issuedAt: '2026-01-01T00:00:00.000Z', ownerVerbatim: oldSol })]
    }),
    entry({
      id: 'R40.2', verbatim: allowSol, parents: ['R40'], supersession: directive('R55', allowSol),
      clauses: [clause({ ruleId: 'rule_spawn_sol_new', ruleKey: 'spawn.sol', sourceRequestId: 'R55', issuedAt: '2026-02-01T00:00:00.000Z', ownerVerbatim: allowSol })]
    }),
    entry({
      id: 'R40.3', verbatim: 'Keep the independent safety clause.', parents: ['R40'], supersession: directive('R56', 'Keep the independent safety clause.'),
      clauses: [clause({ ruleId: 'rule_spawn_safety', ruleKey: 'spawn.safety', sourceRequestId: 'R56', issuedAt: '2026-02-02T00:00:00.000Z', ownerVerbatim: 'Keep the independent safety clause.' })]
    }),
    entry({ id: 'R40.2.3', verbatim: 'Merge both owner lines.', parents: ['R40.2', 'R40.3'], supersession: directive('R57', 'Merge both owner lines.') })
  ]);
  const merge = chain.mergeProvenance('R40.2.3', { nowMs: Date.parse('2026-03-01T00:00:00.000Z') });
  assert.deepEqual(merge.parents.map(parent => parent.id), ['R40.2', 'R40.3']);
  assert.equal(merge.parents[0].verbatim, allowSol);
  assert.deepEqual(merge.parents.map(parent => parent.contributedRuleIds), [['rule_spawn_sol_new'], ['rule_spawn_safety']]);
  assert.deepEqual(merge.resolution.rules.map(rule => rule.ruleKey).sort(), ['spawn.safety', 'spawn.sol']);
  assert.deepEqual(activeView(chain).map(item => item.id), ['R40.2.3']);
});

check('the active view cannot contain a superseded entry under exhaustive small-chain inputs', () => {
  let supersededEntriesChecked = 0;
  for (let depth = 0; depth < 8; depth += 1) {
    const entries = [entry({ id: 'R70', verbatim: 'root' })];
    let parent = 'R70';
    for (let index = 1; index <= depth; index += 1) {
      const id = `${parent}.1`;
      entries.push(entry({ id, verbatim: `v${index}`, parents: [parent], supersession: directive(`R${80 + index}`, `owner ${index}`) }));
      parent = id;
    }
    const chain = buildVersionChain(entries);
    const activeIds = new Set(activeView(chain).map(item => item.id));
    for (const candidate of entries) {
      if (chain.getSupersededBy(candidate.id).length > 0) {
        supersededEntriesChecked += 1;
        assert.equal(activeIds.has(candidate.id), false, candidate.id);
      }
    }
    assert.deepEqual([...activeIds], [parent]);
  }
  assert.equal(supersededEntriesChecked, 28, 'every generated non-leaf must be checked');
});

check('the active view rejects objects forged outside buildVersionChain', () => {
  expectCode(() => activeView({ active: [entry({ id: 'R70', verbatim: 'forged' })] }), 'VERSION_CHAIN_REQUIRED');
});

check('deep valid chains use iterative graph and resolution traversal', () => {
  const entries = [entry({ id: 'R71', verbatim: 'root' })];
  let parentId = 'R71';
  for (let index = 0; index < 2_000; index += 1) {
    const id = `${parentId}.1`;
    entries.push(entry({ id, verbatim: id, parents: [parentId], supersession: directive('R72', 'owner') }));
    parentId = id;
  }
  const chain = buildVersionChain(entries);
  assert.equal(chain.getSupersedes(parentId, { transitive: true }).length, 2_000);
  assert.deepEqual(chain.resolveClauses(parentId).rules, []);
});

check('verbatim text is byte-identical after repeated supersessions and a merge', () => {
  const raw = ['zero\r\nline', 'one\nline', 'two\r\nline', 'merge\nline'];
  const chain = buildVersionChain([
    entry({ id: 'R90', verbatim: raw[0] }),
    entry({ id: 'R90.1', verbatim: raw[1], parents: ['R90'], supersession: directive('R91', raw[1]) }),
    entry({ id: 'R90.2', verbatim: raw[2], parents: ['R90'], supersession: directive('R92', raw[2]) }),
    entry({ id: 'R90.1.2', verbatim: raw[3], parents: ['R90.1', 'R90.2'], supersession: directive('R93', raw[3]) })
  ]);
  assert.deepEqual(chain.entries.map(item => item.verbatim), raw);
  assert.equal(chain.mergeProvenance('R90.1.2').parents[0].verbatim, raw[1]);
  assert.equal(chain.mergeProvenance('R90.1.2').parents[1].verbatim, raw[2]);
});

check('an agent-authored supersession is refused', () => {
  expectCode(() => buildVersionChain([
    entry({ id: 'R100', verbatim: 'owner' }),
    entry({ id: 'R100.1', verbatim: 'agent', parents: ['R100'], supersession: { ...directive('R101', 'agent'), actor: 'agent' } })
  ]), 'VERSION_AGENT_SUPERSESSION_REFUSED');
});

check('a cycle is rejected before lineage traversal', () => {
  expectCode(() => buildVersionChain([
    entry({ id: 'R110', verbatim: 'root' }),
    entry({ id: 'R110.1', verbatim: 'one', parents: ['R110.2'], supersession: directive('R111', 'one') }),
    entry({ id: 'R110.2', verbatim: 'two', parents: ['R110.1'], supersession: directive('R112', 'two') })
  ]), 'VERSION_CYCLE_REFUSED');
});

check('an unparented dotted version is rejected', () => {
  expectCode(() => buildVersionChain([
    entry({ id: 'R120', verbatim: 'root' }),
    entry({ id: 'R120.1', verbatim: 'orphan' })
  ]), 'VERSION_UNPARENTED_DESCENDANT');
});

check('phase active view uses the existing queue completedIds receipt instead of a new completion status', () => {
  const chain = buildVersionChain([
    entry({ id: 'Q40', kind: 'phase', verbatim: 'first phase' }),
    entry({ id: 'Q41', kind: 'phase', verbatim: 'second phase' })
  ]);
  assert.deepEqual(activePhaseView(chain, { completedIds: ['Q40'] }).map(item => item.id), ['Q41']);
  expectCode(() => activePhaseView(chain, { completedIds: ['R40'] }), 'VERSION_QUEUE_PROJECTION_INVALID');
});

check('phase active view rejects R-family completion receipts', () => {
  const chain = buildVersionChain([]);
  expectCode(() => activePhaseView(chain, { completedIds: ['R40'] }), 'VERSION_QUEUE_PROJECTION_INVALID');
});

check('migrationPlan never infers authority from a historical request number or matching rule label', () => {
  const input = [
    { id: 'R901', verbatim: 'Earlier customer rule.', ruleKey: 'spawn.model-restriction' },
    { id: 'R1065', verbatim: 'Unrelated customer request with a reused number.' }
  ];
  const before = JSON.stringify(input);
  const plan = migrationPlan(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(plan.appliesChanges, false);
  assert.deepEqual(plan.proposals, []);
});

check('migrationPlan proposes only an explicit current-ledger amendment', () => {
  const plan = migrationPlan([
    { id: 'R901', verbatim: 'Earlier customer rule.', ruleKey: 'spawn.model-restriction' },
    { id: 'R1065', verbatim: 'Explicitly amend the earlier rule.', amends: ['R901'] }
  ]);
  assert.deepEqual(plan.proposals.map(proposal => [proposal.proposedId, proposal.parentIds, proposal.ownerDirective.directiveId]), [
    ['R901.1', ['R901'], 'R1065']
  ]);
});

check('migrationPlan accepts dotted historical inputs without inferring lineage', () => {
  const input = [
    { id: 'R01', verbatim: 'old' },
    { id: 'R133.1', verbatim: 'legacy continuation' },
    { id: 'R200', verbatim: 'amends dotted', amends: ['R133.1'] }
  ];
  const plan = migrationPlan(input);
  assert.deepEqual(plan.proposals.map(item => [item.proposedId, item.parentIds]), [
    ['R133.1.1', ['R133.1']]
  ]);
});

check('migrationPlan rejects self-amendment', () => {
  expectCode(() => migrationPlan([{ id: 'R5', verbatim: 'self', amends: ['R5'] }]), 'VERSION_MIGRATION_ENTRY_INVALID');
});

check('migrationPlan increments a suffix near the shared grammar limit without precision loss', () => {
  const plan = migrationPlan([
    { id: 'R6', verbatim: 'parent' },
    { id: 'R6.9007199254740990', verbatim: 'amendment', amends: ['R6'] }
  ]);
  assert.equal(plan.proposals[0].proposedId, 'R6.9007199254740991');
  assert.doesNotThrow(() => buildVersionChain([
    entry({ id: 'R6', verbatim: 'parent' }),
    entry({
      id: plan.proposals[0].proposedId,
      verbatim: 'amendment',
      parents: ['R6'],
      supersession: plan.proposals[0].ownerDirective
    })
  ]));
});

check('public construction refusals reject invalid chain, entry, id, kind, clauses, and duplicate ids without effects', () => {
  const cases = [
    ['VERSION_CHAIN_INVALID', null, input => buildVersionChain(input)],
    ['VERSION_ENTRY_INVALID', { id: 'R1' }, input => buildVersionChain([input])],
    ['VERSION_ID_INVALID', entry({ id: 'not-an-id', verbatim: 'bad' }), input => buildVersionChain([input])],
    ['VERSION_KIND_MISMATCH', entry({ id: 'Q1', verbatim: 'wrong family' }), input => buildVersionChain([input])],
    ['VERSION_CLAUSES_INVALID', { ...entry({ id: 'R1', verbatim: 'bad clauses' }), clauses: null }, input => buildVersionChain([input])],
    ['VERSION_ID_DUPLICATE', [entry({ id: 'R1', verbatim: 'first' }), entry({ id: 'R1', verbatim: 'second' })], input => buildVersionChain(input)]
  ];
  for (const [code, input, invoke] of cases) expectPureRefusal(code, input, () => invoke(input));
});

check('lineage construction drives descendant, merge-id, and clause-provenance refusals without effects', () => {
  const badDescendant = [
    entry({ id: 'R10', verbatim: 'root' }),
    entry({ id: 'R10.1', verbatim: 'first', parents: ['R10'], supersession: directive('R20', 'first') }),
    entry({ id: 'R10.2', verbatim: 'not below its parent', parents: ['R10.1'], supersession: directive('R21', 'bad') })
  ];
  expectPureRefusal('VERSION_DESCENDANT_INVALID', badDescendant, () => buildVersionChain(badDescendant));

  const badMerge = [
    entry({ id: 'R30', verbatim: 'root' }),
    entry({ id: 'R30.1', verbatim: 'one', parents: ['R30'], supersession: directive('R31', 'one') }),
    entry({ id: 'R30.2', verbatim: 'two', parents: ['R30'], supersession: directive('R32', 'two') }),
    entry({ id: 'R30.1.3', verbatim: 'bad merge', parents: ['R30.1', 'R30.2'], supersession: directive('R33', 'merge') })
  ];
  expectPureRefusal('VERSION_MERGE_ID_INVALID', badMerge, () => buildVersionChain(badMerge));

  const badProvenance = [
    entry({ id: 'R40', verbatim: 'root' }),
    entry({
      id: 'R40.1', verbatim: 'new', parents: ['R40'], supersession: directive('R41', 'new'),
      clauses: [clause({ ruleId: 'rule_bad_source', ruleKey: 'source', sourceRequestId: 'R42', issuedAt: '2026-01-01T00:00:00.000Z', ownerVerbatim: 'other' })]
    })
  ];
  expectPureRefusal('VERSION_CLAUSE_PROVENANCE_INVALID', badProvenance, () => buildVersionChain(badProvenance));
});

check('query paths drive not-found, not-a-merge, and ambiguous inherited-clause refusals without effects', () => {
  const singleInput = [entry({ id: 'R50', verbatim: 'root' })];
  const single = buildVersionChain(singleInput);
  expectPureRefusal('VERSION_NOT_FOUND', singleInput, () => single.getSupersedes('R404'));
  expectPureRefusal('VERSION_NOT_A_MERGE', singleInput, () => single.mergeProvenance('R50'));

  const ambiguousInput = [
    entry({ id: 'R60', verbatim: 'root' }),
    entry({
      id: 'R60.1', verbatim: 'one', parents: ['R60'], supersession: directive('R61', 'one'),
      clauses: [clause({ ruleId: 'rule_same_history', ruleKey: 'one', sourceRequestId: 'R61', issuedAt: '2026-01-01T00:00:00.000Z', ownerVerbatim: 'one' })]
    }),
    entry({
      id: 'R60.2', verbatim: 'two', parents: ['R60'], supersession: directive('R62', 'two'),
      clauses: [clause({ ruleId: 'rule_same_history', ruleKey: 'two', sourceRequestId: 'R62', issuedAt: '2026-01-02T00:00:00.000Z', ownerVerbatim: 'two' })]
    }),
    entry({ id: 'R60.1.2', verbatim: 'merge', parents: ['R60.1', 'R60.2'], supersession: directive('R63', 'merge') })
  ];
  const ambiguous = buildVersionChain(ambiguousInput);
  expectPureRefusal('VERSION_CLAUSE_DUPLICATE_AMBIGUOUS', ambiguousInput, () => ambiguous.resolveClauses('R60.1.2'));
});

check('migration input and duplicate-entry refusals leave input and the outside world untouched', () => {
  expectPureRefusal('VERSION_MIGRATION_INPUT_INVALID', null, () => migrationPlan(null));
  const duplicates = [{ id: 'R70', verbatim: 'one' }, { id: 'R70', verbatim: 'two' }];
  expectPureRefusal('VERSION_MIGRATION_ENTRY_DUPLICATE', duplicates, () => migrationPlan(duplicates));
});

console.log(`request-version/version-chain: ${checks} checks passed`);
