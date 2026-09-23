'use strict';

// The owner's request ledger, from the command line. The four /Request* skills
// call `file`; people and agents call the rest.
//
//   node tools/r-ledger.js file --scope global  --words "<the owner's words>"
//   node tools/r-ledger.js file --scope session --key <sessionId> --words "..."
//   node tools/r-ledger.js file --scope tree    --key <anchorSessionId> --words "..."
//   node tools/r-ledger.js file --scope thread  --key <threadId> --words "..."
//   node tools/r-ledger.js file --scope global  --words-file <path>   (long text)
//   node tools/r-ledger.js list [--scope <scope> --key <key>] [--json]
//   node tools/r-ledger.js all [--json]                (every record, removed too)
//   node tools/r-ledger.js show R12 [--json]           (current text + git history)
//   node tools/r-ledger.js stack --session <id> [--tree <anchor> ...] [--thread <id>] [--json]
//   node tools/r-ledger.js edit   --id R12 --words-stdin  < new-words.txt
//   node tools/r-ledger.js remove --id R12
//   node tools/r-ledger.js verify [--json]              (the history chain)
//   node tools/r-ledger.js recover --from <absolute path to a preserved history file> [--json]
//   node tools/r-ledger.js adopt [--json]               (keep the ledger as it stands when its history is gone)
//
// Every tier lives in the ONE canonical ledger (src/lib/owner-request-store.js,
// reached here through the src/lib/r-ledger.js adapter); ids are R-numbered for
// every scope. `edit` and `remove` are the PERSON's hand (owner, 2026-08-22:
// "its a hand edit tool. for the user to go in on the toolsenabled ledger and
// hand edit or delete them"): edit rewrites the one entry's words and keeps the
// words before in its history; remove marks the entry and its refinements
// (R12.1...) deleted and keeps them on file. The new words arrive on STDIN,
// never on the command line (the owner-spool-review rule: argv is logged,
// quoted and truncated by shells; the person's words are none of those). No
// agent tool reaches them.
//
// `recover` and `adopt` are the person's hand too, for a ledger that refuses
// every write with R_LEDGER_CHAIN_APPEND_UNCONFIRMED: a saved change names a
// history line this computer's journal does not hold (the document came from
// another computer or a merge, state/ was lost, or an append failed after the
// save). `recover` proves the rows against the journal they came with and is
// the better repair when that file still exists. `adopt` needs no other file:
// it chains one event per such record naming the reference that could not be
// confirmed, changes no words or statuses, and writing resumes. Both call the
// store directly; the adapter's export list is unchanged.
//
// Exit codes: 0 ok; 1 the request was refused (reason printed); 2 usage.
// `show` reads git history of the ledger file so "what did R12 used to say"
// is one command -- the lookup cost the owner named as the old system's pain.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ledger = require('../src/lib/r-ledger');
const store = require('../src/lib/owner-request-store');
const { ROOT } = require('../src/lib/runtime');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

function parseArgs(argv) {
  const out = { _: [], tree: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const name = arg.slice(2);
    if (name === 'json') { out.json = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) { out[name] = true; continue; }
    if (name === 'tree') out.tree.push(value); else out[name] = value;
    index += 1;
  }
  return out;
}

function usage() {
  console.error('usage: node tools/r-ledger.js <file|list|all|show|stack|edit|remove|verify|recover|adopt> ... (see the header of this file)');
  process.exit(2);
}

