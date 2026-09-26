'use strict';

// Report-only Gemini output is untrusted.  GeminiReport/v2 is deliberately a
// transcription format, not a natural-language summary format: the sole
// CLAIM must be byte-for-byte equal to a specifically pre-authorized source
// line.  v1 remains parseable for already materialized historical records,
// but is never semantic evidence and cannot make a new lane accepted.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DOCUMENT_PATH = path.resolve(__dirname, '../../../docs/GEMINI-FLEET-REPORT-CONTRACT.md');
// Updating the prose document alone is not a contract change: it must be
// consciously accompanied by a reviewed source change and focused tests.
const APPROVED_DOCUMENT_SHA256 = 'f2e70e475287ec6b7d621e2d4010c606fe6fe6ea1335124551a99ad3f34e8384';
const VERSION = 'GeminiReport/v2';
const LEGACY_VERSION = 'GeminiReport/v1';
const ROLE = 'gemini-report-lane';
const MAX_SOURCES = 8;
const MAX_COMMANDS = 4;
const MAX_EVIDENCE_ANCHORS = 8;
const SAFE_SOURCE_PATH = /^(?![./])(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:[cm]?js|[cm]?ts|json|md)$/;
const SAFE_TEST_COMMAND = /^node tests\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js$/;
const ANCHOR_LINE = /^EVIDENCE-ANCHOR: source=([^;]+); line=([1-9][0-9]*); sha256=([a-f0-9]{64})$/;
// CLAIM has exactly one framing space; everything after it is source text.
const CLAIM_PREFIX = 'CLAIM: ';
const boundContracts = new WeakSet();
const boundAnchorDetails = new WeakMap();

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactObject(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function fail(code, extra = {}) { return { ok: false, code, ...extra }; }

function pathCheckFailure(error, absentCode, context) {
  if (error && error.code === 'ENOENT') return fail(absentCode, context);
  return fail('REPORT_CONTRACT_PATH_CHECK_INDETERMINATE', {
    ...context,
    message: 'Could not check the contract path; this result does NOT claim that the path is absent.'
  });
}

function canonicalSources(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SOURCES) return null;
  const sources = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (sources.some(item => !SAFE_SOURCE_PATH.test(item)) || new Set(sources).size !== sources.length) return null;
  return sources;
}

function canonicalCommands(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COMMANDS) return null;
  const commands = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (commands.some(item => !SAFE_TEST_COMMAND.test(item)) || new Set(commands).size !== commands.length) return null;
  return commands;
}

function canonicalEvidence(value, sources) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVIDENCE_ANCHORS) return null;
  const anchors = [];
  for (const item of value) {
    if (!exactObject(item, ['source', 'line', 'sha256']) || !sources.includes(item.source)
      || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > 1_000_000
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) return null;
    anchors.push({ source: item.source, line: item.line, sha256: item.sha256 });
  }
  if (new Set(anchors.map(anchor => `${anchor.source}:${anchor.line}`)).size !== anchors.length) return null;
  return anchors;
}

function normalizeLaneContract(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !['ok', 'version', 'role', 'sources', 'commands', 'evidence'].includes(key))
      || (Object.hasOwn(value, 'ok') && value.ok !== true)) {
    return fail('REPORT_CONTRACT_SHAPE_INVALID');
  }
  const version = value.version === undefined ? VERSION : value.version;
  if (version !== VERSION && version !== LEGACY_VERSION) return fail('REPORT_CONTRACT_VERSION_INVALID');
  if (value.role !== ROLE) return fail('REPORT_CONTRACT_ROLE_INVALID');
  const sources = canonicalSources(value.sources);
  if (!sources) return fail('REPORT_CONTRACT_SOURCES_INVALID');
  const commands = canonicalCommands(value.commands);
  if (!commands) return fail('REPORT_CONTRACT_COMMANDS_INVALID');
  if (version === LEGACY_VERSION) {
    // validateLaneInputs returns a frozen runtime envelope with an empty
    // evidence array for a v1 transport record; raw v1 declarations may not
    // carry evidence because that would suggest a semantic binding exists.
    if (value.evidence !== undefined && !(boundContracts.has(value)
      && Array.isArray(value.evidence) && value.evidence.length === 0)) return fail('REPORT_CONTRACT_V1_EVIDENCE_FORBIDDEN');
    return { ok: true, version, role: ROLE, sources, commands, evidence: [] };
  }
  const evidence = canonicalEvidence(value.evidence, sources);
  if (!evidence) return fail('REPORT_CONTRACT_EVIDENCE_INVALID');
  return { ok: true, version, role: ROLE, sources, commands, evidence };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function refuseLinkComponents(root, candidate, { fsImpl = fs } = {}) {
  if (!inside(root, candidate)) return false;
  let current = root;
  for (const part of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, part);
    const entry = fsImpl.lstatSync(current);
    if (entry.isSymbolicLink()) return false;
  }
  return true;
}

