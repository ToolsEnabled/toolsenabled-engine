'use strict';

// Pure, reversible core for Q50's queue migration.  It deliberately requires
// an explicit phase-to-package assignment: package ownership must never be
// inferred from a title, filename, or prose in BUILD-QUEUE.md.

const crypto = require('node:crypto');
const {
  BuildQueueSliceError,
  generatePackageQueueSlices,
  parseQueueBlocks
} = require('./build-queue-slice');
const {
  parseQueueIndex,
  removeQueueIndex,
  renderQueueIndex
} = require('./build-queue-corpus');

const PACKAGE_ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MARKER_RE = /^<!-- build-queue-slice:v1 phase=(Q[1-9]\d{0,2}) package=([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*) -->(?:\r?\n|$)/gm;

function migrationError(code, message) {
  throw new BuildQueueSliceError(code, message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function byteToCharacterOffset(text, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) migrationError('QUEUE_MIGRATION_RANGE_INVALID', 'phase byte range is invalid.');
  const bytes = Buffer.from(text, 'utf8');
  if (byteOffset > bytes.length) migrationError('QUEUE_MIGRATION_RANGE_INVALID', 'phase byte range exceeds queue bytes.');
  return bytes.subarray(0, byteOffset).toString('utf8').length;
}

function markerFor(phaseId, packageId) {
  if (typeof phaseId !== 'string' || !/^Q[1-9]\d{0,2}$/.test(phaseId)
      || typeof packageId !== 'string' || !PACKAGE_ID_RE.test(packageId)) {
    migrationError('QUEUE_MIGRATION_MARKER_INVALID', 'marker identity is invalid.');
  }
  return `<!-- build-queue-slice:v1 phase=${phaseId} package=${packageId} -->\n`;
}

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    migrationError(code, message);
  }
}

function normalizeRootPhaseIds(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^Q[1-9]\d{0,2}$/.test(id))) {
    migrationError('QUEUE_MIGRATION_ROOT_PHASES_INVALID', 'rootPhaseIds must be an explicit list of Q1 through Q999 identifiers.');
  }
  if (new Set(value).size !== value.length) {
    migrationError('QUEUE_MIGRATION_ROOT_PHASES_DUPLICATE', 'rootPhaseIds must not repeat a phase.');
  }
  return [...value];
}

function sliceMarkdownFromProjection(slice) {
  if (!slice || typeof slice !== 'object' || !Array.isArray(slice.phases) || typeof slice.packageId !== 'string') {
    migrationError('QUEUE_MIGRATION_SLICE_INVALID', 'package slice projection is malformed.');
  }
  if (!PACKAGE_ID_RE.test(slice.packageId)) migrationError('QUEUE_MIGRATION_PACKAGE_INVALID', 'package slice id is invalid.');
  const seen = new Set();
  return slice.phases.map(phase => {
    if (!phase || typeof phase.id !== 'string' || seen.has(phase.id) || typeof phase.phaseMarkdown !== 'string') {
      migrationError('QUEUE_MIGRATION_SLICE_INVALID', 'package slice contains a duplicate or malformed phase.');
    }
    seen.add(phase.id);
    const parsed = parseQueueBlocks(phase.phaseMarkdown);
    if (parsed.length !== 1 || parsed[0].id !== phase.id) {
      migrationError('QUEUE_MIGRATION_SLICE_INVALID', `slice phase ${phase.id} does not round-trip as one phase.`);
    }
    return phase.phaseMarkdown;
  }).join('');
}

function parseSliceMarkdown(packageId, markdown) {
  if (typeof packageId !== 'string' || !PACKAGE_ID_RE.test(packageId) || typeof markdown !== 'string') {
    migrationError('QUEUE_MIGRATION_SLICE_INVALID', 'package slice markdown input is malformed.');
  }
  const phases = parseQueueBlocks(markdown);
  if (phases.length === 0) migrationError('QUEUE_MIGRATION_SLICE_EMPTY', `${packageId} has no queue phases.`);
  return new Map(phases.map(phase => [phase.id, phase.phaseMarkdown]));
}

/**
 * Split exact queue phase bytes into package Markdown and a marker-bearing
 * root.  The returned object is data-only and does not touch the filesystem.
 */
