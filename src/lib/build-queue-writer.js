'use strict';

// The only writer contract for BUILD-QUEUE phases.  Q33 deliberately keeps
// the queue as markdown, but a conveyor cannot safely hand-edit it: a lost
// instruction or a concurrent append would silently lose owner work.  This
// module therefore has a narrow contract: validate the existing queue, render
// one next-numbered OPEN phase, and atomically replace the file only when the
// caller presents the hash it read.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { acquireLock, AgentDigestLockError } = require('./process-claim-lock');
const { parseQueuePhases, STATUSES } = require('./build-queue-projection');
const { composeQueueCorpus, readQueueCorpus } = require('./build-queue-corpus');

// Legacy Q19-Q21 use a hyphen.  Accept them on read so a safe writer can
// repair forward from today's real queue, but always emit the canonical em
// dash used by the current documented grammar.
const HEADING_RE = /^##\s+(Q\d{1,3})\s+(?:—|-)\s+(.+?)\s*$/m;
const STATUS_RE = /^\*\*Status:\*\*\s*(DONE|BLOCKED|IN-PROGRESS|PARTIAL|OPEN)(?:\b|\s|$)/m;
const AUTHORITY_RE = /^\*\*Authority:\*\*\s+R\d+\b.*\bdirectiveId:\s*[^\s)]+/m;
const INSTRUCTION_HEADER_RE = /^\*\*Instructions \(verbatim\):\*\*\r?\n<!-- build-queue-writer:v1 bytes=(\d+) -->\r?\n/m;
const WRITABLE_STATUSES = new Set(STATUSES.filter(status => status !== 'UNKNOWN'));

class BuildQueueWriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuildQueueWriterError';
    this.code = code;
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BuildQueueWriterError(code, message);
  }
}

function assertText(value, code, label, { singleLine = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || (singleLine && /[\r\n]/.test(value))) {
    throw new BuildQueueWriterError(code, `${label} must be non-empty${singleLine ? ' and single-line' : ''}.`);
  }
  return value;
}

function normalizePhaseId(value) {
  if (typeof value !== 'string' || !/^Q[1-9]\d{0,2}$/.test(value)) {
    throw new BuildQueueWriterError('QUEUE_PHASE_ID_INVALID', 'phaseId must be Q1 through Q999.');
  }
  return value;
}

function phaseNumber(id) {
  return Number.parseInt(id.slice(1), 10);
}

// existsSync() collapses every lookup failure (including EACCES and I/O
// errors) into false.  Only ENOENT establishes that the queue is absent;
// every other failure must retain its uncertainty for the caller.
function assertQueueExists(queueFile, message) {
  try {
    fs.statSync(queueFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new BuildQueueWriterError('QUEUE_NOT_FOUND', message);
    }
    throw error;
  }
}

/**
 * Strictly validate the phase headings/status lines in queue markdown.  The
 * dashboard reader intentionally tolerates bad hand-authored data; writers
 * must do the opposite so they never append into an ambiguous document.
 */
function parseStrictQueue(markdown) {
  if (typeof markdown !== 'string') {
    throw new BuildQueueWriterError('QUEUE_MARKDOWN_INVALID', 'Queue markdown must be text.');
  }
  const lines = markdown.split(/\r\n|\n/);
  const phases = [];
  let current = null;

  const finish = () => {
    if (!current) return;
    if (current.statusCount !== 1) {
      throw new BuildQueueWriterError('QUEUE_PHASE_AMBIGUOUS', `${current.id} must contain exactly one documented Status line.`);
    }
    phases.push(current);
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      finish();
      current = { id: heading[1], title: heading[2].trim(), statusCount: 0 };
      continue;
    }
    if (/^##\s+Q\d/i.test(line)) {
      throw new BuildQueueWriterError('QUEUE_PHASE_MALFORMED', `Malformed queue phase heading: ${line}`);
    }
    if (!current) continue;
    if (/^##\s+/.test(line)) {
      // A normal document section (for example "## Completed") closes a
      // phase. A Q-like heading that misses the documented grammar is unsafe:
      // it could otherwise be absorbed into the preceding phase.
      finish();
      continue;
    }
    if (/^\*\*Status:\*\*/.test(line)) {
      if (!STATUS_RE.test(line)) {
        throw new BuildQueueWriterError('QUEUE_PHASE_MALFORMED', `${current.id} has an undocumented Status line.`);
      }
      current.statusCount += 1;
    }
  }
  finish();

  const ids = new Set();
  for (const phase of phases) {
    if (ids.has(phase.id)) throw new BuildQueueWriterError('QUEUE_PHASE_AMBIGUOUS', `Duplicate queue phase ${phase.id}.`);
    ids.add(phase.id);
  }
  return phases;
}