function sourceLogicalLine(sourcePath, lineNumber, { fsImpl = fs } = {}) {
  let bytes;
  try { bytes = fsImpl.readFileSync(sourcePath); } catch {
    return fail('REPORT_CONTRACT_EVIDENCE_SOURCE_READ_FAILED', {
      message: 'Could not read the evidence source; this result does NOT claim that the source is absent.'
    });
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return fail('REPORT_CONTRACT_EVIDENCE_SOURCE_ENCODING_INVALID');
  const rows = text.split('\n');
  if (lineNumber > rows.length) return fail('REPORT_CONTRACT_EVIDENCE_LINE_MISMATCH');
  let claim = rows[lineNumber - 1];
  // A logical source line excludes its CRLF/LF terminator. This is the exact
  // UTF-8 byte sequence that the report may reproduce after `CLAIM: `.
  if (claim.endsWith('\r')) claim = claim.slice(0, -1);
  const claimBytes = Buffer.byteLength(claim, 'utf8');
  if (claimBytes < 1 || claimBytes > 800 || /[\u0000\r\n]/.test(claim)) return fail('REPORT_CONTRACT_EVIDENCE_LINE_INVALID');
  return { ok: true, claim, sha256: crypto.createHash('sha256').update(claim, 'utf8').digest('hex') };
}

function freezeBoundContract(normalized, anchors) {
  const bound = {
    ok: true,
    version: normalized.version,
    role: normalized.role,
    sources: Object.freeze(normalized.sources.slice()),
    commands: Object.freeze(normalized.commands.slice()),
    evidence: Object.freeze(normalized.evidence.map(anchor => Object.freeze({ ...anchor })))
  };
  Object.freeze(bound);
  boundContracts.add(bound);
  boundAnchorDetails.set(bound, Object.freeze(anchors.map(anchor => Object.freeze({ ...anchor }))));
  return bound;
}

// The allowlist is not enough: validate declared source/command targets and
// bind each v2 anchor to the actual source bytes before any worktree or
// provider exists. Symlinks/junctions anywhere in the source chain are refused.
function validateLaneInputs(repoRoot, contract, { fsImpl = fs } = {}) {
  const normalized = normalizeLaneContract(contract);
  if (!normalized.ok) return normalized;
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) return fail('REPORT_CONTRACT_REPO_ROOT_INVALID');
  const root = path.resolve(repoRoot);
  let rootReal;
  try { rootReal = fsImpl.realpathSync(root); } catch (error) {
    return pathCheckFailure(error, 'REPORT_CONTRACT_REPO_ROOT_INVALID');
  }
  const resolvedSources = new Map();
  for (const source of normalized.sources) {
    const candidate = path.resolve(root, source);
    try {
      const resolved = fsImpl.realpathSync(candidate);
      if (!inside(root, candidate) || !inside(rootReal, resolved) || !refuseLinkComponents(rootReal, candidate, { fsImpl })
        || !fsImpl.statSync(resolved).isFile()) return fail('REPORT_CONTRACT_SOURCE_REPARSE_REFUSED', { source });
      resolvedSources.set(source, resolved);
    } catch (error) { return pathCheckFailure(error, 'REPORT_CONTRACT_SOURCE_NOT_FOUND', { source }); }
  }
  for (const command of normalized.commands) {
    const target = command.slice('node '.length);
    const candidate = path.resolve(root, target);
    try {
      const resolved = fsImpl.realpathSync(candidate);
      if (!inside(root, candidate) || !inside(rootReal, resolved) || !refuseLinkComponents(rootReal, candidate, { fsImpl })
        || !fsImpl.statSync(resolved).isFile()) return fail('REPORT_CONTRACT_COMMAND_TARGET_NOT_FOUND', { command });
    } catch (error) { return pathCheckFailure(error, 'REPORT_CONTRACT_COMMAND_TARGET_NOT_FOUND', { command }); }
  }
  if (normalized.version === LEGACY_VERSION) return freezeBoundContract(normalized, []);
  const anchors = [];
  for (const anchor of normalized.evidence) {
    const source = sourceLogicalLine(resolvedSources.get(anchor.source), anchor.line, { fsImpl });
    if (!source.ok) return source;
    if (source.sha256 !== anchor.sha256) return fail('REPORT_CONTRACT_EVIDENCE_HASH_MISMATCH', { source: anchor.source, line: anchor.line });
    anchors.push({ ...anchor, claim: source.claim });
  }
  return freezeBoundContract(normalized, anchors);
}

