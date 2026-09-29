#!/usr/bin/env node
// GREPSAVER — mechanical index generator. See GREPSAVER-PLAN.md §3/§5-§6 and
// the "MECHANICAL INDEX AMENDMENT" it links to (added alongside this file).
//
// The problem this closes: grepsaver-check.js already makes each card's
// CONTENT self-updating (mechanical zones auto-refresh from
// grepsaver-extract.js's facts, judgment zones are protected, drift is
// fingerprinted and surfaced) — but the SET of systems listed in
// context/systems.json and context/SYSTEMS.md was still assembled by hand:
// an agent recon session decided which systems existed and pasted rows into
// both files. Nothing regenerated that list, and nothing detected when a
// card was added or removed without updating it. Q23's HARDENING/MECHANICAL
// AMENDMENTs closed the per-card gap; this closes the per-INDEX gap.
//
// This script makes membership (which systems exist, where, their ports,
// their display name) a pure, deterministic function of:
//   - the cards actually present in context/*.md (frontmatter only — never
//     their judgment prose), and
//   - ServerControl/servers.json (ports).
// It never writes card content and never touches a card's judgment zones.
// Per-card fingerprint/review state (whether a card is FRESH, its reviewed
// hashes) is carried forward unchanged for ids that already existed —
// review trust is earned by a human/agent review pass (grepsaver-check.js
// --approve), never manufactured by this script.
//
// Usage:
//   node tools/grepsaver-reindex.js            # (re)write systems.json + SYSTEMS.md
//   node tools/grepsaver-reindex.js --check    # exit 1 if regenerating would
//                                                 change anything; prints the
//                                                 diff. Writes nothing. This is
//                                                 the "is the index current?"
//                                                 gate — wire it into a test or
//                                                 pre-work check (see README in
//                                                 GREPSAVER-PLAN.md's amendment;
//                                                 do not schedule it as a task
//                                                 without the owner's say-so).
//   node tools/grepsaver-reindex.js --json     # print the recomputed registry
//                                                 (systems.json shape); writes
//                                                 nothing.
//
// Determinism: the SAME cards in context/ (plus the SAME servers.json) always
// produce BYTE-IDENTICAL systems.json + SYSTEMS.md output on rerun, with one
// documented, intentional exception — systems.json's top-level `generated`
// field records wall-clock run time, the way a build timestamp does. Every
// staleness/content comparison (including --check) ignores that one field;
// nothing else is allowed to vary between two runs over unchanged input. For
// a byte-identical test across that field too, pin
// TOOLSENABLED_GREPSAVER_NOW=YYYY-MM-DD.
//
// Staleness signal: systems.json's `generated_from` is a SHA-256 over sorted
// (id, path, fingerprint_type, manifest, wsl_distro, wsl_base) tuples for
// every registered system — a pure function of the cards in context/,
// independent of wall clock and of review state. Recomputing it and comparing
// against the stored value answers "is the INDEX (the set of systems, not
// any one card) current?" mechanically. --check does this first, then also
// byte-compares the full regenerated files for drift `generated_from` cannot
// see (e.g. a card's H1 display name or ServerControl's ports changed).
//
// Exit codes: 0 = written (or, under --check, already current); 1 = --check
// found drift; 2 = a card could not be parsed, is invalid, or ids collide —
// an uncertain input is a hard error, never a silently shrunk index.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./grepsaver-lib.js');

const CONTEXT_DIR = process.env.TOOLSENABLED_GREPSAVER_CONTEXT || path.join(__dirname, '..', 'context');
// Injectable clock, isolated-test convention (mirrors TOOLSENABLED_GREPSAVER_CONTEXT).
// Production runs always use the real date; only tests pin this, to prove
// determinism of the ONE field that legitimately carries wall-clock time.
const now = () => process.env.TOOLSENABLED_GREPSAVER_NOW || lib.today();

// --- discovery ---------------------------------------------------------------

