// GREPSAVER shared helpers — single source of truth for text normalization,
// card parsing, fingerprint recipes, secret redaction, and atomic writes.
// Used by grepsaver-check.js and grepsaver-extract.js so the two cannot
// diverge on the canonical recipes. See GREPSAVER-PLAN.md §2/§3/§5-§7.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const toPosix = (p) => String(p).replace(/\\/g, '/');
const today = () => new Date().toISOString().slice(0, 10);

// Windows editors may re-save cards with a BOM and/or CRLF. Normalize on every
// read so parsing never breaks; writes always emit LF.
const normalizeText = (s) => s.replace(/^﻿/, '').replace(/\r\n/g, '\n');

// Secret-like content must never be quoted into a card (plan §7). Mirrors the
// search indexer's sensitivity posture.
const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/, /sk-[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /xox[a-z]?-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const looksSecret = (line) => SECRET_PATTERNS.some((re) => re.test(line));

// Atomic write: temp file + rename on the same volume, so a crash mid-write
// can never leave truncated JSON/markdown behind. Windows can transiently
// EPERM the rename while AV/search-indexer briefly holds the destination —
// retry a few times before giving up.
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ } };
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      if ((e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') && attempt < 6) { sleepMs(100 * attempt); continue; }
      try { fs.rmSync(tmp, { force: true }); } catch { /* leave no debris */ }
      throw e;
    }
  }
}

// --- card frontmatter -------------------------------------------------------

const REQUIRED_KEYS = ['system', 'source_path', 'fingerprint', 'fingerprint_type', 'generated', 'reviewed_on', 'generator'];
const BANNER_PREFIX = '> STATUS:';
// The banner's only legal position is immediately after the frontmatter block.
const BANNER_SLOT = /^(---\n[\s\S]*?\n---\n)((?:> STATUS:[^\n]*\n\n?)*)/;
const ZONE_MARKERS = Object.freeze({
  mechanical: Object.freeze({ start: '<!-- mechanical -->', end: '<!-- /mechanical -->' }),
  judgment: Object.freeze({ start: '<!-- judgment -->', end: '<!-- /judgment -->' }),
});
const DERIVED_MARKERS = Object.freeze({ start: '<!-- grepsaver:derived -->', end: '<!-- /grepsaver:derived -->' });

