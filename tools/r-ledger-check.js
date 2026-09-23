'use strict';

// The one tripwire the owner's request system keeps: a /Request* turn he
// typed that never reached a ledger. Everything else in the system is on
// purpose in his hands (he marks requests, he edits the files); this is the
// single mechanical check that the marking WORKED. It reads the ingress spool
// (every owner turn lands there before any agent reasons) and the one owner
// request ledger (every tier, src/lib/owner-request-store.js), and names any
// /Request-prefixed turn whose words are in no record.
//
//   node tools/r-ledger-check.js [--hours 48] [--json]
//
// Exit 0 clean; 5 when at least one marked request is unfiled (the same code
// owner-capture-audit uses for "said but never recorded"); 2 usage. Advisory
// by design: wire it beside the other pre-push advisories, never as a block.

const ingress = require('./owner-ingress-spool');
const store = require('../src/lib/owner-request-store');

const COMMAND_RE = /^\/request(session|tree|thread)?\b\s*/i;

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/* Every record in the one ledger, every tier, including rows the person has
   since removed or declined: a turn that was filed and later deleted was still
   filed, which is all this tripwire measures. Normalized words -> id, for
   containment tests. An absent ledger is an empty corpus; an unreadable one
   throws, because a partial corpus cannot support a definite verdict. */
function ledgerCorpus(options = {}) {
  const all = store.readAll({ includeRemoved: true, includeProposed: true, ...options });
  return all.records.map(record => ({ id: record.id, path: all.path, norm: normalize(record.verbatim) }));
}

/* `listIngress` and `corpus` are seams: production reads the live spool and
   the real ledgers; tests hand in fixtures. Same shape as owner-spool-review. */
function check({ hours = 48, now = Date.now(), listIngress = ingress.listUnclassifiedIngress, corpus = ledgerCorpus() } = {}) {
  const since = now - hours * 3600 * 1000;
  const marked = listIngress()
    .filter(record => COMMAND_RE.test(String(record.text || '').trimStart()))
    .filter(record => !record.when || Date.parse(record.when) >= since);
  const unfiled = [];
  for (const record of marked) {
    const body = normalize(String(record.text).trimStart().replace(COMMAND_RE, ''));
    if (!body) continue;
    const filed = corpus.some(entry => entry.norm === body || entry.norm.includes(body) || body.includes(entry.norm));
    if (!filed) unfiled.push({ id: record.id, when: record.when, words: String(record.text).slice(0, 400), file: record.file });
  }
  return { hours, markedInWindow: marked.length, ledgerEntries: corpus.length, unfiled };
}

function main() {
  const args = process.argv.slice(2);
  const hoursIndex = args.indexOf('--hours');
  const hours = hoursIndex !== -1 ? Number(args[hoursIndex + 1]) : 48;
  if (!Number.isFinite(hours) || hours <= 0) { console.error('usage: node tools/r-ledger-check.js [--hours N] [--json]'); process.exit(2); }
  const result = check({ hours });
  if (args.includes('--json')) { console.log(JSON.stringify(result)); process.exit(result.unfiled.length ? 5 : 0); }
  if (result.unfiled.length === 0) {
    console.log(`r-ledger check: clean — ${result.markedInWindow} /Request* turn(s) in the last ${hours}h, all filed (${result.ledgerEntries} ledger entries read).`);
    process.exit(0);
  }
  console.log(`r-ledger check: ${result.unfiled.length} /Request* turn(s) the owner typed in the last ${hours}h are in NO ledger — the command's filing step did not land:`);
  for (const item of result.unfiled) {
    console.log(`  ${item.when}  ${JSON.stringify(item.words.slice(0, 120))}`);
    console.log(`      spool: ${item.file}`);
  }
  console.log('File them now with the words as typed: node tools/r-ledger.js file --scope <global|session|tree|thread> [--key <id>] --words "<words>"');
  process.exit(5);
}

module.exports = Object.freeze({ COMMAND_RE, check, ledgerCorpus, normalize });
if (require.main === module) main();
