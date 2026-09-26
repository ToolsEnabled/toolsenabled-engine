#!/usr/bin/env node
// GREPSAVER Phase 3 — drift checker for system cards. See GREPSAVER-PLAN.md §5-§6.
//
// Usage:
//   node tools/grepsaver-check.js                       # check all cards
//   node tools/grepsaver-check.js --approve <id> [--note "text"]
//       Record a review: stamp reviewed_on + fingerprint + card-body hash,
//       promote to FRESH. Run ONLY after the card was actually reviewed.
//       Refused when the card has validity errors or an uncomputable fingerprint.
//   node tools/grepsaver-check.js --refresh <id>
//       Rerun the extractor for that system and demote the card to
//       PENDING-REVIEW (clears the reviewed fingerprint/hash). The agent then
//       updates the card; a new --approve re-promotes it.
//   node tools/grepsaver-check.js --auto-refresh
//       Apply only mechanical extractor changes when no closed semantic trigger
//       changed. Judgment zones and identity/provenance remain review-gated.
//   node tools/grepsaver-check.js --dispute <id> [--note "why"]
//       Append a false-STALE disposition to the run log (Phase 4 gate evidence).
//
// Status machine (§5/§6): FRESH only via --approve, with one exception — a
// plain check restores FRESH when BOTH the source fingerprint and the card-body
// hash match the last reviewed values (e.g. a git revert back to reviewed
// bytes). A card whose BODY changed after review demotes to PENDING-REVIEW even
// if the source is unchanged. MISSING = source_path gone. UNKNOWN = fingerprint
// uncomputable (WSL distro down, unparsable card, invalid frontmatter).
// Exit codes: 0 all FRESH, 1 not all FRESH, 2 errors (incl. cap violations,
// index divergence, refused approvals).
//
// Concurrency: a lock file (context/.check.lock, stale after 5 min) makes
// concurrent runs fail fast instead of corrupting state; all writes are atomic
// (temp + rename).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = require('./grepsaver-lib.js');

const CONTEXT_DIR = process.env.TOOLSENABLED_GREPSAVER_CONTEXT || path.join(__dirname, '..', 'context');
const CARD_BYTE_CAP = 6144;       // ~2K tokens at ~3 chars/token (plan §2)
const INDEX_BYTE_CAP = 1600;      // ~500 tokens at the same ~3 chars/token proxy (plan §3)
const LOG_ROTATE_BYTES = 262144;  // rotate check-log.jsonl at 256 KB, keep one generation
const LOCK_STALE_MS = 5 * 60 * 1000;
// Infrastructure docs in context/ that are not system cards (orphan-detection
// skip list). Shared with grepsaver-reindex.js via grepsaver-lib.js so card
// discovery and orphan detection can never disagree about what counts as a
// card (previously this list was a local copy here and was missing
// ORIENTATION.md — see lib.js's comment on NON_CARD_FILES for the bug that
// caused).
const NON_CARD_FILES = lib.NON_CARD_FILES;

function die(msg) { process.stderr.write(`grepsaver-check: ${msg}\n`); process.exit(2); }

// --- lock ------------------------------------------------------------------

function acquireLock(contextDir) {
  const lockPath = path.join(contextDir, '.check.lock');
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (createError) {
    let stale;
    try {
      stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch (statError) {
      // ENOENT can occur when another checker releases the lock between our
      // create and stat. Retry the exclusive create, but never interpret an
      // unreadable/unstatable lock as stale and remove a possibly-live lock.
      if (statError.code === 'ENOENT') {
        try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return () => { try { fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ } }; }
        catch (retryError) { die(`cannot acquire ${lockPath}: ${retryError.message}`); }
      }
      die(`cannot inspect existing lock ${lockPath}: ${statError.message} (initial create failed: ${createError.message})`);
    }
    if (!stale) die(`another checker run holds ${lockPath}; retry shortly (or delete the lock if no run is live)`);
    try { fs.rmSync(lockPath, { force: true }); }
    catch (e) { if (e.code !== 'ENOENT') die(`cannot remove stale lock ${lockPath}: ${e.message}`); }
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); }
    catch (e) { die(`cannot acquire ${lockPath} after removing stale lock: ${e.message}`); }
  }
  return () => { try { fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ } };
}

