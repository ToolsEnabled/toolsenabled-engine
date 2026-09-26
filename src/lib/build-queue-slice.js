'use strict';

// Q50's queue writer is intentionally the only mutator of BUILD-QUEUE.md.
// This companion is deliberately narrower: callers pass queue *text* and an
// explicit package-to-phase allocation, and receive deterministic, reversible
// read-only projections.  It does not read files, write files, or load package
// configuration, so it cannot accidentally become a second queue authority.

const crypto = require('node:crypto');
const { parseStrictQueue } = require('./build-queue-writer');

const HEADING_RE = /^##\s+(Q\d{1,3})\s+(?:\u2014|-)\s+(.+?)\s*$/gm;
const STATUS_RE = /^\*\*Status:\*\*\s*(DONE|BLOCKED|IN-PROGRESS|PARTIAL|OPEN)(?:\b|\s|$).*$/gm;
const AUTHORITY_RE = /^\*\*Authority:\*\*\s+(.+?)\s*$/gm;
const VERBATIM_INSTRUCTION_LABEL_RE = /^\*\*Instructions \(verbatim\):\*\*\s*$/m;
const INSTRUCTION_HEADER_RE = /^\*\*Instructions \(verbatim\):\*\*\r?\n<!-- build-queue-writer:v1 bytes=(\d+) -->\r?\n/gm;
const PACKAGE_ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SLICE_KEYS = Object.freeze(['schemaVersion', 'packageId', 'sourceSha256', 'sourceBytes', 'phaseIds', 'phases']);
const PHASE_KEYS = Object.freeze([
  'id', 'title', 'status', 'statusLine', 'authority', 'verbatimInstructions',
  'verbatimInstructionBytes', 'phaseMarkdown', 'phaseSha256', 'sourceRange'
]);
const ENVELOPE_KEYS = Object.freeze(['schemaVersion', 'slice', 'sliceSha256']);

class BuildQueueSliceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuildQueueSliceError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BuildQueueSliceError(code, message);
  }
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key));
}

function assertPackageId(value) {
  if (typeof value !== 'string' || !PACKAGE_ID_RE.test(value)) {
    throw new BuildQueueSliceError('QUEUE_SLICE_PACKAGE_INVALID', 'packageId must be a dotted lowercase package identifier.');
  }
  return value;
}

function assertPhaseIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !/^Q[1-9]\d{0,2}$/.test(id))) {
    throw new BuildQueueSliceError('QUEUE_SLICE_PHASE_IDS_INVALID', 'phaseIds must be a non-empty list of Q1 through Q999 identifiers.');
  }
  if (new Set(value).size !== value.length) {
    throw new BuildQueueSliceError('QUEUE_SLICE_PHASE_IDS_DUPLICATE', 'phaseIds must not repeat an id within a package slice.');
  }
  return [...value];
}

function byteOffset(text, characterOffset) {
  return Buffer.byteLength(text.slice(0, characterOffset), 'utf8');
}

function exactVerbatimInstruction(phaseMarkdown) {
  const header = INSTRUCTION_HEADER_RE.exec(phaseMarkdown);
  if (!header) {
    if (VERBATIM_INSTRUCTION_LABEL_RE.test(phaseMarkdown)) {
      throw new BuildQueueSliceError('QUEUE_SLICE_INSTRUCTION_MALFORMED', 'Verbatim instruction label is missing its exact byte envelope.');
    }
    return null;
  }
  if (INSTRUCTION_HEADER_RE.test(phaseMarkdown)) {
    INSTRUCTION_HEADER_RE.lastIndex = 0;
    throw new BuildQueueSliceError('QUEUE_SLICE_INSTRUCTION_AMBIGUOUS', 'A phase may contain at most one verbatim instruction envelope.');
  }
  INSTRUCTION_HEADER_RE.lastIndex = 0;
  const declaredLength = Number.parseInt(header[1], 10);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) {
    throw new BuildQueueSliceError('QUEUE_SLICE_INSTRUCTION_MALFORMED', 'Verbatim instruction byte length is invalid.');
  }
  const prefix = phaseMarkdown.slice(0, header.index + header[0].length);
  const bytes = Buffer.from(phaseMarkdown, 'utf8');
  const start = Buffer.byteLength(prefix, 'utf8');
  const end = start + declaredLength;
  if (end >= bytes.length || bytes[end] !== 0x0a) {
    throw new BuildQueueSliceError('QUEUE_SLICE_INSTRUCTION_MALFORMED', 'Verbatim instruction payload does not end at its declared byte boundary.');
  }
  const payload = bytes.subarray(start, end);
  if (!Buffer.from(payload.toString('utf8'), 'utf8').equals(payload)) {
    throw new BuildQueueSliceError('QUEUE_SLICE_INSTRUCTION_MALFORMED', 'Verbatim instruction payload is not exact UTF-8.');
  }
  return { text: payload.toString('utf8'), bytes: payload.length };
}

