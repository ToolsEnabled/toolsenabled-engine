'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ingress = require('../tools/owner-ingress-spool');
const review = require('../tools/owner-spool-review');
const spool = require('../src/lib/owner-capture-spool');

const TOOL = path.resolve(__dirname, '..', 'tools', 'owner-spool-review.js');
let checks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `owner-spool-review-${name}-`));
  const ledger = path.join(root, 'OWNER-REQUEST-LEDGER.json');
  fs.writeFileSync(ledger, `${JSON.stringify({ revision: 1, updatedAt: '2026-08-11', requests: [] }, null, 2)}\n`);
  return { root, ledger, fallback: ingress.fallbackFileForLedger(ledger) };
}

function addIngress(f, text, at = '2026-08-11T08:00:00.000Z') {
  return spool.writeAhead(f.ledger, {
    mode: 'ingress', id: null, text, interpretation: null,
    actor: 'owner-ingress-hook', source: 'claude-code/UserPromptSubmit', gates: [],
    status: null, scope: null, threadId: 'fixture-session', provenanceClass: null,
    proposal: null, now: new Date(at)
  });
}

function runCli(f, args) {
  return spawnSync(process.execPath, [TOOL, '--ledger', f.ledger, '--fallback', f.fallback, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
}

function listShowsIdWhenAndVerbatimText() {
  const f = fixture('list');
  const words = 'ok, keep going — this is still unclassified';
  const handle = addIngress(f, words);
  const result = runCli(f, ['--json']);
  check(result.status === 0, `review list exited ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  check(parsed.pending.length === 1, 'review must list one pending ingress turn');
  check(parsed.pending[0].id === handle.name, 'review must expose the stable spool id');
  check(parsed.pending[0].when === handle.record.spooledAt, 'review must expose when the turn arrived');
  check(Buffer.from(parsed.pending[0].text).equals(Buffer.from(words)), 'review must return the exact spooled text');
}

function promotionPipesExactBytesWithHiddenSpawn() {
  const f = fixture('pipe');
  const words = 'exact bytes\r\nwith unicode café — and trailing spaces  ';
  const handle = addIngress(f, words);
  const record = ingress.listUnclassifiedIngress({ ledgerFile: f.ledger, fallbackFile: f.fallback })[0];
  let observed = null;
  const result = review.runCapture(record, {
    'new-id': 'R9001',
    interpretation: 'fixture promotion',
    gates: []
  }, f.ledger, {
    run(executable, args, options) {
      observed = { executable, args, options };
      return { status: 0, stdout: '{"id":"R9001","revision":2}', stderr: '' };
    }
  });
  check(result.summary.id === 'R9001', 'the promotion result must preserve owner-capture.js output');
  check(observed.executable === process.execPath, 'promotion must use the current Node interpreter');
  check(observed.args[0] === review.CAPTURE_SCRIPT, 'promotion must call tools/owner-capture.js');
  check(observed.options.windowsHide === true, 'promotion spawn must set windowsHide');
  check(Buffer.from(observed.options.input).equals(Buffer.from(words)), 'promotion must pipe the exact spooled bytes');
  check(!observed.args.includes(words), 'owner words must not be placed on the command line');
  check(handle.record.text === words, 'the source fixture must remain unchanged');
}

function promotionRefusesUnmeasurableCaptureResult() {
  const f = fixture('invalid-result');
  addIngress(f, 'keep this pending until capture can be verified');
  const record = ingress.listUnclassifiedIngress({ ledgerFile: f.ledger, fallbackFile: f.fallback })[0];
  const args = { 'new-id': 'R9003', interpretation: 'fixture promotion', gates: [] };

  for (const stdout of ['not json', '{"id":"R9003"}']) {
    assert.throws(
      () => review.runCapture(record, args, f.ledger, {
        run() { return { status: 0, stdout, stderr: '' }; }
      }),
      error => error.code === 'OWNER_SPOOL_PROMOTION_RESULT_INVALID',
      'promotion must refuse when the successful child result cannot establish its id and revision'
    );
    checks += 1;
  }
  check(spool.listPending(f.ledger).length === 1, 'an unmeasurable capture result must leave ingress pending');
}

function promotionUsesTheRealLedgerWriter() {
  const f = fixture('promote');
  const words = 'Please make ingress capture mechanical now.';
  const handle = addIngress(f, words);
  const result = runCli(f, [
    '--promote', handle.name,
    '--new-id', 'R9002',
    '--interpretation', 'make owner ingress capture mechanical'
  ]);
  check(result.status === 0, `real promotion exited ${result.status}: ${result.stderr}`);
  const ledger = JSON.parse(fs.readFileSync(f.ledger, 'utf8'));
  const entry = ledger.requests.find(item => item.id === 'R9002');
  check(entry && entry.verbatim === words, 'promotion must reach the ledger through owner-capture.js with verbatim text');
  check(spool.listPending(f.ledger).length === 0, 'successful promotion must settle both the ingress and capture write-ahead records');
  const reconciled = fs.readdirSync(spool.reconciledDirectory(f.ledger));
  check(reconciled.includes(handle.name), 'the original ingress record must be retained in reconciled/');
}

function discardRetainsBytesAndReason() {
  const f = fixture('discard');
  const words = 'yes';
  const handle = addIngress(f, words);
  const reason = 'acknowledgement only; no new request or scope change';
  const result = runCli(f, ['--discard', handle.name, '--reason', reason]);
  check(result.status === 0, `discard exited ${result.status}: ${result.stderr}`);
  check(spool.listPending(f.ledger).length === 0, 'discarded noise must leave the pending queue');
  const kept = JSON.parse(fs.readFileSync(path.join(spool.reconciledDirectory(f.ledger), handle.name), 'utf8'));
  check(kept.ledgerOutcome === 'discarded', 'discard must be a recorded classification, not deletion');
  check(kept.discardReason === reason, 'discard must retain the custodian reason');
  check(Buffer.from(kept.text).equals(Buffer.from(words)), 'discard must retain the original bytes');
  const ledger = JSON.parse(fs.readFileSync(f.ledger, 'utf8'));
  check(ledger.requests.length === 0, 'discard must not pollute the request ledger');
}

function fallbackRecordsAreReviewableAndSettleAppendOnly() {
  const f = fixture('fallback');
  const words = 'fallback owner turn';
  ingress.captureHookEvent({ hook_event_name: 'UserPromptSubmit', prompt: words }, {
    ledgerFile: f.ledger,
    fallbackFile: f.fallback,
    spoolModule: { writeAhead() { throw Object.assign(new Error('down'), { code: 'DOWN' }); } },
    now: new Date('2026-08-11T09:00:00.000Z')
  });
  const before = fs.readFileSync(f.fallback, 'utf8');
  const pending = ingress.listUnclassifiedIngress({ ledgerFile: f.ledger, fallbackFile: f.fallback });
  check(pending.length === 1 && pending[0].storage === 'fallback', 'fallback turns must appear in the same review queue');
  const result = runCli(f, ['--discard', pending[0].id, '--reason', 'fixture fallback noise']);
  check(result.status === 0, `fallback discard exited ${result.status}: ${result.stderr}`);
  const after = fs.readFileSync(f.fallback, 'utf8');
  check(after.startsWith(before) && after.length > before.length, 'fallback settlement must append and never rewrite the fallback bytes');
  check(ingress.listUnclassifiedIngress({ ledgerFile: f.ledger, fallbackFile: f.fallback }).length === 0, 'resolved fallback turn must leave the review queue');
}

/* THE TWO FAILURES THAT MADE 29 OF THE OWNER'S 30 RECENT MESSAGES UNREACHABLE
   (measured 2026-09-03 on the live install):

   1. a turn an agent read and filed nothing for was settled 'discarded' and
      left the pending queue, so nothing could list or promote it again;
   2. this tool's default run reads the canonical ledger's own spool, while the
      product writes the person's turns to the r-ledger anchor spool -- 22
      records the default run answered "clean. 0 turns" about.

   Both are driven here through the real CLI against a redirected state root
   (TOOLSENABLED_STATE_ROOT), so the tool resolves the same two locations the
   product does and the unfiled record has to survive the whole way to the
   canonical ledger. */
function unfiledProductTurnsAreListedAndStillPromotable() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-spool-review-product-')));
  const ledger = path.join(root, 'reports', 'OWNER-REQUEST-LEDGER.json');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, `${JSON.stringify({ revision: 1, updatedAt: '2026-09-03', requests: [] }, null, 2)}\n`);
  const anchor = path.join(root, 'state', 'r-ledger', 'R-PROPOSALS');
  const words = 'the account checker on page two is broken again';
  const handle = spool.writeAhead(anchor, {
    mode: 'ingress', id: null, text: words, actor: 'claude', source: 'product/sendTurn',
    status: 'unclassified', scope: 'session', threadId: 'chat-fixture', provenanceClass: 'owner-ingress',
    now: new Date('2026-09-03T14:43:59.341Z')
  });
  spool.markUnfiled(handle, { reason: 'agent read it and filed nothing', actor: 'claude' });

  const run = extra => spawnSync(process.execPath, [TOOL, ...extra], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TOOLSENABLED_STATE_ROOT: root }
  });

  const listed = run(['--json']);
  check(listed.status === 0, `default listing exited ${listed.status}: ${listed.stderr}`);
  const parsed = JSON.parse(listed.stdout);
  check(parsed.pending.length === 1, 'a turn the product spooled must appear in a default listing');
  check(parsed.pending[0].id === handle.name, 'the listing must expose the product record\'s id');
  check(Buffer.from(parsed.pending[0].text).equals(Buffer.from(words)), 'the listing must return the exact spooled text');
  check(parsed.pending[0].outcome === 'unfiled', 'a turn an agent filed nothing for must be visible as unfiled');
  check(parsed.pending[0].unfiled && parsed.pending[0].unfiled.by === 'claude',
    'the listing must name who was reading when nothing was filed');

  const plain = run([]);
  check(plain.status === 0, `default plain listing exited ${plain.status}: ${plain.stderr}`);
  check(plain.stdout.includes('read by an agent that filed nothing'),
    'the plain listing must say how many turns an agent read and left');

  const promoted = run(['--promote', handle.name, '--new-id', 'R9010', '--interpretation', 'fix the page two account checker']);
  check(promoted.status === 0, `re-filing an unfiled turn exited ${promoted.status}: ${promoted.stderr}`);
  const filed = JSON.parse(fs.readFileSync(ledger, 'utf8')).requests.find(entry => entry.id === 'R9010');
  check(filed && filed.verbatim === words, 'an unfiled turn must re-file into the canonical ledger with the words intact');
  check(spool.listPending(anchor).length === 0, 're-filing must settle the product record');
  check(fs.readdirSync(spool.reconciledDirectory(anchor)).includes(handle.name),
    're-filing must keep the original bytes in reconciled/');

  const after = run(['--json']);
  check(JSON.parse(after.stdout).pending.length === 0, 'a re-filed turn must leave the review queue');
  const gone = run(['--discard', handle.name, '--reason', 'already promoted']);
  check(gone.status === 1, `discarding a settled id exited ${gone.status}`);
  check(/list the ids that are waiting/.test(gone.stderr),
    'the not-found refusal must say how to find the ids that are still waiting');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

/* A DISCARD FROM BEFORE THE PERSON-DECIDED GUARD IS THE SAME LOSS IN A
   DIFFERENT DIRECTORY.

   MEASURED 2026-09-03 on the owner's live spool: 228 records already sit in
   reconciled/ with ledgerOutcome 'discarded', an agent's name, and no proof a
   person decided anything -- the exact shape markDiscarded's decidedBy guard
   now refuses to create. The guard stops new ones; it does nothing by itself
   for the 228 already on disk, so a default `owner-spool-review.js --json` run
   against the live state root answers with only the OTHER, already-fixed
   category (turns marked unfiled) and says nothing about these.

   Driven here through the real CLI against a redirected state root, seeding
   the reconciled/ record directly (the current, guarded markDiscarded cannot
   produce this shape, which is exactly the point): the record must become
   visible in a default listing, must still promote into the canonical ledger
   with its words intact, and a record from the SAME reconciled/ directory that
   really was a person's decision must stay exactly where it was settled. */
function misdiscardedProductTurnsAreRecoveredListedAndStillPromotable() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-spool-review-misdiscarded-')));
  const ledger = path.join(root, 'reports', 'OWNER-REQUEST-LEDGER.json');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, `${JSON.stringify({ revision: 1, updatedAt: '2026-09-03', requests: [] }, null, 2)}\n`);
  const anchor = path.join(root, 'state', 'r-ledger', 'R-PROPOSALS');

  const words = 'the mirror folder setup you asked about is still not done';
  const reconciledDirectory = spool.reconciledDirectory(anchor);
  fs.mkdirSync(reconciledDirectory, { recursive: true });
  const stuckName = 'pre-guard-turn.json';
  const stuckAt = '2026-08-30T01:19:33.494Z';
  fs.writeFileSync(path.join(reconciledDirectory, stuckName), `${JSON.stringify({
    version: 1, name: stuckName, spooledAt: stuckAt, spooledByPid: 1234,
    ledgerFile: path.resolve(anchor), mode: 'ingress', id: null, text: words,
    interpretation: null, actor: 'codex', source: 'product/sendTurn', gates: [],
    status: 'unclassified', scope: 'session', threadId: 'chat-fixture',
    provenanceClass: 'owner-ingress', proposal: null,
    ledgerOutcome: 'discarded', discardedAt: stuckAt, discardedBy: 'codex',
    discardReason: 'agent read it and filed nothing'
    // no decidedBy: the pre-guard shape measured live, not a hypothetical one.
  }, null, 2)}\n`);

  // A record from the very same reconciled/ directory that really was the
  // person's decision -- made through the current, guarded markDiscarded, so
  // it carries decidedBy. Recovery must leave this one alone.
  const genuineHandle = spool.writeAhead(anchor, {
    mode: 'ingress', id: null, text: 'ok', actor: 'owner-ingress-hook', now: new Date('2026-08-30T02:00:00.000Z')
  });
  const genuineSettled = spool.markDiscarded(genuineHandle, {
    reason: 'acknowledgement only', actor: 'person', decidedBy: spool.DISCARD_DECIDED_BY
  });

  const run = extra => spawnSync(process.execPath, [TOOL, ...extra], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TOOLSENABLED_STATE_ROOT: root }
  });

  const listed = run(['--json']);
  check(listed.status === 0, `default listing exited ${listed.status}: ${listed.stderr}`);
  const parsed = JSON.parse(listed.stdout);
  check(parsed.pending.length === 1, 'a record discarded before the person-decided guard must reappear in a default listing');
  check(parsed.pending[0].id === stuckName, 'the recovered listing must expose the original record id');
  check(Buffer.from(parsed.pending[0].text).equals(Buffer.from(words)), 'the recovered listing must return the exact original text');
  check(parsed.pending[0].outcome === 'unfiled', 'a recovered record must read exactly like any other turn an agent filed nothing for');

  check(fs.existsSync(path.join(reconciledDirectory, stuckName)) === false,
    'the pre-guard record must move out of reconciled/, not merely be read from two places');
  check(fs.existsSync(genuineSettled.file), 'the person\'s real, guarded discard must remain exactly where it was settled');

  const promoted = run(['--promote', stuckName, '--new-id', 'R9011', '--interpretation', 'finish the mirror folder setup']);
  check(promoted.status === 0, `re-filing a recovered turn exited ${promoted.status}: ${promoted.stderr}`);
  const filed = JSON.parse(fs.readFileSync(ledger, 'utf8')).requests.find(entry => entry.id === 'R9011');
  check(filed && filed.verbatim === words, 'a record discarded before the guard must re-file into the canonical ledger with its words intact');

  const after = run(['--json']);
  check(JSON.parse(after.stdout).pending.length === 0, 'a re-filed, recovered turn must leave the review queue');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

function reasonIsMandatory() {
  const f = fixture('reason');
  const handle = addIngress(f, 'ok');
  const result = runCli(f, ['--discard', handle.name]);
  check(result.status === 2, 'discard without a reason must be a usage refusal');
  check(spool.listPending(f.ledger).length === 1, 'a refused discard must leave the words pending');
}

function run() {
  listShowsIdWhenAndVerbatimText();
  promotionPipesExactBytesWithHiddenSpawn();
  promotionRefusesUnmeasurableCaptureResult();
  promotionUsesTheRealLedgerWriter();
  discardRetainsBytesAndReason();
  fallbackRecordsAreReviewableAndSettleAppendOnly();
  unfiledProductTurnsAreListedAndStillPromotable();
  misdiscardedProductTurnsAreRecoveredListedAndStillPromotable();
  reasonIsMandatory();
  process.stdout.write(`Owner spool review tests passed (${checks} checks).\n`);
}

try { run(); }
catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
