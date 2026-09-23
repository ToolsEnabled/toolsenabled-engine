'use strict';

// Q46's checker inspects the tree and never writes it. It is still report-only
// in the sense that matters: it changes no source file and moves nothing.
//
// CHANGED 2026-08-09, and this contradicts the sentence that used to be here
// ("never ... changes an exit status because a boundary is found"). That
// sentence described stage 1 of the enforcement ladder in
// docs/PACKAGE-TREE-PLAN.md section 4.3, which reads: report-only, then
// ADVISORY once the roster stabilizes, then blocking after two quiet weeks.
// This change moves the tool to stage 2 and no further -- the exit code now
// tells the truth, and the only caller (.githooks/pre-push) reports it loudly
// WITHOUT blocking a push. Stage 3 remains un-taken.
//
// The reason it could not stay at stage 1: an exit status of 0 alongside 209
// unmapped files and 329 layering violations is not neutrality, it is a false
// statement to every automated caller. That fail-open shape is what let a
// bridge supervisor compute a correct verdict, write it to JSON, and exit 0
// unconditionally for hours.
//
// This is a requirements deviation from Q46 as literally written and was
// escalated as one rather than resolved quietly. If the owner wants stage 1
// restored, revert to `process.exitCode = 0` here -- the verdict function is
// pure and keeps working for every other caller.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  PackageManifestError,
  normalizePackageManifest,
  normalizeRepoRelativePath
} = require('../src/lib/package-manifest-contract');

const REPORT_MODE = 'report-only';

// REPORT_MODE stays 'report-only' because the LIBRARY mutates nothing -- it
// reads a manifest and returns a frozen report. That was never the same claim
// as "this process always succeeds", but until 2026-08-09 the CLI conflated
// them: it printed 207 unmapped files and 329 layering violations and then
// exited 0, so any caller that checked the exit code was told everything was
// fine. Same fail-open shape as the bridge supervisor that computed a correct
// verdict, wrote it to JSON, and exited 0 unconditionally.
//
// The trichotomy deliberately copies tools/check-single-copy-work.js
// (CLEAN/STRANDED/INDETERMINATE) rather than inventing a second vocabulary for
// the same idea: 0 means checked and clean, 1 means checked and bad, 2 means
// the check could not form a trustworthy opinion. Keeping 1 and 2 distinct is
// the point -- "the boundaries are violated" and "I could not read the
// manifest" must never arrive as the same signal.
const EXIT_CODES = Object.freeze({
  CLEAN: 0,
  VIOLATIONS: 1,
  INDETERMINATE: 2
});

const RECORD_FIELDS = new Set(['repositoryFiles', 'requireEdges', 'fileLoc']);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function plainDataObject(value, label) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: label, message: `${label} must be a plain object.` } };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: label, message: `${label} must not inherit a custom prototype.` } };
    }
    const fields = new Map();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: label, message: `${label} must not contain symbol fields.` } };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: `${label}.${key}`, message: `${label}.${key} must be an enumerable data field.` } };
      }
      fields.set(key, descriptor.value);
    }
    return { ok: true, fields };
  } catch {
    return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: label, message: `${label} must expose only safe plain data.` } };
  }
}

function plainDataArray(value, label) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: label, message: `${label} must be a plain array.` } };
    }
    const values = [];
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) {
      return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: label, message: `${label} has an invalid length.` } };
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: `${label}[${index}]`, message: `${label}[${index}] must be an enumerable data value.` } };
      }
      values.push(descriptor.value);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length' || (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length)) continue;
      return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: label, message: `${label} must not contain extra fields.` } };
    }
    return { ok: true, values };
  } catch {
    return { ok: false, issue: { code: 'PACKAGE_CHECK_INVALID_RECORDS', field: label, message: `${label} must expose only safe plain data.` } };
  }
}

function normalizeRepositoryFiles(value) {
  const array = plainDataArray(value, 'records.repositoryFiles');
  if (!array.ok) return { files: [], duplicates: [], issues: [array.issue] };
  const files = new Set();
  const duplicates = new Set();
  const issues = [];
  for (let index = 0; index < array.values.length; index += 1) {
    try {
      const file = normalizeRepoRelativePath(array.values[index], `records.repositoryFiles[${index}]`);
      if (files.has(file)) duplicates.add(file);
      files.add(file);
    } catch (error) {
      issues.push({
        code: error instanceof PackageManifestError ? error.code : 'PACKAGE_CHECK_INVALID_RECORDS',
        field: `records.repositoryFiles[${index}]`,
        message: 'Repository file records must be safe repository-relative JavaScript paths.'
      });
    }
  }
  return { files: [...files].sort(compareText), duplicates: [...duplicates].sort(compareText), issues };
}

