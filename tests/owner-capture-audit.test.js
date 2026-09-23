// EXECUTABLE CHANGE
// Assertion audit report (2026-08-26): the captured-turn assertion below used
// `captured >= 1`.  Mutation: `isCaptured()` was temporarily changed to return
// true for every turn.  Before this change that specific check remained green:
// "ok  a captured owner turn is recognised even when the entry was later appended to".
// With the exact-count assertion, the same mutant is rejected with:
// "AssertionError [ERR_ASSERTION]: only the ledger-backed turn may be captured\n\n2 !== 1".
// NOT-FOUND: empty loop/forEach assertion bodies; exit-status/truthy-return-only
// evidence; swallowed failures via try/catch or optional chaining; mocks of the
// subject; platform skips or precondition guards; expectations computed by the
// same subject code.  Mutation preconditions: none unmet.  The product file was
// restored byte-for-byte after the mutation, and the restored run ended:
// "10 passed, 0 failed".
'use strict';
// WHAT HE SAID vs WHAT R HOLDS.
//
// The owner, 2026-08-11 (reports/OWNER-REQUEST-LEDGER.json R1233, verbatim):
//   "I think maybe R is not working or something is going wrong because I have
//    said a lot of times what I want"
//
// Capture is manual, so the ledger only holds what an agent remembered to file.
// Measured with this tool on 2026-08-11 over a 24-hour window: 71 real owner
// turns, 6 present in the ledger's verbatim corpus, 65 absent -- including
// "I wanted the whole list. Go back and review what I had wanted on the purchase
// list, it should be in R".
//
// The load-bearing property under test is NOT the diff, it is the DISCRIMINATOR:
// a detector that mistakes agent traffic for the owner's words would file lane
// briefs as his requirements (the R1098 defect) and would drown the real signal.
// So the fixture deliberately mixes human turns with task-notification turns,
// peer turns, sidechain turns and tool results carrying the same absent text.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auditTool = require('../tools/owner-capture-audit.js');
const captureSpool = require('../src/lib/owner-capture-spool');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}: ${error.stack || error.message}`); }
}

const CAPTURED = 'ok continue working with your team until it makes sense to ship a candidate to A for testing';
const UNCAPTURED = 'I wanted the whole list. Go back and review what I had wanted on the purchase list, it should be in R';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-audit-'));
  const ledger = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({
    revision: 1,
    requests: [
      { id: 'R1230', verbatim: `${CAPTURED}\n[APPEND 2026-08-11T00:00:00.000Z] and one more thing`, request: '(interpretation) x', status: 'open' },
      { id: 'R900', request: '(interpretation) an entry with no verbatim at all', status: 'open' }
    ]
  }));

  const projects = path.join(dir, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const at = '2026-08-11T04:25:28.209Z';
  const rows = [
    { origin: { kind: 'human' }, text: CAPTURED },
    { origin: { kind: 'human' }, text: UNCAPTURED },
    { origin: { kind: 'task-notification' }, text: `<task-notification> ${UNCAPTURED} </task-notification>` },
    { origin: { kind: 'peer' }, text: UNCAPTURED },
    { origin: { kind: 'human' }, text: UNCAPTURED, isSidechain: true },
    { text: UNCAPTURED }   // no origin at all: an older transcript shape
  ].map((row, index) => JSON.stringify({
    type: 'user',
    timestamp: at,
    isSidechain: Boolean(row.isSidechain),
    ...(row.origin ? { origin: row.origin } : {}),
    uuid: `u${index}`,
    message: { role: 'user', content: [{ type: 'text', text: row.text }] }
  }));
  // A tool result carrying the same words must never count as him saying them.
  rows.push(JSON.stringify({
    type: 'user', timestamp: at, isSidechain: false, origin: { kind: 'human' }, uuid: 'tr',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: UNCAPTURED }] }
  }));
  fs.writeFileSync(path.join(projects, 'session.jsonl'), `${rows.join('\n')}\n`);
  return { ledger, projects };
}

const OPTIONS = f => ({ ledger: f.ledger, projects: [f.projects], since: '2026-08-01T00:00:00.000Z' });

(async () => {
  await check('a captured owner turn is recognised even when the entry was later appended to', async () => {
    const f = fixture();
    const result = await auditTool.audit(OPTIONS(f));
    assert.strictEqual(result.captured, 1, 'only the ledger-backed turn may be captured');
    assert.ok(!result.uncaptured.some(u => u.text === CAPTURED));
  });

  await check('an owner turn absent from the ledger is reported with file and line', async () => {
    const f = fixture();
    const result = await auditTool.audit(OPTIONS(f));
    const hit = result.uncaptured.find(u => u.text === UNCAPTURED);
    assert.ok(hit, 'the uncaptured owner turn must be reported');
    assert.match(hit.file, /session\.jsonl$/);
    assert.strictEqual(hit.line, 2, 'the line number must point at the actual transcript row');
  });

  await check('ONLY origin.kind "human" counts: agent traffic wearing the user role is excluded', async () => {
    const f = fixture();
    const result = await auditTool.audit(OPTIONS(f));
    assert.strictEqual(result.humanTurns, 2, `expected 2 human turns, saw ${result.humanTurns}`);
    assert.strictEqual(result.uncapturedCount, 1,
      'a task-notification, a peer turn, a sidechain turn, an origin-less row and a tool result all carry the same text and must all be excluded');
  });

  await check('the audit reads only: the ledger and transcript are byte-identical afterwards', async () => {
    const f = fixture();
    const before = [fs.readFileSync(f.ledger, 'utf8'), fs.readFileSync(path.join(f.projects, 'session.jsonl'), 'utf8')];
    await auditTool.audit(OPTIONS(f));
    const after = [fs.readFileSync(f.ledger, 'utf8'), fs.readFileSync(path.join(f.projects, 'session.jsonl'), 'utf8')];
    assert.deepStrictEqual(after, before,
      'this tool must never capture on its own; auto-filing his words is how a paraphrase acquires his authority');
  });

  await check('only VERBATIM counts as capture, never an interpretation that paraphrases him', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-audit-paraphrase-'));
    const ledger = path.join(dir, 'ledger.json');
    fs.writeFileSync(ledger, JSON.stringify({
      revision: 1,
      requests: [{ id: 'R1', request: `(interpretation) ${UNCAPTURED}`, status: 'open' }]
    }));
    const projects = path.join(dir, 'projects');
    fs.mkdirSync(projects);
    fs.writeFileSync(path.join(projects, 's.jsonl'), `${JSON.stringify({
      type: 'user', timestamp: '2026-08-11T04:25:28.209Z', isSidechain: false, origin: { kind: 'human' }, uuid: 'a',
      message: { role: 'user', content: [{ type: 'text', text: UNCAPTURED }] }
    })}\n`);
    const result = await auditTool.audit({ ledger, projects: [projects], since: '2026-08-01T00:00:00.000Z' });
    assert.strictEqual(result.uncapturedCount, 1,
      'an interpretation field holding the same words is exactly the R44 paraphrase failure, not a capture');
  });

  await check('--include-spooled counts an ingress turn as not lost without calling it ledger-captured', async () => {
    const f = fixture();
    captureSpool.writeAhead(f.ledger, {
      mode: 'ingress', id: null, text: UNCAPTURED, interpretation: null,
      actor: 'owner-ingress-hook', source: 'claude-code/UserPromptSubmit', gates: [],
      status: null, scope: null, threadId: 'fixture', provenanceClass: null,
      proposal: null, now: new Date('2026-08-11T04:25:28.209Z')
    });
    const result = await auditTool.audit({ ...OPTIONS(f), includeSpooled: true });
    assert.strictEqual(result.captured, 1, 'the ledger count must remain separate');
    assert.strictEqual(result.spooled, 1, 'the pending ingress turn must be counted as spooled');
    assert.strictEqual(result.uncapturedCount, 0, 'a turn present in the spool is not lost');
    assert.strictEqual(result.spoolRecords, 1, 'the result must expose the reviewed spool corpus size');
  });

  await check('a short turn with no 8-gram falls back to containment rather than guessing', async () => {
    const corpus = auditTool.loadLedgerCorpus((() => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-audit-short-')), 'l.json');
      fs.writeFileSync(file, JSON.stringify({ requests: [{ id: 'R1', verbatim: 'ok approve everything and keep going' }] }));
      return file;
    })());
    assert.strictEqual(auditTool.isCaptured(corpus, auditTool.normalize('approve everything')), true);
    assert.strictEqual(auditTool.isCaptured(corpus, auditTool.normalize('cancel the run')), false);
  });

  await check('normalization survives the way he actually types', async () => {
    assert.strictEqual(
      auditTool.normalize('  Trademark,  licnsing, entity ioncorportation, all the toolsanebaled.ai .io .com ? '),
      'trademark licnsing entity ioncorportation all the toolsanebaled ai io com'
    );
    assert.strictEqual(auditTool.shingles(auditTool.normalize('one two three')).length, 0, 'a short turn has no shingle');
    assert.strictEqual(auditTool.shingles(auditTool.normalize('a b c d e f g h i')).length, 2);
  });

  await check('a bare slash command is not a directive; a real sentence is', async () => {
    assert.strictEqual(auditTool.isDirectiveText('/goal'), false);
    assert.strictEqual(auditTool.isDirectiveText('<command-name>/loop</command-name>'), false);
    assert.strictEqual(auditTool.isDirectiveText('   '), false);
    assert.strictEqual(auditTool.isDirectiveText(UNCAPTURED), true);
  });

  await check('an unreadable ledger fails loudly with exit code 4, never as "nothing missing"', async () => {
    await assert.rejects(
      () => auditTool.audit({ ledger: path.join(os.tmpdir(), 'no-such-ledger-3f9a1.json'), projects: [os.tmpdir()], since: '2026-08-01T00:00:00.000Z' }),
      error => error.name === 'CaptureAuditError' && error.exitCode === 4
    );
  });

  await check('a missing or empty transcript tree refuses instead of reporting a clean zero-item scan', async () => {
    const f = fixture();
    const empty = path.join(path.dirname(f.projects), 'empty-projects');
    fs.mkdirSync(empty);
    await assert.rejects(
      () => auditTool.audit({ ledger: f.ledger, projects: [empty], since: '2026-08-01T00:00:00.000Z' }),
      error => error.name === 'CaptureAuditError' && error.exitCode === 4 && /no transcript files/.test(error.message)
    );
    await assert.rejects(
      () => auditTool.audit({ ledger: f.ledger, projects: [`${empty}-missing`], since: '2026-08-01T00:00:00.000Z' }),
      error => error.name === 'CaptureAuditError' && error.exitCode === 4 && /Could not scan transcript directory/.test(error.message)
    );
  });

  await check('a malformed transcript row refuses instead of omitting an unknown owner turn', async () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.projects, 'session.jsonl'), '{not-json}\n');
    await assert.rejects(
      () => auditTool.audit(OPTIONS(f)),
      error => error.name === 'CaptureAuditError' && error.exitCode === 4 && /Could not parse transcript/.test(error.message)
    );
  });

  await check('an unreadable spool record refuses instead of treating the spool as empty', async () => {
    const f = fixture();
    const pending = captureSpool.pendingDirectory(f.ledger);
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'broken.json'), '{not-json}\n');
    await assert.rejects(
      () => auditTool.audit({ ...OPTIONS(f), includeSpooled: true }),
      error => error.name === 'CaptureAuditError' && error.exitCode === 4 && /Could not establish the pending owner capture spool/.test(error.message)
    );
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
})();
