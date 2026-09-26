'use strict';

// Mechanical scope contract carried from the lane dispatcher into every child
// process. This module is deliberately dependency-free and performs no I/O.

const path = require('node:path');

const ENV_VAR = 'TOOLSENABLED_LANE_SCOPE';
const MACHINE_SCOPES = Object.freeze(['local', 'cross-machine']);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TERRITORY_ENTRIES = 256;
const MAX_TERRITORY_ENTRY_CHARS = 2048;
const MAX_DIRECTIVE_ID_CHARS = 240;

class LaneScopeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'LaneScopeError';
    this.code = 'LANE_SCOPE_INVALID';
    if (details) this.details = details;
  }
}

function fail(message, details) {
  throw new LaneScopeError(message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateTerritoryEntry(value, index) {
  if (typeof value !== 'string') fail(`territory[${index}] must be a string.`, { index });
  const entry = value.trim();
  if (!entry) fail(`territory[${index}] must not be empty.`, { index });
  if (entry.length > MAX_TERRITORY_ENTRY_CHARS || /[\0\r\n]/.test(entry)) {
    fail(`territory[${index}] is not a bounded single-line path expression.`, { index });
  }
  if (entry.includes(';')) {
    fail(`territory[${index}] must not contain the semicolon list delimiter.`, { index });
  }
  if (path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) {
    fail(`territory[${index}] must be repo-relative, not absolute.`, { index, entry });
  }
  if (entry.split(/[\\/]+/).some(segment => segment === '..')) {
    fail(`territory[${index}] must not contain a '..' path segment.`, { index, entry });
  }
  return entry;
}

function validateTerritory(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_TERRITORY_ENTRIES) {
    fail(`territory must contain from 1 through ${MAX_TERRITORY_ENTRIES} entries.`);
  }
  return Object.freeze(values.map(validateTerritoryEntry));
}

function parseTerritory(cliString) {
  if (typeof cliString !== 'string') fail('territory must be a semicolon-separated string.');
  return validateTerritory(cliString.split(';'));
}

function validateDirectiveId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('directiveId must be a string when provided.');
  const directiveId = value.trim();
  if (!directiveId || directiveId.length > MAX_DIRECTIVE_ID_CHARS || /[\0\r\n]/.test(directiveId)) {
    fail('directiveId must be a bounded non-empty single-line string when provided.');
  }
  return directiveId;
}

function validate(scope) {
  if (!isPlainObject(scope)) fail('lane scope must be a plain object.');
  const allowed = new Set(['directiveId', 'territory', 'machineScope']);
  const unknown = Object.keys(scope).filter(key => !allowed.has(key));
  if (unknown.length) fail(`lane scope contains unsupported field(s): ${unknown.join(', ')}.`);
  const directiveId = validateDirectiveId(scope.directiveId);
  const territory = validateTerritory(scope.territory);
  if (!MACHINE_SCOPES.includes(scope.machineScope)) {
    fail(`machineScope must be one of: ${MACHINE_SCOPES.join(', ')}.`);
  }
  const normalized = { territory, machineScope: scope.machineScope };
  if (directiveId !== undefined) normalized.directiveId = directiveId;
  return Object.freeze(normalized);
}

function serialize(scope) {
  const normalized = validate(scope);
  const payload = {};
  if (normalized.directiveId !== undefined) payload.directiveId = normalized.directiveId;
  payload.territory = normalized.territory;
  payload.machineScope = normalized.machineScope;
  return JSON.stringify(payload);
}

function parse(payload) {
  if (typeof payload !== 'string' || !payload || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    fail(`lane scope env payload must be a non-empty string no larger than ${MAX_PAYLOAD_BYTES} bytes.`);
  }
  let decoded;
  try { decoded = JSON.parse(payload); }
  catch { fail('lane scope env payload must be valid JSON.'); }
  return validate(decoded);
}

module.exports = Object.freeze({
  ENV_VAR,
  LaneScopeError,
  MACHINE_SCOPES,
  parse,
  parseTerritory,
  serialize,
  validate
});