// --- fingerprint dispatch --------------------------------------------------

function computeFingerprint(fm) {
  try { fs.statSync(fm.source_path); }
  catch (e) {
    if (e.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unknown', note: `source probe failed: ${String(e.message || e).slice(0, 180)}` };
  }
  try {
    if (fm.fingerprint_type === 'git') return { fp: lib.fingerprintGit(fm.source_path) };
    if (fm.fingerprint_type === 'manifest') return { fp: lib.fingerprintManifest(fm.source_path, fm.manifest) };
    if (fm.fingerprint_type === 'wsl') {
      try { return { fp: lib.fingerprintWsl(fm.wsl_distro, fm.manifest, fm.wsl_base) }; }
      catch (e) { return { status: 'unknown', note: `wsl failed: ${String(e.message || e).slice(0, 120)}` }; }
    }
    return { error: `unknown fingerprint_type: ${fm.fingerprint_type}` };
  } catch (e) {
    return { status: 'unknown', note: String(e.message || e).slice(0, 200) };
  }
}

function compactExtractedFacts(sourcePath, raw) {
  const text = (value, max = 1200) => String(value == null ? '' : value).slice(0, max);
  const packageScripts = Array.isArray(raw.package_scripts) ? raw.package_scripts.map((group) => {
    const scripts = Object.fromEntries(Object.entries(group.scripts || {})
      .filter(([name]) => /^(?:run|build|test|start|dev|serve|check|lint)(?::|$)/i.test(String(name)))
      .map(([name, command]) => [text(name, 120), text(command, 360)]));
    return Object.keys(scripts).length ? {
      file: text(group.file, 240),
      name: group.name == null ? null : text(group.name, 240),
      scripts,
      provenance: 'extracted, unexecuted',
    } : null;
  }).filter(Boolean) : [];
  const readmeCommands = Array.isArray(raw.readme_commands) ? raw.readme_commands.map((item) => ({
    command: text(item.command, 360),
    provenance: 'extracted, unexecuted',
  })).slice(0, 20) : [];
  return {
    schemaVersion: 1,
    extractor: 'tools/grepsaver-extract.js',
    source_path: text(sourcePath, 1000),
    git: raw.git ? { isGit: !!raw.git.isGit, head: raw.git.head || null, dirty: !!raw.git.dirty } : null,
    servers: Array.isArray(raw.servers) ? raw.servers.map((s) => ({ name: text(s.name, 160), port: s.port, url: text(s.url, 300), workDir: text(s.workDir, 500), provenance: 'extracted, unexecuted' })).slice(0, 16) : [],
    package_scripts: packageScripts.slice(0, 20),
    readme_commands: readmeCommands,
    // Only directory names participate in the closed semantic trigger; files
    // stay out of the derived snapshot to keep cards under the byte cap.
    top_level: Array.isArray(raw.top_level) ? [...new Set(raw.top_level.filter((e) => e.type === 'dir').map((e) => text(e.name, 160)))].sort().slice(0, 80).map((name) => ({ name, type: 'dir' })) : [],
  };
}

function extractFacts(sourcePath, fingerprintType) {
  // The WSL card uses a deliberate executable sentinel rather than a local
  // directory. Never boot or inspect a stopped distro just to refresh prose.
  if (fingerprintType === 'wsl') return { facts: null, note: 'wsl extractor skipped; fingerprint-only card' };
  try {
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) return { error: `extractor source is not a directory: ${sourcePath}` };
    const output = execFileSync(process.execPath, [path.join(__dirname, 'grepsaver-extract.js'), sourcePath, '--json'], {
      encoding: 'utf8', timeout: 60000, windowsHide: true, shell: false,
    });
    return { facts: lib.mechanicalSnapshot(compactExtractedFacts(sourcePath, JSON.parse(output))) };
  } catch (e) {
    return { error: `extractor failed: ${String(e.message || e).slice(0, 240)}` };
  }
}

