'use strict';

const { normalizeAllowanceBuckets, MAX_BUCKETS } = require('./allowance-buckets');

// @google/gemini-cli-core 0.58.0, RetrieveUserQuotaResponse/BucketInfo.
// No CLI prompt, SDK import, authentication, I/O or account selection belongs
// here. Later callers supply the actual SDK version and observation time.
function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => Object.hasOwn(field, 'value'));
}

function decodeGeminiQuota(value, { observedAt, sourceVersion } = {}) {
  let buckets = null;
  if (record(value)) {
    const raw = Object.hasOwn(value, 'buckets') ? value.buckets : [];
    if (Array.isArray(raw)) {
      buckets = raw.length > MAX_BUCKETS ? raw : Array.from({ length: raw.length }, (_, index) => {
        const field = Object.getOwnPropertyDescriptor(raw, String(index));
        const bucket = field && Object.hasOwn(field, 'value') ? field.value : null;
        if (!record(bucket)) return null;
        const own = key => Object.hasOwn(bucket, key) ? bucket[key] : undefined;
        return { modelId: own('modelId'), tokenType: own('tokenType'),
          remainingFraction: own('remainingFraction'), remainingAmount: own('remainingAmount'),
          resetsAt: own('resetTime') };
      });
    }
  }
  return normalizeAllowanceBuckets({ provider: 'gemini', source: 'gemini-cli-core/retrieveUserQuota',
    sourceVersion, observedAt, buckets });
}

module.exports = Object.freeze({ decodeGeminiQuota });
