#!/usr/bin/env node
'use strict';

// Classification stays a judgement call. This tool makes that call cheap while
// keeping the only ledger write path unchanged: promotions invoke
// tools/owner-capture.js and pipe the spooled text to it byte-for-byte. A
// discard is not deletion; the original bytes move to reconciled/ with the
// custodian's reason.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const spool = require('../src/lib/owner-capture-spool');
const ingress = require('./owner-ingress-spool');

const CAPTURE_SCRIPT = path.join(__dirname, 'owner-capture.js');
const REVIEW_ACTOR = 'owner-spool-review';
const MAX_REASON_LENGTH = 2000;

/* THE PRODUCT'S QUEUE IS THE SECOND ONE, AND WAS NEVER READ HERE.
 *
 * MEASURED 2026-09-03: this tool's default ledger is the canonical
 * reports/OWNER-REQUEST-LEDGER.json, whose spool sits beside it and, on the
 * owner's machine, holds nothing. The product spools every turn the person
 * types under the r-ledger anchor instead (src/lib/r-ledger-proposals.js
 * anchorFile -> state/r-ledger/owner-capture-spool), where 22 records were
 * waiting. Run with no --ledger, this tool answered "clean. 0 turns awaiting
 * classification" -- a definite "not there" for a queue it had not looked in.
 *
 * So a default run reads BOTH spools and promotes out of either into the one
 * canonical ledger; each record settles back into the spool it came from,
 * because markReconciled and markDiscarded follow the record's own ledgerFile.
 * An explicit --ledger still reads exactly that ledger's spool and no other:
 * naming a ledger is asking about that ledger. */
function productSpoolRecords() {
  const anchor = require('../src/lib/r-ledger-proposals').anchorFile();
  // A read heals what an earlier bug left stuck: any record in this spool's
  // reconciled/ that reads as a discard nobody person-decided (the shape
  // markDiscarded refused before 2026-09-03) goes back to pending/ first, so
  // it is spoolPending's own already-tested reader that lists it -- the same
  // queue, the same "unfiled" note, the same --promote/--discard path.
  spool.recoverMisdiscarded(anchor);
  return { anchor, records: ingress.spoolPending({ ledgerFile: anchor }) };
}

class OwnerSpoolReviewError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.name = 'OwnerSpoolReviewError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const out = { gates: [], json: false, help: false };
  const valueFlags = new Set([
    '--ledger', '--fallback', '--promote', '--discard', '--reason', '--new-id', '--request-id',
    '--interpretation', '--status', '--scope', '--thread-id', '--gate', '--hedged-gate'
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') out.json = true;
    else if (token === '--help' || token === '-h') out.help = true;
    else if (valueFlags.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) throw new OwnerSpoolReviewError('OWNER_SPOOL_REVIEW_USAGE', `${token} requires a value`);
      index += 1;
      if (token === '--gate' || token === '--hedged-gate') {
        out.gates.push({ flag: token, value });
      } else {
        const key = token.slice(2);
        if (Object.hasOwn(out, key)) throw new OwnerSpoolReviewError('OWNER_SPOOL_REVIEW_USAGE', `Duplicate flag: ${token}`);
        out[key] = value;
      }
    } else {
      throw new OwnerSpoolReviewError('OWNER_SPOOL_REVIEW_USAGE', `Unexpected argument: ${token}`);
    }
  }
  return out;
}

function validateAction(args) {
  if (args.promote && args.discard) {
    throw new OwnerSpoolReviewError('OWNER_SPOOL_REVIEW_USAGE', '--promote and --discard are mutually exclusive.');
  }
  if (!args.promote && !args.discard) return 'list';
  if (args.discard) {
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!reason) throw new OwnerSpoolReviewError('OWNER_SPOOL_DISCARD_REASON_REQUIRED', '--discard requires --reason.');
    if (reason.length > MAX_REASON_LENGTH) {
      throw new OwnerSpoolReviewError('OWNER_SPOOL_DISCARD_REASON_INVALID', `--reason exceeds ${MAX_REASON_LENGTH} characters.`);
    }
    const promotionOnly = ['new-id', 'request-id', 'interpretation', 'status', 'scope', 'thread-id'];
    if (promotionOnly.some(key => args[key] !== undefined) || args.gates.length) {
      throw new OwnerSpoolReviewError('OWNER_SPOOL_REVIEW_USAGE', 'Promotion flags cannot be combined with --discard.');
    }
    return 'discard';
  }
  if ((args['new-id'] === undefined) === (args['request-id'] === undefined)) {
    throw new OwnerSpoolReviewError(
      'OWNER_SPOOL_REVIEW_USAGE',
      '--promote requires exactly one of --new-id or --request-id.'
    );
  }
  if (args['new-id'] !== undefined && (typeof args.interpretation !== 'string' || !args.interpretation.trim())) {
    throw new OwnerSpoolReviewError('OWNER_SPOOL_REVIEW_USAGE', '--new-id promotion requires --interpretation.');
  }
  if (args['request-id'] !== undefined
      && ['interpretation', 'status', 'scope', 'thread-id'].some(key => args[key] !== undefined)) {
    throw new OwnerSpoolReviewError(
      'OWNER_SPOOL_REVIEW_USAGE',
      '--interpretation, --status, --scope, and --thread-id apply only to --new-id promotion.'
    );
  }
  if (args.reason !== undefined) {
    throw new OwnerSpoolReviewError('OWNER_SPOOL_REVIEW_USAGE', '--reason applies only to --discard.');
  }
  return 'promote';
}