function splitQueueMigration({ queueMarkdown, assignments, rootPhaseIds } = {}) {
  if (typeof queueMarkdown !== 'string') migrationError('QUEUE_MIGRATION_QUEUE_INVALID', 'queueMarkdown must be text.');
  assertPlainObject(assignments, 'QUEUE_MIGRATION_ASSIGNMENTS_INVALID', 'assignments must be a plain object.');
  const rootIds = normalizeRootPhaseIds(rootPhaseIds);
  if (Object.keys(assignments).length === 0) {
    migrationError('QUEUE_MIGRATION_ASSIGNMENTS_EMPTY', 'At least one package slice assignment is required.');
  }
  const generated = generatePackageQueueSlices({ queueMarkdown, assignments });
  const unassigned = new Set(generated.unassignedPhaseIds);
  const declaredRoot = new Set(rootIds);
  if (rootIds.some(id => !unassigned.has(id)) || generated.unassignedPhaseIds.some(id => !declaredRoot.has(id))) {
    migrationError('QUEUE_MIGRATION_PHASES_UNASSIGNED', `Explicit root ownership does not match unassigned phases: ${generated.unassignedPhaseIds.join(', ')}.`);
  }

  const phases = parseQueueBlocks(queueMarkdown);
  const packageByPhase = new Map();
  for (const [packageId, phaseIds] of Object.entries(assignments)) {
    for (const phaseId of phaseIds) {
      if (packageByPhase.has(phaseId)) migrationError('QUEUE_MIGRATION_PHASE_COLLISION', `${phaseId} is assigned more than once.`);
      packageByPhase.set(phaseId, packageId);
    }
  }

  let rootMarkdown = queueMarkdown;
  for (const phase of [...phases].reverse()) {
    const packageId = packageByPhase.get(phase.id);
    if (!packageId) continue;
    const start = byteToCharacterOffset(queueMarkdown, phase.sourceRange.startByte);
    const end = byteToCharacterOffset(queueMarkdown, phase.sourceRange.endByte);
    rootMarkdown = rootMarkdown.slice(0, start)
      + markerFor(phase.id, packageId)
      + rootMarkdown.slice(end);
  }
  const firstPhaseStart = phases.length === 0
    ? rootMarkdown.length
    : byteToCharacterOffset(queueMarkdown, phases[0].sourceRange.startByte);
  rootMarkdown = rootMarkdown.slice(0, firstPhaseStart)
    + renderQueueIndex(Object.keys(assignments))
    + rootMarkdown.slice(firstPhaseStart);

  const slices = {};
  for (const packageId of Object.keys(generated.slices).sort()) {
    slices[packageId] = sliceMarkdownFromProjection(generated.slices[packageId]);
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceSha256: sha256(queueMarkdown),
    sourceBytes: Buffer.byteLength(queueMarkdown, 'utf8'),
    phaseOrder: Object.freeze(phases.map(phase => phase.id)),
    rootPhaseIds: Object.freeze(rootIds),
    rootMarkdown,
    slices: Object.freeze(slices)
  });
}

/** Merge marker-bearing root + explicit package Markdown back to source bytes. */
function mergeQueueMigration({ rootMarkdown, slices, sourceSha256, sourceBytes } = {}) {
  if (typeof rootMarkdown !== 'string') migrationError('QUEUE_MIGRATION_ROOT_INVALID', 'rootMarkdown must be text.');
  assertPlainObject(slices, 'QUEUE_MIGRATION_SLICES_INVALID', 'slices must be a package-to-markdown object.');
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)
      || !Number.isSafeInteger(sourceBytes) || sourceBytes < 1) {
    migrationError('QUEUE_MIGRATION_SOURCE_RECEIPT_REQUIRED', 'A valid source SHA-256 and byte length are required for merge.');
  }
  const index = parseQueueIndex(rootMarkdown);
  const indexedPackages = index.map(entry => entry.packageId);
  const suppliedPackages = Object.keys(slices).sort();
  if (indexedPackages.length !== suppliedPackages.length
      || indexedPackages.some((packageId, offset) => packageId !== suppliedPackages[offset])) {
    migrationError('QUEUE_MIGRATION_SLICE_SET_INVALID', 'The supplied slices do not exactly match the root queue index.');
  }
  const byPackage = new Map();
  const globallySliced = new Map();
  for (const packageId of Object.keys(slices)) {
    const phases = parseSliceMarkdown(packageId, slices[packageId]);
    for (const phaseId of phases.keys()) {
      if (globallySliced.has(phaseId)) {
        migrationError('QUEUE_MIGRATION_PHASE_COLLISION', `${phaseId} appears in both ${globallySliced.get(phaseId)} and ${packageId}.`);
      }
      globallySliced.set(phaseId, packageId);
    }
    byPackage.set(packageId, phases);
  }

  const rootWithoutIndex = removeQueueIndex(rootMarkdown);

  const markers = [];
  MARKER_RE.lastIndex = 0;
  let match;
  while ((match = MARKER_RE.exec(rootWithoutIndex)) !== null) {
    markers.push({ phaseId: match[1], packageId: match[2], start: match.index, end: match.index + match[0].length });
  }
  MARKER_RE.lastIndex = 0;
  if (markers.length === 0) migrationError('QUEUE_MIGRATION_MARKERS_MISSING', 'rootMarkdown has no queue slice markers.');

  const used = new Set();
  let merged = rootWithoutIndex;
  for (const marker of [...markers].reverse()) {
    const packagePhases = byPackage.get(marker.packageId);
    if (!packagePhases) migrationError('QUEUE_MIGRATION_SLICE_MISSING', `${marker.packageId} slice is missing.`);
    if (used.has(marker.phaseId)) migrationError('QUEUE_MIGRATION_MARKER_DUPLICATE', `duplicate marker ${marker.phaseId}.`);
    const phaseMarkdown = packagePhases.get(marker.phaseId);
    if (phaseMarkdown === undefined) migrationError('QUEUE_MIGRATION_PHASE_MISSING', `${marker.phaseId} is absent from ${marker.packageId}.`);
    used.add(marker.phaseId);
    merged = merged.slice(0, marker.start) + phaseMarkdown + merged.slice(marker.end);
  }

  for (const [packageId, packagePhases] of byPackage) {
    for (const phaseId of packagePhases.keys()) {
      if (!used.has(phaseId)) migrationError('QUEUE_MIGRATION_SLICE_EXTRA', `${phaseId} in ${packageId} has no root marker.`);
    }
  }
  if (sha256(merged) !== sourceSha256) {
    migrationError('QUEUE_MIGRATION_HASH_MISMATCH', 'merged queue bytes do not match the source hash.');
  }
  if (mergedBytes(merged) !== sourceBytes) {
    migrationError('QUEUE_MIGRATION_BYTE_MISMATCH', 'merged queue byte length does not match the source.');
  }
  return merged;
}

function mergedBytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

module.exports = Object.freeze({ mergeQueueMigration, splitQueueMigration });
