'use strict';

// Result collectors: data-only declarations, never code-as-config. A collector
// turns what a finished runner left behind (printed output, files in the run's
// artifact folder) into result records; the shallow declared schema is checked
// here so a record that does not carry what the experiment promised is refused
// by name instead of stored as if it were evidence.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COLLECTOR_KINDS = Object.freeze(['stdout-json', 'artifact-glob', 'none']);
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RECORDS = 500;
const MAX_INLINE_ARTIFACT_BYTES = 4096;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = MAX_RECORDS * 4;
const ARTIFACT_PROVENANCE = '_toolsEnabledArtifact';

class CollectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
    this.details = details;
  }
}

// The declared result schema is deliberately shallow — {fields, required} with
// primitive type names — because that is what can be honestly enforced. A full
// schema language would validate less than it appears to.
function schemaDefinitionProblems(resultSchema) {
  const problems = [];
  const schema = resultSchema === undefined || resultSchema === null ? {} : resultSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return ['resultSchema must be an object'];
  for (const name of Object.keys(schema)) {
    if (!['fields', 'required'].includes(name)) problems.push(`resultSchema property "${name}" is not supported`);
  }
  if (schema.fields !== undefined && (!schema.fields || typeof schema.fields !== 'object' || Array.isArray(schema.fields))) {
    problems.push('resultSchema.fields must be an object');
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(name => typeof name !== 'string' || !name))) {
    problems.push('resultSchema.required must contain field names');
  }
  for (const [name, kind] of Object.entries(schema.fields || {})) {
    if (!['string', 'number', 'boolean'].includes(kind)) problems.push(`field "${name}" declares unsupported type "${String(kind)}"`);
  }
  return problems;
}

function schemaProblems(record, resultSchema) {
  const problems = schemaDefinitionProblems(resultSchema);
  const fields = resultSchema && typeof resultSchema.fields === 'object' && resultSchema.fields !== null ? resultSchema.fields : {};
  const required = Array.isArray(resultSchema && resultSchema.required) ? resultSchema.required : [];
  for (const name of required) {
    if (!Object.hasOwn(record, name) || record[name] === undefined || record[name] === null) problems.push(`required field "${name}" is missing`);
  }
  for (const [name, kind] of Object.entries(fields)) {
    if (!['string', 'number', 'boolean'].includes(kind)) continue;
    const value = record[name];
    if (!Object.hasOwn(record, name) || value === undefined) continue;
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (['string', 'number', 'boolean'].includes(kind) && actual !== kind) {
      problems.push(`field "${name}" is ${actual}, the experiment declared ${kind}`);
    }
  }
  const pending = [{ value: record, location: '' }];
  const seen = new WeakSet();
  while (pending.length) {
    const { value, location } = pending.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) problems.push(`field "${location}" is not a finite number`);
    if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const [name, nested] of Object.entries(value)) pending.push({ value: nested, location: location ? `${location}.${name}` : name });
    }
  }
  return problems;
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// Printed output → records. One JSON object per line is the primary contract;
// a whole-output single object is accepted so trivial commands need no framing.
function collectStdoutJson({ collector, stdout, resultSchema }) {
  const recordKind = typeof collector.recordKind === 'string' && collector.recordKind ? collector.recordKind : 'summary';
  const text = String(stdout || '');
  const candidates = [];
  const refused = [];
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsedLines = lines.map(parseJsonObject);
  const lineObjects = parsedLines.filter(Boolean);
  if (lineObjects.length > 0) {
    candidates.push(...lineObjects);
    for (let index = 0; index < parsedLines.length; index += 1) {
      if (!parsedLines[index]) refused.push({ reason: `stdout line ${index + 1} could not be parsed as a JSON object` });
    }
  }
  else {
    const whole = parseJsonObject(text.trim());
    if (whole) candidates.push(whole);
    else if (lines.length > 0) refused.push({ reason: 'stdout could not be parsed as a JSON object' });
  }
  const records = [];
  for (const record of candidates.slice(0, MAX_RECORDS)) {
    const problems = schemaProblems(record, resultSchema);
    if (problems.length) { refused.push({ reason: problems.join('; ') }); continue; }
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES) {
      refused.push({ reason: `record exceeds ${MAX_RECORD_BYTES} bytes` });
      continue;
    }
    records.push({ recordKind, record });
  }
  const dropped = Math.max(0, candidates.length - MAX_RECORDS);
  return { records, refused, dropped };
}

