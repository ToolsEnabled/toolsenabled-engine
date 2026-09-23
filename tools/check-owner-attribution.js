#!/usr/bin/env node
'use strict';

// WHOSE DECISION IS THIS? -- a fail-closed guard on attribution.
//
// The owner, verbatim, 2026-08-11:
//   "And again who put a $100 day cap? Literally not something I did"
//   "Why are agent rules stille being pushed as mine"
//
// He was right, and it was provable. `defaultDailySpendUsd: 100` in
// config/toolsenabled.policy.json traces to commit 02b27ac, "Initial commit:
// ToolsEnabled v1.3.0 baseline", Co-Authored-By an AI agent. No human chose it.
// It was then described back to him -- in reports, in docs, and by the
// coordinator in conversation -- as "his own $100/day cap" and "HIS setting",
// and a lane went on to remove a $350 trademark filing he had personally asked
// for because that number "breaks his own cap". An invented constraint wearing
// his name silently vetoed a real requirement.
//
// That is the failure this file exists to make impossible to repeat.
//
// WHY A GUARD AND NOT A CLEANUP. A cleanup fixes the 327 instances that exist
// today. It does nothing about the 328th, written tomorrow by an agent that
// genuinely believes it is recording a decision the owner made -- which is
// exactly how every one of the current instances got written. Attribution drift
// is not a typo class, it is a process defect, and the only durable answer is an
// instrument that runs and refuses.
//
// WHY IT IS FAIL-CLOSED. An attribution with no evidence is not a small
// documentation problem. It is the mechanism by which an engineering default
// acquires the authority of an owner instruction, and once it has that
// authority, other agents defer to it and build on it. So an unsourced claim is
// an ERROR, not a warning: silence must never be readable as provenance. That is
// the same defect class -- absence read as consent -- this codebase has now
// found nine times, pointed at the owner instead of at a permission check.
//
// THE PRODUCT REASON, which outlives this incident. The product's frame is that
// RULES ARE USER SETTINGS: the owner's values become HIS saved profile, and
// every other customer configures their own. If agent-invented defaults are
// stamped as the owner's values, every customer inherits a stranger's
// preferences presented as their own choices. Mis-attribution is therefore a
// shipping defect, not an internal tidiness issue.
//
// WHAT COUNTS AS EVIDENCE. Exactly two things:
//   1. An OWNER-STATED entry in the request ledger carrying his verbatim words.
//   2. An entry in the exceptions file below, which must quote him directly.
// A commit Co-Authored-By an AI agent is NOT owner provenance -- that is
// precisely how the $100 cap acquired its false pedigree. Neither is another
// document repeating the claim; this guard follows citations to a primary
// source or it refuses.
//
// Usage:
//   node tools/check-owner-attribution.js              scan the default roots
//   node tools/check-owner-attribution.js <path>...    scan specific paths
//   node tools/check-owner-attribution.js --json       machine-readable
//
// Exit 0 clean, 1 unsourced attributions found, 2 the guard itself failed.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = path.join(ROOT, 'reports', 'OWNER-REQUEST-LEDGER.json');
const EXCEPTIONS = path.join(ROOT, 'config', 'owner-attribution-exceptions.json');
const DEFAULT_ROOTS = ['config', 'docs', 'reports', 'src', 'STANDING-ORDERS.md'];

const TEXT_EXTENSIONS = new Set(['.md', '.json', '.js', '.mjs', '.cjs', '.txt', '.ps1', '.yml', '.yaml']);
// Directories that are never scanned. `.git` because a guard that reads git
// objects reports on history it cannot fix; node_modules because third-party
// prose about "the owner" of a package is not about this owner.
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'vault', 'state', 'private', 'logs']);

// Phrases that assert the owner made a decision. Deliberately narrow: this
// guard's usefulness dies the moment it produces noise, because a guard people
// route around is worse than no guard. It does NOT flag neutral references
// ("the owner inbox"), quoted directives already carrying their citation, or
// second-person copy in customer-facing UI, which is addressed to the USER and
// is correct there -- that distinction is the whole point of the product frame.
const CLAIM_PATTERNS = [
  { name: 'his own <thing>', re: /\bhis own\b/gi },
  { name: 'HIS setting/value/choice', re: /\bHIS (setting|value|choice|decision|rule|cap|limit)\b/g },
  { name: 'the owner decided/chose/set', re: /\bthe owner (decided|chose|set|selected|ruled|wanted|approved)\b/gi },
  { name: 'he decided/chose/set', re: /\bhe (decided|chose|set|selected|ruled)\b/gi },
  { name: 'per the owner', re: /\bper the owner\b/gi },
  { name: 'owner-ratified', re: /\bowner[- ]ratified\b/gi },
  { name: 'you asked/wanted (second person to the owner)', re: /\byou (asked for|wanted|requested|decided|chose)\b/gi },
  { name: 'owner directive/instruction', re: /\bowner (directive|instruction|decision)\b/gi },
];

