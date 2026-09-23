'use strict';

// Portable contract tests for the standing-order enforcement report. The
// installation's standing orders are private operator state, so every case
// below runs the production parser and drift detectors against a disposable
// JSON/Markdown pair with no customer instructions or identities.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadOrders,
  unenforcedOrders,
  checkBackstopDrift,
  enforcementReport
} = require('../../src/lib/standing-orders');

const ROOT = path.resolve(__dirname, '..', '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enforcement-gaps-'));
const jsonPath = path.join(fixtureRoot, 'config', 'standing-orders.json');
const mdPath = path.join(fixtureRoot, 'STANDING-ORDERS.md');

const fixtureDoc = Object.freeze({
  schemaVersion: 1,
  sessionBoot: [{ number: 1, instruction: 'Load the disposable fixture orders.' }],
  classes: [{
    id: 'FIXTURE',
    heading: 'Disposable fixture actions',
    orders: [
      {
        number: '1',
        summary: 'A prose-only fixture order.',
        verbatim: 'Review fixture actions deliberately.',
        enforcement: 'discipline',
        enforcingComponent: null,
        revocationPhrase: null,
        wired: null
      },
      {
        number: '2',
        summary: 'A fully wired fixture order.',
        verbatim: null,
        enforcement: 'mechanical',
        enforcingComponent: 'src/lib/standing-orders.js#loadOrders',
        revocationPhrase: null,
        wired: true
      },
      {
        number: '3',
        summary: 'A partially covered fixture order.',
        verbatim: null,
        enforcement: 'mechanical',
        enforcingComponent: 'src/lib/standing-orders.js#loadOrders',
        revocationPhrase: null,
        wired: true,
        coverageGap: 'A fixture-only alternate transport remains outside this mechanism.'
      },
      {
        number: '4',
        summary: 'An advisory fixture with no production caller.',
        verbatim: null,
        enforcement: 'advisory',
        enforcingComponent: 'src/lib/standing-orders.js#fixtureNeverCalled',
        revocationPhrase: null,
        wired: false
      },
      {
        number: '5',
        summary: 'A retired fixture order.',
        verbatim: null,
        enforcement: 'retired',
        enforcingComponent: null,
        revocationPhrase: 'Retire this fixture order permanently.',
        wired: null
      }
    ]
  }],
  classificationHeuristics: {
    FIXTURE: { keywords: ['fixture'] }
  }
});

const fixtureMarkdown = `# Disposable standing orders

## Class: FIXTURE — disposable actions

1. Review the fixture deliberately.
   "Review fixture actions deliberately."

2. Run the wired fixture check.
   Mechanical backstop: src/lib/standing-orders.js#loadOrders.

3. Run the partially covering fixture check.
   Mechanical
   backstop: src/lib/standing-orders.js#loadOrders.

4. Record the advisory fixture.

5. **RETIRED** Keep this entry only as fixture history.
   "Retire this fixture order permanently."
`;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mutatedDoc(mutate) {
  const value = structuredClone(fixtureDoc);
  mutate(value);
  return value;
}

let mutationNumber = 0;
function mutationPath(value) {
  mutationNumber += 1;
  const file = path.join(fixtureRoot, 'mutations', `standing-orders-${mutationNumber}.json`);
  writeJson(file, value);
  return file;
}

function order(doc, number) {
  return doc.classes[0].orders.find(item => item.number === number);
}

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

