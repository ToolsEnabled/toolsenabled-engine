#!/usr/bin/env node
'use strict';

// Reports whether explicitly named owner-request ledger copies disagree with
// the ledger in this repository. The repository containing this script is the
// authority for this invocation; additional installation roots must be passed
// with --copy-root. The tool never searches a user profile, Desktop, OneDrive,
// sibling checkout, or any other guessed location.
//
// Exit codes:
//   0  one ledger, or additional copies that are strict, non-divergent subsets
//   3  FORK: a non-authoritative copy holds ids the authority does not, or the
//      same id means different things in two copies
//   4  a ledger needed for the comparison could not be read at all
//   2  usage error

const fs = require('node:fs');
const path = require('node:path');

const LEDGER_RELATIVE = path.join('reports', 'OWNER-REQUEST-LEDGER.json');

const CANONICAL_ROOT = path.resolve(__dirname, '..');

const KNOWN_ROOTS = Object.freeze([
  Object.freeze({ root: CANONICAL_ROOT, label: 'current repository' })
]);

class LedgerAuthorityError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'LedgerAuthorityError';
    this.exitCode = exitCode;
  }
}

function readLedger(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') {
      // A missing known tree is genuinely absent. A tree that exists but has
      // lost its ledger is not an empty/harmless copy: there is no evidence
      // from which to answer whether that copy has forked.
      const root = path.dirname(path.dirname(file));
      try { fs.statSync(root); }
      catch (rootError) {
        if (rootError.code === 'ENOENT') return { file, present: false };
        return { file, present: false, readable: false, error: rootError.code || 'ROOT_UNREADABLE' };
      }
      return { file, present: false, readable: false, error: 'MISSING_LEDGER' };
    }
    return { file, present: true, readable: false, error: error.code || 'UNREADABLE' };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { file, present: true, readable: false, error: 'INVALID_JSON' }; }
  if (!parsed || !Array.isArray(parsed.requests)) {
    return { file, present: true, readable: false, error: 'NO_REQUESTS_ARRAY' };
  }
  const byId = new Map();
  for (const entry of parsed.requests) {
    if (!entry || typeof entry.id !== 'string') {
      return { file, present: true, readable: false, error: 'INVALID_REQUEST_ID' };
    }
    // Last write wins for a duplicated id inside one file; duplicates inside a
    // single ledger are a different defect and tools/ledger-truth.js owns it.
    byId.set(entry.id, entry);
  }
  let mtime = null;
  try { mtime = fs.statSync(file).mtime.toISOString(); } catch { /* raced away */ }
  return {
    file,
    present: true,
    readable: true,
    count: parsed.requests.length,
    revision: parsed.revision ?? null,
    updatedAt: parsed.updatedAt ?? null,
    mtime,
    byId
  };
}

// Same id, different meaning. Compares the two fields that carry what was
// asked: the owner's verbatim words and the recorded interpretation. Status,
// gates and captureLog legitimately differ between copies of the SAME request
// (one side did work the other has not seen) and are not evidence of a fork.
function divergentIds(authority, other) {
  const out = [];
  for (const [id, mine] of other.byId) {
    const theirs = authority.byId.get(id);
    if (!theirs) continue;
    const a = `${theirs.verbatim || ''}\u0000${theirs.request || ''}`;
    const b = `${mine.verbatim || ''}\u0000${mine.request || ''}`;
    if (a !== b) out.push(id);
  }
  return out;
}

// `canonicalRoot` is a parameter so tests can build a real two-tree fork. The
// CLI never accepts an authority override: its authority is always the current
// repository derived from this script's location.
function validatedRoots(roots, canonicalRoot) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new LedgerAuthorityError('at least the current repository root must be declared');
  }
  if (typeof canonicalRoot !== 'string' || !path.isAbsolute(canonicalRoot)) {
    throw new LedgerAuthorityError('canonical root must be an explicit absolute path');
  }
  const seen = new Set();
  let canonicalCount = 0;
  const normalized = roots.map((entry, index) => {
    if (!entry || typeof entry.root !== 'string' || !path.isAbsolute(entry.root)) {
      throw new LedgerAuthorityError(`root ${index + 1} must be an explicit absolute path`);
    }
    const root = path.resolve(entry.root);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) {
      throw new LedgerAuthorityError(`ambiguous duplicate ledger root: ${root}`);
    }
    seen.add(key);
    const canonical = key === (process.platform === 'win32'
      ? path.resolve(canonicalRoot).toLowerCase()
      : path.resolve(canonicalRoot));
    if (canonical) canonicalCount += 1;
    return {
      root,
      label: String(entry.label || `explicit copy ${index}`),
      canonical,
      required: entry.required === true
    };
  });
  if (canonicalCount !== 1) {
    throw new LedgerAuthorityError(`exactly one declared root must be the current repository; found ${canonicalCount}`);
  }
  return normalized;
}

