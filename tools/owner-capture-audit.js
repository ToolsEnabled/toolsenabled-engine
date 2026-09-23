#!/usr/bin/env node
'use strict';

// WORDS THE OWNER SAID THAT NEVER REACHED THE LEDGER.
//
// The owner, 2026-08-11 (reports/OWNER-REQUEST-LEDGER.json R1233, verbatim):
//   "Again - i think thats not the correct cart, I think maybe R is not working
//    or something is going wrong because I have said a lot of times what I want"
//
// He was right, and the reason is mechanical rather than mysterious. Capture is
// MANUAL: reports/OWNER-REQUEST-LEDGER.json only ever gains what some agent
// remembered to run tools/owner-capture.js on. Everything he types mid-turn --
// the corrections, the "I wanted the whole list", the scope changes -- lives in
// the session transcript and dies with the session.
//
// Measured on this machine, 2026-08-11, by exact substring probe against the
// 535-entry canonical ledger. Every one of these is ABSENT from it:
//
//   04:22  "bring up the purchase list. use more opus5 ultra as needed..."
//   04:25  "I wanted the whole list. Go back and review what I had wanted on
//           the purchase list, it should be in R"
//   04:44  "It muyst be throuygh mission control the purchase list"
//   08:05  "Ok add items that need to be purhcased to the purchase list..."
//   14:34  "ok launch the cart but is it verfiied all i need? And did you get
//           everything I needed? Trademark, licnsing, entity ioncorportation,
//           all the toolsanebaled.ai .io .com ?"
//   (source: the Claude Code session transcript for the legacy ToolsEnabled
//    checkout -- <claude-home>/projects/<project-slug>/<session-id>.jsonl,
//    lines 24159 / 24207 / 24547 / 27119 / 28941)
//
//   The path is described by SHAPE rather than spelled out on purpose. This
//   comment ships: tools/ is staged into the capability payload, so a literal
//   home directory here is the builder's home directory in the customer's
//   install. tools/pack-capability-layer.mjs's owner-data guard failed the
//   whole ship chain on exactly these two lines, which is the guard working.
//
// He told an agent the purchase list "should be in R". It was not in R, because
// the sentence saying so was itself never put in R. The cart could not have been
// built from his words; no code path had them.
//
// WHAT THIS TOOL IS. The detector half of capture-at-ingress: it diffs the
// owner's real chat turns against the ledger's verbatim corpus and names what
// is missing, with file and line, so it can be captured. It is read-only and it
// never captures anything itself -- tools/owner-capture.js is the only writer,
// and a tool that auto-filed paraphrases of his words would be manufacturing
// the very provenance src/lib/owner-request-provenance.js exists to protect.
//
// CAPTURE-AT-INGRESS -- THE DESIGN THIS TOOL IS THE FIRST STEP OF.
//
// Target: an owner turn reaches durable state because it ARRIVED, not because
// an agent remembered. Four parts, in dependency order:
//
//   1. SPOOL AT INGRESS. tools/owner-ingress-spool.js is the UserPromptSubmit
//      hook command, sibling to
//      the SessionStart hook already wired in .claude/settings.json, appends
//      every `origin.kind === "human"` turn verbatim to the existing
//      src/lib/owner-capture-spool.js. The spool is deliberately NOT the
//      ledger: an unclassified turn is not yet a request, and writing straight
//      into reports/OWNER-REQUEST-LEDGER.json would fill it with "ok" and
//      "yes" and destroy the signal that makes it worth reading.
//   2. CLASSIFY, NEVER PARAPHRASE. A turn is promoted from spool to ledger by
//      tools/owner-capture.js with the verbatim text intact and a provenance
//      class from src/lib/owner-request-provenance.js. Classification is a
//      judgement and stays one; what stops being a judgement is whether his
//      words SURVIVE long enough to be classified.
//   3. PUSH THE BACKLOG INTO THE PROMPT (composes with R1232). R1232 asks for
//      status data to be pushed into agent prompts mechanically, as a setting,
//      default off. The same channel carries "N owner turns are spooled and
//      unclassified; oldest is 3h old" -- which turns an invisible loss into a
//      visible queue on the surface an agent cannot avoid reading. One setting,
//      two payloads, no new plumbing.
//      tools/owner-ingress-spool.js --status now emits that one-line payload;
//      the separate status-injection lane owns putting it into prompts.
//   4. THIS TOOL as the regression test: --include-spooled counts either a
//      ledger capture or a pending spool record as "not lost". After the hook
//      wiring is applied, new turns must stop increasing the uncaptured count.
//
// WHAT IS ACTUALLY BUILT TODAY: the ingress command, review command, status
// payload and regression mode. The shared .claude/settings.json wiring remains
// a coordinator-owned serial edit; until that exact UserPromptSubmit entry is
// applied, this tool continues to report the historical/manual-capture gap.
//
// HOW A REAL OWNER TURN IS IDENTIFIED. Mechanically, not by heuristics on the
// text: a Claude Code transcript entry records `origin.kind`, and only
// `"human"` is the owner typing. `"task-notification"` and `"peer"` are agent
// traffic wearing the user role -- 1030 and 99 of them respectively in a
// 300-transcript sample, against 722 genuine human turns. Guessing from the
// text instead would file agent briefs as the owner's words, which is exactly
// the R1098 defect.
//
// Exit codes:  0 clean · 5 uncaptured owner turns found · 4 ledger unreadable · 2 usage

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const ingressSpool = require('./owner-ingress-spool');
const captureSpool = require('../src/lib/owner-capture-spool');
const { programOrStatePath } = require('../src/lib/runtime-state-root');
const textShingles = require('../src/lib/text-shingles');