try {
  writeJson(jsonPath, fixtureDoc);
  fs.writeFileSync(mdPath, fixtureMarkdown, 'utf8');

  check('the production parser accepts the complete disposable mirror', () => {
    const parsed = loadOrders({ jsonPath, force: true });
    assert.equal(parsed.classes.length, 1);
    assert.equal(parsed.classes[0].orders.length, 5);
  });

  check('every order lands in exactly one enforcement bucket', () => {
    const gaps = unenforcedOrders({ jsonPath, force: true });
    assert.deepEqual(Object.fromEntries(Object.entries(gaps).map(([name, rows]) => [name, rows.length])), {
      prose: 1,
      unenforced: 1,
      partial: 1,
      enforced: 1,
      retired: 1
    });
    const identities = Object.values(gaps).flat().map(item => `${item.classId}#${item.number}`);
    assert.equal(new Set(identities).size, 5);
  });

  check('the prose bucket preserves the fixture quote and names no mechanism', () => {
    const [prose] = unenforcedOrders({ jsonPath, force: true }).prose;
    assert.equal(prose.verbatim, 'Review fixture actions deliberately.');
    assert.equal(prose.enforcingComponent, null);
  });

  check('partial and enforced are distinct despite both being wired', () => {
    const gaps = unenforcedOrders({ jsonPath, force: true });
    assert.equal(gaps.enforced[0].coverageGap, null);
    assert.match(gaps.partial[0].coverageGap, /alternate transport/);
    assert.equal(gaps.partial[0].wired, true);
  });

  check('discipline cannot smuggle in a mechanism coverage gap', () => {
    const invalidPath = mutationPath(mutatedDoc(doc => {
      order(doc, '1').coverageGap = 'Pretend partial coverage where no mechanism exists.';
    }));
    assert.throws(() => loadOrders({ jsonPath: invalidPath, force: true }),
      /is discipline; a coverageGap describes a partially-covering mechanism/);
  });

  check('the matching disposable JSON and Markdown pair has no drift', () => {
    const report = enforcementReport({ jsonPath, mdPath, root: ROOT });
    assert.equal(report.ok, true, report.checks.flatMap(item => item.issues).join('\n'));
    assert.deepEqual(report.checks.map(item => item.name).sort(),
      ['checkBackstopDrift', 'checkConsistency', 'checkWiredDrift']);
  });

  check('a prose backstop claim contradicting a discipline mirror is detected', () => {
    const driftPath = mutationPath(mutatedDoc(doc => {
      const target = order(doc, '2');
      target.enforcement = 'discipline';
      target.enforcingComponent = null;
      target.wired = null;
    }));
    const result = checkBackstopDrift({ jsonPath: driftPath, mdPath });
    assert.equal(result.ok, false);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0], /Class "FIXTURE" order 2/);
    assert.match(result.issues[0], /reading only the \.md would believe it was covered/);
  });

  check('a Markdown retirement with a still-live mirror is detected', () => {
    const driftPath = mutationPath(mutatedDoc(doc => {
      const target = order(doc, '5');
      target.enforcement = 'mechanical';
      target.enforcingComponent = 'src/lib/standing-orders.js#loadOrders';
      target.revocationPhrase = null;
      target.wired = true;
    }));
    const result = checkBackstopDrift({ jsonPath: driftPath, mdPath });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => /order 5/.test(issue) && /marks this order RETIRED/.test(issue)));
  });

  check('a mirror retirement with no visible Markdown marker is detected', () => {
    const activeMarkdown = fixtureMarkdown.replace('5. **RETIRED**', '5. Active');
    const activeMarkdownPath = path.join(fixtureRoot, 'STANDING-ORDERS-active.md');
    fs.writeFileSync(activeMarkdownPath, activeMarkdown, 'utf8');
    const result = checkBackstopDrift({ jsonPath, mdPath: activeMarkdownPath });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => /order 5/.test(issue) && /no bold RETIRED marker/.test(issue)));
  });

  check('retirement requires quoted revocation evidence', () => {
    const invalidPath = mutationPath(mutatedDoc(doc => { order(doc, '5').revocationPhrase = null; }));
    assert.throws(() => loadOrders({ jsonPath: invalidPath, force: true }),
      /is retired but records no "revocationPhrase"/);
  });

  check('retirement refuses every stale live-enforcement field', () => {
    for (const [mutate, pattern] of [
      [target => { target.enforcingComponent = 'src/lib/standing-orders.js#loadOrders'; }, /revoked order has no enforcing component/],
      [target => { target.wired = true; }, /"wired" must be null or absent/],
      [target => { target.coverageGap = 'A stale live mechanism gap.'; }, /revoked order has none/]
    ]) {
      const invalidPath = mutationPath(mutatedDoc(doc => mutate(order(doc, '5'))));
      assert.throws(() => loadOrders({ jsonPath: invalidPath, force: true }), pattern);
    }
  });

  check('a mechanical-backstop claim split across a line wrap is still detected', () => {
    const driftPath = mutationPath(mutatedDoc(doc => {
      const target = order(doc, '3');
      target.enforcement = 'discipline';
      target.enforcingComponent = null;
      target.wired = null;
      delete target.coverageGap;
    }));
    const result = checkBackstopDrift({ jsonPath: driftPath, mdPath });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => /Class "FIXTURE" order 3/.test(issue)));
  });

  check('the report counts active and retired entries without flattering coverage', () => {
    const report = enforcementReport({ jsonPath, mdPath, root: ROOT });
    assert.deepEqual(report.counts, {
      total: 5,
      active: 4,
      enforced: 1,
      partial: 1,
      unenforced: 1,
      prose: 1,
      retired: 1,
      enforcedFraction: 0.25
    });
  });

  check('retiring an enforced order cannot improve the coverage fraction', () => {
    const before = enforcementReport({ jsonPath, mdPath, root: ROOT }).counts;
    const retiredPath = mutationPath(mutatedDoc(doc => {
      const target = order(doc, '2');
      target.enforcement = 'retired';
      target.enforcingComponent = null;
      target.wired = null;
      target.revocationPhrase = 'Retire this fixture order permanently.';
    }));
    const after = enforcementReport({ jsonPath: retiredPath, mdPath, root: ROOT }).counts;
    assert.equal(after.retired, before.retired + 1);
    assert.equal(after.enforced, before.enforced - 1);
    assert.ok(after.enforcedFraction < before.enforcedFraction);
  });

  check('an unreadable mirror is UNKNOWN and never reported as passing', () => {
    const missingPath = path.join(fixtureRoot, 'missing', 'standing-orders.json');
    const report = enforcementReport({ jsonPath: missingPath, mdPath, root: ROOT });
    const unknown = report.checks.filter(item => item.ok === null);
    assert.equal(report.ok, false);
    assert.ok(unknown.some(item => item.name === 'unenforcedOrders'));
    assert.equal(report.counts.total, 0);
    for (const item of unknown) assert.match(item.issues[0], /^UNKNOWN: /);
  });

  console.log(`Enforcement-gap tests passed (${checks} checks against a disposable standing-orders profile).`);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