/**
 * Produce immutable-by-convention phase records from queue text.  Raw phase
 * markdown and its byte span are carried alongside parsed display fields so a
 * consumer can prove no authority, status, or instruction text was rewritten.
 */
function parseQueueBlocks(queueMarkdown) {
  if (typeof queueMarkdown !== 'string') {
    throw new BuildQueueSliceError('QUEUE_SLICE_MARKDOWN_INVALID', 'queueMarkdown must be text.');
  }
  try {
    parseStrictQueue(queueMarkdown);
  } catch (error) {
    throw new BuildQueueSliceError(error.code || 'QUEUE_SLICE_QUEUE_INVALID', error.message);
  }

  const headings = [];
  let match;
  while ((match = HEADING_RE.exec(queueMarkdown)) !== null) {
    headings.push({ id: match[1], title: match[2].trim(), characterStart: match.index });
  }
  HEADING_RE.lastIndex = 0;
  const sectionStarts = [...queueMarkdown.matchAll(/^##\s+/gm)].map(entry => entry.index);
  const ids = new Set();
  for (const heading of headings) {
    if (ids.has(heading.id)) throw new BuildQueueSliceError('QUEUE_SLICE_PHASE_DUPLICATE', `Duplicate phase ${heading.id}.`);
    ids.add(heading.id);
  }

  return headings.map(heading => {
    const nextSection = sectionStarts.find(start => start > heading.characterStart);
    const characterEnd = nextSection === undefined ? queueMarkdown.length : nextSection;
    const phaseMarkdown = queueMarkdown.slice(heading.characterStart, characterEnd);
    const statuses = [...phaseMarkdown.matchAll(STATUS_RE)];
    STATUS_RE.lastIndex = 0;
    if (statuses.length !== 1) {
      throw new BuildQueueSliceError('QUEUE_SLICE_STATUS_AMBIGUOUS', `${heading.id} must contain exactly one documented Status line.`);
    }
    const authorities = [...phaseMarkdown.matchAll(AUTHORITY_RE)];
    AUTHORITY_RE.lastIndex = 0;
    if (authorities.length > 1) {
      throw new BuildQueueSliceError('QUEUE_SLICE_AUTHORITY_AMBIGUOUS', `${heading.id} contains more than one Authority line.`);
    }
    const startByte = byteOffset(queueMarkdown, heading.characterStart);
    const endByte = byteOffset(queueMarkdown, characterEnd);
    const verbatimInstructions = exactVerbatimInstruction(phaseMarkdown);
    return Object.freeze({
      id: heading.id,
      title: heading.title,
      status: statuses[0][1],
      statusLine: statuses[0][0],
      authority: authorities.length === 1 ? authorities[0][1] : null,
      verbatimInstructions: verbatimInstructions ? verbatimInstructions.text : null,
      verbatimInstructionBytes: verbatimInstructions ? verbatimInstructions.bytes : null,
      phaseMarkdown,
      phaseSha256: sha256(phaseMarkdown),
      sourceRange: Object.freeze({ startByte, endByte })
    });
  });
}

function projectPackageQueueSlice({ queueMarkdown, packageId, phaseIds }) {
  const selectedPackageId = assertPackageId(packageId);
  const requestedIds = assertPhaseIds(phaseIds);
  const phases = parseQueueBlocks(queueMarkdown);
  const byId = new Map(phases.map(phase => [phase.id, phase]));
  for (const id of requestedIds) {
    if (!byId.has(id)) throw new BuildQueueSliceError('QUEUE_SLICE_PHASE_UNKNOWN', `Unknown queue phase ${id}.`);
  }
  const requested = new Set(requestedIds);
  const projected = phases.filter(phase => requested.has(phase.id));
  return Object.freeze({
    schemaVersion: 1,
    packageId: selectedPackageId,
    sourceSha256: sha256(queueMarkdown),
    sourceBytes: Buffer.byteLength(queueMarkdown, 'utf8'),
    phaseIds: Object.freeze(projected.map(phase => phase.id)),
    phases: Object.freeze(projected)
  });
}

/**
 * Make non-overlapping slices for multiple packages.  Allocation is caller
 * supplied: this function deliberately does not infer package authority from
 * filenames, titles, or configuration.
 */
function generatePackageQueueSlices({ queueMarkdown, assignments }) {
  assertPlainObject(assignments, 'QUEUE_SLICE_ASSIGNMENTS_INVALID', 'assignments must be a plain package-to-phase-id object.');
  const seen = new Map();
  const slices = {};
  for (const packageId of Object.keys(assignments).sort()) {
    const ids = assertPhaseIds(assignments[packageId]);
    for (const id of ids) {
      if (seen.has(id)) {
        throw new BuildQueueSliceError('QUEUE_SLICE_PHASE_COLLISION', `${id} is assigned to both ${seen.get(id)} and ${packageId}.`);
      }
      seen.set(id, packageId);
    }
    slices[packageId] = projectPackageQueueSlice({ queueMarkdown, packageId, phaseIds: ids });
  }
  const allPhases = parseQueueBlocks(queueMarkdown).map(phase => phase.id);
  return Object.freeze({
    schemaVersion: 1,
    sourceSha256: sha256(queueMarkdown),
    sourceBytes: Buffer.byteLength(queueMarkdown, 'utf8'),
    slices: Object.freeze(slices),
    unassignedPhaseIds: Object.freeze(allPhases.filter(id => !seen.has(id)))
  });
}

function validateSerializedSliceObject(slice) {
  if (!hasExactKeys(slice, SLICE_KEYS) || slice.schemaVersion !== 1) {
    throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_INVALID', 'serialized slice has an invalid exact schema.');
  }
  assertPackageId(slice.packageId);
  if (typeof slice.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(slice.sourceSha256)
      || !Number.isSafeInteger(slice.sourceBytes) || slice.sourceBytes < 1) {
    throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_TAMPERED', 'serialized source receipt is invalid.');
  }
  const phaseIds = assertPhaseIds(slice.phaseIds);
  if (!Array.isArray(slice.phases) || slice.phases.length !== phaseIds.length) {
    throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_TAMPERED', 'serialized phaseIds do not match the phase records.');
  }
  let previousEnd = -1;
  for (let index = 0; index < slice.phases.length; index += 1) {
    const phase = slice.phases[index];
    if (!hasExactKeys(phase, PHASE_KEYS) || !hasExactKeys(phase.sourceRange, ['startByte', 'endByte'])
        || typeof phase.phaseMarkdown !== 'string' || sha256(phase.phaseMarkdown) !== phase.phaseSha256) {
      throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_TAMPERED', 'serialized phase bytes or schema do not match their receipt.');
    }
    const { startByte, endByte } = phase.sourceRange;
    const phaseBytes = Buffer.byteLength(phase.phaseMarkdown, 'utf8');
    if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)
        || startByte < 0 || endByte <= startByte || endByte > slice.sourceBytes
        || endByte - startByte !== phaseBytes || startByte < previousEnd) {
      throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_TAMPERED', 'serialized phase source range is invalid.');
    }
    previousEnd = endByte;
    const parsed = parseQueueBlocks(phase.phaseMarkdown);
    const actual = parsed[0];
    if (parsed.length !== 1 || phaseIds[index] !== phase.id || actual.id !== phase.id
        || actual.title !== phase.title || actual.status !== phase.status
        || actual.statusLine !== phase.statusLine || actual.authority !== phase.authority
        || actual.verbatimInstructions !== phase.verbatimInstructions
        || actual.verbatimInstructionBytes !== phase.verbatimInstructionBytes) {
      throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_TAMPERED', 'serialized phase metadata does not round-trip from its exact queue block.');
    }
  }
  return slice;
}