function zonePattern(marker) {
  const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc(marker.start)}\\n([\\s\\S]*?)\\n${esc(marker.end)}`, 'g');
}

// Return all named zones. Multiple non-overlapping pairs are intentional: the
// card keeps its human-readable section order while each mechanical/judgment
// section carries an explicit provenance boundary. Missing markers are an
// integrity error, never a reason to guess section boundaries automatically.
function cardZone(cardText, name) {
  const marker = ZONE_MARKERS[name];
  if (!marker) throw new Error(`unknown card zone '${name}'`);
  const matches = [...normalizeText(cardText).matchAll(zonePattern(marker))];
  if (!matches.length) throw new Error(`${name} zone markers are required (found 0)`);
  return {
    matches: matches.map((match) => ({ start: match.index, end: match.index + match[0].length, body: match[1] })),
    start: matches[0].index,
    end: matches[matches.length - 1].index + matches[matches.length - 1][0].length,
    body: matches.map((match) => match[1]).join('\n'),
  };
}

function cardZones(cardText) {
  const normalized = normalizeText(cardText);
  const mechanical = cardZone(normalized, 'mechanical');
  const judgment = cardZone(normalized, 'judgment');
  const ranges = [
    ...mechanical.matches.map((m) => ({ ...m, name: 'mechanical' })),
    ...judgment.matches.map((m) => ({ ...m, name: 'judgment' })),
  ].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i - 1].end > ranges[i].start) throw new Error(`${ranges[i - 1].name} and ${ranges[i].name} zones overlap`);
  }
  return { mechanical, judgment };
}

function canonicalFrontmatter(cardText) {
  const text = normalizeText(cardText);
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('no frontmatter');
  const parsed = {};
  let listKey = null;
  for (const line of match[1].split('\n')) {
    const noComment = line.replace(/\s{2,} #.*$/, '');
    const item = noComment.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { (parsed[listKey] = parsed[listKey] || []).push(item[1].trim()); continue; }
    const kv = noComment.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) {
      if (kv[2] === '') { listKey = kv[1]; parsed[kv[1]] = []; }
      else { parsed[kv[1]] = kv[2].trim(); listKey = null; }
    }
  }
  return parsed;
}

// The source fingerprint, generated/reviewed dates, and the derived mechanical
// block may change without reopening the human judgment review. Stable identity
// and provenance fields remain in the judgment hash so a card cannot silently
// switch systems or fingerprint recipes.
const JUDGMENT_FRONTMATTER_KEYS = Object.freeze([
  'system', 'source_path', 'fingerprint_type', 'manifest', 'wsl_distro', 'wsl_base', 'generator',
]);

function cardMechanicalHash(cardText) {
  const zone = cardZone(cardText, 'mechanical');
  return sha256(normalizeText(zone.body).trim() + '\n');
}

function cardJudgmentHash(cardText) {
  const normalized = normalizeText(cardText).replace(BANNER_SLOT, '$1');
  const zones = cardZone(normalized, 'mechanical');
  let unmechanical = normalized;
  for (const match of zones.matches.slice().sort((a, b) => b.start - a.start)) {
    unmechanical = unmechanical.slice(0, match.start) + unmechanical.slice(match.end);
  }
  const fm = canonicalFrontmatter(normalized);
  const stable = {};
  for (const key of JUDGMENT_FRONTMATTER_KEYS) if (fm[key] !== undefined) stable[key] = fm[key];
  return sha256(JSON.stringify({ frontmatter: stable, judgment: unmechanical.trim() + '\n' }));
}

function cardZoneHashes(cardText) {
  // Validate both markers before returning either hash; callers must never
  // partially trust a card whose provenance boundary is malformed.
  cardZones(cardText);
  return { mechanicalHash: cardMechanicalHash(cardText), judgmentHash: cardJudgmentHash(cardText) };
}

function derivedBlock(cardText) {
  const text = normalizeText(cardText);
  const match = text.match(/<!-- grepsaver:derived -->\n([\s\S]*?)\n<!-- \/grepsaver:derived -->/);
  if (!match) return null;
  const codeStart = match[1].indexOf('```json');
  if (codeStart < 0) return null;
  const jsonStart = codeStart + '```json'.length;
  const codeEnd = match[1].indexOf('```', jsonStart);
  if (codeEnd < 0) return null;
  try { return JSON.parse(match[1].slice(jsonStart, codeEnd).trim()); } catch { return null; }
}

function sanitizeDerived(value) {
  if (typeof value === 'string') return looksSecret(value) ? '[REDACTED - secret-like content]' : value;
  if (Array.isArray(value)) return value.map(sanitizeDerived);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeDerived(item);
    return out;
  }
  return value;
}

