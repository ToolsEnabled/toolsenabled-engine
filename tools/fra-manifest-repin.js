#!/usr/bin/env node
'use strict';

// Re-pin the FRA capability manifests' `registryNameDigest` -- as an INFORMED
// authorization, not a rubber stamp.
//
// WHY THE DIGEST EXISTS. config/fra-capability-manifest.<machine>.json names
// 37 exact tools FRA may reach and 13 it may never reach. It also pins a
// SHA-256 over the sorted names of the WHOLE tool registry. That second pin is
// not redundant: without it, adding a tool to the product could quietly change
// what "the registry" means underneath a manifest that still looks correct, and
// nobody reviewing the manifest would see it. The digest makes any registry
// change a stop-the-world event for FRA.
//
// WHICH IS EXACTLY WHY RE-PINNING IT BY HAND IS THE DANGEROUS MOVE. The digest
// is a one-way hash of a name list, so "just recompute it" throws away the only
// thing it was protecting: the delta. This tool refuses to do that. It
// RECOVERS the pinned name list first, prints the exact tools added and removed
// since, and only then -- with the operator naming the digest they reviewed --
// writes.
//
// HOW THE BASELINE IS RECOVERED. You cannot invert SHA-256, so the pinned list
// is found rather than derived: walk the git history of src/lib/tool-registry.js,
// extract each revision's tool names statically, hash them, and stop at the
// revision whose hash EQUALS the pinned digest. That equality is proof, not
// inference -- if the extraction were wrong by a single name the digest would
// not match. The extractor is additionally proved against the working tree
// before any history is scanned: it must reproduce, exactly, the name set that
// the live registry module actually exports. If it cannot, this tool refuses
// rather than diff against a list it guessed at.
//
// WHAT IT WILL NOT DO. It never edits allowedTools or excludedTools. It refuses
// to write if a tool named in either set disappeared from the registry, because
// that is a capability change wearing a digest change's clothes, and it belongs
// in front of a human.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { machineAddressPolicy } = require(path.join(ROOT, 'src', 'lib', 'service-registry.js'));
const {
  MANIFEST_BASENAME, resolveManifestPath, validateDeclaration
} = require(path.join(ROOT, 'src', 'lib', 'fra-capability-manifest.js'));
const { assertFilenameSafeMachineId } = require(path.join(ROOT, 'src', 'lib', 'fra-machine-identity.js'));

const REGISTRY_SOURCE = 'src/lib/tool-registry.js';
const DIGEST_RE = /^[a-f0-9]{64}$/;
const NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
// The one registration form in tool-registry.js. Proved sufficient against the
// live module before use; see extractorSelfCheck().
const DEFINE_RE = /\bdefine\(\s*'([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+)'/g;
const HISTORY_LIMIT = 200;

class RepinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RepinError';
    this.code = code;
  }
}

function fail(code, message) { throw new RepinError(code, message); }

function digestOfNames(names) {
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !NAME_RE.test(name))) {
    fail('FRA_REPIN_NAMES_INVALID', 'A registry name list contained something that is not a tool name.');
  }
  return crypto.createHash('sha256').update([...names].sort().join('\n'), 'utf8').digest('hex');
}

function extractNames(source) {
  const found = new Set();
  DEFINE_RE.lastIndex = 0;
  let match;
  while ((match = DEFINE_RE.exec(source)) !== null) found.add(match[1]);
  return [...found].sort();
}

function liveRegistryNames() {
  const { TOOL_REGISTRY } = require(path.join(ROOT, 'src', 'lib', 'tool-registry.js'));
  if (!Array.isArray(TOOL_REGISTRY) || TOOL_REGISTRY.length === 0) {
    fail('FRA_REPIN_REGISTRY_UNREADABLE', 'The tool registry did not load as a non-empty array.');
  }
  return TOOL_REGISTRY.map(entry => entry && entry.name).sort();
}