function discoverCards(contextDir) {
  const cards = [];
  const errors = [];
  let names;
  try {
    names = fs.readdirSync(contextDir);
  } catch (e) {
    // Cannot tell "no systems" from "cannot see the directory" — refuse
    // rather than silently reporting an empty (wrong-looking-clean) index.
    errors.push(`cannot read ${contextDir}: ${e.code || e.message}`);
    return { cards, errors };
  }
  for (const name of names.slice().sort()) {
    if (!name.endsWith('.md') || lib.NON_CARD_FILES.has(name)) continue;
    const cardPath = path.join(contextDir, name);
    let parsed;
    try {
      parsed = lib.parseCard(cardPath);
    } catch (e) {
      errors.push(`context/${name}: unparsable — ${e.message}`);
      continue;
    }
    if (parsed.missingKeys.length) {
      errors.push(`context/${name}: invalid frontmatter — missing ${parsed.missingKeys.join(', ')}`);
      continue;
    }
    const id = parsed.frontmatter.system;
    const expectedFile = `${id}.md`;
    if (name !== expectedFile) {
      errors.push(`context/${name}: frontmatter system '${id}' must match filename context/${expectedFile} (the context/<id>.md rule)`);
      continue;
    }
    cards.push({ file: name, id, frontmatter: parsed.frontmatter, text: parsed.text });
  }
  if (!cards.length && !errors.length) {
    errors.push(`no system cards found in ${contextDir} — refusing to produce or validate an empty index`);
  }
  return { cards, errors };
}