function replaceDerivedBlock(cardText, facts) {
  const text = normalizeText(cardText);
  const body = JSON.stringify(sanitizeDerived(mechanicalSnapshot(facts)));
  const block = `${DERIVED_MARKERS.start}\n<!-- provenance: extracted, unexecuted -->\n\`\`\`json\n${body}\n\`\`\`\n${DERIVED_MARKERS.end}`;
  const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc(DERIVED_MARKERS.start)}[\\s\\S]*?${esc(DERIVED_MARKERS.end)}`);
  if (re.test(text)) return text.replace(re, block);
  const marker = ZONE_MARKERS.mechanical;
  const end = text.indexOf(marker.end);
  if (end < 0) throw new Error('mechanical zone markers are required exactly once (derived block insertion)');
  const before = text.slice(0, end);
  const separator = before.endsWith('\n') ? '' : '\n';
  return `${before}${separator}${block}\n${text.slice(end)}`;
}

function cardContentForCap(cardText) {
  return normalizeText(cardText)
    .replace(/<!-- grepsaver:derived -->[\s\S]*?<!-- \/grepsaver:derived -->\n?/g, '')
    .replace(/<!-- \/?(?:mechanical|judgment) -->\n?/g, '');
}

function derivedByteLength(cardText) {
  const match = normalizeText(cardText).match(/<!-- grepsaver:derived -->[\s\S]*?<!-- \/grepsaver:derived -->/);
  return match ? Buffer.byteLength(match[0], 'utf8') : 0;
}

function extractDerivedSemanticFacts(facts) {
  if (facts && facts.semantic) {
    const dirs = Array.isArray(facts.semantic.topLevelDirs) ? facts.semantic.topLevelDirs.slice().sort() : [];
    return {
      ports: Array.isArray(facts.semantic.ports) ? facts.semantic.ports : [],
      commandDigest: facts.semantic.commandDigest || sha256(JSON.stringify(facts.semantic.commands || [])),
      commandCount: Number(facts.semantic.commandCount || (Array.isArray(facts.semantic.commands) ? facts.semantic.commands.length : 0)),
      topLevelDirDigest: facts.semantic.topLevelDirDigest || sha256(JSON.stringify(dirs)),
      topLevelDirCount: Number(facts.semantic.topLevelDirCount || dirs.length),
    };
  }
  const commands = [];
  for (const group of facts && Array.isArray(facts.package_scripts) ? facts.package_scripts : []) {
    for (const [name, command] of Object.entries(group.scripts || {})) {
      // Only lifecycle/build/test entry points are closed semantic triggers.
      // Other package scripts can change freely without reopening a card; they
      // remain visible in the untrusted derived snapshot for human review.
      if (!/^(?:run|build|test|start|dev|serve|check|lint)(?::|$)/i.test(String(name))) continue;
      commands.push({ file: group.file, name, command: String(command) });
    }
  }
  for (const item of facts && Array.isArray(facts.readme_commands) ? facts.readme_commands : []) {
    commands.push({ file: item.provenance || 'README fence', name: 'fence', command: String(item.command || '') });
  }
  const ports = (facts && Array.isArray(facts.servers) ? facts.servers : []).map((s) => ({ name: s.name, port: s.port, url: s.url, workDir: s.workDir })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  const topLevelDirs = (facts && Array.isArray(facts.top_level) ? facts.top_level : []).filter((e) => e.type === 'dir').map((e) => e.name).sort();
  return {
    ports,
    commandDigest: sha256(JSON.stringify(commands.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')))),
    commandCount: commands.length,
    topLevelDirDigest: sha256(JSON.stringify(topLevelDirs)),
    topLevelDirCount: topLevelDirs.length,
  };
}

// Keep the card's derived block compact. Full extractor output remains an
// untrusted read-only result; the card stores only semantic trigger data,
// command digests (never executable command text), and a digest of the full
// extracted packet. This preserves the card cap and avoids a new command-
// injection surface in the human-readable map.
function mechanicalSnapshot(facts) {
  const semantic = extractDerivedSemanticFacts(facts || {});
  return {
    provenance: 'extracted, unexecuted',
    semantic: {
      ports: semantic.ports,
      commandDigest: semantic.commandDigest,
      topLevelDirDigest: semantic.topLevelDirDigest,
    },
  };
}

function semanticDiff(previousFacts, currentFacts) {
  const a = extractDerivedSemanticFacts(previousFacts || {});
  const b = extractDerivedSemanticFacts(currentFacts || {});
  const changed = [];
  if (JSON.stringify(a.ports) !== JSON.stringify(b.ports)) changed.push('ports/services changed');
  if (a.commandDigest !== b.commandDigest) changed.push('run/build/test commands changed');
  if (a.topLevelDirDigest !== b.topLevelDirDigest) changed.push('top-level directories changed');
  return changed;
}

function parseCard(cardPath) {
  const text = normalizeText(fs.readFileSync(cardPath, 'utf8'));
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`no frontmatter in ${cardPath}`);
  const fm = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    // Inline comments require 2+ spaces before '#' (template style), so paths
    // containing ' #' survive.
    const noComment = line.replace(/\s{2,}#.*$/, '');
    const item = noComment.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { (fm[listKey] = fm[listKey] || []).push(item[1].trim()); continue; }
    const kv = noComment.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) {
      if (kv[2] === '') { listKey = kv[1]; fm[kv[1]] = []; }
      else { fm[kv[1]] = kv[2].trim(); listKey = null; }
    }
  }
  const missing = REQUIRED_KEYS.filter((k) => fm[k] === undefined || fm[k] === '');
  if ((fm.fingerprint_type === 'manifest' || fm.fingerprint_type === 'wsl') && (!Array.isArray(fm.manifest) || fm.manifest.length === 0)) {
    missing.push('manifest');
  }
  if (fm.fingerprint_type === 'wsl' && !fm.wsl_distro) missing.push('wsl_distro');
  return { text, frontmatter: fm, missingKeys: missing };
}

// Card-body hash for the trust model: the checker-managed banner is excluded
// so banner churn never changes the reviewed hash; everything a reader trusts
// (frontmatter + body) is covered.
function cardTrustHash(cardText) {
  const stripped = normalizeText(cardText).replace(BANNER_SLOT, '$1');
  return sha256(stripped);
}

function setBanner(cardPath, bannerLine) {
  const text = normalizeText(fs.readFileSync(cardPath, 'utf8'));
  const m = text.match(BANNER_SLOT);
  if (!m) return; // unparsable card — reported as a parse error by the caller
  const rebuilt = m[1] + (bannerLine ? `${bannerLine}\n\n` : '') + text.slice(m[0].length);
  if (rebuilt !== text) atomicWrite(cardPath, rebuilt);
}

function writeCardField(cardPath, key, value) {
  const text = normalizeText(fs.readFileSync(cardPath, 'utf8'));
  const fmMatch = text.match(/^---\n[\s\S]*?\n---\n/);
  if (!fmMatch) throw new Error(`no frontmatter in ${cardPath}`);
  const re = new RegExp(`^(${key}:)[^\n]*$`, 'm');
  if (!re.test(fmMatch[0])) throw new Error(`frontmatter key '${key}' not found in ${cardPath}`);
  const newFm = fmMatch[0].replace(re, (mm, g1) => `${g1} ${value}`); // replacer => value is literal
  atomicWrite(cardPath, newFm + text.slice(fmMatch[0].length));
}

// --- fingerprint recipes (canonical) ---------------------------------------

// git: `git:<HEAD sha>`; dirty recorded separately, never in the comparison.
// Hardened against hostile repo config (fsmonitor/hooks execute code).
function fingerprintGit(sourcePath) {
  const run = (args) => execFileSync('git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=', '-C', sourcePath, ...args],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false, env: safeLaunchEnvironment() }).trim();
  const head = run(['rev-parse', 'HEAD']);
  const dirty = run(['status', '--porcelain']).length > 0;
  return { value: `git:${head}`, dirty };
}

// manifest: SHA-256 over `<relpath>|<size>|<mtime-seconds>` lines, manifest
// entries sorted by relpath BEFORE formatting. A missing entry is reported —
// it must never silently freeze the fingerprint (review finding: a typo'd
// entry would otherwise defeat drift detection forever).
function fingerprintManifest(sourcePath, manifest) {
  const missing = [];
  const lines = manifest.slice().sort().map((rel) => {
    const p = path.join(sourcePath, rel);
    try {
      const st = fs.statSync(p);
      return `${toPosix(rel)}|${st.size}|${Math.floor(st.mtimeMs / 1000)}`;
    } catch {
      missing.push(rel);
      return `${toPosix(rel)}|MISSING`;
    }
  });
  return { value: `manifest-hash:sha256:${sha256(lines.join('\n'))}`, dirty: false, missingEntries: missing };
}

// wsl: content hashes via wsl.exe (immune to 9P mtime weirdness). Optional
// wsl_base anchors relative manifest entries.
// CRITICAL GUARD: `wsl -d <distro> <cmd>` BOOTS a stopped distro. The
// OpenClawGateway distro must never be booted as a side effect of a fingerprint
// check (billing gotcha) — so first consult --list --running and bail to
// UNKNOWN without ever invoking `-d` when the distro is not already up.
function wslDistroRunning(distro) {
  const out = execFileSync('wsl.exe', ['--list', '--running', '--quiet'],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false, env: safeLaunchEnvironment() });
  // wsl.exe emits UTF-16-ish output that lands with NUL bytes when read as utf8
  const names = out.replace(/\0/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return names.includes(distro);
}

function fingerprintWsl(distro, manifest, wslBase) {
  if (!wslDistroRunning(distro)) {
    const err = new Error(`distro ${distro} is not running (deliberately not booted)`);
    err.code = 'WSL_NOT_RUNNING';
    throw err;
  }
  const args = ['-d', distro];
  if (wslBase) args.push('--cd', wslBase);
  args.push('sha256sum', ...manifest);
  const out = execFileSync('wsl.exe', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: safeLaunchEnvironment() });
  const lines = out.trim().split('\n').map((l) => l.trim()).sort();
  return { value: `wsl-hash:sha256:${sha256(lines.join('\n'))}`, dirty: false, missingEntries: [] };
}

// --- registry / index generation (amends §3: SYSTEMS.md and systems.json's
// system LIST, not just their status, become a mechanical function of the
// cards in context/, instead of a human/agent hand-editing both files when a
// system is added. See tools/grepsaver-reindex.js. ---------------------------

// Files in context/ that are hand-authored infrastructure docs, never system
// cards. Shared by the checker (orphan detection) and the reindexer (card
// discovery) so the two can never disagree about what counts as a card --
// previously each script would have needed its own copy of this list, and
// the checker's copy was missing ORIENTATION.md (a real bug this fixes: any
// checker run against a real context/ containing ORIENTATION.md flagged it
// as an "orphan card ... divergence" error, because ORIENTATION.md is
// hand-authored and deliberately has no systems.json entry).
const NON_CARD_FILES = Object.freeze(new Set([
  'SYSTEMS.md', 'CARD-TEMPLATE.md', 'DOCS.md', 'toolsenabled-tools.md', 'ORIENTATION.md',
]));

// Resolve ServerControl/servers.json the same way for every caller (the
// extractor and the reindexer previously each carried their own copy of this
// candidate list, which is exactly the kind of duplication that lets two
// "mechanical" facts silently disagree).
function resolveServersJsonPath() {
  const candidates = [
    process.env.TOOLSENABLED_SERVER_CONTROL_ROOT
      ? path.join(path.resolve(process.env.TOOLSENABLED_SERVER_CONTROL_ROOT), 'servers.json')
      : null,
    path.resolve(__dirname, '..', '..', 'ServerControl', 'servers.json'),
    path.join(os.homedir(), 'OneDrive', 'Desktop', 'ServerControl', 'servers.json'),
    path.join(os.homedir(), 'Desktop', 'ServerControl', 'servers.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.statSync(candidate);
      return candidate;
    } catch (error) {
      // A definitely absent candidate may fall through to the next location.
      // Permission and I/O failures are not evidence that the file is absent.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw new Error(`could not inspect ServerControl servers.json candidate ${candidate}: ${error.message}`, { cause: error });
    }
  }
  return candidates[0];
}

// Ports/services for a system root, cross-referenced from ServerControl's
// authoritative servers.json. Never hand-copied into a card or systems.json;
// every caller re-derives it fresh, so it cannot go stale independently of
// the source it is derived from.
function serverFacts(root, serversJsonPath) {
  const p = serversJsonPath || resolveServersJsonPath();
  let source;
  try {
    source = fs.readFileSync(p, 'utf8');
  } catch (error) {
    /* ABSENCE IS DATA, UNREADABILITY IS NOT -- and this function needed BOTH
     * halves, which is why neither side alone was right. main returned [] for
     * every failure, so an unreadable registry became a confident "this root
     * has no servers". w20 threw for every failure, so a machine that has
     * simply never registered a server -- the ordinary state, no file at all --
     * could no longer produce facts. NO REGISTRY is a measured answer: there
     * are no ServerControl-registered servers. Anything else is unmeasurable. */
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw new Error(`could not read ServerControl registry ${p}: ${error.message}`, { cause: error });
  }
  try {
    const servers = JSON.parse(source.replace(/^﻿/, ''));
    const abs = path.resolve(root).toLowerCase();
    // Boundary-safe prefix match: 'Desktop\Presentation' must not claim a
    // sibling 'Desktop\PresentationOld'.
    const inRoot = (w) => { const r = path.resolve(w).toLowerCase(); return r === abs || r.startsWith(abs + path.sep); };
    return servers
      .filter((s) => s.WorkDir && inRoot(s.WorkDir))
      .map((s) => ({ name: s.Name, port: s.Port, url: s.Url, workDir: s.WorkDir, provenance: 'ServerControl servers.json' }));
  } catch (error) {
    // A registry that EXISTS but does not parse cannot establish that this root
    // has no servers. Refuse instead of returning a confidently empty fact set.
    throw new Error(`could not derive server facts from ${p}: ${error.message}`, { cause: error });
  }
}

// Format an absolute path relative to the current user's home directory
// instead of a hand-picked per-machine base-path legend (the exact fault that
// shipped in context/SYSTEMS.md: a "T=D\<checkout-dir>" legend entry mapping a
// short token to one machine's checkout directory was hardcoded true on the
// machine that wrote it and false on the machine that checked it out, per the
// 2026-08-02 "Stop versioning grepsaver's per-machine output" commit). This
// function has no memory of any machine; it asks the OS at generation time.
function homeRelative(absPath) {
  const home = os.homedir();
  const abs = path.resolve(absPath);
  const rel = path.relative(home, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${toPosix(rel)}`;
  return toPosix(abs);
}

