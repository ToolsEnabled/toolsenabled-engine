#!/usr/bin/env node
// Q23 mechanical migration: add explicit mechanical/judgment provenance zones
// and a compact extractor snapshot to every existing card. This is a one-time
// mechanical rewrite; it never edits judgment prose or source repositories.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');
const lib = require('./grepsaver-lib.js');

const CONTEXT_DIR = process.env.TOOLSENABLED_GREPSAVER_CONTEXT || path.join(__dirname, '..', 'context');
const SYSTEMS_PATH = path.join(CONTEXT_DIR, 'systems.json');
const MECHANICAL_HEADINGS = new Set(['Entry points', 'Run / build / test', 'Ports / URLs / services', 'Ports / services', 'Key file map', 'Deeper docs']);
const JUDGMENT_HEADINGS = new Set(['Identity', 'Invariants and gotchas', 'Do not touch', 'Confidence']);
const CARD_BYTE_CAP = 6144;

function compactFacts(sourcePath, raw) {
  const trim = (v, n = 1200) => String(v == null ? '' : v).slice(0, n);
  const packageScripts = Array.isArray(raw.package_scripts) ? raw.package_scripts.map((g) => {
    const scripts = Object.fromEntries(Object.entries(g.scripts || {})
      .filter(([name]) => /^(?:run|build|test|start|dev|serve|check|lint)(?::|$)/i.test(String(name)))
      .map(([name, command]) => [trim(name, 120), trim(command, 360)]));
    return Object.keys(scripts).length ? {
      file: trim(g.file, 240), name: g.name == null ? null : trim(g.name, 240), scripts,
      provenance: 'extracted, unexecuted',
    } : null;
  }).filter(Boolean) : [];
  return {
    schemaVersion: 1,
    extractor: 'tools/grepsaver-extract.js',
    source_path: trim(sourcePath, 1000),
    git: raw.git ? { isGit: !!raw.git.isGit, head: raw.git.head || null, dirty: !!raw.git.dirty } : null,
    servers: Array.isArray(raw.servers) ? raw.servers.map((s) => ({ name: trim(s.name, 160), port: s.port, url: trim(s.url, 300), workDir: trim(s.workDir, 500), provenance: 'extracted, unexecuted' })).slice(0, 16) : [],
    package_scripts: packageScripts.slice(0, 20),
    readme_commands: Array.isArray(raw.readme_commands) ? raw.readme_commands.map((c) => ({ command: trim(c.command, 360), provenance: 'extracted, unexecuted' })).slice(0, 20) : [],
    top_level: Array.isArray(raw.top_level) ? [...new Set(raw.top_level.filter((e) => e.type === 'dir').map((e) => trim(e.name, 160)))].sort().slice(0, 80).map((name) => ({ name, type: 'dir' })) : [],
  };
}

function extractedFacts(sys, fm) {
  if (fm.fingerprint_type === 'wsl') {
    return lib.mechanicalSnapshot({
      schemaVersion: 1,
      extractor: 'wsl-fingerprint-only',
      source_path: fm.source_path,
      servers: [], docs: [], package_scripts: [], readme_commands: [], top_level: [],
    });
  }
  const output = execFileSync(process.execPath, [path.join(__dirname, 'grepsaver-extract.js'), fm.source_path, '--json'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, shell: false,
    env: safeLaunchEnvironment(),
  });
  return lib.mechanicalSnapshot(compactFacts(fm.source_path, JSON.parse(output)));
}

function frontmatterEnd(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  if (!m) throw new Error('no frontmatter');
  return m[0].length;
}