// Through the state-root split, not a bare join: on a packaged install the
// install directory is immutable (check-install-dir-immutable measures it),
// so the ledger default must land in the per-user state root there while a
// source checkout keeps resolving reports/ under the checkout byte-for-byte.
const DEFAULT_LEDGER = programOrStatePath(path.join(__dirname, '..'), ['reports', 'OWNER-REQUEST-LEDGER.json']);
const DEFAULT_PROJECTS = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');
const DEFAULT_WINDOW_HOURS = 24;
const { SHINGLE_WORDS, normalize, shingles } = textShingles;

class CaptureAuditError extends Error {
  constructor(message, exitCode = 2) { super(message); this.name = 'CaptureAuditError'; this.exitCode = exitCode; }
}

function loadLedgerCorpus(ledgerFile) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); }
  catch (error) { throw new CaptureAuditError(`Could not read the owner request ledger at ${ledgerFile}: ${error.message}`, 4); }
  if (!parsed || !Array.isArray(parsed.requests)) throw new CaptureAuditError(`${ledgerFile} has no "requests" array.`, 4);
  const shingleSet = new Set();
  const normalizedTexts = [];
  for (const entry of parsed.requests) {
    // Only VERBATIM counts as capture. An interpretation that happens to
    // paraphrase him is precisely what R44 proved unsafe to treat as a record.
    if (!entry || typeof entry.verbatim !== 'string' || !entry.verbatim.trim()) continue;
    const normalized = normalize(entry.verbatim);
    normalizedTexts.push(normalized);
    for (const shingle of shingles(normalized)) shingleSet.add(shingle);
  }
  return { shingleSet, normalizedTexts, entryCount: parsed.requests.length, verbatimCount: normalizedTexts.length };
}

function corpusFromTexts(texts) {
  const shingleSet = new Set();
  const normalizedTexts = [];
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const normalized = normalize(text);
    normalizedTexts.push(normalized);
    for (const shingle of shingles(normalized)) shingleSet.add(shingle);
  }
  return { shingleSet, normalizedTexts };
}