function findRecord(records, id) {
  const matches = records.filter(record => record.id === id);
  if (matches.length !== 1) {
    throw new OwnerSpoolReviewError(
      matches.length ? 'OWNER_SPOOL_REVIEW_ID_AMBIGUOUS' : 'OWNER_SPOOL_REVIEW_ID_NOT_FOUND',
      matches.length
        ? `More than one pending record has id ${id}.`
        : `No pending owner turn has id ${id}. Run this tool with no flags to list the ids that are waiting; `
          + 'a turn already promoted or discarded has left the queue and its bytes are kept in the spool\'s reconciled/ directory.',
      1
    );
  }
  return matches[0];
}

function captureArguments(record, args, ledgerFile) {
  const source = `owner-ingress-spool:${record.id}`;
  const output = [CAPTURE_SCRIPT, '--ledger', ledgerFile, '--actor', REVIEW_ACTOR, '--source', source];
  if (args['new-id'] !== undefined) {
    output.push('--new-id', args['new-id'], '--interpretation', args.interpretation);
    for (const key of ['status', 'scope', 'thread-id']) {
      if (args[key] !== undefined) output.push(`--${key}`, args[key]);
    }
  } else {
    output.push('--request-id', args['request-id']);
  }
  for (const gate of args.gates) output.push(gate.flag, gate.value);
  return output;
}

