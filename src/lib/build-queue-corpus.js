'use strict';

// Q50 keeps BUILD-QUEUE.md as the protocol, cross-package queue, completed
// record, and package-slice index.  This module is the one filesystem reader
// for that indexed corpus.  Consumers receive one deterministic text
// projection, while the physical slice files remain explicit and independently
// attributable.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertPackageId, queueSlicePath } = require('./build-queue-package-contract');

const INDEX_HEADING = '## Package queue index';
const INDEX_BEGIN = '<!-- build-queue-index:v1 begin -->';
const INDEX_END = '<!-- build-queue-index:v1 end -->';
const INDEX_LINE_RE = /^- `([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)`: \[(queue\/[^\]]+\.md)\]\((queue\/[^)]+\.md)\)$/;
const PHASE_HEADING_RE = /^##\s+(Q[1-9]\d{0,2})\b/gm;

class BuildQueueCorpusError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BuildQueueCorpusError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new BuildQueueCorpusError(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function renderQueueIndex(packageIds) {
  if (!Array.isArray(packageIds) || packageIds.length === 0) {
    fail('QUEUE_CORPUS_INDEX_PACKAGES_INVALID', 'At least one package id is required for an indexed queue.');
  }
  const normalized = packageIds.map(assertPackageId).sort();
  if (new Set(normalized).size !== normalized.length) {
    fail('QUEUE_CORPUS_INDEX_PACKAGE_DUPLICATE', 'The queue index may name each package only once.');
  }
  const lines = normalized.map(packageId => {
    const slicePath = queueSlicePath(packageId);
    return `- \`${packageId}\`: [${slicePath}](${slicePath})`;
  });
  return `${INDEX_HEADING}\n${INDEX_BEGIN}\n${lines.join('\n')}\n${INDEX_END}\n\n`;
}

function indexSectionRange(rootMarkdown) {
  if (typeof rootMarkdown !== 'string') {
    fail('QUEUE_CORPUS_ROOT_INVALID', 'Root queue markdown must be text.');
  }
  const beginMatches = [...rootMarkdown.matchAll(new RegExp(`^${INDEX_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm'))];
  const endMatches = [...rootMarkdown.matchAll(new RegExp(`^${INDEX_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm'))];
  const headingMatches = [...rootMarkdown.matchAll(/^## Package queue index\s*$/gm)];
  if (beginMatches.length === 0 && endMatches.length === 0 && headingMatches.length === 0) return null;
  if (beginMatches.length !== 1 || endMatches.length !== 1 || headingMatches.length !== 1) {
    fail('QUEUE_CORPUS_INDEX_AMBIGUOUS', 'The root queue must contain either zero or one complete package index.');
  }
  const heading = headingMatches[0];
  const begin = beginMatches[0];
  const end = endMatches[0];
  if (!(heading.index < begin.index && begin.index < end.index)) {
    fail('QUEUE_CORPUS_INDEX_MALFORMED', 'The package queue index markers are out of order.');
  }
  const betweenHeadingAndBegin = rootMarkdown.slice(heading.index + heading[0].length, begin.index);
  if (!/^\r?\n$/.test(betweenHeadingAndBegin)) {
    fail('QUEUE_CORPUS_INDEX_MALFORMED', 'The package queue index heading and begin marker must be adjacent.');
  }
  const lineEnd = rootMarkdown.indexOf('\n', end.index + end[0].length);
  const endExclusive = lineEnd === -1 ? rootMarkdown.length : lineEnd + 1;
  const trailing = rootMarkdown.slice(endExclusive, endExclusive + 1) === '\n' ? 1 : 0;
  return Object.freeze({
    headingStart: heading.index,
    beginStart: begin.index,
    beginEnd: begin.index + begin[0].length,
    endStart: end.index,
    endExclusive: endExclusive + trailing
  });
}

function parseQueueIndex(rootMarkdown) {
  const range = indexSectionRange(rootMarkdown);
  if (!range) return Object.freeze([]);
  const body = rootMarkdown.slice(range.beginEnd, range.endStart).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  if (!body) fail('QUEUE_CORPUS_INDEX_EMPTY', 'An indexed queue must name at least one package slice.');
  const entries = [];
  const packages = new Set();
  for (const line of body.split(/\r?\n/)) {
    const match = INDEX_LINE_RE.exec(line);
    if (!match || match[2] !== match[3]) {
      fail('QUEUE_CORPUS_INDEX_LINE_INVALID', 'Every queue index line must use the canonical package/path form.');
    }
    const packageId = assertPackageId(match[1]);
    const expectedPath = queueSlicePath(packageId);
    if (match[2] !== expectedPath) {
      fail('QUEUE_CORPUS_INDEX_PATH_INVALID', `Queue slice path for ${packageId} is not canonical.`);
    }
    if (packages.has(packageId)) {
      fail('QUEUE_CORPUS_INDEX_PACKAGE_DUPLICATE', `Package ${packageId} appears more than once in the queue index.`);
    }
    packages.add(packageId);
    entries.push(Object.freeze({ packageId, path: expectedPath }));
  }
  const sorted = [...entries].sort((left, right) => left.packageId.localeCompare(right.packageId, 'en'));
  if (entries.some((entry, index) => entry.packageId !== sorted[index].packageId)) {
    fail('QUEUE_CORPUS_INDEX_ORDER_INVALID', 'Queue index entries must be sorted by package id.');
  }
  return Object.freeze(entries);
}

function phaseIds(markdown) {
  const ids = [];
  PHASE_HEADING_RE.lastIndex = 0;
  let match;
  while ((match = PHASE_HEADING_RE.exec(markdown)) !== null) ids.push(match[1]);
  PHASE_HEADING_RE.lastIndex = 0;
  return ids;
}

function corpusDigest(rootText, slices) {
  if (slices.length === 0) return sha256(rootText);
  const hash = crypto.createHash('sha256');
  const values = [{ path: 'BUILD-QUEUE.md', text: rootText }, ...slices.map(slice => ({ path: slice.path, text: slice.text }))];
  for (const value of values) {
    const bytes = Buffer.from(value.text, 'utf8');
    hash.update(Buffer.from(`${value.path}\0${bytes.length}\0`, 'utf8'));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function composeQueueCorpus({ rootFile, rootMarkdown, sliceMarkdownByPath = {} } = {}) {
  if (typeof rootFile !== 'string' || !rootFile || typeof rootMarkdown !== 'string') {
    fail('QUEUE_CORPUS_INPUT_INVALID', 'rootFile and rootMarkdown are required.');
  }
  if (!sliceMarkdownByPath || typeof sliceMarkdownByPath !== 'object' || Array.isArray(sliceMarkdownByPath)) {
    fail('QUEUE_CORPUS_INPUT_INVALID', 'sliceMarkdownByPath must be a path-to-text object.');
  }
  const index = parseQueueIndex(rootMarkdown);
  const supplied = Object.keys(sliceMarkdownByPath);
  const expected = new Set(index.map(entry => entry.path));
  if (supplied.some(slicePath => !expected.has(slicePath)) || supplied.length !== expected.size) {
    fail('QUEUE_CORPUS_SLICE_SET_INVALID', 'The supplied slice set does not exactly match the root queue index.');
  }
  const slices = index.map(entry => {
    const text = sliceMarkdownByPath[entry.path];
    if (typeof text !== 'string') fail('QUEUE_CORPUS_SLICE_INVALID', `${entry.path} must contain text.`);
    return Object.freeze({ ...entry, text, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') });
  });
  const seen = new Map();
  for (const source of [{ path: 'BUILD-QUEUE.md', text: rootMarkdown }, ...slices]) {
    for (const id of phaseIds(source.text)) {
      if (seen.has(id)) fail('QUEUE_CORPUS_PHASE_DUPLICATE', `${id} appears in both ${seen.get(id)} and ${source.path}.`);
      seen.set(id, source.path);
    }
  }
  const separator = rootMarkdown.endsWith('\n') ? '\n' : '\n\n';
  const text = slices.length === 0 ? rootMarkdown : `${rootMarkdown}${separator}${slices.map(slice => slice.text).join('\n')}`;
  return Object.freeze({
    schemaVersion: 1,
    indexed: slices.length > 0,
    rootFile: path.resolve(rootFile),
    rootText: rootMarkdown,
    index,
    slices: Object.freeze(slices),
    files: Object.freeze(['BUILD-QUEUE.md', ...slices.map(slice => slice.path)]),
    text,
    sha256: corpusDigest(rootMarkdown, slices)
  });
}

function readQueueCorpus(rootFile, { fsImpl = fs } = {}) {
  if (typeof rootFile !== 'string' || !rootFile) fail('QUEUE_CORPUS_FILE_REQUIRED', 'rootFile is required.');
  const resolvedRoot = path.resolve(rootFile);
  let rootMarkdown;
  try { rootMarkdown = fsImpl.readFileSync(resolvedRoot, 'utf8'); }
  catch (error) { fail('QUEUE_CORPUS_ROOT_UNREADABLE', 'The root queue could not be read.', { causeCode: error && error.code }); }
  const index = parseQueueIndex(rootMarkdown);
  const repoRoot = path.dirname(resolvedRoot);
  const sliceMarkdownByPath = {};
  for (const entry of index) {
    const resolvedSlice = path.resolve(repoRoot, ...entry.path.split('/'));
    const expectedParent = `${path.resolve(repoRoot, 'queue')}${path.sep}`;
    if (!resolvedSlice.startsWith(expectedParent)) fail('QUEUE_CORPUS_SLICE_PATH_INVALID', 'A queue slice escaped the queue directory.');
    try { sliceMarkdownByPath[entry.path] = fsImpl.readFileSync(resolvedSlice, 'utf8'); }
    catch (error) { fail('QUEUE_CORPUS_SLICE_UNREADABLE', `Queue slice ${entry.path} could not be read.`, { causeCode: error && error.code }); }
  }
  return composeQueueCorpus({ rootFile: resolvedRoot, rootMarkdown, sliceMarkdownByPath });
}

function removeQueueIndex(rootMarkdown) {
  const range = indexSectionRange(rootMarkdown);
  if (!range) fail('QUEUE_CORPUS_INDEX_MISSING', 'The root queue has no package index to remove.');
  return rootMarkdown.slice(0, range.headingStart) + rootMarkdown.slice(range.endExclusive);
}

module.exports = Object.freeze({
  INDEX_BEGIN,
  INDEX_END,
  INDEX_HEADING,
  BuildQueueCorpusError,
  composeQueueCorpus,
  parseQueueIndex,
  readQueueCorpus,
  removeQueueIndex,
  renderQueueIndex,
  sha256
});