function loadSpoolCorpus(ledgerFile, fallbackFile) {
  // The sibling readers deliberately make their operational commands
  // best-effort.  An audit cannot inherit that contract: an unreadable queue
  // is an unknown capture state, not an empty queue.
  const pendingDirectory = captureSpool.pendingDirectory(ledgerFile);
  try {
    const names = fs.readdirSync(pendingDirectory)
      .filter(name => name.endsWith('.json') && !name.endsWith('.tmp'));
    for (const name of names) JSON.parse(fs.readFileSync(path.join(pendingDirectory, name), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new CaptureAuditError(`Could not establish the pending owner capture spool at ${pendingDirectory}: ${error.message}`, 4);
    }
  }
  try {
    const raw = fs.readFileSync(fallbackFile, 'utf8');
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (line) {
        try { JSON.parse(line); }
        catch (error) {
          throw new CaptureAuditError(`Could not parse the owner ingress fallback at ${fallbackFile}:${index + 1}: ${error.message}`, 4);
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error instanceof CaptureAuditError) throw error;
      throw new CaptureAuditError(`Could not read the owner ingress fallback at ${fallbackFile}: ${error.message}`, 4);
    }
  }
  let primary;
  try {
    primary = captureSpool.listPending(ledgerFile)
      .filter(record => record && typeof record.text === 'string' && record.text.trim());
  } catch (error) {
    throw new CaptureAuditError(`Could not read the pending owner capture spool at ${pendingDirectory}: ${error.message}`, 4);
  }
  const fallback = ingressSpool.fallbackPending(fallbackFile);
  const records = [...primary, ...fallback];
  return { ...corpusFromTexts(records.map(record => record.text)), records };
}

function isCaptured(corpus, normalized) {
  const own = shingles(normalized);
  if (own.length) return own.some(s => corpus.shingleSet.has(s));
  // Short turns ("approve everything", "just do it") have no 8-gram. Fall back
  // to containment, which is strict enough at this length to avoid claiming a
  // capture that did not happen.
  if (!normalized) return true;
  return corpus.normalizedTexts.some(text => text.includes(normalized));
}

function ownerTurnText(entry) {
  // origin.kind is the mechanical discriminator; see the header.
  if (!entry || entry.type !== 'user' || entry.isSidechain || entry.isMeta) return null;
  if (!entry.origin || entry.origin.kind !== 'human') return null;
  const message = entry.message;
  if (!message || message.role !== 'user') return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'tool_result') return null;
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join('\n') : null;
}

// A human turn that is only a slash command or a pasted system block is not a
// directive; excluding it keeps the report actionable rather than noisy.
function isDirectiveText(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^<(?:command-name|command-message|local-command|bash-input|system-reminder)/i.test(trimmed)) return false;
  if (/^\/[a-z][a-z0-9:-]*\s*$/i.test(trimmed)) return false;
  return true;
}

function listTranscripts(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      throw new CaptureAuditError(`Could not scan transcript directory ${dir}: ${error.message}`, 4);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

async function scanTranscript(file, corpus, spoolCorpus, sinceMs, uncaptured, stats) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (!line) continue;
    if (line[0] !== '{') {
      throw new CaptureAuditError(`Could not parse transcript ${file}:${lineNumber}: line is not a JSON object`, 4);
    }
    let entry;
    try { entry = JSON.parse(line); }
    catch (error) {
      throw new CaptureAuditError(`Could not parse transcript ${file}:${lineNumber}: ${error.message}`, 4);
    }
    const text = ownerTurnText(entry);
    if (text === null) continue;
    const at = Date.parse(entry.timestamp || '');
    if (!Number.isFinite(at)) {
      throw new CaptureAuditError(`Could not establish the timestamp of owner turn ${file}:${lineNumber}`, 4);
    }
    if (at < sinceMs) continue;
    stats.humanTurns += 1;
    if (!isDirectiveText(text)) { stats.skippedNonDirective += 1; continue; }
    const normalized = normalize(text);
    if (isCaptured(corpus, normalized)) { stats.captured += 1; continue; }
    if (spoolCorpus && isCaptured(spoolCorpus, normalized)) { stats.spooled += 1; continue; }
    uncaptured.push({ at: entry.timestamp, file, line: lineNumber, chars: text.length, text });
  }
}

async function audit(options = {}) {
  const ledgerFile = path.resolve(options.ledger || DEFAULT_LEDGER);
  const projectRoots = (options.projects && options.projects.length ? options.projects : [DEFAULT_PROJECTS]).map(p => path.resolve(p));
  const windowHours = Number.isFinite(options.hours) ? options.hours : DEFAULT_WINDOW_HOURS;
  const sinceMs = options.since !== undefined && options.since !== null
    ? Date.parse(options.since)
    : Date.now() - windowHours * 3600_000;
  if (!Number.isFinite(sinceMs)) throw new CaptureAuditError(`--since is not a valid ISO timestamp: ${options.since}`, 2);

  const corpus = loadLedgerCorpus(ledgerFile);
  const fallbackFile = options.fallback ? path.resolve(options.fallback) : ingressSpool.fallbackFileForLedger(ledgerFile);
  const spoolCorpus = options.includeSpooled ? loadSpoolCorpus(ledgerFile, fallbackFile) : null;
  const stats = { humanTurns: 0, captured: 0, spooled: 0, skippedNonDirective: 0, transcripts: 0 };
  const uncaptured = [];
  for (const root of projectRoots) {
    for (const file of listTranscripts(root)) {
      stats.transcripts += 1;
      await scanTranscript(file, corpus, spoolCorpus, sinceMs, uncaptured, stats);
    }
  }
  if (stats.transcripts === 0) {
    throw new CaptureAuditError(`Could not audit owner capture: no transcript files were found under ${projectRoots.join(', ')}`, 4);
  }
  uncaptured.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    ledgerFile,
    projectRoots,
    since: new Date(sinceMs).toISOString(),
    ledgerEntries: corpus.entryCount,
    ledgerVerbatimEntries: corpus.verbatimCount,
    includeSpooled: Boolean(options.includeSpooled),
    spoolRecords: spoolCorpus ? spoolCorpus.records.length : 0,
    ...stats,
    uncapturedCount: uncaptured.length,
    uncaptured
  };
}