function buildEntries(cards) {
  const byId = new Map();
  const errors = [];
  for (const card of cards) {
    if (byId.has(card.id)) {
      errors.push(`duplicate system id '${card.id}': context/${byId.get(card.id).file} and context/${card.file} — routing would be ambiguous`);
      continue;
    }
    byId.set(card.id, card);
  }
  if (errors.length) return { entries: [], errors };

  const entries = [...byId.values()]
    .map((card) => {
      const fm = card.frontmatter;
      const ports = lib.serverFacts(fm.source_path)
        .map((s) => s.port)
        .filter((p) => p !== undefined && p !== null);
      return {
        id: card.id,
        name: lib.deriveSystemName(card.text, card.id),
        path: lib.toPosix(fm.source_path),
        card: `context/${card.id}.md`,
        ports: [...new Set(ports)].sort((a, b) => a - b),
        fingerprint_type: fm.fingerprint_type,
        manifest: Array.isArray(fm.manifest) ? fm.manifest.slice() : undefined,
        wsl_distro: fm.wsl_distro,
        wsl_base: fm.wsl_base,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { entries, errors: [] };
}

// --- merge with prior state (review trust is earned, never manufactured) ----

// Explicit, fixed key order so JSON.stringify never depends on an old
// object's incidental key insertion order — this IS the mechanism behind
// byte-identical reruns, not an accident of how V8 iterates objects.
function mergeEntry(fresh, previous) {
  const fingerprint = { type: fresh.fingerprint_type };
  if (Array.isArray(fresh.manifest)) fingerprint.manifest = fresh.manifest;
  if (previous && previous.fingerprint) {
    if (previous.fingerprint.value !== undefined) fingerprint.value = previous.fingerprint.value;
    if (previous.fingerprint.captured_at !== undefined) fingerprint.captured_at = previous.fingerprint.captured_at;
    if (previous.fingerprint.dirty !== undefined) fingerprint.dirty = previous.fingerprint.dirty;
  }
  const out = {
    id: fresh.id, name: fresh.name, path: fresh.path, card: fresh.card, ports: fresh.ports, fingerprint,
  };
  if (previous) {
    if (previous.status) out.status = previous.status;
    if (previous.stale_since) out.stale_since = previous.stale_since;
    if (previous.reviewed_fingerprint) out.reviewed_fingerprint = previous.reviewed_fingerprint;
    if (previous.reviewed_card_hash) out.reviewed_card_hash = previous.reviewed_card_hash;
    if (previous.reviewed_mechanical_hash) out.reviewed_mechanical_hash = previous.reviewed_mechanical_hash;
    if (previous.reviewed_judgment_hash) out.reviewed_judgment_hash = previous.reviewed_judgment_hash;
    if (previous.mechanical_snapshot) out.mechanical_snapshot = previous.mechanical_snapshot;
  }
  return out;
}

// --- SYSTEMS.md rendering ----------------------------------------------------

// Status text is grepsaver-check.js's domain (fingerprint comparison, review
// state) — this script only needs the ROW to exist so the checker can write
// into it without a divergence error. Carrying forward whatever text was
// last computed (rather than inventing a fresh date-stamped placeholder)
// keeps SYSTEMS.md generation itself entirely clock-free: an unchanged card
// set reruns to byte-identical output with zero wall-clock dependency.
function parsePriorStatuses(mdText) {
  const map = new Map();
  if (!mdText) return map;
  for (const line of mdText.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    const id = cells[1];
    if (!id || id === 'system' || /^-+$/.test(id)) continue;
    map.set(id, cells[4]);
  }
  return map;
}

// `trustedIds` gates the carry-forward: a status cell is only reused when the
// id also has a real prior systems.json entry backing it. Without this, an
// orphaned SYSTEMS.md row left over from a deleted/never-written systems.json
// (a real scenario: systems.json is gitignored and SYSTEMS.md is not always
// deleted alongside it) would carry forward stale, unearned status text for a
// system this run has never actually checked — the exact "stale index that
// looks current" failure this tool exists to prevent.
function renderSystemsMd(entries, priorStatuses, trustedIds) {
  const lines = [
    '# System index',
    '',
    'Read the relevant card before exploration. This file, and each card\'s',
    'id / path / ports / entry-point / run-command / port facts, are',
    'mechanically generated from context/*.md — never hand-edit; run',
    '`node tools/grepsaver-reindex.js` instead (`--check` reports drift without',
    'writing). Each card\'s Identity / Invariants / Do not touch prose remains',
    'human judgment — a generated status of FRESH means the source has not',
    'drifted since a human reviewed THAT content, not that the judgment prose',
    'is independently machine-verified. Verify before any destructive edit.',
    '',
    '| system | path | ports | status |',
    '|---|---|---|---|',
  ];
  for (const entry of entries) {
    const displayPath = lib.homeRelative(entry.path);
    const ports = entry.ports && entry.ports.length ? entry.ports.join('/') : '-';
    const status = (trustedIds.has(entry.id) && priorStatuses.get(entry.id)) || 'NOT-YET-CHECKED';
    lines.push(`| ${entry.id} | ${displayPath} | ${ports} | ${status} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// --- target computation -------------------------------------------------------

function readTextIfPresent(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function loadJsonIfPresent(p) {
  const text = readTextIfPresent(p);
  return text === null ? null : JSON.parse(text);
}

function computeTarget(contextDir) {
  const { cards, errors: discoverErrors } = discoverCards(contextDir);
  if (discoverErrors.length) return { errors: discoverErrors };
  const { entries, errors: buildErrors } = buildEntries(cards);
  if (buildErrors.length) return { errors: buildErrors };

  const generatedFrom = lib.registryFingerprint(entries);
  let previousState;
  let priorMd;
  try {
    previousState = loadJsonIfPresent(path.join(contextDir, 'systems.json'));
  } catch (e) {
    return { errors: [`cannot load ${path.join(contextDir, 'systems.json')}: ${e.code || e.message}`] };
  }
  if (previousState !== null && (!previousState || !Array.isArray(previousState.systems))) {
    return { errors: [`cannot use ${path.join(contextDir, 'systems.json')}: expected a top-level systems array`] };
  }
  if (previousState) {
    const priorIds = previousState.systems.map((system) => system && system.id);
    if (priorIds.some((id) => typeof id !== 'string' || !id)) {
      return { errors: [`cannot use ${path.join(contextDir, 'systems.json')}: every prior system must have a non-empty string id`] };
    }
    if (new Set(priorIds).size !== priorIds.length) {
      return { errors: [`cannot use ${path.join(contextDir, 'systems.json')}: duplicate prior system ids would make review-state carry-forward ambiguous`] };
    }
  }
  try {
    const priorMdText = readTextIfPresent(path.join(contextDir, 'SYSTEMS.md'));
    priorMd = priorMdText === null ? null : lib.normalizeText(priorMdText);
  } catch (e) {
    return { errors: [`cannot read ${path.join(contextDir, 'SYSTEMS.md')}: ${e.code || e.message}`] };
  }
  const previousById = new Map((previousState && Array.isArray(previousState.systems) ? previousState.systems : []).map((s) => [s.id, s]));
  const merged = entries.map((e) => mergeEntry(e, previousById.get(e.id)));
  const droppedIds = [...previousById.keys()].filter((id) => !entries.some((e) => e.id === id));

  const priorStatuses = parsePriorStatuses(priorMd);

  const state = { generated: now(), generated_from: generatedFrom, systems: merged };
  return {
    errors: [],
    state,
    systemsJsonText: `${JSON.stringify(state, null, 2)}\n`,
    systemsMdText: renderSystemsMd(merged, priorStatuses, new Set(previousById.keys())),
    previousState,
    droppedIds,
    cardCount: cards.length,
  };
}

// --- diffing for --check ------------------------------------------------------

function diffSummary(previousSystems, mergedSystems) {
  const prevById = new Map((previousSystems || []).map((s) => [s.id, s]));
  const nextById = new Map(mergedSystems.map((s) => [s.id, s]));
  const lines = [];
  for (const id of nextById.keys()) if (!prevById.has(id)) lines.push(`+ ${id} (new card in context/, not yet in the index)`);
  for (const id of prevById.keys()) if (!nextById.has(id)) lines.push(`- ${id} (indexed, but its card is gone from context/)`);
  for (const id of nextById.keys()) {
    if (!prevById.has(id)) continue;
    const a = prevById.get(id);
    const b = nextById.get(id);
    for (const field of ['name', 'path', 'card']) {
      if (a[field] !== b[field]) lines.push(`~ ${id}: ${field} changed ('${a[field]}' -> '${b[field]}')`);
    }
    if (JSON.stringify(a.ports || []) !== JSON.stringify(b.ports || [])) {
      lines.push(`~ ${id}: ports changed (${JSON.stringify(a.ports || [])} -> ${JSON.stringify(b.ports || [])})`);
    }
  }
  return lines;
}

// --- main ----------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const asJson = args.includes('--json');

  const target = computeTarget(CONTEXT_DIR);
  if (target.errors.length) {
    target.errors.forEach((e) => process.stderr.write(`ERROR: ${e}\n`));
    process.stderr.write(`grepsaver-reindex: refusing to write — a shrunk or wrong index is worse than none. Fix the above and rerun.\n`);
    process.exitCode = 2;
    return;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(target.state, null, 2)}\n`);
    return;
  }

  const sysPath = path.join(CONTEXT_DIR, 'systems.json');
  const mdPath = path.join(CONTEXT_DIR, 'SYSTEMS.md');

  if (checkOnly) {
    const onDiskSysRaw = fs.existsSync(sysPath) ? fs.readFileSync(sysPath, 'utf8') : null;
    const onDiskMd = fs.existsSync(mdPath) ? lib.normalizeText(fs.readFileSync(mdPath, 'utf8')) : null;
    const problems = [];

    if (onDiskSysRaw === null) {
      problems.push('context/systems.json does not exist — index was never generated');
    } else {
      const onDiskState = loadJsonIfPresent(sysPath);
      if (!onDiskState) {
        problems.push('context/systems.json is not valid JSON');
      } else {
        if (onDiskState.generated_from !== target.state.generated_from) {
          problems.push(`membership drift: generated_from is '${onDiskState.generated_from || '(none)'}\', current cards hash to '${target.state.generated_from}'`);
          problems.push(...diffSummary(onDiskState.systems, target.state.systems));
        }
        // Ignore the wall-clock `generated` field for content comparison —
        // substitute the on-disk value before comparing the rest byte-for-byte.
        const comparable = { ...target.state, generated: onDiskState.generated };
        const comparableText = `${JSON.stringify(comparable, null, 2)}\n`;
        if (comparableText !== onDiskSysRaw && onDiskState.generated_from === target.state.generated_from) {
          problems.push('context/systems.json content differs from what regeneration would produce (name/path/ports/review-state drift)');
        }
      }
    }

    if (onDiskMd === null) problems.push('context/SYSTEMS.md does not exist — index was never generated');
    else if (onDiskMd !== target.systemsMdText) problems.push('context/SYSTEMS.md does not match what regeneration would produce');

    if (problems.length) {
      process.stdout.write('STALE — the index no longer matches context/*.md. Run: node tools/grepsaver-reindex.js\n');
      problems.forEach((p) => process.stdout.write(`  ${p}\n`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`CURRENT — systems.json and SYSTEMS.md match the ${target.cardCount} card(s) in context/ (generated_from ${target.state.generated_from.slice(0, 12)}...).\n`);
    process.exitCode = 0;
    return;
  }

  // Write mode: skip the write entirely when content is already identical,
  // so a no-op regeneration never touches mtime and never produces a diff —
  // not even a timestamp-only one.
  const onDiskSys = fs.existsSync(sysPath) ? fs.readFileSync(sysPath, 'utf8') : null;
  const onDiskMd = fs.existsSync(mdPath) ? lib.normalizeText(fs.readFileSync(mdPath, 'utf8')) : null;
  let wroteSys = false;
  let wroteMd = false;
  if (onDiskSys !== target.systemsJsonText) { lib.atomicWrite(sysPath, target.systemsJsonText); wroteSys = true; }
  if (onDiskMd !== target.systemsMdText) { lib.atomicWrite(mdPath, target.systemsMdText); wroteMd = true; }

  if (target.droppedIds.length) {
    process.stdout.write(`dropped (card no longer present): ${target.droppedIds.join(', ')}\n`);
  }
  process.stdout.write(`${target.cardCount} card(s) indexed. systems.json ${wroteSys ? 'written' : 'unchanged'}; SYSTEMS.md ${wroteMd ? 'written' : 'unchanged'}.\n`);
  process.stdout.write(`generated_from: ${target.state.generated_from}\n`);
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = {
  discoverCards, buildEntries, mergeEntry, renderSystemsMd, parsePriorStatuses, computeTarget, diffSummary,
};