function normalizeRequireEdges(value) {
  const array = plainDataArray(value, 'records.requireEdges');
  if (!array.ok) return { edges: [], issues: [array.issue] };
  const edgeKeys = new Set();
  const edges = [];
  const issues = [];
  for (let index = 0; index < array.values.length; index += 1) {
    const entry = plainDataObject(array.values[index], `records.requireEdges[${index}]`);
    if (!entry.ok) {
      issues.push(entry.issue);
      continue;
    }
    const unknown = [...entry.fields.keys()].filter(key => !['from', 'to'].includes(key));
    const missing = ['from', 'to'].filter(key => !entry.fields.has(key));
    if (unknown.length || missing.length) {
      issues.push({
        code: 'PACKAGE_CHECK_INVALID_EDGE',
        field: `records.requireEdges[${index}]`,
        message: 'Require-edge records must contain exactly from and to paths.'
      });
      continue;
    }
    try {
      const from = normalizeRepoRelativePath(entry.fields.get('from'), `records.requireEdges[${index}].from`);
      const to = normalizeRepoRelativePath(entry.fields.get('to'), `records.requireEdges[${index}].to`);
      const key = `${from}\u0000${to}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ from, to });
      }
    } catch (error) {
      issues.push({
        code: error instanceof PackageManifestError ? error.code : 'PACKAGE_CHECK_INVALID_EDGE',
        field: `records.requireEdges[${index}]`,
        message: 'Require-edge endpoints must be safe repository-relative JavaScript paths.'
      });
    }
  }
  edges.sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to));
  return { edges, issues };
}

function normalizeFileLoc(value) {
  const object = plainDataObject(value, 'records.fileLoc');
  if (!object.ok) return { fileLoc: new Map(), issues: [object.issue] };
  const fileLoc = new Map();
  const issues = [];
  for (const [rawFile, rawLoc] of object.fields) {
    try {
      const file = normalizeRepoRelativePath(rawFile, `records.fileLoc.${rawFile}`);
      if (!Number.isSafeInteger(rawLoc) || rawLoc < 0) {
        issues.push({ code: 'PACKAGE_CHECK_INVALID_LOC', field: `records.fileLoc.${rawFile}`, message: 'Line counts must be non-negative safe integers.' });
      } else {
        fileLoc.set(file, rawLoc);
      }
    } catch (error) {
      issues.push({ code: error instanceof PackageManifestError ? error.code : 'PACKAGE_CHECK_INVALID_LOC', field: `records.fileLoc.${rawFile}`, message: 'Line-count keys must be safe repository-relative JavaScript paths.' });
    }
  }
  return { fileLoc, issues };
}

function normalizeRecords(records) {
  const result = {
    repositoryFilesProvided: false,
    repositoryFiles: [],
    duplicateRepositoryFiles: [],
    requireEdgesProvided: false,
    requireEdges: [],
    fileLoc: new Map(),
    invalidRecords: []
  };
  if (records === undefined) return result;
  const recordObject = plainDataObject(records, 'records');
  if (!recordObject.ok) {
    result.invalidRecords.push(recordObject.issue);
    return result;
  }
  const unknown = [...recordObject.fields.keys()].filter(key => !RECORD_FIELDS.has(key));
  if (unknown.length) {
    result.invalidRecords.push({
      code: 'PACKAGE_CHECK_INVALID_RECORDS',
      field: 'records',
      message: `records contains unsupported fields: ${unknown.sort(compareText).join(', ')}.`
    });
  }
  if (recordObject.fields.has('repositoryFiles')) {
    result.repositoryFilesProvided = true;
    const normalized = normalizeRepositoryFiles(recordObject.fields.get('repositoryFiles'));
    result.repositoryFiles = normalized.files;
    result.duplicateRepositoryFiles = normalized.duplicates;
    result.invalidRecords.push(...normalized.issues);
  }
  if (recordObject.fields.has('requireEdges')) {
    result.requireEdgesProvided = true;
    const normalized = normalizeRequireEdges(recordObject.fields.get('requireEdges'));
    result.requireEdges = normalized.edges;
    result.invalidRecords.push(...normalized.issues);
  }
  if (recordObject.fields.has('fileLoc')) {
    const normalized = normalizeFileLoc(recordObject.fields.get('fileLoc'));
    result.fileLoc = normalized.fileLoc;
    result.invalidRecords.push(...normalized.issues);
  }
  return result;
}

function layerForPackage(packageId) {
  const root = packageId.split('.', 1)[0];
  if (root === 'kernel') return 'kernel';
  if (root === 'surface') return 'surface';
  if (root === 'entry') return 'entry';
  return 'domain';
}

function layeringViolation(fromPackage, toPackage) {
  if (fromPackage === toPackage) return null;
  const fromLayer = layerForPackage(fromPackage);
  const toLayer = layerForPackage(toPackage);
  if (fromLayer === 'entry') return null;
  if (toLayer === 'entry') return 'IMPORTS_ENTRYPOINT';
  if (fromLayer === 'kernel' && toLayer !== 'kernel') return 'KERNEL_IMPORTS_UP';
  if (fromLayer === 'surface' && toLayer === 'domain') return 'SURFACE_IMPORTS_DOMAIN';
  if (fromLayer === 'domain' && toLayer === 'domain') return 'SIDEWAYS_DOMAIN_IMPORT';
  return null;
}

function freezeStrings(values) {
  return Object.freeze([...values].sort(compareText));
}

function freezeObjects(values, compare) {
  return Object.freeze([...values].sort(compare).map(value => {
    const copy = { ...value };
    if (Array.isArray(copy.missing)) copy.missing = freezeStrings(copy.missing);
    return Object.freeze(copy);
  }));
}

function makeReport(fields) {
  const invalidClaims = freezeObjects(fields.invalidClaims || [], (left, right) => compareText(left.code, right.code) || compareText(left.message, right.message));
  const invalidRecords = freezeObjects(fields.invalidRecords || [], (left, right) => compareText(left.field, right.field) || compareText(left.code, right.code));
  const unmappedEdges = freezeObjects(fields.unmappedEdges || [], (left, right) => compareText(left.from, right.from) || compareText(left.to, right.to));
  const layeringViolations = freezeObjects(fields.layeringViolations || [], (left, right) => compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.code, right.code));
  return Object.freeze({
    mode: REPORT_MODE,
    manifestValid: fields.manifestValid === true,
    repositoryFilesProvided: fields.repositoryFilesProvided === true,
    requireEdgesProvided: fields.requireEdgesProvided === true,
    summary: Object.freeze({
      claimCount: fields.claimCount || 0,
      repositoryFileCount: fields.repositoryFileCount || 0,
      requireEdgeCount: fields.requireEdgeCount || 0
    }),
    invalidClaims,
    duplicateClaims: freezeStrings(fields.duplicateClaims || []),
    invalidRecords,
    duplicateRepositoryFiles: freezeStrings(fields.duplicateRepositoryFiles || []),
    unmappedFiles: freezeStrings(fields.unmappedFiles || []),
    orphanedClaims: freezeStrings(fields.orphanedClaims || []),
    unmappedEdges,
    layeringViolations
    ,packageMetrics: freezeObjects(fields.packageMetrics || [], (left, right) => compareText(left.id, right.id))
  });
}

function packageMetrics(manifest, edges, fileLoc) {
  const metrics = new Map(manifest.packages.map(entry => [entry.id, {
    id: entry.id,
    fileCount: entry.files.length,
    loc: entry.files.reduce((total, file) => total + (fileLoc.get(file) || 0), 0),
    fanIn: 0,
    fanOut: 0
  }]));
  const byFile = new Map(manifest.claims.map(claim => [claim.file, claim.packageId]));
  const inbound = new Set();
  const outbound = new Set();
  for (const edge of edges) {
    const from = byFile.get(edge.from);
    const to = byFile.get(edge.to);
    if (!from || !to || from === to) continue;
    outbound.add(`${from}\u0000${to}`);
    inbound.add(`${to}\u0000${from}`);
  }
  for (const key of outbound) metrics.get(key.split('\u0000', 1)[0]).fanOut += 1;
  for (const key of inbound) metrics.get(key.split('\u0000', 1)[0]).fanIn += 1;
  return [...metrics.values()];
}

function invalidManifestReport(error) {
  const code = error instanceof PackageManifestError ? error.code : 'PACKAGE_MANIFEST_INVALID';
  const duplicate = error instanceof PackageManifestError && code === 'PACKAGE_MANIFEST_DUPLICATE_CLAIM'
    && typeof error.details.file === 'string' ? [error.details.file] : [];
  return makeReport({
    manifestValid: false,
    invalidClaims: [{
      code,
      message: error instanceof PackageManifestError ? error.message : 'Manifest validation failed before boundary checks could run.'
    }],
    duplicateClaims: duplicate
  });
}

/**
 * Produce a deterministic Q46 boundary report without reading or writing.
 *
 * @param {unknown} manifest Parsed config/packages.json value.
 * @param {{repositoryFiles?: string[], requireEdges?: Array<{from: string, to: string}>}} [records]
 * @returns {Readonly<object>} A report-only result; it never throws for bad input.
 */
function checkPackageManifest(manifest, records) {
  let normalizedManifest;
  try {
    // Validate the manifest before touching injected observations: malformed
    // claims therefore cannot lead to partial coverage or edge conclusions.
    normalizedManifest = normalizePackageManifest(manifest);
  } catch (error) {
    return invalidManifestReport(error);
  }

  const normalizedRecords = normalizeRecords(records);
  const claimsByFile = new Map(normalizedManifest.claims.map(claim => [claim.file, claim.packageId]));
  const repositoryFiles = new Set(normalizedRecords.repositoryFiles);
  const unmappedFiles = normalizedRecords.repositoryFilesProvided
    ? normalizedRecords.repositoryFiles.filter(file => !claimsByFile.has(file)) : [];
  const orphanedClaims = normalizedRecords.repositoryFilesProvided
    ? normalizedManifest.claims.filter(claim => !repositoryFiles.has(claim.file)).map(claim => claim.file) : [];
  const unmappedEdges = [];
  const layeringViolations = [];

  for (const edge of normalizedRecords.requireEdges) {
    const fromPackage = claimsByFile.get(edge.from);
    const toPackage = claimsByFile.get(edge.to);
    if (!fromPackage || !toPackage) {
      const missing = [];
      if (!fromPackage) missing.push('from');
      if (!toPackage) missing.push('to');
      unmappedEdges.push({ from: edge.from, to: edge.to, missing });
      continue;
    }
    const code = layeringViolation(fromPackage, toPackage);
    if (code) layeringViolations.push({ code, from: edge.from, fromPackage, to: edge.to, toPackage });
  }

  return makeReport({
    manifestValid: true,
    repositoryFilesProvided: normalizedRecords.repositoryFilesProvided,
    requireEdgesProvided: normalizedRecords.requireEdgesProvided,
    claimCount: normalizedManifest.claims.length,
    repositoryFileCount: normalizedRecords.repositoryFiles.length,
    requireEdgeCount: normalizedRecords.requireEdges.length,
    invalidRecords: normalizedRecords.invalidRecords,
    duplicateRepositoryFiles: normalizedRecords.duplicateRepositoryFiles,
    unmappedFiles,
    orphanedClaims,
    unmappedEdges,
    layeringViolations,
    packageMetrics: packageMetrics(normalizedManifest, normalizedRecords.requireEdges, normalizedRecords.fileLoc)
  });
}

function formatPackageCheckReport(report) {
  const lines = [
    'Package boundary report (report-only)',
    `manifest: ${report.manifestValid ? 'valid' : 'invalid'}`,
    `claims: ${report.summary.claimCount}; repository files: ${report.summary.repositoryFileCount}; require edges: ${report.summary.requireEdgeCount}`,
    `invalid claims: ${report.invalidClaims.length}; duplicate claims: ${report.duplicateClaims.length}; unmapped files: ${report.unmappedFiles.length}; orphaned claims: ${report.orphanedClaims.length}; layering violations: ${report.layeringViolations.length}`
  ];
  for (const claim of report.invalidClaims) lines.push(`- invalid claim: ${claim.code}: ${claim.message}`);
  for (const record of report.invalidRecords) lines.push(`- invalid record: ${record.code} (${record.field}): ${record.message}`);
  for (const violation of report.layeringViolations) {
    lines.push(`- ${violation.code}: ${violation.fromPackage} (${violation.from}) -> ${violation.toPackage} (${violation.to})`);
  }
  for (const claim of report.duplicateClaims) lines.push(`- duplicate claim: ${claim}`);
  for (const file of report.unmappedFiles) lines.push(`- unmapped file: ${file}`);
  for (const file of report.orphanedClaims) lines.push(`- orphaned claim: ${file}`);
  for (const metric of report.packageMetrics) lines.push(`- package ${metric.id}: files=${metric.fileCount}; loc=${metric.loc}; fan-in=${metric.fanIn}; fan-out=${metric.fanOut}`);
  return lines.join('\n');
}

function walkJavaScriptFiles(rootDirectory) {
  const files = [];
  for (const sourceRoot of ['src', 'tools', 'sidecars']) {
    const absoluteRoot = path.join(rootDirectory, sourceRoot);
    // existsSync collapses both "absent" and "could not stat" to false. Only
    // an actually absent optional source root may be skipped; an inaccessible
    // root must abort collection rather than silently turn a partial scan into
    // a complete-looking file list.
    try {
      fs.statSync(absoluteRoot);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.relative(rootDirectory, absolute).split(path.sep).join('/'));
      }
    };
    walk(absoluteRoot);
  }
  return files.sort(compareText);
}

function resolveRelativeRequire(fromFile, request, sourceFiles) {
  if (!request.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), request));
  const candidates = base.endsWith('.js') ? [base, `${base}/index.js`] : [`${base}.js`, `${base}/index.js`];
  return candidates.find(candidate => sourceFiles.has(candidate)) || null;
}

function collectPackageRecords(rootDirectory) {
  const repositoryFiles = walkJavaScriptFiles(rootDirectory);
  const sourceFiles = new Set(repositoryFiles);
  const requireEdges = [];
  const fileLoc = {};
  for (const file of repositoryFiles) {
    const source = fs.readFileSync(path.join(rootDirectory, file), 'utf8');
    fileLoc[file] = source.length === 0 ? 0 : source.split(/\r?\n/).length;
    const matcher = /\brequire\s*\(\s*(['"])([^'"\\]+)\1\s*\)/g;
    for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
      const resolved = resolveRelativeRequire(file, match[2], sourceFiles);
      if (resolved) requireEdges.push({ from: file, to: resolved });
    }
  }
  return { repositoryFiles, requireEdges, fileLoc };
}

function runPackageCheck({ rootDirectory = path.resolve(__dirname, '..'), manifestPath = path.join(rootDirectory, 'config', 'packages.json') } = {}) {
  const records = collectPackageRecords(rootDirectory);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return makeReport({
      manifestValid: false,
      repositoryFilesProvided: true,
      requireEdgesProvided: true,
      repositoryFileCount: records.repositoryFiles.length,
      requireEdgeCount: records.requireEdges.length,
      invalidClaims: [{ code: 'PACKAGE_MANIFEST_READ_FAILED', message: `Could not read manifest: ${error.code || error.name}.` }]
    });
  }
  return checkPackageManifest(manifest, records);
}

// Counts that constitute known, pre-existing debt. Committed to
// config/package-check-baseline.json so that changing one is a reviewable diff
// in a pull request rather than a quiet edit -- anyone can raise a number, the
// point is that they must be seen doing it.
const BASELINE_FILENAME = path.join('config', 'package-check-baseline.json');
const BASELINE_COUNT_KEYS = Object.freeze([
  'duplicateClaims',
  'duplicateRepositoryFiles',
  'unmappedFiles',
  'orphanedClaims',
  'unmappedEdges',
  'layeringViolations'
]);

function countsFromReport(report) {
  const counts = {};
  for (const key of BASELINE_COUNT_KEYS) counts[key] = report[key].length;
  return counts;
}

function findingIdentity(value) {
  if (Array.isArray(value)) return `[${value.map(findingIdentity).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${findingIdentity(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function findingsFromReport(report) {
  return Object.fromEntries(BASELINE_COUNT_KEYS.map(key => [key,
    [...report[key]].sort((left, right) => compareText(findingIdentity(left), findingIdentity(right)))]));
}

function validFindings(findings, counts) {
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)
    || Object.keys(findings).sort().join(',') !== [...BASELINE_COUNT_KEYS].sort().join(',')) return false;
  return BASELINE_COUNT_KEYS.every(key => Array.isArray(findings[key])
    && findings[key].length === counts[key]
    && findings[key].every(row => typeof row === 'string' || (row && typeof row === 'object' && !Array.isArray(row)))
    && new Set(findings[key].map(findingIdentity)).size === findings[key].length);
}

// A file missing from disk is ambiguous by itself -- git tells us which of two
// very different situations it is:
//  - never tracked at HEAD: this branch predates the ratchet (~30 live
//    worktrees are in this state) or the ratchet was deliberately never wired
//    here. Turning that into a hard failure would break pushes for a
//    condition none of those branches caused, so it stays a known safe state:
//    "no ratchet configured", falling through to the raw verdict below.
//  - tracked at HEAD but absent from the working tree: the file was written
//    and committed at some point on this branch and has since VANISHED --
//    `rm`, a careless `git clean`, or (measured 2026-08-09) a config-integrity
//    test guard that deletes any untracked file it did not expect to see
//    still on disk, colliding with a fresh, not-yet-committed
//    `--write-baseline` write from a concurrent session in the same tree
//    (tests/run-isolated.js `restoreConfigPaths`). That is exactly the
//    vacuous-pass shape this file already refuses elsewhere (see
//    repositoryFilesProvided/requireEdgesProvided below): a ratchet with
//    nothing to compare against must never read as "nothing to compare, so
//    pass". It fails closed as INDETERMINATE, the same as a baseline that
//    exists but will not parse.
// If git itself cannot answer the tracked/untracked question, that is treated
// the same as "will not parse": a broken instrument, not a green light.
function isBaselineTrackedAtHead(rootDirectory) {
  let result;
  try {
    result = spawnSync('git', ['ls-files', '--error-unmatch', '--', BASELINE_FILENAME], {
      cwd: rootDirectory,
      encoding: 'utf8',
      windowsHide: true
    });
  } catch (error) {
    return { ok: false, detail: error.code || error.message };
  }
  if (result.error) return { ok: false, detail: result.error.code || result.error.message };
  // `git ls-files --error-unmatch` exits 0 when the path is in the index and
  // 1 when it is not -- that is the actual git contract for this flag, not a
  // failure to distinguish from other errors. Any other exit status (bad
  // repo, git missing, etc.) is a real "can't tell", so it takes the
  // unreadable branch instead of silently defaulting to "not tracked".
  if (result.status === 0) return { ok: true, tracked: true };
  if (result.status === 1) return { ok: true, tracked: false };
  return { ok: false, detail: `git ls-files exited ${result.status}: ${(result.stderr || '').trim() || 'no stderr'}` };
}

function readBaseline(rootDirectory) {
  const baselinePath = path.join(rootDirectory, BASELINE_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(baselinePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      const tracking = isBaselineTrackedAtHead(rootDirectory);
      if (!tracking.ok) {
        return {
          state: 'unreadable',
          path: baselinePath,
          detail: `file is absent and git could not say whether it should exist (${tracking.detail})`
        };
      }
      if (tracking.tracked) {
        return {
          state: 'missing',
          path: baselinePath,
          detail: 'git tracks this path at the current commit but the working tree does not have it'
        };
      }
      return { state: 'absent', path: baselinePath };
    }
    return { state: 'unreadable', path: baselinePath, detail: error.code || error.name };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { state: 'unreadable', path: baselinePath, detail: `not valid JSON (${error.message})` };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.counts || typeof parsed.counts !== 'object') {
    return { state: 'unreadable', path: baselinePath, detail: 'missing a "counts" object' };
  }
  const counts = {};
  for (const key of BASELINE_COUNT_KEYS) {
    const value = parsed.counts[key];
    if (!Number.isInteger(value) || value < 0) {
      return { state: 'unreadable', path: baselinePath, detail: `counts.${key} must be a non-negative integer` };
    }
    counts[key] = value;
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 2) {
    return { state: 'unreadable', path: baselinePath, detail: 'unsupported baseline schemaVersion' };
  }
  if (parsed.schemaVersion === 2 || Object.hasOwn(parsed, 'findings')) {
    if (!validFindings(parsed.findings, counts)) return { state: 'unreadable', path: baselinePath,
      detail: 'findings must name every recorded finding exactly once and agree with all counts' };
    return { state: 'present', path: baselinePath, counts, findings: parsed.findings };
  }
  // Legacy count-only baselines remain readable while a reviewed migration
  // records their original findings. Every newly written baseline is exact.
  return { state: 'present', path: baselinePath, counts };
}

// The verdict this file already computed correctly, finally expressed as
// something a caller can branch on. Pure and exported so it is testable
// without spawning a process.
//
// The ratchet only ever turns one way. Counts ABOVE baseline are a regression.
// Counts BELOW baseline also fail, deliberately: a baseline that silently
// absorbs improvement stops being a ratchet within a month, because the number
// drifts down invisibly and nothing ever re-pins it. Someone fixing debt is
// asked to commit the smaller number, which is a two-second edit and leaves a
// record of the improvement.
function packageCheckVerdict(report, baseline = null) {
  if (!report || report.manifestValid !== true) {
    return { exitCode: EXIT_CODES.INDETERMINATE, status: 'indeterminate', reason: 'the package manifest did not parse, so no boundary conclusion is possible' };
  }
  if (report.invalidClaims.length || report.invalidRecords.length) {
    return { exitCode: EXIT_CODES.INDETERMINATE, status: 'indeterminate', reason: 'the manifest or the injected records contained invalid entries, so coverage and layering conclusions would be partial' };
  }
  // Fail closed on a vacuous pass. Without observed repository files or require
  // edges there is nothing to violate, and "zero violations" would be a
  // reassuring silence rather than a check -- the precise failure that let a
  // keeper report healthy for hours while its service was down.
  if (report.repositoryFilesProvided !== true || report.requireEdgesProvided !== true) {
    return { exitCode: EXIT_CODES.INDETERMINATE, status: 'indeterminate', reason: 'the repository was not actually scanned (no repository files and/or no require edges were observed), so a clean result would be vacuous' };
  }
  // "Provided" only says the caller supplied an array. An empty array used to
  // satisfy that guard, allowing a collector that found no JavaScript files to
  // compare six zero counts with a zero baseline and exit clean. Require at
  // least one observed file so a zero-item scan is not a definite answer.
  if (!report.summary || !Number.isSafeInteger(report.summary.repositoryFileCount)
    || report.summary.repositoryFileCount < 1) {
    return { exitCode: EXIT_CODES.INDETERMINATE, status: 'indeterminate', reason: 'the repository scan observed zero files, so coverage and layering conclusions would be vacuous' };
  }

  if (baseline && baseline.state === 'unreadable') {
    return {
      exitCode: EXIT_CODES.INDETERMINATE,
      status: 'indeterminate',
      reason: `the committed baseline exists but could not be read (${baseline.detail}), so no ratchet comparison is possible`
    };
  }
  // Fail closed on a vacuous baseline comparison, the same reasoning as the
  // repositoryFilesProvided/requireEdgesProvided guard above. `missing` means
  // git tracks config/package-check-baseline.json at the current commit but
  // it is not on disk right now -- the ratchet used to have something to
  // compare against and no longer does. Silently falling through to the
  // no-baseline raw verdict below would read as "nothing to compare, so
  // pass" whenever the raw counts happened to be clean, which is exactly the
  // false-green shape a vanished baseline must never produce. This never
  // fires for a branch that genuinely predates the ratchet -- see `absent`.
  if (baseline && baseline.state === 'missing') {
    return {
      exitCode: EXIT_CODES.INDETERMINATE,
      status: 'indeterminate',
      reason: `${BASELINE_FILENAME} is committed on this branch but missing from the working tree (${baseline.detail}) -- restore it with \`git checkout -- ${BASELINE_FILENAME}\`, or if the deletion was intentional run \`node tools/package-check.js --write-baseline\` and commit the result; a vanished baseline must never read as a pass`
    };
  }

  const current = countsFromReport(report);
  const describe = keys => keys.map(key => `${key} ${current[key]} vs baseline ${baseline.counts[key]}`).join('; ');

  if (baseline && baseline.state === 'present') {
    if (baseline.findings !== undefined) {
      if (!validFindings(baseline.findings, baseline.counts)) return { exitCode: EXIT_CODES.INDETERMINATE,
        status: 'indeterminate', reason: 'the baseline findings do not agree with their counts' };
      const added = BASELINE_COUNT_KEYS.flatMap(key => {
        const known = new Set(baseline.findings[key].map(findingIdentity));
        return report[key].filter(row => !known.has(findingIdentity(row))).map(row => `${key}: ${findingIdentity(row)}`);
      });
      if (added.length) return { exitCode: EXIT_CODES.VIOLATIONS, status: 'regression',
        reason: `${added.length} new package finding(s), even if totals fell. Fix the new dependency or ownership; do not replace recorded debt. ${added.slice(0, 8).join('; ')}` };
    }
    const exceeded = BASELINE_COUNT_KEYS.filter(key => current[key] > baseline.counts[key]);
    if (exceeded.length) {
      return {
        exitCode: EXIT_CODES.VIOLATIONS,
        status: 'regression',
        reason: `package debt GREW: ${describe(exceeded)}. Map the new files in config/packages.json or route the import through a public API; do not raise the baseline to make this pass.`
      };
    }
    const improved = BASELINE_COUNT_KEYS.filter(key => current[key] < baseline.counts[key]);
    if (improved.length) {
      return {
        exitCode: EXIT_CODES.VIOLATIONS,
        status: 'baseline-stale',
        reason: `you fixed some -- commit the new lower baseline: ${describe(improved)}. Run \`node tools/package-check.js --write-baseline\` and commit ${BASELINE_FILENAME}.`
      };
    }
    const remaining = BASELINE_COUNT_KEYS.filter(key => current[key] > 0);
    if (remaining.length) {
      return {
        exitCode: EXIT_CODES.CLEAN,
        status: 'clean',
        reason: `no regression against the committed baseline (known debt unchanged: ${remaining.map(key => `${current[key]} ${key}`).join('; ')})`
      };
    }
    return { exitCode: EXIT_CODES.CLEAN, status: 'clean', reason: 'baseline is zero and the tree matches it' };
  }

  // `baseline.state === 'absent'` (or no baseline object at all): git has
  // never tracked BASELINE_FILENAME at this commit, i.e. this branch
  // genuinely predates the ratchet. Report the raw verdict. This is the only
  // remaining silent-ish path, and it is deliberately narrow: a baseline that
  // vanished after being tracked takes the `missing` branch above instead.
  const findings = BASELINE_COUNT_KEYS.filter(key => current[key] > 0);
  if (findings.length) {
    return {
      exitCode: EXIT_CODES.VIOLATIONS,
      status: 'violations',
      reason: `${findings.map(key => `${current[key]} ${key}`).join('; ')} (no ${BASELINE_FILENAME} on this branch, so this is the raw count, not a regression)`
    };
  }
  return { exitCode: EXIT_CODES.CLEAN, status: 'clean', reason: 'every repository file is claimed and no edge crosses a package boundary illegally' };
}

module.exports = {
  BASELINE_FILENAME,
  EXIT_CODES,
  REPORT_MODE,
  checkPackageManifest,
  collectPackageRecords,
  formatPackageCheckReport,
  packageCheckVerdict,
  readBaseline,
  runPackageCheck
};

if (require.main === module) {
  const rootDirectory = path.resolve(__dirname, '..');
  const report = runPackageCheck({ rootDirectory });

  if (process.argv.includes('--write-baseline')) {
    // Never turn a failed inspection into a fresh zero baseline. On a partial
    // installation (most importantly, one without config/packages.json),
    // runPackageCheck returns an invalid report whose finding arrays happen to
    // be empty. Writing those counts would falsely certify an unperformed
    // check; if config/ is absent it would instead escape as an ENOENT stack
    // trace. Refuse before either outcome and name the missing precondition.
    if (report.manifestValid !== true || report.invalidClaims.length || report.invalidRecords.length
      || report.repositoryFilesProvided !== true || report.requireEdgesProvided !== true
      || report.summary.repositoryFileCount < 1) {
      const verdict = packageCheckVerdict(report, null);
      process.stdout.write(`${formatPackageCheckReport(report)}\n`);
      process.stdout.write(`\nverdict: ${verdict.status.toUpperCase()} (exit ${verdict.exitCode}) -- ${verdict.reason}\n`);
      process.exitCode = verdict.exitCode;
      return;
    }
    // An explicit update may lower reviewed debt, never absorb a regression.
    // Missing or unreadable committed baselines cannot be replaced with an
    // apparently successful fresh measurement either.
    const baseline = readBaseline(rootDirectory);
    const verdict = packageCheckVerdict(report, baseline);
    if (baseline.state !== 'absent' && !['clean', 'baseline-stale'].includes(verdict.status)) {
      process.stdout.write(`${formatPackageCheckReport(report)}\n`);
      process.stdout.write(`\nverdict: ${verdict.status.toUpperCase()} (exit ${verdict.exitCode}) -- ${verdict.reason}\n`);
      process.stdout.write('The reviewed baseline has NOT been touched. --write-baseline may only lower its counts.\n');
      process.exitCode = verdict.exitCode;
      return;
    }
    const counts = countsFromReport(report);
    const baselinePath = path.join(rootDirectory, BASELINE_FILENAME);
    const payload = {
      schemaVersion: 2,
      comment: 'Known package-boundary findings. Any new finding fails, even when totals fall. Removed findings require a reviewed lower baseline; --write-baseline cannot absorb a regression.',
      recordedAt: new Date().toISOString(),
      counts,
      findings: findingsFromReport(report)
    };
    fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(`wrote ${BASELINE_FILENAME}: ${BASELINE_COUNT_KEYS.map(key => `${key}=${counts[key]}`).join(' ')}\n`);
    process.stdout.write('Commit it so the change is visible in review.\n');
    process.exitCode = EXIT_CODES.CLEAN;
  } else {
    const verdict = packageCheckVerdict(report, readBaseline(rootDirectory));
    process.stdout.write(`${formatPackageCheckReport(report)}\n`);
    // State the verdict in words next to the exit code. A bare non-zero exit
    // from a tool whose header once said "report-only" reads as a crash;
    // naming it stops the next reader from "fixing" the exit code back to 0.
    process.stdout.write(`\nverdict: ${verdict.status.toUpperCase()} (exit ${verdict.exitCode}) -- ${verdict.reason}\n`);
    process.exitCode = verdict.exitCode;
  }
}
