#!/usr/bin/env node
'use strict';

/* Prove a compacted ledger still means what the uncompacted one meant.
 *
 * Six checks, all of them read-only:
 *   1 chain-untouched   the history file's bytes are identical
 *   2 records-present   every id in the before document is in the after document
 *   3 core-identical    coreSha256(record) is identical for every record
 *   4 decisions-length  decisions.length is identical for every record (it is
 *                       in the core hash, so 3 implies it; checked separately so
 *                       a failure names the real cause)
 *   5 verify-history    verifyHistory() returns the same ok/code/drift/missing/
 *                       unchained/head/events as before. On live48 that means it
 *                       must still report R1-R28 missing -- no better, no worse.
 *   6 restore-exact     restoring the sidecar reproduces the before bytes
 *
 * Usage: node tools/ledger-compact-verify.js --before <f> --after <f>
 *          --history <f> [--history-after <f>] --sidecar <f> [--json] */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../src/lib/owner-request-store.js');
const compact = require('./ledger-compact.js');

function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function parseArguments(argv) {
  const options = { before: null, after: null, history: null, historyAfter: null, sidecar: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => { index += 1; return argv[index]; };
    if (argument === '--before') options.before = path.resolve(next());
    else if (argument === '--after') options.after = path.resolve(next());
    else if (argument === '--history') options.history = path.resolve(next());
    else if (argument === '--history-after') options.historyAfter = path.resolve(next());
    else if (argument === '--sidecar') options.sidecar = path.resolve(next());
    else if (argument === '--json') options.json = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  for (const key of ['before', 'after', 'history', 'sidecar']) {
    if (!options[key]) throw new Error(`--${key} is required`);
  }
  if (!options.historyAfter) options.historyAfter = options.history;
  return options;
}

function verdictOf(result) {
  return {
    ok: result.ok, code: result.code || null, events: result.events, head: result.head,
    drift: [...result.drift].sort(), missing: [...result.missing].sort(), unchained: [...result.unchained].sort()
  };
}

function verify(options) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  const beforeRaw = fs.readFileSync(options.before, 'utf8');
  const afterRaw = fs.readFileSync(options.after, 'utf8');
  const beforeDocument = JSON.parse(beforeRaw);
  const afterDocument = JSON.parse(afterRaw);

  const historyBefore = sha256(fs.readFileSync(options.history, 'utf8'));
  const historyAfter = sha256(fs.readFileSync(options.historyAfter, 'utf8'));
  add('chain-untouched', historyBefore === historyAfter, `${historyBefore.slice(0, 12)} vs ${historyAfter.slice(0, 12)}`);

  const beforeById = new Map(beforeDocument.requests.filter(plain).map(entry => [entry.id, entry]));
  const afterById = new Map(afterDocument.requests.filter(plain).map(entry => [entry.id, entry]));
  const absent = [...beforeById.keys()].filter(id => !afterById.has(id));
  const added = [...afterById.keys()].filter(id => !beforeById.has(id));
  add('records-present', absent.length === 0 && added.length === 0,
    `${beforeById.size} before, ${afterById.size} after, ${absent.length} absent, ${added.length} added`);

  const coreDiff = [];
  const lengthDiff = [];
  for (const [id, entry] of beforeById) {
    const other = afterById.get(id);
    if (!other) continue;
    if (store.coreSha256(entry) !== store.coreSha256(other)) coreDiff.push(id);
    const a = Array.isArray(entry.decisions) ? entry.decisions.length : -1;
    const b = Array.isArray(other.decisions) ? other.decisions.length : -1;
    if (a !== b) lengthDiff.push(`${id}:${a}->${b}`);
  }
  add('core-identical', coreDiff.length === 0, `${beforeById.size} records compared, ${coreDiff.length} differ${coreDiff.length ? `: ${coreDiff.slice(0, 10).join(', ')}` : ''}`);
  add('decisions-length', lengthDiff.length === 0, `${lengthDiff.length} differ${lengthDiff.length ? `: ${lengthDiff.slice(0, 10).join(', ')}` : ''}`);

  const verdictBefore = verdictOf(store.verifyHistory({ ledgerFile: options.before, historyFile: options.history }));
  const verdictAfter = verdictOf(store.verifyHistory({ ledgerFile: options.after, historyFile: options.historyAfter }));
  const same = JSON.stringify(verdictBefore) === JSON.stringify(verdictAfter);
  add('verify-history', same,
    `before ok=${verdictBefore.ok} code=${verdictBefore.code} drift=${verdictBefore.drift.length} missing=${verdictBefore.missing.length} unchained=${verdictBefore.unchained.length}`
    + ` | after ok=${verdictAfter.ok} code=${verdictAfter.code} drift=${verdictAfter.drift.length} missing=${verdictAfter.missing.length} unchained=${verdictAfter.unchained.length}`);

  let restoreDetail = 'sidecar unreadable';
  let restoreOk = false;
  try {
    const { header, folded } = compact.readSidecar(options.sidecar);
    const rebuilt = compact.serialize(compact.restore(JSON.parse(afterRaw), folded));
    restoreOk = sha256(rebuilt) === sha256(beforeRaw) && header.ledgerSha256Before === sha256(beforeRaw);
    restoreDetail = `${folded.length} folded values, rebuilt sha ${sha256(rebuilt).slice(0, 12)}, before sha ${sha256(beforeRaw).slice(0, 12)}`;
  } catch (error) { restoreDetail = error.message; }
  add('restore-exact', restoreOk, restoreDetail);

  return {
    ok: checks.every(check => check.pass),
    bytesBefore: Buffer.byteLength(beforeRaw, 'utf8'),
    bytesAfter: Buffer.byteLength(afterRaw, 'utf8'),
    sidecarBytes: fs.statSync(options.sidecar).size,
    verdictBefore, verdictAfter, checks
  };
}

module.exports = { verify, verdictOf };

if (require.main === module) {
  try {
    const result = verify(parseArguments(process.argv.slice(2)));
    for (const check of result.checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name.padEnd(18)} ${check.detail}`);
    console.log(`\n${result.ok ? 'ALL CHECKS PASS' : 'VERIFICATION FAILED'}  before ${result.bytesBefore} B, after ${result.bytesAfter} B, sidecar ${result.sidecarBytes} B`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`ledger-compact-verify: ${error.message}`);
    process.exitCode = 1;
  }
}
