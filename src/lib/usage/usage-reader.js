'use strict';

const {
  UNKNOWN_REASONS,
  applyFreshness,
  normalizeUsageRecord,
  unknownUsageRecord
} = require('./usage-contract');

class UsageReaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UsageReaderError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UsageReaderError(code, message);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{1,119}$/i.test(value)) {
    fail('USAGE_ACCOUNT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function normalizeAccount(value) {
  if (!plain(value) || Object.keys(value).some(key => !['accountId', 'provider', 'lane', 'adapterId', 'derivationSource'].includes(key))
    || !['accountId', 'provider', 'lane', 'adapterId'].every(key => Object.hasOwn(value, key))) {
    fail('USAGE_ACCOUNT_INVALID', 'Usage account configuration is invalid.');
  }
  if (value.derivationSource !== undefined && !['audit-call-ledger', 'agent-churn-ledger'].includes(value.derivationSource)) {
    fail('USAGE_ACCOUNT_INVALID', 'Usage account derivation source is invalid.');
  }
  return Object.freeze({
    accountId: identifier(value.accountId, 'accountId'),
    provider: identifier(value.provider, 'provider'),
    lane: identifier(value.lane, 'lane'),
    adapterId: identifier(value.adapterId, 'adapterId'),
    ...(value.derivationSource === undefined ? {} : { derivationSource: value.derivationSource })
  });
}

function normalizeAdapters(value) {
  const rows = value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [];
  const adapters = new Map();
  for (const adapter of rows) {
    if (!plain(adapter) || Object.keys(adapter).some(key => !['id', 'read'].includes(key))
      || typeof adapter.id !== 'string' || typeof adapter.read !== 'function') {
      fail('USAGE_ADAPTER_INVALID', 'Usage adapter is invalid.');
    }
    const id = identifier(adapter.id, 'adapter.id');
    if (adapters.has(id)) fail('USAGE_ADAPTER_INVALID', 'Usage adapter identifiers must be unique.');
    adapters.set(id, Object.freeze({ id, read: adapter.read }));
  }
  return adapters;
}

function matchesAccount(record, account) {
  return record.accountId === account.accountId && record.provider === account.provider && record.lane === account.lane;
}

class UsageReader {
  constructor({ accounts, adapters, freshnessBudgetMs = 15 * 60 * 1000, clock = () => Date.now() } = {}) {
    if (!Array.isArray(accounts) || accounts.length === 0) fail('USAGE_ACCOUNTS_INVALID', 'At least one usage account is required.');
    if (!Number.isSafeInteger(freshnessBudgetMs) || freshnessBudgetMs < 0 || typeof clock !== 'function') {
      fail('USAGE_READER_INVALID', 'Usage reader configuration is invalid.');
    }
    const accountIds = new Set();
    this.accounts = Object.freeze(accounts.map(normalizeAccount));
    for (const account of this.accounts) {
      if (accountIds.has(account.accountId)) fail('USAGE_ACCOUNTS_INVALID', 'Usage account identifiers must be unique.');
      accountIds.add(account.accountId);
    }
    this.adapters = normalizeAdapters(adapters);
    this.freshnessBudgetMs = freshnessBudgetMs;
    this.clock = clock;
  }

  nowMs() {
    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('USAGE_READER_CLOCK_INVALID', 'Usage reader clock is invalid.');
    return nowMs;
  }

  unknown(account, reason, nowMs) {
    return applyFreshness(unknownUsageRecord({ ...account, reason, observedAt: nowMs }), {
      nowMs,
      freshnessBudgetMs: this.freshnessBudgetMs
    });
  }

  async readAccount(accountId) {
    const account = this.accounts.find(candidate => candidate.accountId === accountId);
    if (!account) fail('USAGE_ACCOUNT_NOT_FOUND', 'Usage account is not configured.');
    const nowMs = this.nowMs();
    const adapter = this.adapters.get(account.adapterId);
    if (!adapter) return this.unknown(account, UNKNOWN_REASONS.ADAPTER_NOT_CONFIGURED, nowMs);

    let response;
    try {
      response = await adapter.read(account, Object.freeze({ nowMs, freshnessBudgetMs: this.freshnessBudgetMs }));
    } catch {
      return this.unknown(account, UNKNOWN_REASONS.ADAPTER_READ_FAILED, nowMs);
    }
    let record;
    try {
      record = normalizeUsageRecord(response);
      if (!matchesAccount(record, account)) fail('USAGE_ADAPTER_RESPONSE_INVALID', 'Usage adapter response belongs to a different account.');
    } catch {
      return this.unknown(account, UNKNOWN_REASONS.ADAPTER_RESPONSE_INVALID, nowMs);
    }

    // Do not infer provenance from the presence of values.  In particular, a
    // DERIVED or UNKNOWN adapter result stays exactly that; the reader only
    // adds age/freshness metadata after contract validation.
    return applyFreshness(record, { nowMs, freshnessBudgetMs: this.freshnessBudgetMs });
  }

  async readAll() {
    const records = await Promise.all(this.accounts.map(account => this.readAccount(account.accountId)));
    return Object.freeze(records);
  }
}

module.exports = Object.freeze({ UsageReader, UsageReaderError });