function compare(roots = KNOWN_ROOTS, canonicalRoot = CANONICAL_ROOT) {
  const declaredRoots = validatedRoots(roots, canonicalRoot);
  const copies = declaredRoots.map(({ root, label, canonical, required }) => ({
    root,
    label,
    canonical,
    required,
    ...readLedger(path.join(root, LEDGER_RELATIVE))
  }));
  const authority = copies.find(copy => copy.canonical && copy.readable);
  const unavailableCopy = authority && copies.find(copy => !copy.canonical
    && (copy.error || (copy.required && !copy.present)));
  if (unavailableCopy) {
    throw new LedgerAuthorityError(
      `cannot compare ledger copy ${unavailableCopy.file}: ${unavailableCopy.error || 'EXPLICIT_ROOT_ABSENT'}`,
      4
    );
  }
  const findings = [];
  let fork = false;

  for (const copy of copies) {
    if (copy.canonical || !copy.readable || !authority) continue;
    const onlyHere = [...copy.byId.keys()].filter(id => !authority.byId.has(id));
    const divergent = divergentIds(authority, copy);
    const shared = [...copy.byId.keys()].filter(id => authority.byId.has(id)).length;
    if (onlyHere.length || divergent.length) fork = true;
    findings.push({
      root: copy.root,
      label: copy.label,
      count: copy.count,
      revision: copy.revision,
      updatedAt: copy.updatedAt,
      shared,
      onlyHere,
      divergent
    });
  }

  return {
    authoritative: authority
      ? { root: authority.root, file: authority.file, count: authority.count, revision: authority.revision, updatedAt: authority.updatedAt, mtime: authority.mtime }
      : null,
    authorityDeclaredBy: 'the current repository containing tools/ledger-authority.js',
    copies: copies.map(copy => ({
      root: copy.root, label: copy.label, canonical: copy.canonical,
      present: copy.present, readable: Boolean(copy.readable),
      error: copy.error || null, count: copy.count ?? null, revision: copy.revision ?? null,
      updatedAt: copy.updatedAt ?? null, mtime: copy.mtime ?? null
    })),
    findings,
    fork
  };
}

function render(result) {
  const lines = [];
  lines.push('OWNER-REQUEST LEDGER AUTHORITY');
  lines.push('');
  if (!result.authoritative) {
    lines.push('  UNREADABLE: the authoritative ledger could not be read.');
    lines.push(`  Declared canonical root: ${CANONICAL_ROOT}`);
  } else {
    const a = result.authoritative;
    lines.push(`  AUTHORITATIVE: ${a.file}`);
    lines.push(`    ${a.count} requests, revision ${a.revision}, updatedAt ${a.updatedAt}`);
    lines.push(`    Authority declared by: ${result.authorityDeclaredBy}`);
  }
  lines.push('');
  lines.push('  Declared copies checked:');
  for (const copy of result.copies) {
    const state = copy.error ? `UNREADABLE (${copy.error})`
      : !copy.present ? 'absent'
        : !copy.readable ? 'UNREADABLE'
        : `${copy.count} requests, revision ${copy.revision}`;
    lines.push(`    ${copy.canonical ? '*' : ' '} ${copy.root}  [${copy.label}]  ${state}`);
  }
  if (result.findings.length) {
    lines.push('');
    for (const f of result.findings) {
      lines.push(`  vs ${f.root} [${f.label}]:`);
      lines.push(`    shared ids: ${f.shared}`);
      lines.push(`    ids only there (never merged into the authority): ${f.onlyHere.length}${f.onlyHere.length ? ` -- ${f.onlyHere.slice(0, 20).join(', ')}` : ''}`);
      lines.push(`    ids that MEAN SOMETHING DIFFERENT there: ${f.divergent.length}${f.divergent.length ? ` -- ${f.divergent.slice(0, 20).join(', ')}` : ''}`);
    }
  }
  lines.push('');
  if (result.fork) {
    lines.push('  VERDICT: FORKED. Cite tree AND id -- an id alone is ambiguous across these');
    lines.push('  copies. Capture owner words ONLY into the authoritative ledger. This tool');
    lines.push('  will not merge; tools/ledger-merge.js is the reviewed path.');
  } else if (result.authoritative) {
    lines.push('  VERDICT: single authority, no divergent or unmerged ids detected.');
  }
  return lines.join('\n');
}

function parseArguments(argv) {
  const roots = [...KNOWN_ROOTS];
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') { json = true; continue; }
    if (argument === '--help' || argument === '-h') { help = true; continue; }
    if (argument === '--copy-root') {
      const root = argv[index + 1];
      if (!root || root.startsWith('--')) {
        throw new LedgerAuthorityError('--copy-root requires an absolute repository root');
      }
      if (!path.isAbsolute(root)) {
        throw new LedgerAuthorityError(`--copy-root must be absolute: ${root}`);
      }
      roots.push({ root: path.resolve(root), label: `explicit copy: ${path.resolve(root)}`, required: true });
      index += 1;
      continue;
    }
    throw new LedgerAuthorityError(`unknown argument: ${argument}`, 2);
  }
  validatedRoots(roots, CANONICAL_ROOT);
  return { json, help, roots };
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write('usage: node tools/ledger-authority.js [--json] [--copy-root <absolute-repository-root>]...\n\nCompares the current repository ledger with only the explicitly named installation roots. Read-only; never searches sibling or user-profile paths.\n');
    return 0;
  }
  const result = compare(options.roots);
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`);
  if (!result.authoritative) return 4;
  return result.fork ? 3 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof LedgerAuthorityError ? error.exitCode : 1;
  }
}

module.exports = Object.freeze({
  CANONICAL_ROOT, KNOWN_ROOTS, LEDGER_RELATIVE,
  LedgerAuthorityError,
  readLedger, divergentIds, validatedRoots, parseArguments, compare, render, main
});