// Deterministic display name: the card's own first H1 heading if present (a
// human already chose it while writing the card, so it survives), else a
// mechanical Title-Cased-From-Id fallback. Never invented prose, so this can
// run unattended.
function deriveSystemName(cardText, id) {
  const body = normalizeText(cardText || '').replace(/^---\n[\s\S]*?\n---\n/, '');
  const heading = body.match(/^#\s+(.+?)\s*$/m);
  if (heading && heading[1].trim()) return heading[1].trim();
  return String(id).split(/[-_]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Content hash of registry membership + identity: which system ids exist,
// where they live, and how each is fingerprinted. Pure function of the cards
// present in context/ -- independent of wall clock and of review state -- so
// it is what "is the INDEX (not just one card) current?" can be answered
// against mechanically. See grepsaver-reindex.js's --check mode.
function registryFingerprint(entries) {
  const canon = entries
    .map((e) => ({
      id: e.id,
      source_path: toPosix(e.path || e.source_path || ''),
      fingerprint_type: e.fingerprint_type || null,
      manifest: Array.isArray(e.manifest) ? e.manifest.slice().sort() : null,
      wsl_distro: e.wsl_distro || null,
      wsl_base: e.wsl_base || null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(JSON.stringify(canon));
}

module.exports = {
  sha256, toPosix, today, normalizeText, looksSecret, atomicWrite,
  REQUIRED_KEYS, BANNER_PREFIX, BANNER_SLOT,
  ZONE_MARKERS, DERIVED_MARKERS, JUDGMENT_FRONTMATTER_KEYS, NON_CARD_FILES,
  parseCard, cardTrustHash, cardZone, cardZones, cardMechanicalHash, cardJudgmentHash, cardZoneHashes,
  derivedBlock, replaceDerivedBlock, cardContentForCap, derivedByteLength, extractDerivedSemanticFacts, mechanicalSnapshot, semanticDiff,
  setBanner, writeCardField,
  fingerprintGit, fingerprintManifest, fingerprintWsl,
  resolveServersJsonPath, serverFacts, homeRelative, deriveSystemName, registryFingerprint,
};