function refuse(error) {
  const code = error && error.code ? error.code : 'R_LEDGER_ERROR';
  console.error(`${code}: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
}

function gitHistory(file) {
  try {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    // windowsHide: this is the tool behind /Request, so it runs at the moment
    // the owner is typing at his desk. LOCAL-WORK rule 3 (his R193) forbids a
    // console flash, and `git log` has no owner-facing interaction to justify one.
    const out = execFileSync('git', ['log', '--follow', '--date=iso-strict', '--format=%h %ad %s', '--', relative], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      // git needs none of this process's credentials, and a plain delete list
      // cannot scrub them on Windows, where env names are case-insensitive
      // and a JS object is not. The helper is the only correct spelling.
      env: safeLaunchEnvironment(process.env, { context: 'r-ledger git history' })
    });
    return out.trim() ? out.trim().split('\n') : [];
  } catch {
    return null;
  }
}

// A refinement (R12.1) prints indented under its parent; the words are
// printed as filed, never reflowed. The status rides on the head line.
function printEntry(entry, layer) {
  const pad = '  '.repeat(entry.depth || 0);
  const status = entry.status && entry.status !== 'open' ? ` [${entry.status}]` : '';
  const who = entry.filedBy ? ` · filed by ${entry.filedBy}` : '';
  console.log(`${pad}${entry.id}${entry.stamp ? ` — ${entry.stamp}` : ''}${who}${status}${layer ? `  [${layer.scope}${layer.key ? ` ${layer.key}` : ''}]` : ''}`);
  for (const line of String(entry.words || '').split('\n')) console.log(`${pad}    ${line}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command) usage();

  if (command === 'file') {
    const scope = args.scope;
    let words = args.words;
    if (typeof args['words-file'] === 'string') words = fs.readFileSync(args['words-file'], 'utf8');
    if (typeof scope !== 'string' || typeof words !== 'string') usage();
    let receipt;
    try { receipt = ledger.fileRequest({ scope, key: args.key, words }); } catch (error) { refuse(error); }
    if (args.json) { console.log(JSON.stringify(receipt)); return; }
    console.log(`Filed ${receipt.id} (${scope}${receipt.key ? ` ${receipt.key}` : ''}) → ${receipt.path}`);
    return;
  }

  if (command === 'edit' || command === 'remove') {
    const id = typeof args.id === 'string' ? args.id : args._[1];
    if (!id) usage();
    let receipt;
    try {
      if (command === 'edit') {
        if (typeof args.words === 'string' || typeof args['words-file'] === 'string') {
          console.error('edit takes the new words on STDIN (--words-stdin), never on the command line.');
          process.exit(2);
        }
        if (!Object.prototype.hasOwnProperty.call(args, 'words-stdin')) usage();
        receipt = ledger.editRequest({ id, key: args.key, words: fs.readFileSync(0, 'utf8') });
      } else {
        receipt = ledger.removeRequest({ id, key: args.key });
      }
    } catch (error) { refuse(error); }
    if (args.json) { console.log(JSON.stringify(receipt)); return; }
    if (command === 'edit') console.log(`Edited ${receipt.id} in ${receipt.path} (the words before stay in its history; the previous file is beside it as .bak)`);
    else console.log(`Removed ${receipt.removed.join(', ')} in ${receipt.path} (kept on file as deleted; the previous file is beside it as .bak)`);
    return;
  }

  if (command === 'list') {
    const scope = typeof args.scope === 'string' ? args.scope : 'global';
    let read;
    try { read = ledger.readLedger(scope, args.key); } catch (error) { refuse(error); }
    if (args.json) { console.log(JSON.stringify(read)); return; }
    if (!read.exists) { console.log(`No ledger yet at ${read.path}.`); return; }
    console.log(`${read.entries.length} ${scope} request${read.entries.length === 1 ? '' : 's'} in ${read.path}`);
    for (const entry of ledger.nestEntries(read.entries)) printEntry(entry);
    for (const warning of read.warnings) console.log(`  warning: ${warning}`);
    return;
  }

  if (command === 'all') {
    let all;
    try { all = ledger.readAll({ includeRemoved: true, includeProposed: true }); } catch (error) { refuse(error); }
    if (args.json) { console.log(JSON.stringify(all)); return; }
    if (!all.exists) { console.log(`No ledger yet at ${all.path}.`); return; }
    console.log(`${all.records.length} record${all.records.length === 1 ? '' : 's'} in ${all.path} (revision ${all.revision === null ? '?' : all.revision})`);
    for (const record of all.records) {
      const layer = { scope: record.scope, key: record.scopeKey };
      printEntry({ id: record.id, stamp: record.filedAt, filedBy: record.filedBy === 'owner' ? null : record.filedBy, status: record.status, words: record.verbatim, depth: 0 }, layer);
    }
    return;
  }

  if (command === 'show') {
    const id = args._[1];
    if (!id) usage();
    let found;
    try { found = ledger.findEntry(id); } catch (error) { refuse(error); }
    let read;
    try { read = ledger.readAll({ includeRemoved: true, includeProposed: true }); } catch (error) { refuse(error); }
    const record = read.records.find(candidate => candidate.id === found.id) || null;
    const entry = record
      ? { id: record.id, stamp: record.filedAt, filedBy: record.filedBy === 'owner' ? null : record.filedBy, status: record.status, words: record.verbatim, parentId: record.parentId, depth: 0 }
      : null;
    const history = gitHistory(read.path);
    if (args.json) { console.log(JSON.stringify({ id: found.id, scope: found.scope, key: found.key, path: read.path, entry, record, history })); return; }
    if (!entry) {
      console.log(`${found.id} is not in ${read.path}.`);
    } else {
      printEntry(entry, { scope: found.scope, key: found.key });
      for (const row of record.history) {
        console.log(`  history: ${row.kind} ${row.at} by ${row.actor}${row.statusBefore ? ` (was ${row.statusBefore})` : ''}`);
        if (typeof row.wordsBefore === 'string') for (const line of row.wordsBefore.split('\n')) console.log(`      before: ${line}`);
      }
    }
    if (history === null) console.log('  git: unavailable for this path.');
    else if (history.length === 0) console.log('  git: no commits yet touch this ledger.');
    else {
      console.log(`  git (${history.length} commit${history.length === 1 ? '' : 's'} touching ${path.relative(ROOT, read.path)}):`);
      for (const line of history.slice(0, 20)) console.log(`    ${line}`);
      if (history.length > 20) console.log(`    … ${history.length - 20} more: git log --follow -- ${path.relative(ROOT, read.path)}`);
    }
    return;
  }

  if (command === 'stack') {
    let stack;
    try {
      stack = ledger.collectStack({ sessionId: args.session || null, treeAnchors: args.tree, threadId: args.thread || null });
    } catch (error) { refuse(error); }
    if (args.json) { console.log(JSON.stringify(stack)); return; }
    for (const layer of stack) {
      const where = `${layer.scope}${layer.key ? ` ${layer.key}` : ''}`;
      if (!layer.exists) { console.log(`[${where}] no ledger (${layer.path})`); continue; }
      console.log(`[${where}] ${layer.entries.length} request${layer.entries.length === 1 ? '' : 's'} — applies to ${layer.appliesTo}`);
      for (const entry of layer.entries) printEntry(entry);
    }
    return;
  }

  if (command === 'verify') {
    let result;
    try { result = ledger.verifyHistory(); } catch (error) { refuse(error); }
    if (args.json) { console.log(JSON.stringify(result)); }
    else if (result.ok) {
      console.log(`History verified: ${result.events} event${result.events === 1 ? '' : 's'}${result.unchained.length ? `; ${result.unchained.length} record${result.unchained.length === 1 ? '' : 's'} with no history line (${result.unchained.join(', ')})` : ''}.`);
    } else {
      console.log(`${result.code}: ${result.message}`);
    }
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'recover') {
    if (typeof args.from !== 'string') usage();
    let result;
    try { result = store.recoverHistory({ sourceHistoryFile: args.from, actor: 'owner' }); } catch (error) { refuse(error); }
    if (args.json) { console.log(JSON.stringify(result)); return; }
    console.log(result.recovered.length
      ? `Recovered the history of ${result.recovered.join(', ')} from the preserved file (kept beside the journal by its sha256 ${result.sourceSha256}).`
      : 'Nothing to recover: no saved record needs that preserved history.');
    return;
  }

  if (command === 'adopt') {
    let result;
    try { result = store.adoptUnconfirmedHistory({ actor: 'owner' }); } catch (error) { refuse(error); }
    if (args.json) { console.log(JSON.stringify(result)); return; }
    if (!result.adopted.length) { console.log('Nothing to adopt: every saved change is confirmed by this journal.'); return; }
    console.log(`Adopted ${result.adopted.length} record${result.adopted.length === 1 ? '' : 's'} as ${result.adopted.length === 1 ? 'it stands' : 'they stand'}: ${result.adopted.map(row => row.id).join(', ')}.`);
    console.log('Each now has a history line naming the reference that could not be confirmed; no words or statuses changed. Writing can resume; a program that was already running when its history was lost keeps refusing until it is restarted.');
    return;
  }

  usage();
}

main();