// A minimal glob: * within a segment, ** across segments, ? single character.
// Written out rather than imported so the collector's whole behavior stays in
// this file and the pattern language cannot silently widen.
function globToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/');
  if (normalized.includes('..')) throw new CollectorError('RESEARCH_COLLECTOR_PATTERN_INVALID', 'The artifact pattern may not traverse upward.');
  let expression = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      if (normalized[index + 1] === '*' && normalized[index + 2] === '/') { expression += '(?:.*/)?'; index += 2; }
      else if (normalized[index + 1] === '*') { expression += '.*'; index += 1; }
      else expression += '[^/]*';
    } else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`);
}

function artifactReadUnavailable(error, location) {
  const causeCode = error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
  return new CollectorError(
    'RESEARCH_COLLECTOR_ARTIFACTS_UNAVAILABLE',
    `The artifact ${location} could not be read (${causeCode}), so collection is undetermined; this does NOT claim that any artifact is absent.`,
    { causeCode, location }
  );
}

function walkFiles(root) {
  const found = [];
  const refused = [];
  const frontier = [''];
  let inspected = 0;
  while (frontier.length) {
    const relative = frontier.pop();
    const absolute = relative ? path.join(root, relative) : root;
    let entries;
    try {
      // Recheck queued directories: a directory entry may have been replaced
      // by a link since its parent was inspected.
      const stat = fs.lstatSync(absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        refused.push({ reason: `artifact directory "${relative || '.'}" is not a regular directory and was not followed` });
        continue;
      }
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      const location = relative || '.';
      if (!error || error.code !== 'ENOENT') throw artifactReadUnavailable(error, `directory "${location}"`);
      const detail = error && typeof error.code === 'string' ? ` (${error.code})` : '';
      refused.push({ reason: `artifact directory "${location}" could not be read${detail}` });
      continue;
    }
    for (const entry of entries) {
      if (inspected >= MAX_ARTIFACT_ENTRIES || found.length >= MAX_RECORDS * 2) {
        refused.push({ reason: `artifact traversal reached its inspection limit (${MAX_ARTIFACT_ENTRIES} entries / ${MAX_RECORDS * 2} files); collection is incomplete` });
        return { found, refused };
      }
      inspected += 1;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) refused.push({ reason: `artifact "${childRelative}" is a link and was not followed` });
      else if (entry.isDirectory()) frontier.push(childRelative);
      else if (entry.isFile()) found.push(childRelative);
    }
  }
  return { found, refused };
}

// Every typed artifact must really satisfy the declared schema. A metadata
// receipt for an unreadable/oversize JSON file is not a measurement. Untyped
// binary artifacts may be represented by their measured path/size/hash.
function collectArtifactGlob({ collector, artifactDir, resultSchema }) {
  const pattern = collector.pattern;
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new CollectorError('RESEARCH_COLLECTOR_PATTERN_INVALID', 'The artifact-glob collector requires a pattern.');
  }
  const recordKind = typeof collector.recordKind === 'string' && collector.recordKind ? collector.recordKind : 'artifact';
  const matcher = globToRegExp(pattern);
  let rootStat;
  try { rootStat = fs.lstatSync(artifactDir); } catch (error) {
    if (error?.code !== 'ENOENT') throw artifactReadUnavailable(error, 'directory "."');
    return { records: [], refused: [{ reason: 'artifact directory "." could not be read (ENOENT)' }], dropped: 0 };
  }
  if (rootStat.isSymbolicLink()) throw new CollectorError('RESEARCH_COLLECTOR_PATTERN_INVALID', 'The artifact directory may not be a link.');
  const walked = walkFiles(artifactDir);
  const matches = walked.found.map(name => name.replace(/\\/g, '/')).filter(name => matcher.test(name)).sort();
  const records = [];
  const refused = [...walked.refused];
  const typed = Object.keys(resultSchema?.fields || {}).length > 0 || (resultSchema?.required || []).length > 0;
  const byteLimit = typed ? MAX_RECORD_BYTES : MAX_ARTIFACT_BYTES;
  for (const relative of matches.slice(0, MAX_RECORDS)) {
    const absolute = path.join(artifactDir, relative);
    let content;
    let descriptor;
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        refused.push({ reason: `artifact "${relative}" is not a regular file` });
        continue;
      }
      if (stat.size > byteLimit) {
        refused.push({ reason: `artifact "${relative}" exceeds the ${byteLimit} byte ${typed ? 'typed record' : 'inspection'} limit; collection is incomplete` });
        continue;
      }
      descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        refused.push({ reason: `artifact "${relative}" changed before it could be inspected` });
        continue;
      }
      const chunks = [];
      let bytes = 0;
      while (bytes <= byteLimit) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, byteLimit + 1 - bytes));
        const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (count === 0) break;
        chunks.push(chunk.subarray(0, count));
        bytes += count;
      }
      const after = fs.fstatSync(descriptor);
      if (bytes > byteLimit || after.size !== bytes || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        refused.push({ reason: `artifact "${relative}" changed or exceeded its byte limit during inspection; collection is incomplete` });
        continue;
      }
      content = Buffer.concat(chunks, bytes);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw artifactReadUnavailable(error, `file "${relative}"`);
      refused.push({ reason: `artifact "${relative}" could not be read` });
      continue;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    if (typed || content.length <= MAX_INLINE_ARTIFACT_BYTES) {
      const parsed = parseJsonObject(content.toString('utf8'));
      if (parsed) {
        const problems = schemaProblems(parsed, resultSchema);
        if (Object.hasOwn(parsed, ARTIFACT_PROVENANCE) || Object.hasOwn(parsed, 'artifactPath')) {
          problems.push('artifact metadata fields are reserved for measured provenance');
        }
        if (problems.length) {
          refused.push({ reason: `artifact "${relative}": ${problems.join('; ')}` });
          continue;
        }
        const record = { ...parsed, artifactPath: relative, [ARTIFACT_PROVENANCE]: { bytes: content.length, sha256 } };
        if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES) {
          refused.push({ reason: `artifact "${relative}" exceeds the ${MAX_RECORD_BYTES} byte record limit with provenance` });
          continue;
        }
        records.push({ recordKind, record, artifactPath: relative });
        continue;
      }
      if (typed) { refused.push({ reason: `artifact "${relative}" could not be parsed as a JSON object required by its schema` }); continue; }
    }
    records.push({ recordKind, record: {
      artifactPath: relative, bytes: content.length, sha256,
      [ARTIFACT_PROVENANCE]: { bytes: content.length, sha256 }
    }, artifactPath: relative });
  }
  return { records, refused, dropped: Math.max(0, matches.length - MAX_RECORDS) };
}

function collect({ collector, resultSchema, stdout, artifactDir }) {
  const source = collector && typeof collector === 'object' && !Array.isArray(collector) ? collector : {};
  const kind = source.kind;
  if (!COLLECTOR_KINDS.includes(kind)) {
    throw new CollectorError('RESEARCH_COLLECTOR_UNSUPPORTED', `collector.kind must be one of: ${COLLECTOR_KINDS.join(', ')}.`, { kind });
  }
  const schemaErrors = schemaDefinitionProblems(resultSchema);
  if (schemaErrors.length) throw new CollectorError('RESEARCH_RESULT_SCHEMA_UNSUPPORTED', schemaErrors.join('; '));
  if (kind === 'none') return { records: [], refused: [], dropped: 0 };
  if (kind === 'stdout-json') return collectStdoutJson({ collector: source, stdout, resultSchema });
  return collectArtifactGlob({ collector: source, artifactDir, resultSchema });
}

module.exports = {
  COLLECTOR_KINDS, CollectorError, MAX_INLINE_ARTIFACT_BYTES, MAX_RECORDS, MAX_RECORD_BYTES, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_ENTRIES,
  collect, globToRegExp, schemaProblems, schemaDefinitionProblems
};