// A claim is SOURCED if the same line, or the line before it, cites a ledger
// entry or an exception id. Proximity rather than same-line only, because the
// house style puts a citation on its own line beneath the sentence it supports.
//
// EVERY id in the context is considered, not just the first one the regex
// happens to reach. The earlier single-match form was first-match-wins, so a
// line carrying a real citation could still be judged on some other token that
// appeared earlier in the string -- deciding provenance by word order.
const CITED_ID_RE = /\bR(\d+)(?:\.\d+)?\b|\bATTRIBUTION-OK:([A-Za-z0-9._:-]+)\b/g;

// A BARE MARKER IS NOT EVIDENCE, and this is the correction that matters most.
//
// The earlier rule accepted the words "OWNER-STATED" or "verbatim" appearing
// anywhere on the line or the line above, with no id and no quotation, as proof
// that a claim was sourced. Verified behaviourally against this very guard: a
// file containing only
//
//     This was the owner decided value. See OWNER-STATED notes.
//
// was reported "Clean: every claim that a decision was the owner's cites
// evidence" and exited 0. So did "the $100/day cap is his own cap (verbatim
// record kept elsewhere)" -- the exact claim shape this guard was written to
// stop.
//
// That hole was reachable by ACCIDENT and, worse, by COMPLIANCE: the guard's own
// remediation text tells the reader to "cite an OWNER-STATED ledger entry", so
// an agent following the instruction literally would type OWNER-STATED, get a
// green, and believe it had proved something. A guard that is easiest to defeat
// by obeying it is not fail-closed.
//
// The distinction kept is a real one. "verbatim: 'i dont think your codex
// workers are doing...'" carries the owner's words RIGHT THERE and is genuine
// primary evidence; "the verbatim text is elsewhere" is a promise about another
// file. So a marker counts only when an actual quotation follows it. Measured
// across the tree, this change flags 11 additional real claims and zero of the
// quoted-directive lines it must not disturb.
const MARKER_WITH_QUOTE_RE = /\b(?:OWNER-STATED|verbatim)\b[^\n]{0,40}?["'“](.{12,})/i;

class GuardError extends Error {}

function readJson(file, what) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new GuardError(`${what} exists but is unreadable: ${error.message}`);
  }
}

// Which R-ids in the ledger genuinely carry the owner's own words? An entry an
// agent inferred is not evidence that he said anything, so this deliberately
// requires a provenance field rather than accepting every id that exists. If the
// ledger has no provenance field at all -- which is the state that allowed this
// whole problem -- every id is treated as UNPROVEN and the guard says so once,
// loudly, instead of silently passing everything.
function ownerStatedIds() {
  const parsed = readJson(LEDGER, 'the owner request ledger');
  if (!parsed) return { ids: new Set(), ledgerHasProvenance: false, total: 0 };
  const entries = Array.isArray(parsed) ? parsed : (parsed.requests || parsed.entries || parsed.items || []);
  const ids = new Set();
  let withProvenance = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id || entry.rid || entry.R;
    if (!id) continue;
    const provenance = String(entry.provenance || entry.source || '').toUpperCase();
    const hasVerbatim = typeof entry.verbatim === 'string' && entry.verbatim.trim().length > 0;
    if (provenance.includes('OWNER-STATED') || provenance.includes('OWNER_STATED') || hasVerbatim) {
      ids.add(String(id));
      withProvenance += 1;
    }
  }
  return { ids, ledgerHasProvenance: withProvenance > 0, total: entries.length };
}

function exceptionIds() {
  const parsed = readJson(EXCEPTIONS, 'the attribution exceptions file');
  if (!parsed) return new Set();
  const list = Array.isArray(parsed) ? parsed : (parsed.exceptions || []);
  const ids = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    // An exception without his actual words is just an assertion with extra
    // steps, so the quote is mandatory rather than encouraged.
    if (typeof item.quote !== 'string' || !item.quote.trim()) {
      throw new GuardError(
        `attribution exception ${JSON.stringify(item.id || '(no id)')} has no "quote". ` +
          'An exception must carry the owner\'s own words, or it is the very thing this guard exists to catch.',
      );
    }
    if (item.id) ids.add(String(item.id));
  }
  return ids;
}

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(path.join(target, entry.name));
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield path.join(target, entry.name);
    }
  }
}