function runCapture(record, args, ledgerFile, { run = spawnSync } = {}) {
  const commandArgs = captureArguments(record, args, ledgerFile);
  const result = run(process.execPath, commandArgs, {
    input: record.text,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = result.error
      ? result.error.message
      : (result.stderr && result.stderr.trim()) || `owner-capture.js exited ${result.status}`;
    throw new OwnerSpoolReviewError('OWNER_SPOOL_PROMOTION_FAILED', detail, 1);
  }
  let summary;
  try {
    summary = JSON.parse(result.stdout);
  } catch (error) {
    throw new OwnerSpoolReviewError(
      'OWNER_SPOOL_PROMOTION_RESULT_INVALID',
      `owner-capture.js returned an unreadable success result: ${error.message}`,
      1
    );
  }
  if (!summary || typeof summary.id !== 'string' || !summary.id || !Number.isInteger(summary.revision)) {
    throw new OwnerSpoolReviewError(
      'OWNER_SPOOL_PROMOTION_RESULT_INVALID',
      'owner-capture.js success result must include a non-empty id and integer revision.',
      1
    );
  }
  return { result, summary, commandArgs };
}

function settlePromoted(record, captureResult, { fallbackFile }) {
  const ledgerId = captureResult.summary && captureResult.summary.id ? captureResult.summary.id : null;
  const revision = captureResult.summary && Number.isInteger(captureResult.summary.revision)
    ? captureResult.summary.revision
    : null;
  if (record.storage === 'spool') {
    spool.markReconciled({ name: record.record.name, file: record.file, record: record.record }, { revision });
  } else {
    ingress.appendFallbackResolution(fallbackFile, {
      targetId: record.id,
      outcome: 'in-ledger',
      ledgerId
    });
  }
  return { ledgerId, revision };
}

function discardRecord(record, reason, { fallbackFile }) {
  if (record.storage === 'spool') {
    const result = spool.markDiscarded(
      { name: record.record.name, file: record.file, record: record.record },
      // A person ran this command by hand with a reason of their own; that is
      // the decision the spool refuses to accept from anyone else.
      { reason, actor: REVIEW_ACTOR, decidedBy: spool.DISCARD_DECIDED_BY }
    );
    return { file: result.file };
  }
  ingress.appendFallbackResolution(fallbackFile, {
    targetId: record.id,
    outcome: 'discarded',
    reason,
    actor: REVIEW_ACTOR
  });
  return { file: fallbackFile };
}

/* An unfiled turn is one an agent read and left, still waiting. It is the
   record's own note (owner-capture-spool.markUnfiled), so a listing that does
   not carry it hides the whole category behind an undifferentiated count. */
function unfiledNoteOf(record) {
  const stored = record && record.record;
  if (!stored || stored.ledgerOutcome !== 'unfiled') return null;
  return {
    at: typeof stored.unfiledAt === 'string' ? stored.unfiledAt : null,
    by: typeof stored.unfiledBy === 'string' ? stored.unfiledBy : null,
    reason: typeof stored.unfiledReason === 'string' ? stored.unfiledReason : null
  };
}

function serializableRecord(record) {
  const unfiled = unfiledNoteOf(record);
  const row = { id: record.id, when: record.when, text: record.text, storage: record.storage };
  return unfiled ? { ...row, outcome: 'unfiled', unfiled } : row;
}

function renderList(records) {
  if (!records.length) return 'Owner ingress spool: clean. 0 turns awaiting classification.\n';
  const unread = records.filter(record => unfiledNoteOf(record) !== null).length;
  const lines = [`Owner ingress spool: ${records.length} turn(s) awaiting classification`
    + `${unread ? `, ${unread} of them read by an agent that filed nothing` : ''}.`];
  for (const record of records) {
    const unfiled = unfiledNoteOf(record);
    lines.push('', `id: ${record.id}`, `when: ${record.when}`, `storage: ${record.storage}`);
    if (unfiled) {
      lines.push(`unfiled: ${unfiled.reason || 'nothing was filed'}`
        + `${unfiled.by ? ` (${unfiled.by})` : ''}${unfiled.at ? ` at ${unfiled.at}` : ''}`);
    }
    lines.push('text:', record.text);
  }
  return `${lines.join('\n')}\n`;
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node tools/owner-spool-review.js [--json] [--ledger FILE] [--fallback FILE]',
    '  node tools/owner-spool-review.js --promote ID --new-id RNNN --interpretation TEXT [capture flags]',
    '  node tools/owner-spool-review.js --promote ID --request-id RNNN [--gate TEXT]...',
    '  node tools/owner-spool-review.js --discard ID --reason TEXT',
    '',
    'With no --ledger, the listing covers both queues: the canonical ledger\'s own spool and the product\'s',
    'r-ledger anchor spool, where a turn the person typed into the app is written.',
    'Promotion pipes the exact spooled text to tools/owner-capture.js. Discard retains the bytes and reason.',
    'A turn marked "unfiled" is one an agent read and filed nothing for; it is still waiting and still promotable.',
    ''
  ].join('\n'));
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  if (args.help) { printUsage(); return 0; }
  const action = validateAction(args);
  const ledgerFile = path.resolve(args.ledger || ingress.DEFAULT_LEDGER);
  const fallbackFile = path.resolve(args.fallback || ingress.fallbackFileForLedger(ledgerFile));
  // Same self-heal as productSpoolRecords(), for the ledger named here (the
  // default, or an explicit --ledger): a record stuck in reconciled/ by the
  // pre-guard discard bug goes back to pending/ before this queue is read.
  spool.recoverMisdiscarded(ledgerFile);
  const beside = ingress.listUnclassifiedIngress({ ledgerFile, fallbackFile });
  const product = args.ledger === undefined ? productSpoolRecords() : null;
  const records = (product && path.resolve(product.anchor) !== ledgerFile
    ? [...beside, ...product.records]
    : beside).sort((a, b) => String(a.when).localeCompare(String(b.when)));

  if (action === 'list') {
    process.stdout.write(args.json
      ? `${JSON.stringify({ ledgerFile, productSpool: product ? product.anchor : null, pending: records.map(serializableRecord) }, null, 2)}\n`
      : renderList(records));
    return 0;
  }

  const id = args.promote || args.discard;
  const record = findRecord(records, id);
  if (action === 'discard') {
    const settled = discardRecord(record, args.reason.trim(), { fallbackFile });
    process.stdout.write(`${JSON.stringify({ ok: true, action: 'discarded', id: record.id, reason: args.reason.trim(), recordFile: settled.file }, null, 2)}\n`);
    return 0;
  }

  const captureResult = runCapture(record, args, ledgerFile, dependencies);
  const settled = settlePromoted(record, captureResult, { fallbackFile });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: 'promoted',
    id: record.id,
    ledgerId: settled.ledgerId,
    ledgerRevision: settled.revision
  }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const code = error && error.code ? error.code : 'OWNER_SPOOL_REVIEW_FAILED';
    process.stderr.write(`${code}: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = error instanceof OwnerSpoolReviewError ? error.exitCode : 1;
  }
}

module.exports = Object.freeze({
  CAPTURE_SCRIPT,
  REVIEW_ACTOR,
  MAX_REASON_LENGTH,
  OwnerSpoolReviewError,
  parseArgs,
  validateAction,
  findRecord,
  captureArguments,
  runCapture,
  settlePromoted,
  discardRecord,
  productSpoolRecords,
  unfiledNoteOf,
  serializableRecord,
  renderList,
  main
});