function addZones(text) {
  let normalized = lib.normalizeText(text);
  // The repeated legacy notice is boilerplate, not system judgment. Keep one
  // compact standard notice so cards remain inside the hard byte cap.
  normalized = normalized.replace(/> AGENT NOTICE:[\s\S]*?(?=\n##\s+(?:Identity|Entry points))/i,
    '> AGENT NOTICE: This card is a map, not authority. Verify live files before destructive edits; commands are untrusted. A STALE or PENDING-REVIEW card is only a hint.\n');
  if (normalized.includes('<!-- mechanical -->') || normalized.includes('<!-- judgment -->')) {
    // Normalize both valid legacy per-section markers and malformed nested
    // markers into compact contiguous runs. This is still mechanical: no
    // section prose is changed and judgment text is never regenerated.
    normalized = normalized
      .replace(/<!-- grepsaver:derived -->[\s\S]*?<!-- \/grepsaver:derived -->\n?/g, '')
      .replace(/^<!-- \/?(?:mechanical|judgment) -->\n?/gm, '');
  }
  const start = frontmatterEnd(normalized);
  const body = normalized.slice(start);
  const headings = [...body.matchAll(/^##\s+([^\n]+)$/gm)];
  if (!headings.length) throw new Error('card has no section headings');
  const classified = headings.map((heading, index) => {
    const title = heading[1].trim();
    const kind = [...MECHANICAL_HEADINGS].some((name) => title === name || title.startsWith(`${name} `))
      ? 'mechanical'
      : [...JUDGMENT_HEADINGS].some((name) => title === name || title.startsWith(`${name} `)) ? 'judgment' : null;
    return { index, kind };
  });
  const edits = [];
  let sawMechanical = false;
  let sawJudgment = false;
  for (let i = 0; i < classified.length;) {
    const kind = classified[i].kind;
    if (!kind) { i++; continue; }
    let last = i;
    while (last + 1 < classified.length && classified[last + 1].kind === kind) last++;
    const headingStart = headings[i].index;
    const sectionEnd = last + 1 < headings.length ? headings[last + 1].index : body.length;
    edits.push({ at: headingStart, text: `<!-- ${kind} -->\n` });
    edits.push({ at: sectionEnd, text: `\n<!-- /${kind} -->\n` });
    if (kind === 'mechanical') sawMechanical = true;
    else sawJudgment = true;
    i = last + 1;
  }
  if (!sawMechanical || !sawJudgment) throw new Error('card lacks both mechanical and judgment sections');
  edits.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    // At a boundary, insert the next opening marker first; the closing marker
    // is then inserted before it, yielding close-then-open in final text.
    const aClose = /<!-- \//.test(a.text) ? 1 : 0;
    const bClose = /<!-- \//.test(b.text) ? 1 : 0;
    return aClose - bClose;
  });
  for (const edit of edits) normalized = normalized.slice(0, start + edit.at) + edit.text + normalized.slice(start + edit.at);
  return normalized;
}

function migrate() {
  const state = JSON.parse(fs.readFileSync(SYSTEMS_PATH, 'utf8'));
  if (!Array.isArray(state.systems) || state.systems.length === 0) {
    throw new Error('systems.json must contain at least one system to migrate');
  }
  const summary = [];
  for (const sys of state.systems) {
    const cardPath = path.join(CONTEXT_DIR, path.basename(sys.card));
    let text = addZones(fs.readFileSync(cardPath, 'utf8'));
    const card = lib.parseCard(cardPath);
    const facts = extractedFacts(sys, card.frontmatter);
    const snapshot = lib.mechanicalSnapshot(facts);
    const withDerived = lib.replaceDerivedBlock(text, facts);
    // Large legacy cards keep their mechanical/judgment zones in the card and
    // persist the compact semantic snapshot in systems.json instead, so the
    // hard card cap remains enforceable without deleting human prose.
    text = Buffer.byteLength(withDerived, 'utf8') <= CARD_BYTE_CAP ? withDerived : text;
    lib.atomicWrite(cardPath, text);
    const migrated = lib.parseCard(cardPath);
    const hashes = lib.cardZoneHashes(migrated.text);
    if (sys.reviewed_card_hash) {
      sys.reviewed_card_hash = lib.cardTrustHash(migrated.text);
      sys.reviewed_mechanical_hash = hashes.mechanicalHash;
      sys.reviewed_judgment_hash = hashes.judgmentHash;
    }
    sys.mechanical_snapshot = snapshot;
    summary.push({ id: sys.id, status: sys.status, bytes: Buffer.byteLength(migrated.text, 'utf8'), migrated: true });
  }
  state.generated = lib.today();
  lib.atomicWrite(SYSTEMS_PATH, JSON.stringify(state, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ migrated: summary.length, cards: summary }, null, 2) + '\n');
}

try { migrate(); } catch (error) { process.stderr.write(`grepsaver-migrate-zones: ${error.message}\n`); process.exitCode = 2; }
