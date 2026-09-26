'use strict';

// Independent allowance meters are not subscription periods or an account
// total. Null scope means unknown, never "all models". Quantities remain in
// the provider's units; a fraction is not enough to invent a request limit.
const MAX_BUCKETS = 256;
const MAX_TEXT = 128;
const MAX_AMOUNT = 128;

function dataRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => Object.hasOwn(field, 'value'));
}

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

// Validate calendar dates explicitly: Date.parse alone accepts February 30.
// Retain the original timestamp, including its offset and sub-millisecond
// precision. There is no inferred duration or reset period.
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (offset === 'Z' || (Number(offset.slice(1, 3)) < 24 && Number(offset.slice(4)) < 60))
    && Number.isFinite(Date.parse(value));
}

function quantityPresent(bucket) {
  return bucket.remainingFraction !== null || bucket.remainingAmount !== null;
}

function statusOf(buckets, issues) {
  if (!buckets.some(quantityPresent)) return 'unknown';
  return issues.length || buckets.some(bucket => bucket.issues.length || !quantityPresent(bucket))
    ? 'partial' : 'measured';
}

function decodeBucket(value) {
  if (!dataRecord(value)) return null;
  const issues = [];
  const optional = (key, valid) => {
    const candidate = Object.hasOwn(value, key) ? value[key] : undefined;
    if (candidate === null || candidate === undefined) return null;
    if (valid(candidate)) return candidate;
    issues.push(`invalid_${key}`);
    return null;
  };
  const modelId = optional('modelId', text);
  const tokenType = optional('tokenType', text);
  let remainingFraction = optional('remainingFraction', candidate => typeof candidate === 'number'
    && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1);
  let remainingAmount = optional('remainingAmount', candidate => typeof candidate === 'string'
    && candidate.length <= MAX_AMOUNT && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(candidate));
  const resetsAt = optional('resetsAt', timestamp);
  // A corrupt identity field must not turn into a measured unscoped meter.
  if (issues.includes('invalid_modelId') || issues.includes('invalid_tokenType')) {
    remainingFraction = null;
    remainingAmount = null;
  }
  if (modelId === null) issues.push('model_scope_unknown');
  if (tokenType === null) issues.push('token_scope_unknown');
  return { key: JSON.stringify([modelId, tokenType]), modelId, tokenType,
    remainingFraction, remainingAmount, resetsAt, issues };
}

/** Pure, bounded normalization of provider-neutral independent meters.
 * Metadata is required caller context. Malformed provider data produces an
 * explicit unknown/partial reading; invalid caller metadata throws TypeError.
 * Each bucket's key identifies its reported model/token scope, not a period.
 */
function normalizeAllowanceBuckets({ provider, source, sourceVersion, observedAt, buckets } = {}) {
  if (!text(provider) || !text(source) || !text(sourceVersion, 64) || !timestamp(observedAt)) {
    throw new TypeError('Allowance source and observation metadata are invalid.');
  }
  const issues = [];
  const groups = new Map();
  if (!Array.isArray(buckets)) issues.push(Object.freeze({ code: 'invalid_buckets' }));
  else if (buckets.length > MAX_BUCKETS) issues.push(Object.freeze({ code: 'bucket_limit_exceeded' }));
  else for (let index = 0; index < buckets.length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(buckets, String(index));
    const bucket = decodeBucket(field && Object.hasOwn(field, 'value') ? field.value : null);
    if (!bucket) {
      issues.push(Object.freeze({ code: 'invalid_bucket', index }));
      continue;
    }
    const signature = JSON.stringify(bucket);
    const group = groups.get(bucket.key);
    if (!group) groups.set(bucket.key, { bucket, signature, count: 1, conflict: false });
    else {
      group.count += 1;
      group.conflict ||= group.signature !== signature;
    }
  }
  const normalized = [...groups.values()].map(({ bucket, count, conflict }) => {
    if (count > 1) bucket.issues.push('duplicate_bucket');
    if (conflict) {
      bucket.issues.push('conflicting_buckets');
      bucket.remainingFraction = null;
      bucket.remainingAmount = null;
      bucket.resetsAt = null;
    }
    const status = statusOf([bucket], []);
    return Object.freeze({ ...bucket, status, issues: Object.freeze(bucket.issues) });
  });
  return Object.freeze({ schemaVersion: 1, provider, source, sourceVersion, observedAt,
    status: statusOf(normalized, issues), buckets: Object.freeze(normalized), issues: Object.freeze(issues) });
}

module.exports = Object.freeze({ normalizeAllowanceBuckets, MAX_BUCKETS });
