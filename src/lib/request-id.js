'use strict';

// Canonical R/Q identifier grammar. Existing identifiers are records, so the
// parser preserves their spelling (including R01-R09) and never renumbers them.
const REQUEST_ID_RE = /^(R|Q)(0\d|[1-9]\d{0,3})(\.[1-9]\d*)*$/;

function parseRequestId(value) {
  if (typeof value !== 'string') return null;
  const match = REQUEST_ID_RE.exec(value);
  if (!match) return null;
  const suffix = value.slice(match[1].length + match[2].length);
  const segments = suffix.length === 0 ? [] : suffix.slice(1).split('.').map(segment => {
    const number = Number(segment);
    if (!Number.isSafeInteger(number)) {
      throw new RangeError(`Request id segment is outside the safe integer range: ${segment}`);
    }
    return number;
  });
  return Object.freeze({
    id: value,
    family: match[1],
    root: `${match[1]}${match[2]}`,
    rootNumber: Number(match[2]),
    segments: Object.freeze(segments)
  });
}

function isRequestId(value, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Reflect.ownKeys(options).some(key => key !== 'family' && key !== 'rootOnly')) {
    return false;
  }
  const parsed = parseRequestId(value);
  if (!parsed) return false;
  if (options.family !== undefined && parsed.family !== options.family) return false;
  return options.rootOnly !== true || parsed.segments.length === 0;
}

function compareRequestIds(left, right) {
  const parsedLeft = parseRequestId(left);
  const parsedRight = parseRequestId(right);
  if (!parsedLeft || !parsedRight) throw new TypeError('compareRequestIds requires valid request ids.');
  if (parsedLeft.family !== parsedRight.family) return parsedLeft.family.localeCompare(parsedRight.family);
  if (parsedLeft.rootNumber !== parsedRight.rootNumber) return parsedLeft.rootNumber - parsedRight.rootNumber;
  const count = Math.max(parsedLeft.segments.length, parsedRight.segments.length);
  for (let index = 0; index < count; index += 1) {
    if (index >= parsedLeft.segments.length) return -1;
    if (index >= parsedRight.segments.length) return 1;
    if (parsedLeft.segments[index] !== parsedRight.segments[index]) {
      return parsedLeft.segments[index] - parsedRight.segments[index];
    }
  }
  return left.localeCompare(right);
}

module.exports = Object.freeze({
  REQUEST_ID_RE,
  parseRequestId,
  isRequestId,
  compareRequestIds
});