function doNotTouchMissing(cardText, sourcePath, fingerprintType) {
  if (fingerprintType === 'wsl') return [];
  let body;
  try { body = lib.cardZone(cardText, 'judgment').body; } catch { return ['do-not-touch zone unavailable']; }
  const section = body.match(/##\s+Do not touch[\s\S]*?(?=\n##\s+|$)/i);
  if (!section) return [];
  const refs = [...section[0].matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  const missing = [];
  for (const raw of refs) {
    const ref = raw.replace(/[.,;:]+$/, '');
    if (!/[\\/]/.test(ref) && !/\.[A-Za-z0-9]{1,8}$/.test(ref)) continue;
    if (/^(?:other repos|git history|the user|none)$/i.test(ref)) continue;
    // Deliberately absent secret/backup/archive globs are valid do-not-touch
    // boundaries, not evidence that the system moved. Concrete source paths
    // still use the trigger below; wildcard paths remain untrusted hints.
    if (/^\.env(?:\.|$)/i.test(ref) || /\.bak$/i.test(ref) || /[{}*]/.test(ref) || /[\\/]$/.test(ref)) continue;
    const wildcard = ref.indexOf('*');
    const lastSep = wildcard >= 0 ? Math.max(ref.lastIndexOf('\\', wildcard), ref.lastIndexOf('/', wildcard)) : -1;
    const base = wildcard >= 0 ? (lastSep >= 0 ? ref.slice(0, lastSep) : ref.slice(0, wildcard)) : ref;
    const candidate = path.isAbsolute(ref) ? ref : path.resolve(sourcePath, ref);
    const probe = wildcard >= 0 ? (path.isAbsolute(base) ? base : path.resolve(sourcePath, base)) : candidate;
    if (!fs.existsSync(probe)) missing.push(ref);
  }
  return missing;
}

function derivedDiff(previousFacts, currentFacts) {
  const previous = previousFacts || {};
  const current = currentFacts || {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  const changed = [];
  for (const key of keys) if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) changed.push(key);
  return {
    changed,
    previousHash: lib.sha256(JSON.stringify(previous)),
    currentHash: lib.sha256(JSON.stringify(current)),
  };
}

function assertSafeAutoWrite(text) {
  const lines = String(text).split('\n');
  const secretLine = lines.find((line) => lib.looksSecret(line));
  if (secretLine) throw new Error('auto-refresh would write secret-like content');
}

// --- index rewrite + divergence (§3) ---------------------------------------

function rewriteSystemsMd(contextDir, statuses, errors) {
  const p = path.join(contextDir, 'SYSTEMS.md');
  if (!fs.existsSync(p)) { errors.push('SYSTEMS.md is missing — index/state divergence'); return; }
  const text = lib.normalizeText(fs.readFileSync(p, 'utf8'));
  const lines = text.split('\n');
  let statusCol = -1;
  let headerCells = 0;
  const seenIds = new Set();
  const out = lines.map((line) => {
    if (!line.startsWith('|')) return line;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] and cells[last] are empty artifacts of the leading/trailing '|'
    if (statusCol === -1 && cells.includes('status')) { statusCol = cells.indexOf('status'); headerCells = cells.length; return line; }
    if (statusCol === -1 || /^-+$/.test(cells[1] || '')) return line;
    const id = cells[1];
    if (!id) return line;
    if (statuses[id] !== undefined) {
      seenIds.add(id);
      if (cells.length !== headerCells) {
        errors.push(`SYSTEMS.md row for '${id}' is malformed (column count differs from header); not rewritten`);
        return line;
      }
      cells[statusCol] = statuses[id];
      return `| ${cells.slice(1, -1).join(' | ')} |`;
    }
    errors.push(`SYSTEMS.md row '${id}' has no systems.json entry — divergence`);
    return line;
  });
  for (const id of Object.keys(statuses)) {
    if (!seenIds.has(id)) errors.push(`system '${id}' has no SYSTEMS.md row — divergence`);
  }
  lib.atomicWrite(p, out.join('\n'));
}

function findOrphanCards(contextDir, knownCards, errors) {
  for (const name of fs.readdirSync(contextDir)) {
    if (!name.endsWith('.md') || NON_CARD_FILES.has(name)) continue;
    if (!knownCards.has(name)) errors.push(`orphan card context/${name} has no systems.json entry — divergence`);
  }
}

// A duplicate registry key silently aliases two systems to one index row.  That
// defeats Grepsaver's core promise: an id must resolve to one unambiguous card.
// Keep this validation local to the checker so every lifecycle mode refuses the
// ambiguity, including --approve.
function findDuplicateRegistryIds(systems) {
  const seen = new Set();
  const duplicates = new Set();
  for (const system of systems) {
    if (seen.has(system.id)) duplicates.add(system.id);
    else seen.add(system.id);
  }
  return duplicates;
}

// --- log -------------------------------------------------------------------

function appendLog(contextDir, entry) {
  const logPath = path.join(contextDir, 'check-log.jsonl');
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_ROTATE_BYTES) {
      fs.renameSync(logPath, `${logPath.slice(0, -6)}.1.jsonl`); // overwrite previous generation
    }
  } catch { /* rotation is best-effort */ }
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// --- main ------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || true) : null; };
  const approveId = flag('--approve');
  const refreshId = flag('--refresh');
  const disputeId = flag('--dispute');
  const autoRefreshFlag = args.includes('--auto-refresh');
  const note = flag('--note');
  for (const [f, v] of [['--approve', approveId], ['--refresh', refreshId], ['--dispute', disputeId]]) {
    if (v === true) die(`${f} needs a system id`);
  }
  if (autoRefreshFlag && (approveId || refreshId || disputeId)) die('--auto-refresh cannot be combined with another lifecycle flag');

  const sysPath = path.join(CONTEXT_DIR, 'systems.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(sysPath, 'utf8')); } catch (e) { die(`cannot read systems.json: ${e.message}`); }
  const ids = new Set(state.systems.map((s) => s.id));
  for (const [f, v] of [['--approve', approveId], ['--refresh', refreshId], ['--dispute', disputeId]]) {
    if (v && !ids.has(v)) die(`${f} ${v}: no such system in systems.json`);
  }

  const release = acquireLock(CONTEXT_DIR);
  // NOTE: process.exit() would skip the finally and leak the lock — use return
  // codes and process.exitCode instead.
  let exitCode = 0;
  try {
    exitCode = runLocked({ state, sysPath, approveId, refreshId, disputeId, autoRefreshFlag, note });
  } finally {
    release();
  }
  process.exitCode = exitCode;
}

