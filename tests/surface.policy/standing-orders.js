'use strict';

// The customer standing-orders mirror is optional installation state, not
// repository source. Exercise the shipped reader and drift detectors against a
// complete disposable profile so the release test never imports an owner's
// private directives and never reports missing customer state as coverage.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadOrders,
  ordersForClass,
  getClass,
  classIds,
  classifyAction,
  checkConsistency,
  assertConsistent,
  checkWiredDrift,
  findProductionReferences,
  parseComponentReferences,
  unenforcedOrders,
  checkBackstopDrift,
  enforcementReport
} = require('../../src/lib/standing-orders');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-orders-contract-'));
const jsonPath = path.join(fixtureRoot, 'config', 'standing-orders.json');
const mdPath = path.join(fixtureRoot, 'STANDING-ORDERS.md');

const fixtureDoc = {
  schemaVersion: 'standing-orders-v1',
  sessionBoot: [
    { number: 1, instruction: 'Read the customer standing orders before acting.' }
  ],
  classes: [
    {
      id: 'OUTWARD',
      heading: 'External actions',
      orders: [
        {
          number: '1',
          summary: 'Confirm the destination before sending.',
          verbatim: 'Confirm the destination before sending.',
          enforcement: 'mechanical',
          enforcingComponent: 'src/lib/guard.js#guardIt',
          revocationPhrase: null,
          wired: true
        },
        {
          number: '2',
          summary: 'Record advisory-only routes honestly.',
          verbatim: null,
          enforcement: 'advisory',
          enforcingComponent: 'tools/observer.js#observeIt',
          revocationPhrase: null,
          wired: false
        }
      ]
    },
    {
      id: 'BROWSER',
      heading: 'Browser actions',
      orders: [
        {
          number: '1',
          summary: 'A former browser-only restriction was revoked.',
          verbatim: null,
          enforcement: 'retired',
          enforcingComponent: null,
          revocationPhrase: 'Browser-only restrictions are no longer active.'
        }
      ]
    },
    {
      id: 'SPAWN',
      heading: 'Delegated work',
      orders: [
        {
          number: '1',
          summary: 'Describe delegated work precisely.',
          verbatim: null,
          enforcement: 'discipline',
          enforcingComponent: null,
          revocationPhrase: null
        }
      ]
    },
    {
      id: 'LOCAL-WORK',
      heading: 'Local discovery',
      orders: [
        {
          number: '1',
          summary: 'Search local source before escalating.',
          verbatim: null,
          enforcement: 'discipline',
          enforcingComponent: null,
          revocationPhrase: null
        }
      ]
    }
  ],
  classificationHeuristics: {
    OUTWARD: { keywords: ['send', 'submit'] },
    BROWSER: { tools: ['Browser'], toolPrefixes: ['mcp__browser__'], identifiers: ['browser upload'] },
    SPAWN: { tools: ['Task'], identifiers: ['task submit'] },
    'LOCAL-WORK': { tools: ['Grep'], keywords: ['rg'] }
  }
};

const fixtureMarkdown = `# STANDING ORDERS

## Class: OUTWARD

1. Confirm an external destination.
   "Confirm the destination before sending."
   Mechanical backstop: src/lib/guard.js#guardIt.

2. Record advisory-only routes honestly.

## Class: BROWSER

1. **RETIRED by the customer.**
   "Browser-only restrictions are no longer active."

## Class: SPAWN

1. Describe delegated work precisely.

## Class: LOCAL-WORK

1. Search local source before escalating.
`;

fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, 'src', 'lib'), { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, 'tools'), { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(fixtureDoc, null, 2)}\n`, 'utf8');
fs.writeFileSync(mdPath, fixtureMarkdown, 'utf8');
fs.writeFileSync(path.join(fixtureRoot, 'src', 'lib', 'guard.js'), [
  "'use strict';",
  'function guardIt(value) { return Boolean(value); }',
  'function dispatch(value) { return guardIt(value); }',
  'module.exports = { guardIt, dispatch };',
  ''
].join('\n'), 'utf8');
fs.writeFileSync(path.join(fixtureRoot, 'tools', 'observer.js'), [
  "'use strict';",
  'function observeIt(value) { return Boolean(value); }',
  'module.exports = { observeIt };',
  ''
].join('\n'), 'utf8');

const profileOptions = Object.freeze({ jsonPath, mdPath, root: fixtureRoot });
process.on('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

let checks = 0;
function check(label, assertion) {
  assertion();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

function mutatedDoc(label, mutate) {
  const output = path.join(fixtureRoot, 'mutations', `${label}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const clone = JSON.parse(JSON.stringify(fixtureDoc));
  mutate(clone);
  fs.writeFileSync(output, `${JSON.stringify(clone, null, 2)}\n`, 'utf8');
  return output;
}