// The extractor is only trustworthy on historical revisions if it is exactly
// right on this one. Any disagreement -- a name it misses, a name it invents --
// and every diff it produces would be a guess.
function extractorSelfCheck(live) {
  const extracted = extractNames(fs.readFileSync(path.join(ROOT, REGISTRY_SOURCE), 'utf8'));
  const missed = live.filter(name => !extracted.includes(name));
  const invented = extracted.filter(name => !live.includes(name));
  if (missed.length || invented.length) {
    fail('FRA_REPIN_EXTRACTOR_UNTRUSTWORTHY',
      `The static registry-name extractor does not reproduce the live registry `
      + `(${missed.length} missed, ${invented.length} invented); refusing to diff against a guessed list.`);
  }
  return extracted.length;
}

function gitRevisions() {
  try {
    return execFileSync('git', ['log', '--format=%H', `-${HISTORY_LIMIT}`, '--', REGISTRY_SOURCE],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24, windowsHide: true })
      .split('\n').map(line => line.trim()).filter(Boolean);
  } catch (error) {
    fail('FRA_REPIN_HISTORY_UNAVAILABLE',
      `The git history of ${REGISTRY_SOURCE} could not be read: ${(error && error.code) || 'unknown error'}.`);
  }
}

function revisionNames(revision) {
  try {
    return extractNames(execFileSync('git', ['show', `${revision}:${REGISTRY_SOURCE}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true }));
  } catch (error) {
    fail('FRA_REPIN_REVISION_UNAVAILABLE',
      `The registry at revision ${revision} could not be read: ${(error && error.code) || 'unknown error'}.`);
  }
}

/** Find the revision whose registry name list hashes to `pinned`. */
function recoverBaseline(pinned, { revisions = gitRevisions(), readRevision = revisionNames } = {}) {
  for (const revision of revisions) {
    const names = readRevision(revision);
    if (digestOfNames(names) === pinned) {
      return Object.freeze({ revision, names: Object.freeze(names), scanned: revisions.length });
    }
  }
  return null;
}

function readManifestText(file) {
  const bytes = fs.readFileSync(file);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    // A BOM here is not cosmetic: these files are byte-hashed into the FRA
    // runtime anchor, and a BOM added by a well-meaning editor has already
    // broken this lane once on the other tree.
    fail('FRA_REPIN_MANIFEST_BOM', `${file} starts with a UTF-8 BOM; refusing to touch a byte-anchored file in that state.`);
  }
  return bytes.toString('utf8');
}

function machineTargets(serviceRegistryOptions = {}, { root = ROOT, fsApi } = {}) {
  return machineAddressPolicy(serviceRegistryOptions).entries.map(entry => {
    const machineId = assertFilenameSafeMachineId(entry.machineId);
    const resolved = resolveManifestPath(machineId, serviceRegistryOptions, {
      root,
      ...(fsApi ? { fsApi } : {})
    });
    return Object.freeze({ machineId, address: entry.address, file: resolved.path, keying: resolved.keying });
  });
}

function analyse({ serviceRegistryOptions = {}, manifestRoot = ROOT, fsApi } = {}) {
  const live = liveRegistryNames();
  const extractedCount = extractorSelfCheck(live);
  const current = digestOfNames(live);
  const targets = machineTargets(serviceRegistryOptions, { root: manifestRoot, fsApi });
  if (targets.length === 0) fail('FRA_REPIN_NO_TARGETS', 'The service registry declares no machines to re-pin.');

  const baselineCache = new Map();
  const manifests = targets.map(target => {
    const text = readManifestText(target.file);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { fail('FRA_REPIN_MANIFEST_INVALID', `${target.file} is not valid JSON.`); }
    const declaration = validateDeclaration(parsed);
    const pinned = declaration.registryNameDigest;
    const state = pinned === current ? 'current' : 'stale';
    let baseline = null;
    if (state === 'stale') {
      if (!baselineCache.has(pinned)) baselineCache.set(pinned, recoverBaseline(pinned));
      baseline = baselineCache.get(pinned);
    }
    const baselineNames = baseline ? baseline.names : null;
    const added = baselineNames ? live.filter(name => !baselineNames.includes(name)) : null;
    const removed = baselineNames ? baselineNames.filter(name => !live.includes(name)) : null;
    const pinnedSurface = [...declaration.allowedTools, ...declaration.excludedTools];
    return Object.freeze({
      ...target,
      text,
      pinned,
      state,
      baselineRevision: baseline ? baseline.revision : null,
      baselineCount: baselineNames ? baselineNames.length : null,
      added: added ? Object.freeze(added) : null,
      removed: removed ? Object.freeze(removed) : null,
      // The safety question the digest exists to answer: did anything FRA
      // actually names stop existing, or start existing, underneath the pin?
      removedFromPinnedSurface: removed
        ? Object.freeze(removed.filter(name => pinnedSurface.includes(name)))
        : null,
      addedIntoPinnedSurface: added
        ? Object.freeze(added.filter(name => pinnedSurface.includes(name)))
        : null,
      allowedToolCount: declaration.allowedToolCount,
      excludedToolCount: declaration.excludedTools.length
    });
  });

  return Object.freeze({
    currentRegistryDigest: current,
    currentRegistryCount: live.length,
    extractedCount,
    manifests: Object.freeze(manifests)
  });
}

function renderReport(report) {
  const lines = [];
  lines.push(`FRA capability-manifest registry pin`);
  lines.push(``);
  lines.push(`  live registry            ${report.currentRegistryCount} tools`);
  lines.push(`  live registry digest     ${report.currentRegistryDigest}`);
  lines.push(``);
  for (const manifest of report.manifests) {
    lines.push(`  ${manifest.machineId}  (${manifest.address})  ${path.relative(ROOT, manifest.file).replace(/\\/g, '/')}`);
    lines.push(`      pinned digest        ${manifest.pinned}`);
    lines.push(`      state                ${manifest.state.toUpperCase()}`);
    lines.push(`      FRA surface          ${manifest.allowedToolCount} allowed / ${manifest.excludedToolCount} excluded (unchanged by a re-pin)`);
    if (manifest.state === 'stale') {
      if (!manifest.baselineRevision) {
        lines.push(`      baseline             NOT FOUND in the last ${HISTORY_LIMIT} revisions of ${REGISTRY_SOURCE}`);
        lines.push(`      -> refusing: without the pinned name list there is no delta to review, and a`);
        lines.push(`         re-pin would be exactly the rubber stamp this digest exists to prevent.`);
      } else {
        lines.push(`      baseline revision    ${manifest.baselineRevision}  (${manifest.baselineCount} tools; digest match is proof, not inference)`);
        lines.push(`      ADDED   (${manifest.added.length})${manifest.added.length ? '' : '  (none)'}`);
        for (const name of manifest.added) lines.push(`          + ${name}`);
        lines.push(`      REMOVED (${manifest.removed.length})${manifest.removed.length ? '' : '  (none)'}`);
        for (const name of manifest.removed) lines.push(`          - ${name}`);
        lines.push(`      of those, named in this manifest's allowed/excluded sets:`);
        lines.push(`          removed: ${manifest.removedFromPinnedSurface.length ? manifest.removedFromPinnedSurface.join(', ') : 'none'}`);
        lines.push(`          added:   ${manifest.addedIntoPinnedSurface.length ? manifest.addedIntoPinnedSurface.join(', ') : 'none'}`);
        if (manifest.removedFromPinnedSurface.length) {
          lines.push(`      -> refusing: a tool this manifest names no longer exists. That is a capability`);
          lines.push(`         change, not a pin refresh, and it needs a human before FRA runs again.`);
        }
      }
    }
    lines.push(``);
  }
  return lines.join('\n');
}

function writable(report) {
  const stale = report.manifests.filter(manifest => manifest.state === 'stale');
  if (stale.length === 0) return { ok: false, code: 'FRA_REPIN_NOTHING_TO_DO', reason: 'Every manifest already pins the live registry.' };
  const unresolved = stale.filter(manifest => !manifest.baselineRevision);
  if (unresolved.length) {
    return {
      ok: false, code: 'FRA_REPIN_BASELINE_NOT_FOUND',
      reason: `The pinned registry name list could not be recovered for: ${unresolved.map(m => m.machineId).join(', ')}. `
        + 'Re-pinning without the delta is the rubber stamp this tool exists to refuse.'
    };
  }
  const breaking = stale.filter(manifest => manifest.removedFromPinnedSurface.length);
  if (breaking.length) {
    return {
      ok: false, code: 'FRA_REPIN_SURFACE_TOOL_REMOVED',
      reason: `Tools named by the manifest no longer exist in the registry: `
        + breaking.map(m => `${m.machineId} -> ${m.removedFromPinnedSurface.join(', ')}`).join('; ')
        + '. Fix the capability set deliberately; this tool will not paper over it.'
    };
  }
  return { ok: true, stale };
}

function repinFile(manifest, digest) {
  const pattern = new RegExp(`("registryNameDigest"\\s*:\\s*")${manifest.pinned}(")`);
  if (!pattern.test(manifest.text)) {
    fail('FRA_REPIN_DIGEST_NOT_FOUND', `${manifest.file} does not contain its own pinned digest as literal text.`);
  }
  const updated = manifest.text.replace(pattern, `$1${digest}$2`);
  // Byte-for-byte identical except the 64 hex characters: these files are
  // hashed into the runtime anchor, so an incidental reformat is a real change.
  if (updated.length !== manifest.text.length) {
    fail('FRA_REPIN_WRITE_UNSAFE', 'The re-pin changed more than the digest characters.');
  }
  const reparsed = JSON.parse(updated);
  if (reparsed.registryNameDigest !== digest) fail('FRA_REPIN_WRITE_UNSAFE', 'The re-pinned digest did not survive a reparse.');
  validateDeclaration(reparsed);
  if (`${JSON.stringify(reparsed, null, 2)}\n` !== updated) {
    fail('FRA_REPIN_WRITE_UNSAFE', 'The re-pinned file is no longer canonical 2-space JSON with a trailing newline.');
  }
  const temporary = `${manifest.file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, updated, 'utf8');
  fs.renameSync(temporary, manifest.file);
  return updated;
}

function parseCli(argv) {
  const values = { mode: 'check', acknowledge: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check' || flag === '--write') values.mode = flag.slice(2);
    else if (flag === '--acknowledge-registry-digest') {
      values.acknowledge = argv[++index] || null;
    } else if (flag === '--json') values.json = true;
    else fail('FRA_REPIN_CLI_INVALID', `Unsupported option "${flag}".`);
  }
  if (values.mode === 'write' && (!values.acknowledge || !DIGEST_RE.test(values.acknowledge))) {
    fail('FRA_REPIN_CLI_INVALID',
      '--write requires --acknowledge-registry-digest <sha256>: state the digest you reviewed, so a re-pin '
      + 'is an authorization of a specific reviewed delta rather than "make the error go away".');
  }
  return values;
}

function main(argv) {
  const values = parseCli(argv);
  const report = analyse();
  if (values.json) process.stdout.write(`${JSON.stringify(report, (key, value) => (key === 'text' ? undefined : value), 2)}\n`);
  else process.stdout.write(`${renderReport(report)}\n`);

  if (values.mode === 'check') {
    const stale = report.manifests.filter(manifest => manifest.state === 'stale');
    return stale.length === 0 ? 0 : 2;
  }

  if (values.acknowledge !== report.currentRegistryDigest) {
    fail('FRA_REPIN_ACKNOWLEDGEMENT_MISMATCH',
      `--acknowledge-registry-digest does not match the live registry digest (${report.currentRegistryDigest}). `
      + 'Re-read the delta above and acknowledge the digest you actually reviewed.');
  }
  const decision = writable(report);
  if (!decision.ok) fail(decision.code, decision.reason);
  const written = [];
  for (const manifest of decision.stale) {
    repinFile(manifest, report.currentRegistryDigest);
    written.push(path.relative(ROOT, manifest.file).replace(/\\/g, '/'));
  }
  const after = analyse();
  if (after.manifests.some(manifest => manifest.state !== 'current')) {
    fail('FRA_REPIN_VERIFY_FAILED', 'A manifest is still stale after the re-pin.');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true, repinned: written, registryNameDigest: report.currentRegistryDigest,
    registryToolCount: report.currentRegistryCount, secretValuesEmitted: false
  })}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'FRA_REPIN_FAILED';
    process.stderr.write(`${code}: ${(error && error.message) || 'the re-pin failed'}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  MANIFEST_BASENAME,
  RepinError,
  extractNames,
  extractorSelfCheck,
  digestOfNames,
  recoverBaseline,
  analyse,
  renderReport,
  writable,
  parseCli,
  main
});