// Does this context actually prove the claim above it? Exactly two things count:
// a cited id that resolves to real evidence, or a marker carrying the owner's
// own quoted words. Anything else -- including a confident-looking token with
// nothing behind it -- is unproven, and unproven is a finding.
function isSourced(context, sourced) {
  CITED_ID_RE.lastIndex = 0;
  let match;
  while ((match = CITED_ID_RE.exec(context)) !== null) {
    const id = match[1] ? `R${match[1]}` : match[2];
    if (id && sourced.has(String(id))) return true;
  }
  return MARKER_WITH_QUOTE_RE.test(context);
}

function scanFile(file, sourced) {
  const findings = [];
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return findings;
  }
  // This guard's own explanatory text quotes the phrases it hunts for. Scanning
  // itself would produce findings that can never be fixed without deleting the
  // explanation, so it is excluded by identity rather than by a name pattern
  // that a future file could accidentally match.
  if (path.resolve(file) === path.resolve(__filename)) return findings;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of CLAIM_PATTERNS) {
      pattern.re.lastIndex = 0;
      if (!pattern.re.test(line)) continue;
      const context = `${index > 0 ? lines[index - 1] : ''}\n${line}`;
      if (isSourced(context, sourced)) break;
      findings.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: index + 1,
        claim: pattern.name,
        text: line.trim().slice(0, 160),
      });
      break;
    }
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const targets = argv.filter((a) => !a.startsWith('--'));
  const roots = (targets.length ? targets : DEFAULT_ROOTS)
    .map((r) => path.resolve(ROOT, r))
    .filter((r) => fs.existsSync(r));

  if (roots.length === 0) throw new GuardError('nothing to check: none of the requested paths exist.');

  const { ids, ledgerHasProvenance, total } = ownerStatedIds();
  const sourced = new Set([...ids, ...exceptionIds()]);

  const findings = [];
  let filesSeen = 0;
  for (const root of roots) {
    for (const file of walk(root)) {
      filesSeen += 1;
      findings.push(...scanFile(file, sourced));
    }
  }

  // Scanning nothing is an error, not a pass. A clean report produced by looking
  // at zero files is the most dangerous output this program could print.
  if (filesSeen === 0) throw new GuardError(`nothing to check: scanned 0 files under ${roots.join(', ')}`);

  if (asJson) {
    console.log(JSON.stringify({ filesSeen, ledgerEntries: total, ledgerHasProvenance, findings }, null, 2));
  } else {
    console.log(`Owner-attribution guard: scanned ${filesSeen} file(s).`);
    console.log(`Request ledger: ${total} entr(ies), owner-stated provenance recorded: ${ledgerHasProvenance ? 'yes' : 'NO'}`);
    if (!ledgerHasProvenance) {
      console.log(
        '\nThe ledger records no OWNER-STATED provenance on any entry, so no citation in the tree\n' +
          'can currently be verified against his actual words. Until that is fixed, every\n' +
          'attribution below is unproven by construction -- which is the condition that let an\n' +
          'AI-authored default be described as the owner\'s own cap.',
      );
    }
    if (findings.length === 0) {
      console.log('\nClean: every claim that a decision was the owner\'s cites evidence.');
    } else {
      console.log(`\nUNSOURCED ATTRIBUTION -- ${findings.length} claim(s) that a decision was the owner's, with no evidence:`);
      for (const f of findings.slice(0, 60)) {
        console.log(`  ${f.file}:${f.line}  [${f.claim}]\n      ${f.text}`);
      }
      if (findings.length > 60) console.log(`  ... and ${findings.length - 60} more (use --json for all).`);
      console.log(
        '\nFix by one of: cite an OWNER-STATED ledger entry (R-id) on or above the line;\n' +
          'add it to config/owner-attribution-exceptions.json WITH HIS VERBATIM WORDS; or --\n' +
          'most often the correct fix -- stop calling it his. If an agent chose the value, say\n' +
          'the product chose it. Do not widen a pattern to make this green.',
      );
    }
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

try {
  main();
} catch (error) {
  if (error instanceof GuardError) {
    console.error(`Owner-attribution guard error: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(`Owner-attribution guard error: ${error.stack || error.message}`);
    process.exitCode = 2;
  }
}