process.stdout.write('standing-orders portable contract\n');

check('a complete customer-neutral profile loads and validates', () => {
  const doc = loadOrders({ jsonPath, force: true });
  assert.equal(doc.schemaVersion, 'standing-orders-v1');
  assert.deepEqual(doc.classes.map(entry => entry.id), ['OUTWARD', 'BROWSER', 'SPAWN', 'LOCAL-WORK']);
  assert.deepEqual(doc.sessionBoot.map(entry => entry.number), [1]);
});

check('class readers preserve order and return safe unknown values', () => {
  assert.deepEqual(classIds({ jsonPath }), ['OUTWARD', 'BROWSER', 'SPAWN', 'LOCAL-WORK']);
  assert.equal(ordersForClass('OUTWARD', { jsonPath }).length, 2);
  assert.equal(getClass('SPAWN', { jsonPath }).heading, 'Delegated work');
  assert.deepEqual(ordersForClass('NOT-A-CLASS', { jsonPath }), []);
  assert.equal(getClass('NOT-A-CLASS', { jsonPath }), null);
});

check('malformed JSON and missing required collections fail closed', () => {
  const invalidJson = path.join(fixtureRoot, 'mutations', 'invalid-json.json');
  fs.mkdirSync(path.dirname(invalidJson), { recursive: true });
  fs.writeFileSync(invalidJson, '{ definitely not json', 'utf8');
  assert.throws(() => loadOrders({ jsonPath: invalidJson, force: true }), /not valid JSON/);
  const missingClasses = mutatedDoc('missing-classes', doc => { delete doc.classes; });
  assert.throws(() => loadOrders({ jsonPath: missingClasses, force: true }), /"classes" must be a non-empty array/);
});

check('duplicate boot, class, and order identifiers fail closed', () => {
  const duplicateBoot = mutatedDoc('duplicate-boot', doc => doc.sessionBoot.push({ ...doc.sessionBoot[0] }));
  assert.throws(() => loadOrders({ jsonPath: duplicateBoot, force: true }), /duplicate sessionBoot number/);
  const duplicateClass = mutatedDoc('duplicate-class', doc => doc.classes.push(JSON.parse(JSON.stringify(doc.classes[0]))));
  assert.throws(() => loadOrders({ jsonPath: duplicateClass, force: true }), /duplicate class id/);
  const duplicateOrder = mutatedDoc('duplicate-order', doc => doc.classes[0].orders.push(JSON.parse(JSON.stringify(doc.classes[0].orders[0]))));
  assert.throws(() => loadOrders({ jsonPath: duplicateOrder, force: true }), /duplicate order number/);
});

check('invalid enforcement and retired-order false claims fail closed', () => {
  const invalidEnforcement = mutatedDoc('invalid-enforcement', doc => { doc.classes[0].orders[0].enforcement = 'vibes'; });
  assert.throws(() => loadOrders({ jsonPath: invalidEnforcement, force: true }), /invalid "enforcement"/);
  const retiredWithComponent = mutatedDoc('retired-with-component', doc => { doc.classes[1].orders[0].enforcingComponent = 'tools/observer.js#observeIt'; });
  assert.throws(() => loadOrders({ jsonPath: retiredWithComponent, force: true }), /revoked order has no enforcing component/);
  const retiredWithoutEvidence = mutatedDoc('retired-without-evidence', doc => { doc.classes[1].orders[0].revocationPhrase = null; });
  assert.throws(() => loadOrders({ jsonPath: retiredWithoutEvidence, force: true }), /records no "revocationPhrase"/);
});

check('Markdown and JSON consistency succeeds for the disposable profile', () => {
  assert.deepEqual(checkConsistency(profileOptions), { ok: true, issues: [] });
  assert.doesNotThrow(() => assertConsistent(profileOptions));
});

check('class, order, and verbatim drift are each detected', () => {
  const changed = mutatedDoc('consistency-drift', doc => {
    doc.classes[0].orders[0].verbatim = 'A fabricated replacement quotation.';
    doc.classes[0].orders.push({
      number: '99', summary: 'Only in JSON.', verbatim: null,
      enforcement: 'discipline', enforcingComponent: null, revocationPhrase: null
    });
    doc.classes.push({
      id: 'EXTRA', heading: 'Only in JSON',
      orders: [{ number: '1', summary: 'Only in JSON.', verbatim: null, enforcement: 'discipline', enforcingComponent: null, revocationPhrase: null }]
    });
  });
  const result = checkConsistency({ jsonPath: changed, mdPath });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.includes('Class "EXTRA"')));
  assert.ok(result.issues.some(issue => issue.includes('order 99')));
  assert.ok(result.issues.some(issue => issue.includes('fabricated replacement quotation')));
  assert.throws(() => assertConsistent({ jsonPath: changed, mdPath }), error => {
    assert.equal(error.code, 'STANDING_ORDERS_INCONSISTENT');
    assert.ok(error.issues.length >= 3);
    return true;
  });
});