// A phase id must never be reused once it has ever appeared anywhere in the
// queue's history, not only among the currently open "## Q<id>" phases. Two
// other constructs retire or relocate an id without deleting its number:
//   1. The "## Completed" ledger (mirrored by older completed/fixed lists
//      elsewhere in the file) records a closed phase as a bulleted, bold-led
//      receipt -- "- **Q99: Title:**", "- **Q24 — Title:**", or
//      "- **Q9 (Title):**" -- after its "## Q99" body is deleted per the
//      builder protocol. Reading only the live headings after that deletion
//      is exactly how Q99 became reusable the same day it closed.
//   2. Q50's per-package queue slices pull a phase's body out of this file
//      into queue/<package>.md and leave a marker behind:
//      "<!-- build-queue-slice:v1 phase=Q52 package=... -->". The id is
//      still live; a caller that hands nextPhaseId only the root text
//      (rather than the slice-composed corpus) must still see it reserved.
// Both constructs are recognized narrowly: a line that opens like one of
// them but fails the exact id grammar is a format drift, not something to
// guess past -- fail closed instead of silently under-counting again.
const RETIRED_RECEIPT_OPEN_RE = /^-\s+\*\*Q/;
const RETIRED_RECEIPT_RE = /^-\s+\*\*(Q[1-9]\d{0,2})\b/;
const SLICE_MARKER_OPEN_RE = /^<!--\s*build-queue-slice:v1\s+phase=/;
const SLICE_MARKER_RE = /^<!-- build-queue-slice:v1 phase=(Q[1-9]\d{0,2}) package=[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\s*-->/;

/**
 * Every phase number this document has ever assigned outside the live
 * headings parseStrictQueue already returns: retired into the Completed
 * ledger, or relocated into a package queue slice. Scanned line-by-line
 * (not with a single global regex) so a line that merely opens like one of
 * these constructs but does not match its exact grammar fails loudly rather
 * than being silently skipped.
 */
function retiredAndSlicedPhaseNumbers(markdown) {
  const numbers = new Set();
  for (const line of markdown.split(/\r\n|\n/)) {
    if (RETIRED_RECEIPT_OPEN_RE.test(line)) {
      const match = line.match(RETIRED_RECEIPT_RE);
      if (!match) {
        throw new BuildQueueWriterError('QUEUE_RETIRED_RECEIPT_MALFORMED', `Unrecognized retired-phase receipt: ${line.slice(0, 120)}`);
      }
      numbers.add(phaseNumber(match[1]));
    } else if (SLICE_MARKER_OPEN_RE.test(line)) {
      const match = line.match(SLICE_MARKER_RE);
      if (!match) {
        throw new BuildQueueWriterError('QUEUE_SLICE_MARKER_MALFORMED', `Unrecognized queue slice marker: ${line.slice(0, 120)}`);
      }
      numbers.add(phaseNumber(match[1]));
    }
  }
  return numbers;
}

/**
 * Allocate strictly beyond every id the document has ever carried: the live
 * "## Q<id>" phases plus every retired Completed-ledger receipt and
 * package-slice marker. Allocating from the live phases alone (the original
 * defect) frees a completed or sliced id's number the moment its body
 * leaves the live section, and the queue can then acquire two different
 * phases sharing one identifier.
 */
function nextPhaseId(markdown) {
  const phases = parseStrictQueue(markdown);
  let largest = 0;
  for (const phase of phases) largest = Math.max(largest, phaseNumber(phase.id));
  for (const retired of retiredAndSlicedPhaseNumbers(markdown)) largest = Math.max(largest, retired);
  if (largest >= 999) throw new BuildQueueWriterError('QUEUE_PHASE_LIMIT', 'Queue phase ids are exhausted at Q999.');
  return `Q${largest + 1}`;
}

function validatePhaseInput(input, expectedId) {
  assertPlainObject(input, 'QUEUE_PHASE_INPUT_INVALID', 'Phase input must be a plain object.');
  const phaseId = normalizePhaseId(input.phaseId || expectedId);
  if (phaseId !== expectedId) {
    throw new BuildQueueWriterError('QUEUE_PHASE_NOT_NEXT', `Refusing ${phaseId}; the next collision-free id is ${expectedId}.`);
  }
  const title = assertText(input.title, 'QUEUE_PHASE_TITLE_INVALID', 'title', { singleLine: true });
  const authority = assertText(input.authority, 'QUEUE_PHASE_AUTHORITY_INVALID', 'authority', { singleLine: true });
  if (!AUTHORITY_RE.test(`**Authority:** ${authority}`)) {
    throw new BuildQueueWriterError('QUEUE_PHASE_AUTHORITY_INVALID', 'authority must cite an R-number and directiveId.');
  }
  const instructions = assertText(input.instructions, 'QUEUE_PHASE_INSTRUCTIONS_INVALID', 'instructions');
  const status = input.status === undefined ? 'OPEN' : input.status;
  if (status !== 'OPEN' || !WRITABLE_STATUSES.has(status)) {
    throw new BuildQueueWriterError('QUEUE_PHASE_STATUS_INVALID', 'New queue phases must begin with Status OPEN.');
  }
  return { phaseId, title, authority, instructions, status };
}

/** Render one phase without normalizing its verbatim instruction bytes. */
function renderPhase(input, { expectedId } = {}) {
  const phase = validatePhaseInput(input, expectedId || normalizePhaseId(input && input.phaseId));
  const instructionBytes = Buffer.from(phase.instructions, 'utf8');
  const header = [
    `## ${phase.phaseId} — ${phase.title}`,
    '',
    `**Status:** ${phase.status}`,
    '',
    `**Authority:** ${phase.authority}`,
    '',
    '**Instructions (verbatim):**',
    `<!-- build-queue-writer:v1 bytes=${instructionBytes.length} -->`,
    ''
  ].join('\n');
  return Buffer.concat([Buffer.from(header, 'utf8'), instructionBytes, Buffer.from('\n', 'utf8')]);
}

/** Recover the exact UTF-8 instruction payload emitted by renderPhase(). */
function parseRenderedPhase(markdown) {
  const bytes = Buffer.isBuffer(markdown) ? markdown : Buffer.from(String(markdown), 'utf8');
  const text = bytes.toString('utf8');
  const heading = text.match(HEADING_RE);
  const status = text.match(STATUS_RE);
  const authority = text.match(/^\*\*Authority:\*\*\s+(.+)$/m);
  const header = text.match(INSTRUCTION_HEADER_RE);
  if (!heading || !status || !authority || !header || (text.match(/^\*\*Status:\*\*/gm) || []).length !== 1) {
    throw new BuildQueueWriterError('QUEUE_RENDERED_PHASE_MALFORMED', 'Rendered phase does not satisfy the queue grammar.');
  }
  if (!AUTHORITY_RE.test(`**Authority:** ${authority[1]}`)) {
    throw new BuildQueueWriterError('QUEUE_RENDERED_PHASE_MALFORMED', 'Rendered phase authority is malformed.');
  }
  const headerBytes = Buffer.from(header[0], 'utf8');
  const instructionLength = Number.parseInt(header[1], 10);
  const instructionStart = bytes.indexOf(headerBytes) + headerBytes.length;
  if (!Number.isSafeInteger(instructionLength) || instructionLength < 1 || instructionStart < headerBytes.length || instructionStart + instructionLength >= bytes.length) {
    throw new BuildQueueWriterError('QUEUE_RENDERED_PHASE_MALFORMED', 'Rendered phase instruction length is invalid.');
  }
  const instructionBytes = bytes.subarray(instructionStart, instructionStart + instructionLength);
  const remainder = bytes.subarray(instructionStart + instructionLength);
  if (!remainder.equals(Buffer.from('\n', 'utf8')) || !Buffer.from(instructionBytes.toString('utf8'), 'utf8').equals(instructionBytes)) {
    throw new BuildQueueWriterError('QUEUE_RENDERED_PHASE_MALFORMED', 'Rendered phase instruction payload is not an exact UTF-8 value.');
  }
  return { phaseId: heading[1], title: heading[2].trim(), status: status[1], authority: authority[1], instructions: instructionBytes.toString('utf8') };
}

function atomicReplace(queueFile, previousRaw, nextRaw, { beforeReplace = null } = {}) {
  const temporary = `${queueFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, nextRaw, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    const staged = fs.readFileSync(temporary, 'utf8');
    parseStrictQueue(staged);
    if (beforeReplace !== null) {
      if (typeof beforeReplace !== 'function') throw new BuildQueueWriterError('QUEUE_REPLACE_FENCE_INVALID', 'beforeReplace must be a function.');
      beforeReplace();
    }
    // The lock handles cooperative writers. Re-read immediately before the
    // replace as the CAS fence for a human/editor that did not take that lock.
    if (fs.readFileSync(queueFile, 'utf8') !== previousRaw) {
      throw new BuildQueueWriterError('QUEUE_CONCURRENT_EDIT', 'Queue changed while the replacement was staged; refusing to overwrite it.');
    }
    fs.renameSync(temporary, queueFile);
    const persisted = fs.readFileSync(queueFile, 'utf8');
    if (persisted !== nextRaw) {
      throw new BuildQueueWriterError('QUEUE_WRITE_VERIFY_FAILED', 'Queue bytes differed after atomic replacement.');
    }
  } finally {
    if (descriptor !== undefined && descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function queueTarget(corpus, rootFile, packageId) {
  if (!corpus.indexed) {
    if (packageId !== undefined && packageId !== null) {
      throw new BuildQueueWriterError('QUEUE_PACKAGE_NOT_INDEXED', 'A monolithic queue cannot accept a package-targeted append.');
    }
    return { file: rootFile, relativePath: 'BUILD-QUEUE.md', packageId: null };
  }
  if (packageId === undefined || packageId === null) {
    return { file: rootFile, relativePath: 'BUILD-QUEUE.md', packageId: null };
  }
  if (typeof packageId !== 'string') throw new BuildQueueWriterError('QUEUE_PACKAGE_ID_INVALID', 'packageId must be text.');
  const entry = corpus.index.find(candidate => candidate.packageId === packageId);
  if (!entry) throw new BuildQueueWriterError('QUEUE_PACKAGE_NOT_INDEXED', `Package ${packageId} has no indexed queue slice.`);
  return {
    file: path.resolve(path.dirname(rootFile), ...entry.path.split('/')),
    relativePath: entry.path,
    packageId
  };
}

function candidateCorpus(corpus, target, nextTargetText) {
  const sliceMarkdownByPath = Object.fromEntries(corpus.slices.map(slice => [slice.path, slice.text]));
  let rootMarkdown = corpus.rootText;
  if (target.relativePath === 'BUILD-QUEUE.md') rootMarkdown = nextTargetText;
  else sliceMarkdownByPath[target.relativePath] = nextTargetText;
  return composeQueueCorpus({ rootFile: corpus.rootFile, rootMarkdown, sliceMarkdownByPath });
}

const QUEUE_ACTOR_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const QUEUE_PHASE_ID_RE = /^Q[1-9]\d{0,2}$/;

function transitionInput(input) {
  assertPlainObject(input, 'QUEUE_TRANSITION_INVALID', 'Queue transition must be a plain object.');
  const allowed = ['queueFile', 'expectedHash', 'phaseId', 'action', 'actor', 'reason', 'at'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || allowed.slice(0, 5).some(key => !Object.hasOwn(input, key))) {
    throw new BuildQueueWriterError('QUEUE_TRANSITION_INVALID', 'Queue transition has unexpected or missing fields.');
  }
  if (typeof input.queueFile !== 'string' || !input.queueFile) throw new BuildQueueWriterError('QUEUE_FILE_REQUIRED', 'queueFile is required.');
  if (typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHash)) {
    throw new BuildQueueWriterError('QUEUE_EXPECTED_HASH_INVALID', 'expectedHash must be a SHA-256 hex digest.');
  }
  if (typeof input.phaseId !== 'string' || !QUEUE_PHASE_ID_RE.test(input.phaseId)) {
    throw new BuildQueueWriterError('QUEUE_PHASE_ID_INVALID', 'phaseId must be Q1 through Q999.');
  }
  if (!['claim', 'close'].includes(input.action)) throw new BuildQueueWriterError('QUEUE_ACTION_INVALID', 'action must be claim or close.');
  if (typeof input.actor !== 'string' || !QUEUE_ACTOR_RE.test(input.actor)) {
    throw new BuildQueueWriterError('QUEUE_ACTOR_INVALID', 'actor must be a lowercase agent id.');
  }
  const reason = input.reason === undefined || input.reason === ''
    ? '' : assertText(input.reason, 'QUEUE_REASON_INVALID', 'reason', { singleLine: true }).trim();
  if (Buffer.byteLength(reason, 'utf8') > 500) throw new BuildQueueWriterError('QUEUE_REASON_INVALID', 'reason exceeds 500 UTF-8 bytes.');
  if (input.action === 'close' && !reason) throw new BuildQueueWriterError('QUEUE_REASON_REQUIRED', 'close requires a reason.');
  const atMs = input.at === undefined ? Date.now() : Date.parse(input.at);
  if (!Number.isFinite(atMs)) throw new BuildQueueWriterError('QUEUE_TIMESTAMP_INVALID', 'at must be an ISO timestamp.');
  return { ...input, reason, at: new Date(atMs).toISOString() };
}

function targetForPhase(corpus, rootFile, phaseId) {
  const sources = [
    { file: rootFile, relativePath: 'BUILD-QUEUE.md', packageId: null, text: corpus.rootText },
    ...corpus.slices.map(slice => ({
      file: path.resolve(path.dirname(rootFile), ...slice.path.split('/')),
      relativePath: slice.path,
      packageId: slice.packageId,
      text: slice.text
    }))
  ];
  const matches = sources.filter(source => parseStrictQueue(source.text).some(phase => phase.id === phaseId));
  if (matches.length !== 1) {
    throw new BuildQueueWriterError(matches.length ? 'QUEUE_PHASE_AMBIGUOUS' : 'QUEUE_PHASE_UNKNOWN', `${phaseId} must resolve to exactly one queue source.`);
  }
  return matches[0];
}

function phaseSection(markdown, phaseId) {
  const heading = new RegExp(`^##\\s+${phaseId}\\s+(?:\\u2014|-)\\s+.+$`, 'm').exec(markdown);
  if (!heading) throw new BuildQueueWriterError('QUEUE_PHASE_UNKNOWN', `Unknown queue phase ${phaseId}.`);
  const next = /^##\s+.+$/gm;
  next.lastIndex = heading.index + heading[0].length;
  const following = next.exec(markdown);
  const end = following ? following.index : markdown.length;
  return { start: heading.index, end, text: markdown.slice(heading.index, end) };
}

function insertCompletedReceipt(markdown, receipt) {
  const heading = /^## Completed(?:\s+.*)?$/m.exec(markdown);
  if (!heading) throw new BuildQueueWriterError('QUEUE_COMPLETED_SECTION_MISSING', 'Queue has no ## Completed section.');
  const bodyStart = heading.index + heading[0].length;
  const next = /^##\s+.+$/gm;
  next.lastIndex = bodyStart;
  const following = next.exec(markdown);
  const end = following ? following.index : markdown.length;
  const prefix = markdown.slice(0, end).replace(/[\t ]+$/g, '');
  const separator = prefix.endsWith('\n\n') ? '' : (prefix.endsWith('\n') ? '\n' : '\n\n');
  return `${prefix}${separator}${receipt}\n\n${markdown.slice(end).replace(/^\n+/, '')}`;
}

/**
 * Claim or close one existing phase under the same lock/hash/parser contract
 * as appendQueuePhase(). A close reserves the id in ## Completed and removes
 * the complete live phase in one atomic replacement. Cross-file close is
 * refused because a single-file rename cannot make that pair atomic.
 */
function transitionQueuePhase(input) {
  const request = transitionInput(input);
  const resolved = path.resolve(request.queueFile);
  assertQueueExists(resolved, 'Queue file does not exist.');
  let lock;
  try { lock = acquireLock(`${resolved}.lock`); }
  catch (error) {
    if (error instanceof AgentDigestLockError) throw new BuildQueueWriterError('QUEUE_LOCKED', 'Another queue writer holds the queue lock.');
    throw error;
  }
  try {
    const corpus = readQueueCorpus(resolved, { fsImpl: fs });
    if (corpus.sha256 !== request.expectedHash) throw new BuildQueueWriterError('QUEUE_CONCURRENT_EDIT', 'Queue changed after it was read; refusing to overwrite it.');
    parseStrictQueue(corpus.text);
    const target = targetForPhase(corpus, resolved, request.phaseId);
    const previous = fs.readFileSync(target.file, 'utf8');
    const section = phaseSection(previous, request.phaseId);
    const parsed = parseStrictQueue(section.text);
    if (parsed.length !== 1) throw new BuildQueueWriterError('QUEUE_PHASE_AMBIGUOUS', `${request.phaseId} did not round-trip as one phase.`);
    const status = /^\*\*Status:\*\*\s*(DONE|BLOCKED|IN-PROGRESS|PARTIAL|OPEN)(?:\b|\s|$).*$/m.exec(section.text)?.[1];
    let next;
    if (request.action === 'claim') {
      if (status !== 'OPEN') throw new BuildQueueWriterError('QUEUE_PHASE_NOT_OPEN', `${request.phaseId} is ${status || 'UNKNOWN'}, not OPEN.`);
      const statusLine = /^\*\*Status:\*\*.*$/m.exec(section.text)?.[0];
      if (!statusLine) throw new BuildQueueWriterError('QUEUE_PHASE_AMBIGUOUS', `${request.phaseId} has no unique status line.`);
      const replacement = `**Status:** IN-PROGRESS ${request.at.slice(0, 10)} (claimed by ${request.actor})`;
      next = previous.slice(0, section.start) + section.text.replace(statusLine, replacement) + previous.slice(section.end);
    } else {
      if (target.relativePath !== 'BUILD-QUEUE.md') {
        throw new BuildQueueWriterError('QUEUE_CLOSE_CROSS_FILE_UNSUPPORTED', 'Closing a sliced phase would require a non-atomic cross-file receipt and deletion.');
      }
      if (!['IN-PROGRESS', 'PARTIAL', 'BLOCKED'].includes(status)) {
        throw new BuildQueueWriterError('QUEUE_PHASE_NOT_CLOSABLE', `${request.phaseId} is ${status || 'UNKNOWN'} and cannot be closed.`);
      }
      const heading = /^##\s+Q[1-9]\d{0,2}\s+(?:\u2014|-)\s+(.+?)\s*$/m.exec(section.text);
      const title = heading ? heading[1].trim() : request.phaseId;
      const receipt = `- **${request.phaseId} \u2014 ${title}:** closed ${request.at.slice(0, 10)} by ${request.actor} \u2014 ${request.reason}`;
      const withoutPhase = previous.slice(0, section.start) + previous.slice(section.end).replace(/^\n+/, '');
      next = insertCompletedReceipt(withoutPhase, receipt);
    }
    parseStrictQueue(next);
    const nextCorpus = candidateCorpus(corpus, target, next);
    parseStrictQueue(nextCorpus.text);
    atomicReplace(target.file, previous, next, {
      beforeReplace: () => {
        if (readQueueCorpus(resolved, { fsImpl: fs }).sha256 !== corpus.sha256) {
          throw new BuildQueueWriterError('QUEUE_CONCURRENT_EDIT', 'The indexed queue corpus changed while the transition was staged.');
        }
      }
    });
    const persisted = readQueueCorpus(resolved, { fsImpl: fs });
    if (persisted.sha256 !== nextCorpus.sha256) throw new BuildQueueWriterError('QUEUE_WRITE_VERIFY_FAILED', 'The indexed queue corpus differed after transition.');
    return {
      phaseId: request.phaseId,
      action: request.action,
      actor: request.actor,
      reason: request.reason || null,
      at: request.at,
      queuePath: target.relativePath,
      previousHash: corpus.sha256,
      nextHash: persisted.sha256
    };
  } finally {
    lock.release();
  }
}

/**
 * Return the exact compare-and-swap digest consumed by transitionQueuePhase.
 * The read covers the indexed root plus every declared slice and fails closed
 * through the same strict parser before any hash is offered to a caller.
 */
function inspectQueueCorpus({ queueFile, fsImpl = fs } = {}) {
  if (typeof queueFile !== 'string' || !queueFile) {
    throw new BuildQueueWriterError('QUEUE_FILE_REQUIRED', 'queueFile is required.');
  }
  const corpus = readQueueCorpus(path.resolve(queueFile), { fsImpl });
  parseStrictQueue(corpus.text);
  return Object.freeze({
    sha256: corpus.sha256,
    indexed: corpus.indexed,
    files: corpus.files
  });
}

/**
 * Append a phase only if the queue still has exactly the caller-observed hash.
 * The lock keeps two cooperative writers out of the read/replace window; the
 * hash check makes a concurrent manual edit fail closed even without that lock.
 */
function appendQueuePhase({ queueFile, expectedHash, phase, packageId = null }) {
  if (typeof queueFile !== 'string' || !queueFile) {
    throw new BuildQueueWriterError('QUEUE_FILE_REQUIRED', 'queueFile is required.');
  }
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new BuildQueueWriterError('QUEUE_EXPECTED_HASH_INVALID', 'expectedHash must be a SHA-256 hex digest.');
  }
  const resolved = path.resolve(queueFile);
  assertQueueExists(resolved, 'Refusing to create a queue file implicitly.');
  let lock;
  try {
    lock = acquireLock(`${resolved}.lock`);
  } catch (error) {
    if (error instanceof AgentDigestLockError) {
      throw new BuildQueueWriterError('QUEUE_LOCKED', 'Another queue writer holds the queue lock.');
    }
    throw error;
  }
  try {
    const previousCorpus = readQueueCorpus(resolved, { fsImpl: fs });
    const actualHash = previousCorpus.sha256;
    if (actualHash !== expectedHash) {
      throw new BuildQueueWriterError('QUEUE_CONCURRENT_EDIT', 'Queue changed after it was read; refusing to overwrite it.');
    }
    const target = queueTarget(previousCorpus, resolved, packageId);
    const previous = fs.readFileSync(target.file, 'utf8');
    const expectedId = nextPhaseId(previousCorpus.text);
    const rendered = renderPhase(phase, { expectedId });
    const recovered = parseRenderedPhase(rendered);
    if (recovered.instructions !== phase.instructions) {
      throw new BuildQueueWriterError('QUEUE_INSTRUCTION_LOSS', 'Instruction round-trip changed bytes; refusing to write.');
    }
    const separator = previous.endsWith('\n') ? '\n---\n\n' : '\n\n---\n\n';
    const next = previous + separator + rendered.toString('utf8');
    parseStrictQueue(next);
    const nextCorpus = candidateCorpus(previousCorpus, target, next);
    parseStrictQueue(nextCorpus.text);
    const projected = parseQueuePhases(nextCorpus.text).find(item => item.id === recovered.phaseId);
    if (!projected || projected.title !== recovered.title || projected.status !== 'OPEN') {
      throw new BuildQueueWriterError('QUEUE_PROJECTION_ROUND_TRIP_FAILED', 'Dashboard queue projection did not recover the written phase.');
    }
    atomicReplace(target.file, previous, next, {
      beforeReplace: () => {
        if (readQueueCorpus(resolved, { fsImpl: fs }).sha256 !== actualHash) {
          throw new BuildQueueWriterError('QUEUE_CONCURRENT_EDIT', 'The indexed queue corpus changed while the replacement was staged.');
        }
      }
    });
    const persisted = readQueueCorpus(resolved, { fsImpl: fs });
    if (persisted.sha256 !== nextCorpus.sha256) {
      throw new BuildQueueWriterError('QUEUE_WRITE_VERIFY_FAILED', 'The indexed queue corpus differed after atomic replacement.');
    }
    return {
      phaseId: recovered.phaseId,
      packageId: target.packageId,
      queuePath: target.relativePath,
      previousHash: actualHash,
      nextHash: persisted.sha256,
      rendered: rendered.toString('utf8')
    };
  } finally {
    lock.release();
  }
}

module.exports = {
  BuildQueueWriterError,
  appendQueuePhase,
  inspectQueueCorpus,
  nextPhaseId,
  parseRenderedPhase,
  parseStrictQueue,
  renderPhase,
  sha256,
  transitionQueuePhase
};