function render(result, limit) {
  const lines = [];
  lines.push(`OWNER CAPTURE AUDIT -- human turns vs the ledger${result.includeSpooled ? ' or capture spool' : ''} verbatim corpus`);
  lines.push('');
  lines.push(`  ledger      ${result.ledgerFile}`);
  lines.push(`              ${result.ledgerEntries} entries, ${result.ledgerVerbatimEntries} carrying verbatim text`);
  lines.push(`  transcripts ${result.transcripts} scanned under ${result.projectRoots.join(', ')}`);
  lines.push(`  window      since ${result.since}`);
  lines.push('');
  lines.push(`  human turns in window: ${result.humanTurns}  (captured ${result.captured}, spooled ${result.spooled}, non-directive ${result.skippedNonDirective}, UNCAPTURED ${result.uncapturedCount})`);
  if (result.uncapturedCount) {
    lines.push('');
    lines.push('  UNCAPTURED OWNER TURNS -- said, never recorded in R:');
    for (const item of result.uncaptured.slice(0, limit)) {
      lines.push('');
      lines.push(`    ${item.at}  ${item.file}:${item.line}`);
      lines.push(`      "${item.text.replace(/\s+/g, ' ').slice(0, 300)}${item.text.length > 300 ? '...' : ''}"`);
    }
    if (result.uncaptured.length > limit) lines.push(`\n    ... and ${result.uncaptured.length - limit} more.`);
    lines.push('');
    lines.push('  Capture each one with tools/owner-capture.js --text (verbatim, never a paraphrase).');
  } else {
    lines.push('');
    lines.push(result.includeSpooled
      ? '  Every owner turn in this window is present in the ledger or unclassified ingress spool.'
      : '  Every owner turn in this window is present in the ledger verbatim corpus.');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { projects: [] };
  let limit = 20;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new CaptureAuditError(`${arg} needs a value`, 2);
      i += 1;
      return value;
    };
    if (arg === '--json') json = true;
    else if (arg === '--include-spooled') options.includeSpooled = true;
    else if (arg === '--ledger') options.ledger = next();
    else if (arg === '--fallback') options.fallback = next();
    else if (arg === '--projects') options.projects.push(next());
    else if (arg === '--since') options.since = next();
    else if (arg === '--hours') options.hours = Number(next());
    else if (arg === '--limit') limit = Number(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new CaptureAuditError(`unknown argument: ${arg}`, 2);
  }
  return { options, limit, json };
}

async function main(argv) {
  const { options, limit, json } = parseArgs(argv);
  if (options.help) {
    process.stdout.write([
      'usage: node tools/owner-capture-audit.js [--hours N | --since ISO] [--projects DIR]... [--ledger FILE] [--include-spooled] [--fallback FILE] [--limit N] [--json]',
      '',
      'Diffs the owner\'s real chat turns (origin.kind === "human") against the ledger\'s',
      'verbatim corpus and names what was said but never recorded. --include-spooled',
      'counts an ingress-spooled turn as not lost while it awaits classification. Read-only.',
      'Exit 5 when uncaptured owner turns exist.',
      ''
    ].join('\n'));
    return 0;
  }
  const result = await audit(options);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result, limit)}\n`);
  return result.uncapturedCount ? 5 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error instanceof CaptureAuditError ? error.exitCode : 1;
    }
  );
}

module.exports = Object.freeze({
  DEFAULT_LEDGER, DEFAULT_PROJECTS, SHINGLE_WORDS,
  CaptureAuditError,
  normalize, shingles, loadLedgerCorpus, corpusFromTexts, loadSpoolCorpus,
  isCaptured, ownerTurnText, isDirectiveText, audit, render, main
});