check('classification handles exact tools, prefixes, identifiers, and keywords', () => {
  assert.deepEqual(classifyAction({ tool: 'Task', command: 'delegate a review' }, { jsonPath }).classes, ['SPAWN']);
  assert.deepEqual(classifyAction({ tool: 'mcp__browser__upload', command: '' }, { jsonPath }).classes, ['BROWSER']);
  assert.deepEqual(classifyAction({ tool: 'Grep', command: '' }, { jsonPath }).classes, ['LOCAL-WORK']);
  assert.deepEqual(classifyAction({ tool: 'Bash', command: 'rg symbol src' }, { jsonPath }).classes, ['LOCAL-WORK']);
  assert.deepEqual(classifyAction({ tool: 'Shell', command: 'browser upload then send' }, { jsonPath }).classes, ['OUTWARD', 'BROWSER']);
});

check('a specific identifier claims its tokens before generic keyword matching', () => {
  const result = classifyAction({ tool: 'mcp__agent__submit', command: 'task submit' }, { jsonPath });
  assert.deepEqual(result.classes, ['SPAWN']);
});

check('unknown and empty actions do not invent classifications', () => {
  assert.deepEqual(classifyAction({ tool: 'Read', targetPath: 'README.md' }, { jsonPath }), { classes: [], orders: [] });
  assert.deepEqual(classifyAction({}, { jsonPath }), { classes: [], orders: [] });
  assert.deepEqual(classifyAction(undefined, { jsonPath }), { classes: [], orders: [] });
});

check('wired drift agrees with real calls and declaration-only unwired symbols', () => {
  const result = checkWiredDrift({ jsonPath, root: fixtureRoot });
  assert.deepEqual(result, { ok: true, issues: [], unresolved: [] });
});

check('wired:true without a production call is reported as drift', () => {
  const changed = mutatedDoc('stale-wired-true', doc => {
    doc.classes[0].orders[0].enforcingComponent = 'src/lib/guard.js#neverCalled';
  });
  const result = checkWiredDrift({ jsonPath: changed, root: fixtureRoot });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /neverCalled/);
  assert.match(result.issues.join('\n'), /wired:true/);
});

check('wired:false with a production call is reported as drift', () => {
  const changed = mutatedDoc('stale-wired-false', doc => {
    doc.classes[0].orders[0].wired = false;
  });
  const result = checkWiredDrift({ jsonPath: changed, root: fixtureRoot });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /wired:false.*guardIt/);
});

check('file-only component claims are surfaced as unresolved', () => {
  const changed = mutatedDoc('file-only-component', doc => {
    doc.classes[0].orders[0].enforcingComponent = 'src/lib/guard.js';
  });
  const result = checkWiredDrift({ jsonPath: changed, root: fixtureRoot });
  assert.equal(result.ok, true);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0], /not verifiable at symbol grain/);
});

function scratchRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-orders-scan-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, 'utf8');
  }
  return root;
}