function loadDefinition({ fsImpl = fs, documentPath = DOCUMENT_PATH, approvedSha256 = APPROVED_DOCUMENT_SHA256 } = {}) {
  let text;
  try { text = fsImpl.readFileSync(documentPath, 'utf8'); }
  catch { throw new Error('GEMINI_REPORT_CONTRACT_DOCUMENT_UNAVAILABLE'); }
  const canonicalText = text.replace(/\r\n/g, '\n');
  const sha256 = crypto.createHash('sha256').update(canonicalText, 'utf8').digest('hex');
  if (sha256 !== approvedSha256) {
    const error = new Error('GEMINI_REPORT_CONTRACT_DOCUMENT_DRIFT');
    error.code = 'GEMINI_REPORT_CONTRACT_DOCUMENT_DRIFT';
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024 || !text.includes('`GeminiReport/v2`')
      || !text.includes('ROLE: gemini-report-lane') || !text.includes('EVIDENCE-ANCHOR: source=path/one.js; line=1; sha256=<sha256-of-logical-source-line>')) {
    throw new Error('GEMINI_REPORT_CONTRACT_DOCUMENT_INVALID');
  }
  return Object.freeze({ version: VERSION, role: ROLE, documentPath, sha256 });
}

function legacyReport(value, normalized) {
  const lines = String(value).replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() !== '');
  if (lines.length < 5) return fail('REPORT_CONTRACT_LINES_MISSING');
  if (lines[0] !== `REPORT-CONTRACT: ${LEGACY_VERSION}`) return fail('REPORT_CONTRACT_VERSION_MISMATCH');
  if (lines[1] !== `ROLE: ${ROLE}`) return fail('REPORT_CONTRACT_ROLE_CONFUSION');
  if (lines[2] !== `SOURCES: ${normalized.sources.join(', ')}`) return fail('REPORT_CONTRACT_SOURCES_MISMATCH');
  if (!lines[3].startsWith('EVIDENCE-COMMAND: ')) return fail('REPORT_CONTRACT_COMMAND_MISSING');
  if (!normalized.commands.includes(lines[3].slice('EVIDENCE-COMMAND: '.length))) return fail('REPORT_CONTRACT_COMMAND_UNSUPPORTED');
  if (lines.slice(4).some(line => !/^CLAIM:\s+.{12,800}?\s+\[source:\s*[^\]]+\]$/.test(line))) return fail('REPORT_CONTRACT_UNSUPPORTED_CLAIM');
  return { ok: true, version: LEGACY_VERSION, role: ROLE, sources: normalized.sources, command: lines[3].slice(18), claimCount: lines.length - 4, semanticVerified: false };
}

function validateReport(value, contract) {
  const normalized = normalizeLaneContract(contract);
  if (!normalized.ok) return normalized;
  const text = String(value).replace(/\r\n/g, '\n');
  if (normalized.version === LEGACY_VERSION) return legacyReport(text, normalized);
  if (!boundContracts.has(contract)) return fail('REPORT_CONTRACT_V2_EVIDENCE_UNBOUND');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length !== 6 || lines.some(line => line.length === 0)) return fail('REPORT_CONTRACT_LINES_EXCESS');
  if (lines[0] !== `REPORT-CONTRACT: ${VERSION}`) return fail('REPORT_CONTRACT_VERSION_MISMATCH');
  if (lines[1] !== `ROLE: ${ROLE}`) return fail('REPORT_CONTRACT_ROLE_CONFUSION');
  if (lines[2] !== `SOURCES: ${normalized.sources.join(', ')}`) return fail('REPORT_CONTRACT_SOURCES_MISMATCH');
  if (!lines[3].startsWith('EVIDENCE-COMMAND: ')) return fail('REPORT_CONTRACT_COMMAND_MISSING');
  const command = lines[3].slice('EVIDENCE-COMMAND: '.length);
  if (!normalized.commands.includes(command)) return fail('REPORT_CONTRACT_COMMAND_UNSUPPORTED');
  const match = ANCHOR_LINE.exec(lines[4]);
  if (!match) return fail('REPORT_CONTRACT_EVIDENCE_ANCHOR_INVALID');
  const source = match[1];
  const line = Number(match[2]);
  const sha256 = match[3];
  const anchor = (boundAnchorDetails.get(contract) || []).find(item => item.source === source && item.line === line && item.sha256 === sha256);
  if (!anchor) return fail('REPORT_CONTRACT_EVIDENCE_ANCHOR_UNAUTHORIZED');
  if (!lines[5].startsWith(CLAIM_PREFIX)) return fail('REPORT_CONTRACT_UNSUPPORTED_CLAIM');
  if (lines[5].slice(CLAIM_PREFIX.length) !== anchor.claim) return fail('REPORT_CONTRACT_CLAIM_EVIDENCE_MISMATCH');
  return { ok: true, version: VERSION, role: ROLE, sources: normalized.sources, command, claimCount: 1, semanticVerified: true };
}

module.exports = {
  APPROVED_DOCUMENT_SHA256,
  ANCHOR_LINE,
  CLAIM_PREFIX,
  DOCUMENT_PATH,
  LEGACY_VERSION,
  ROLE,
  SAFE_SOURCE_PATH,
  SAFE_TEST_COMMAND,
  VERSION,
  canonicalCommands,
  canonicalEvidence,
  canonicalSources,
  loadDefinition,
  normalizeLaneContract,
  sourceLogicalLine,
  validateLaneInputs,
  validateReport
};