function serializePackageQueueSlice(slice) {
  try { validateSerializedSliceObject(slice); }
  catch (error) {
    if (error instanceof BuildQueueSliceError) {
      throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZE_INVALID', error.message);
    }
    throw error;
  }
  const envelope = {
    schemaVersion: 1,
    slice,
    sliceSha256: sha256(JSON.stringify(slice))
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function parseSerializedPackageQueueSlice(serialized, { expectedSha256 } = {}) {
  if (typeof serialized !== 'string') throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_INVALID', 'serialized slice must be text.');
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new BuildQueueSliceError('QUEUE_SLICE_EXPECTED_RECEIPT_REQUIRED', 'A trusted serialized-slice SHA-256 receipt is required.');
  }
  let envelope;
  try { envelope = JSON.parse(serialized); }
  catch { throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_INVALID', 'serialized slice is not JSON.'); }
  if (!hasExactKeys(envelope, ENVELOPE_KEYS) || envelope.schemaVersion !== 1
      || typeof envelope.sliceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sliceSha256)) {
    throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_INVALID', 'serialized slice envelope has an invalid exact schema.');
  }
  if (envelope.sliceSha256 !== expectedSha256) {
    throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_TAMPERED', 'serialized slice receipt does not match the trusted receipt.');
  }
  if (sha256(JSON.stringify(envelope.slice)) !== envelope.sliceSha256) {
    throw new BuildQueueSliceError('QUEUE_SLICE_SERIALIZED_TAMPERED', 'serialized slice bytes do not match the envelope receipt.');
  }
  return validateSerializedSliceObject(envelope.slice);
}

module.exports = {
  BuildQueueSliceError,
  generatePackageQueueSlices,
  parseQueueBlocks,
  parseSerializedPackageQueueSlice,
  projectPackageQueueSlice,
  serializePackageQueueSlice
};