check('comments, strings, and declarations cannot prove production wiring', () => {
  const root = scratchRepo({
    'src/lib/defining.js': 'function guardIt(value) { return Boolean(value); }\nmodule.exports = { guardIt };\n',
    'tools/prose.js': '// guardIt() is required\nconst message = "call guardIt()";\nmodule.exports = message;\n'
  });
  try {
    assert.deepEqual(findProductionReferences(root, 'src/lib/defining.js', 'guardIt'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('bare calls, member calls, require bindings, and in-file calls are recognized', () => {
  const root = scratchRepo({
    'src/lib/defining.js': 'function guardIt(value) { return Boolean(value); }\nfunction local(value) { return guardIt(value); }\nmodule.exports = { guardIt, local };\n',
    'src/bare.js': 'const { guardIt } = require("./lib/defining");\nguardIt(1);\n',
    'tools/member.js': 'const guards = require("../src/lib/defining");\nguards.guardIt(2);\n'
  });
  try {
    const hits = findProductionReferences(root, 'src/lib/defining.js', 'guardIt');
    assert.deepEqual(hits.map(hit => hit.file).sort(), ['src/bare.js', 'src/lib/defining.js', 'tools/member.js']);
    assert.ok(hits.some(hit => hit.inDefiningFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('a regex apostrophe does not blind the source scanner', () => {
  const root = scratchRepo({
    'src/lib/defining.js': 'function guardIt(value) { return Boolean(value); }\nmodule.exports = { guardIt };\n',
    'tools/caller.js': "const apostrophe = /don't|won't/;\nfunction run(value) { return guardIt(value) && apostrophe.test(value); }\nmodule.exports = run;\n"
  });
  try {
    assert.deepEqual(findProductionReferences(root, 'src/lib/defining.js', 'guardIt').map(hit => hit.file), ['tools/caller.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('missing scan directories and unreadable source refuse instead of certifying zero calls', () => {
  const missingTools = scratchRepo({ 'src/lib/defining.js': 'function guardIt() {}\n' });
  fs.rmSync(path.join(missingTools, 'tools'), { recursive: true, force: true });
  try {
    assert.throws(() => findProductionReferences(missingTools, 'src/lib/defining.js', 'guardIt'), /ENOENT/);
  } finally {
    fs.rmSync(missingTools, { recursive: true, force: true });
  }

  const unreadableRoot = scratchRepo({
    'src/lib/defining.js': 'function guardIt() {}\n',
    'tools/caller.js': 'guardIt();\n'
  });
  const unreadable = path.join(unreadableRoot, 'tools', 'caller.js');
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readFileSyncWithFixtureFailure(file, ...args) {
    if (file === unreadable) throw new Error('fixture read failure');
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    assert.throws(() => findProductionReferences(unreadableRoot, 'src/lib/defining.js', 'guardIt'), /fixture read failure/);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(unreadableRoot, { recursive: true, force: true });
  }
});

check('component prose is parsed and test-only references are excluded', () => {
  assert.deepEqual(
    parseComponentReferences('tools/observer.js observeIt() plus tests/observer.test.js#observeIt'),
    [{ file: 'tools/observer.js', symbol: 'observeIt' }]
  );
  assert.deepEqual(parseComponentReferences('src/lib/guard.js#guardIt'), [{ file: 'src/lib/guard.js', symbol: 'guardIt' }]);
  assert.deepEqual(parseComponentReferences('tools/observer.js'), [{ file: 'tools/observer.js', symbol: null }]);
});

check('retired, discipline, advisory, and enforced orders are bucketed exactly once', () => {
  const gaps = unenforcedOrders({ jsonPath, force: true });
  assert.deepEqual({
    enforced: gaps.enforced.length,
    partial: gaps.partial.length,
    unenforced: gaps.unenforced.length,
    prose: gaps.prose.length,
    retired: gaps.retired.length
  }, { enforced: 1, partial: 0, unenforced: 1, prose: 2, retired: 1 });
});

check('backstop and enforcement reports compose the disposable profile honestly', () => {
  assert.deepEqual(checkBackstopDrift({ jsonPath, mdPath }), { ok: true, issues: [] });
  const report = enforcementReport(profileOptions);
  assert.equal(report.ok, true, report.checks.flatMap(entry => entry.issues).join('\n'));
  assert.deepEqual(report.counts, {
    total: 5,
    active: 4,
    enforced: 1,
    partial: 0,
    unenforced: 1,
    prose: 2,
    retired: 1,
    enforcedFraction: 0.25
  });
});

check('backstop and retirement drift are detected in both directions', () => {
  const dishonestMd = path.join(fixtureRoot, 'mutations', 'dishonest.md');
  fs.writeFileSync(dishonestMd, fixtureMarkdown
    .replace('1. Describe delegated work precisely.', '1. Mechanical backstop: tools/observer.js#observeIt.')
    .replace('1. **RETIRED by the customer.**', '1. Former browser rule.'), 'utf8');
  const result = checkBackstopDrift({ jsonPath, mdPath: dishonestMd });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.includes('Mechanical backstop')));
  assert.ok(result.issues.some(issue => issue.includes('carries no bold RETIRED marker')));

  const activeRetiredOrder = mutatedDoc('retirement-marker-stale-json', doc => {
    const order = doc.classes[1].orders[0];
    order.enforcement = 'discipline';
    order.revocationPhrase = null;
  });
  const reverse = checkBackstopDrift({ jsonPath: activeRetiredOrder, mdPath });
  assert.equal(reverse.ok, false);
  assert.ok(reverse.issues.some(issue => issue.includes('marks this order RETIRED')));
});

fs.rmSync(fixtureRoot, { recursive: true, force: true });
process.stdout.write(`standing-orders portable contract: ${checks} checks passed\n`);