function runLocked({ state, sysPath, approveId, refreshId, disputeId, autoRefreshFlag, note }) {
  {
    const errors = [];
    const mdStatuses = {};
    const knownCards = new Set(state.systems.map((s) => path.basename(s.card)));
    const duplicateIds = findDuplicateRegistryIds(state.systems);
    const logEntry = {
      ts: new Date().toISOString(),
      mode: approveId ? `approve:${approveId}` : refreshId ? `refresh:${refreshId}` : disputeId ? `dispute:${disputeId}` : autoRefreshFlag ? 'auto-refresh' : 'check',
      ...(note ? { note } : {}),
      systems: {}, errors,
    };

    if (state.systems.length === 0) errors.push('systems.json contains zero systems — refusing to pass a check that scanned nothing');

    if (disputeId) {
      logEntry.disposition = { system: disputeId, verdict: 'false-stale' };
      appendLog(CONTEXT_DIR, logEntry);
      process.stdout.write(`recorded false-STALE disposition for ${disputeId}\n`);
      return 0;
    }

    for (const sys of state.systems) {
      const cardPath = path.join(CONTEXT_DIR, path.basename(sys.card));
      const cardErrors = [];

      if (duplicateIds.has(sys.id)) {
        cardErrors.push(`duplicate systems.json id '${sys.id}' — routing is ambiguous`);
      }

      let card = null;
      try { card = lib.parseCard(cardPath); } catch (e) { cardErrors.push(e.message); }
      const fm = card ? card.frontmatter : null;
      let zoneHashes = null;
      let currentFacts = null;
      let previousFacts = null;
      let autoRefresh = null;

      if (card && card.missingKeys.length) cardErrors.push(`invalid frontmatter — missing: ${card.missingKeys.join(', ')}`);
      if (card) {
        const bytes = Buffer.byteLength(lib.cardContentForCap(card.text), 'utf8');
        const derivedBytes = lib.derivedByteLength(card.text);
        if (bytes > CARD_BYTE_CAP) cardErrors.push(`card content is ${bytes} B, over the ${CARD_BYTE_CAP} B cap`);
        if (derivedBytes > 2048) cardErrors.push(`derived extractor block is ${derivedBytes} B, over the 2048 B cap`);
        if (fm.system && fm.system !== sys.id) cardErrors.push(`card frontmatter system '${fm.system}' != systems.json id '${sys.id}'`);
        if (fm.source_path && lib.toPosix(fm.source_path).toLowerCase() !== lib.toPosix(sys.path).toLowerCase()) {
          cardErrors.push(`card source_path disagrees with systems.json path — divergence`);
        }
        if (lib.toPosix(sys.card) !== `context/${sys.id}.md`) cardErrors.push(`systems.json card path '${sys.card}' violates the context/<id>.md rule`);
        for (const line of card.text.split('\n')) {
          if (lib.looksSecret(line)) { cardErrors.push('card contains secret-like content — remove it'); break; }
        }
      }

      if (card) {
        try { zoneHashes = lib.cardZoneHashes(card.text); }
        catch (e) { cardErrors.push(`card zone provenance invalid - ${e.message}`); }
      }

      let status;
      let result = null;
      if (!card) {
        status = 'unknown';
      } else {
        result = computeFingerprint(fm);
        if (result.error) { cardErrors.push(result.error); status = 'unknown'; }
        else if (result.status) { status = result.status; }
        else {
          const fp = result.fp;
          if (fp.missingEntries && fp.missingEntries.length) {
            cardErrors.push(`manifest entries do not resolve: ${fp.missingEntries.join(', ')} — fingerprint would freeze; fix the manifest`);
          }
          sys.fingerprint = sys.fingerprint || {};
          sys.fingerprint.value = fp.value;
          sys.fingerprint.captured_at = lib.today();
          delete sys.fingerprint.note; // stale hand-written notes cleared once a value is computed
          if (fp.dirty !== undefined) sys.fingerprint.dirty = fp.dirty;

          const extracted = zoneHashes ? extractFacts(fm.source_path, fm.fingerprint_type) : { facts: null };
          if (extracted.error && fm.fingerprint_type !== 'wsl') cardErrors.push(extracted.error);
          currentFacts = extracted.facts;
          previousFacts = lib.derivedBlock(card.text) || sys.mechanical_snapshot || null;
          const missingDoNotTouch = doNotTouchMissing(card.text, fm.source_path, fm.fingerprint_type);
          if (missingDoNotTouch.length) cardErrors.push(`do-not-touch paths no longer resolve: ${missingDoNotTouch.join(', ')}`);
          const semanticChanges = previousFacts && currentFacts ? lib.semanticDiff(previousFacts, currentFacts) : [];
          if (semanticChanges.length && !approveId && !refreshId) cardErrors.push(`semantic trigger: ${semanticChanges.join('; ')}`);

          if (approveId === sys.id) {
            if (cardErrors.length) {
              cardErrors.push(`REFUSED --approve: fix the errors above first`);
              status = 'pending-review';
            } else {
              try {
                if (currentFacts && lib.derivedBlock(card.text)) {
                  const replaced = lib.replaceDerivedBlock(card.text, currentFacts);
                  assertSafeAutoWrite(replaced);
                  if (replaced !== card.text) lib.atomicWrite(cardPath, replaced);
                }
                lib.writeCardField(cardPath, 'reviewed_on', lib.today());
                lib.writeCardField(cardPath, 'fingerprint', fp.value);
                card = lib.parseCard(cardPath);
                zoneHashes = lib.cardZoneHashes(card.text);
                sys.reviewed_fingerprint = fp.value;
                sys.reviewed_card_hash = lib.cardTrustHash(card.text);
                sys.reviewed_mechanical_hash = zoneHashes.mechanicalHash;
                sys.reviewed_judgment_hash = zoneHashes.judgmentHash;
                sys.mechanical_snapshot = currentFacts ? lib.mechanicalSnapshot(currentFacts) : undefined;
                status = 'fresh';
              } catch (e) {
                cardErrors.push(`approve write failed (${e.code || e.message}) — card unchanged, retry`);
                status = 'pending-review';
              }
            }
          } else if (refreshId === sys.id) {
            delete sys.reviewed_fingerprint;
            delete sys.reviewed_card_hash;
            delete sys.reviewed_mechanical_hash;
            delete sys.reviewed_judgment_hash;
            delete sys.mechanical_snapshot;
            status = 'pending-review';
          } else {
            const reviewed = fm.reviewed_on && fm.reviewed_on !== 'PENDING' && fm.reviewed_on >= (fm.generated || '');
            const judgmentHashOk = sys.reviewed_judgment_hash ? zoneHashes && zoneHashes.judgmentHash === sys.reviewed_judgment_hash : false;
            const mechanicalHashOk = sys.reviewed_mechanical_hash ? zoneHashes && zoneHashes.mechanicalHash === sys.reviewed_mechanical_hash : false;
            if (!reviewed || !sys.reviewed_fingerprint || !judgmentHashOk) status = 'pending-review';
            else if (fp.value === sys.reviewed_fingerprint && mechanicalHashOk && !missingDoNotTouch.length && !semanticChanges.length) status = 'fresh';
            else if (fp.value === sys.reviewed_fingerprint) status = 'pending-review';
            else if (!autoRefreshFlag) status = 'stale';
            else if (!mechanicalHashOk) status = 'pending-review';
            else if (semanticChanges.length || missingDoNotTouch.length || !currentFacts || !previousFacts) status = 'pending-review';
            else {
              try {
                const before = card.text;
                const replaced = lib.derivedBlock(before) ? lib.replaceDerivedBlock(before, currentFacts) : before;
                assertSafeAutoWrite(replaced);
                if (replaced !== before) lib.atomicWrite(cardPath, replaced);
                lib.writeCardField(cardPath, 'fingerprint', fp.value);
                card = lib.parseCard(cardPath);
                zoneHashes = lib.cardZoneHashes(card.text);
                sys.reviewed_fingerprint = fp.value;
                sys.reviewed_card_hash = lib.cardTrustHash(card.text);
                sys.reviewed_mechanical_hash = zoneHashes.mechanicalHash;
                sys.reviewed_judgment_hash = zoneHashes.judgmentHash;
                sys.mechanical_snapshot = lib.mechanicalSnapshot(currentFacts);
                status = 'fresh';
                autoRefresh = {
                  applied: true,
                  diff: derivedDiff(previousFacts, currentFacts),
                  sourceFingerprintChanged: true,
                };
              } catch (e) {
                cardErrors.push(`mechanical auto-refresh failed (${e.code || e.message}) - card unchanged, review required`);
                status = 'pending-review';
              }
            }
          }
        }
      }
      if (card && !zoneHashes) status = 'unknown';
      if (approveId === sys.id && status !== 'fresh') {
        cardErrors.push(`REFUSED --approve: card is ${status}${result && result.note ? ' (' + result.note + ')' : ''} — cannot promote`);
      }

      // stale_since persistence (§3/§6 'STALE since <date>')
      if (status === 'stale') { if (sys.status !== 'stale' || !sys.stale_since) sys.stale_since = lib.today(); }
      else delete sys.stale_since;
      sys.status = status;

      const dirtyMark = sys.fingerprint && sys.fingerprint.dirty ? '*' : '';
      mdStatuses[sys.id] = status === 'stale'
        ? `STALE since ${sys.stale_since}`
        : `${status.toUpperCase()}${dirtyMark} ${lib.today()}`;
      logEntry.systems[sys.id] = { status, fingerprint: sys.fingerprint ? sys.fingerprint.value : null, dirty: sys.fingerprint ? !!sys.fingerprint.dirty : undefined, cardErrors: cardErrors.length ? cardErrors : undefined, ...(autoRefresh ? { autoRefresh } : {}) };
      errors.push(...cardErrors.map((e) => `${sys.id}: ${e}`));

      // banner (§6): every non-FRESH status is visible inside the card itself.
      // A transient write failure records an error; it must not kill the run.
      if (card) {
        try {
          if (status === 'fresh') lib.setBanner(cardPath, null);
          else if (status === 'stale') lib.setBanner(cardPath, `${lib.BANNER_PREFIX} STALE since ${sys.stale_since} — source drifted from the reviewed state; treat every claim below as a hint only.`);
          else if (status === 'missing') lib.setBanner(cardPath, `${lib.BANNER_PREFIX} MISSING — source_path does not resolve; the system may have moved; do not trust the paths below.`);
          else if (status === 'unknown') lib.setBanner(cardPath, `${lib.BANNER_PREFIX} UNKNOWN since ${lib.today()} — fingerprint currently uncomputable${result && result.note ? ' (' + result.note + ')' : ''}; verify by reading the real files.`);
          else lib.setBanner(cardPath, `${lib.BANNER_PREFIX} PENDING-REVIEW — not yet trusted; a review pass (then --approve ${sys.id}) promotes it to FRESH.`);
        } catch (e) {
          errors.push(`${sys.id}: banner write failed (${e.code || e.message})`);
        }
      }
      // path canonicalization on write (§3): forward slashes in machine fields
      sys.path = lib.toPosix(sys.path);
      sys.card = lib.toPosix(sys.card);
    }

    findOrphanCards(CONTEXT_DIR, knownCards, errors);
    rewriteSystemsMd(CONTEXT_DIR, mdStatuses, errors);
    const idxPath = path.join(CONTEXT_DIR, 'SYSTEMS.md');
    try {
      const indexBytes = fs.statSync(idxPath).size;
      if (indexBytes > INDEX_BYTE_CAP) errors.push(`SYSTEMS.md is ${indexBytes} B, over the ${INDEX_BYTE_CAP} B cap`);
    } catch (e) {
      errors.push(`cannot measure SYSTEMS.md byte cap: ${e.message}`);
    }

    state.generated = lib.today();
    lib.atomicWrite(sysPath, JSON.stringify(state, null, 2) + '\n');
    appendLog(CONTEXT_DIR, logEntry);

    if (refreshId) {
      const sys = state.systems.find((s) => s.id === refreshId);
      process.stdout.write(`--- extractor output for ${refreshId} (update the card, then --approve) ---\n`);
      try {
        process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, 'grepsaver-extract.js'), sys.path], { encoding: 'utf8', timeout: 60000, windowsHide: true, shell: false }));
      } catch (e) { process.stderr.write(`extractor failed: ${e.message}\n`); }
    }

    process.stdout.write(state.systems.map((s) => `${s.id}: ${s.status}${s.fingerprint && s.fingerprint.dirty ? ' (dirty tree)' : ''}`).join('\n') + '\n');
    errors.forEach((e) => process.stderr.write(`ERROR: ${e}\n`));
    const allFresh = state.systems.every((s) => s.status === 'fresh');
    return errors.length ? 2 : allFresh ? 0 : 1;
  }
}

main();
