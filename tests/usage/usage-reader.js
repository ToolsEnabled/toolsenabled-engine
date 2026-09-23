'use strict';

const assert = require('node:assert/strict');
const {
  CLAUDE_AGENT_SDK_USAGE_METHOD,
  FRESHNESS,
  PROVENANCE,
  SCOPE,
  UNKNOWN_REASONS,
  UsageReader,
  createAuditedLocalLedgerAdapter,
  createClaudeAgentSdkUsageReader,
  createClaudeSubscriptionAdapter,
  createCodexChatgptAdapter,
  createGeminiSubscriptionAdapter,
  createVertexCreditAdapter,
  derivedUsageRecord,
  measuredUsageRecord,
  unknownUsageRecord
} = require('../../src/lib/usage');
const { CODEX_APP_SERVER_CLI_VERSION } = require('../../src/lib/usage/adapters/codex-chatgpt');

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const EARLIER = '2026-08-03T11:59:00.000Z';

function account(overrides = {}) {
  return {
    accountId: 'account-main',
    provider: 'codex',
    lane: 'subscription-cli',
    adapterId: 'test-adapter',
    ...overrides
  };
}

function reader({ accounts = [account()], adapters = [], freshnessBudgetMs = 15 * 60 * 1000 } = {}) {
  return new UsageReader({ accounts, adapters, freshnessBudgetMs, clock: () => NOW });
}

function measuredFor(config = account(), overrides = {}) {
  return measuredUsageRecord({
    ...config,
    used: 12,
    remaining: 88,
    unit: 'requests',
    resetsAt: '2026-08-04T00:00:00.000Z',
    observedAt: EARLIER,
    ...overrides
  });
}

function unknownFor(config = account()) {
  return unknownUsageRecord({
    ...config,
    reason: UNKNOWN_REASONS.PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE,
    observedAt: EARLIER
  });
}

function rateLimitsResponse({ usedPercent = 81, windowDurationMins = 300 } = {}) {
  return {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent, windowDurationMins, resetsAt: 1786305257 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'pro',
    rateLimitReachedType: null
  };
}

function fakeCodexTransport({ response = rateLimitsResponse(), observedAt = EARLIER, cliVersion = CODEX_APP_SERVER_CLI_VERSION } = {}) {
  const requests = [];
  return {
    cliVersion,
    requests,
    async request(message) {
      requests.push(message);
      if (message.method === 'initialize') return { result: { initialized: true }, observedAt };
      if (message.method === 'account/rateLimits/read') return { result: response, observedAt };
      throw new Error(`Unexpected JSON-RPC method: ${message.method}`);
    }
  };
}

function claudeUsageResponse(overrides = {}) {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {}
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 61.27, resets_at: '2026-08-03T16:30:00.000Z' },
      seven_day: { utilization: 43, resets_at: '2026-08-09T08:00:00.000Z' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 28.5, resets_at: '2026-08-09T08:00:00.000Z' }
    },
    behaviors: null,
    ...overrides
  };
}

async function main() {
  // Every provider lane has a concrete adapter.  In this disconnected build
  // their defaults are an honest unknown, never a guessed plan allowance.
  for (const [factory, adapterId, provider, lane] of [
    [createCodexChatgptAdapter, 'codex-chatgpt', 'codex', 'subscription-plan'],
    [createClaudeSubscriptionAdapter, 'claude-subscription', 'claude', 'subscription-plan'],
    [createGeminiSubscriptionAdapter, 'gemini-subscription', 'gemini', 'subscription-plan'],
    [createVertexCreditAdapter, 'vertex-credit', 'vertex', 'credit']
  ]) {
    const configured = account({ accountId: `${adapterId}-account`, provider, lane, adapterId });
    const record = await reader({ accounts: [configured], adapters: [factory()] }).readAll();
    assert.equal(record[0].provenance, PROVENANCE.UNKNOWN, `${adapterId}: absent machine-readable provider surface must be UNKNOWN`);
    assert.equal(record[0].reason, adapterId === 'codex-chatgpt'
      ? UNKNOWN_REASONS.PROVIDER_SURFACE_UNAVAILABLE
      : UNKNOWN_REASONS.PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE);
    assert.equal(record[0].used, null);
    assert.equal(record[0].remaining, null);
  }

  // Claude's public Agent SDK Query exposes a structured /usage control
  // request. The adapter consumes an already-running Query handle, so it does
  // not read a credential, parse terminal text, or create a model turn.
  let claudeSdkCalls = 0;
  const claudeQuery = {
    async [CLAUDE_AGENT_SDK_USAGE_METHOD]() {
      claudeSdkCalls += 1;
      return claudeUsageResponse();
    }
  };
  const claudeAccount = account({
    accountId: 'claude-subscription-account',
    provider: 'claude',
    lane: 'subscription-plan',
    adapterId: 'claude-subscription'
  });
  const claudeMeasured = await reader({
    accounts: [claudeAccount],
    adapters: [createClaudeSubscriptionAdapter({ readUsage: createClaudeAgentSdkUsageReader(claudeQuery) })]
  }).readAll();
  assert.equal(claudeSdkCalls, 1);
  assert.equal(claudeMeasured[0].provenance, PROVENANCE.MEASURED);
  assert.equal(claudeMeasured[0].scope, SCOPE.ACCOUNT_ALLOWANCE);
  assert.equal(claudeMeasured[0].used, 6127);
  assert.equal(claudeMeasured[0].remaining, 3873);
  assert.equal(claudeMeasured[0].unit, 'basis-points-5-hour');
  assert.equal(claudeMeasured[0].resetsAt, '2026-08-03T16:30:00.000Z');

  const claudeSonnet = await reader({
    accounts: [claudeAccount],
    adapters: [createClaudeSubscriptionAdapter({
      readUsage: async () => ({ response: claudeUsageResponse(), observedAt: EARLIER }),
      window: 'seven_day_sonnet'
    })]
  }).readAll();
  assert.equal(claudeSonnet[0].used, 2850);
  assert.equal(claudeSonnet[0].remaining, 7150);
  assert.equal(claudeSonnet[0].unit, 'basis-points-weekly-sonnet');
  assert.equal(claudeSonnet[0].observedAt, EARLIER);

  // The experimental SDK shape is guarded at the adapter boundary. Missing
  // plan scope is UNKNOWN; malformed utilization is a surface error; neither
  // can leak a plausible percentage into the account allowance slot.
  const claudeUnavailable = await reader({
    accounts: [claudeAccount],
    adapters: [createClaudeSubscriptionAdapter({
      readUsage: async () => claudeUsageResponse({ rate_limits_available: false, rate_limits: null })
    })]
  }).readAll();
  assert.equal(claudeUnavailable[0].provenance, PROVENANCE.UNKNOWN);
  assert.equal(claudeUnavailable[0].reason, UNKNOWN_REASONS.PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE);

  const malformedClaudeResponse = claudeUsageResponse();
  malformedClaudeResponse.rate_limits.five_hour.utilization = 101;
  const claudeMalformed = await reader({
    accounts: [claudeAccount],
    adapters: [createClaudeSubscriptionAdapter({ readUsage: async () => malformedClaudeResponse })]
  }).readAll();
  assert.equal(claudeMalformed[0].provenance, PROVENANCE.UNKNOWN);
  assert.equal(claudeMalformed[0].reason, UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID);
  assert.equal(claudeMalformed[0].used, null);
  assert.equal(claudeMalformed[0].remaining, null);
  assert.throws(
    () => createClaudeAgentSdkUsageReader({}),
    /does not expose the pinned experimental usage method/
  );

  // The adapter sends its own bounded app-server handshake over an injected
  // transport, so tests do not spawn Codex or consult a provider surface.
  const transport = fakeCodexTransport();
  const measuredAdapter = createCodexChatgptAdapter({ transport });
  const measuredAccount = account({ adapterId: 'codex-chatgpt' });
  const measured = await reader({ accounts: [measuredAccount], adapters: [measuredAdapter] }).readAll();
  assert.equal(measured[0].provenance, PROVENANCE.MEASURED);
  assert.equal(measured[0].scope, SCOPE.ACCOUNT_ALLOWANCE);
  assert.equal(measured[0].used, 81);
  assert.equal(measured[0].remaining, 19);
  assert.equal(measured[0].unit, 'percent-5-hour');
  assert.equal(measured[0].resetsAt, new Date(1786305257 * 1000).toISOString());
  assert.deepEqual(transport.requests, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }
  ]);

  // Regression: primary is not intrinsically the short window. Its label is
  // derived from the duration returned in this response, which here is weekly.
  const weeklyTransport = fakeCodexTransport({ response: rateLimitsResponse({ windowDurationMins: 10080 }) });
  const weekly = await reader({
    accounts: [measuredAccount],
    adapters: [createCodexChatgptAdapter({ transport: weeklyTransport })]
  }).readAll();
  assert.equal(weekly[0].provenance, PROVENANCE.MEASURED);
  assert.equal(weekly[0].used, 81);
  assert.equal(weekly[0].remaining, 19);
  assert.equal(weekly[0].unit, 'percent-weekly', 'a weekly primary window must not be labelled as a short window');

  // `usedPercent` must be both present and integral; neither a missing value
  // nor a fractional value can become a plausible allowance reading.
  const missingUsedPercent = rateLimitsResponse();
  delete missingUsedPercent.primary.usedPercent;
  for (const malformedResponse of [missingUsedPercent, rateLimitsResponse({ usedPercent: 81.5 })]) {
    const malformedCodex = await reader({
      accounts: [measuredAccount],
      adapters: [createCodexChatgptAdapter({ transport: fakeCodexTransport({ response: malformedResponse }) })]
    }).readAll();
    assert.equal(malformedCodex[0].provenance, PROVENANCE.UNKNOWN);
    assert.equal(malformedCodex[0].reason, UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID);
    assert.equal(malformedCodex[0].used, null);
    assert.equal(malformedCodex[0].remaining, null);
  }

  // A change to the experimental CLI surface is an UNKNOWN, never a number
  // carried over from a previous release or inferred from a similar shape.
  const wrongVersionTransport = fakeCodexTransport({ cliVersion: 'codex-cli 0.146.1' });
  const wrongVersion = await reader({
    accounts: [measuredAccount],
    adapters: [createCodexChatgptAdapter({ transport: wrongVersionTransport })]
  }).readAll();
  assert.equal(wrongVersion[0].provenance, PROVENANCE.UNKNOWN);
  assert.equal(wrongVersion[0].reason, UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID);
  assert.equal(wrongVersion[0].used, null);
  assert.equal(wrongVersionTransport.requests.length, 0, 'version mismatch must fail before app-server I/O');

  const staleTransport = fakeCodexTransport({ observedAt: EARLIER });
  const staleCodex = await reader({
    accounts: [measuredAccount],
    adapters: [createCodexChatgptAdapter({ transport: staleTransport })],
    freshnessBudgetMs: 30_000
  }).readAll();
  assert.equal(staleCodex[0].provenance, PROVENANCE.MEASURED);
  assert.equal(staleCodex[0].freshness, FRESHNESS.STALE);
  assert.equal(staleCodex[0].ageMs, 60_000);

  // Missing adapters are records, not omissions.  This prevents a dashboard
  // from mistaking an unconfigured account for one with no usage.
  const missing = await reader({ accounts: [account({ adapterId: 'not-installed' })] }).readAll();
  assert.equal(missing.length, 1);
  assert.equal(missing[0].provenance, PROVENANCE.UNKNOWN);
  assert.equal(missing[0].reason, UNKNOWN_REASONS.ADAPTER_NOT_CONFIGURED);
  assert.equal(missing[0].used, null);
  assert.equal(missing[0].remaining, null);

  // A supplied measurement retains its timestamp and exposes its exact age
  // instead of being silently treated as current.
  const staleAdapter = Object.freeze({ id: 'test-adapter', read: async input => measuredFor(input) });
  const stale = await reader({ adapters: [staleAdapter], freshnessBudgetMs: 30_000 }).readAll();
  assert.equal(stale[0].freshness, FRESHNESS.STALE);
  assert.equal(stale[0].ageMs, 60_000);
  assert.equal(stale[0].provenance, PROVENANCE.MEASURED);

  // A malformed adapter response fails closed.  It cannot leak an invented
  // partial value through the aggregator.
  const malformedAdapter = Object.freeze({
    id: 'test-adapter',
    read: async () => ({ accountId: 'account-main', provider: 'codex', lane: 'subscription-cli', used: 9 })
  });
  const malformed = await reader({ adapters: [malformedAdapter] }).readAll();
  assert.equal(malformed[0].provenance, PROVENANCE.UNKNOWN);
  assert.equal(malformed[0].reason, UNKNOWN_REASONS.ADAPTER_RESPONSE_INVALID);
  assert.equal(malformed[0].used, null);
  assert.equal(malformed[0].remaining, null);

  // Regression: the reader must never infer MEASURED from a number.  Both
  // lower-provenance source states survive aggregation unchanged.
  const derivedAdapter = Object.freeze({
    id: 'derived-adapter',
    read: async input => derivedUsageRecord({ ...input, used: 31, unit: 'tokens', observedAt: EARLIER })
  });
  const unknownAdapter = Object.freeze({ id: 'unknown-adapter', read: async input => unknownFor(input) });
  const provenanceRecords = await reader({
    accounts: [
      account({ accountId: 'derived-account', adapterId: 'derived-adapter' }),
      account({ accountId: 'unknown-account', adapterId: 'unknown-adapter' })
    ],
    adapters: [derivedAdapter, unknownAdapter]
  }).readAll();
  assert.deepEqual(provenanceRecords.map(record => record.provenance), [PROVENANCE.DERIVED, PROVENANCE.UNKNOWN],
    'REGRESSION: UNKNOWN or DERIVED must never be upgraded to MEASURED by the reader');
  assert.equal(provenanceRecords[0].scope, SCOPE.LOCAL_SYSTEM_ONLY);
  assert.equal(provenanceRecords[0].remaining, null, 'derived local spend must not claim account-wide remaining allowance');
  assert.equal(provenanceRecords[1].used, null);

  // The signed local audit snapshot is useful only when it explicitly says it
  // is complete.  A Claude CLI observation that proves broker exclusion can
  // yield a DERIVED local-system token count, never an account balance.
  const auditAccount = account({
    accountId: 'claude-local', provider: 'claude', lane: 'subscription-cli', adapterId: 'audited-local-ledger'
  });
  const cliObservation = {
    action: 'controller.cli_session.usage',
    details: {
      schemaVersion: 1,
      provider: 'claude',
      observationId: 'obs_abcdefghijklmnop',
      sourceKind: 'local-session-record',
      brokerExcluded: true,
      coverage: 'complete',
      operationCount: 1,
      reportedTokens: 24,
      durationMs: null,
      outputBytes: null,
      transcriptCount: 1
    }
  };
  const auditAdapter = createAuditedLocalLedgerAdapter({
    readAuditLedger: async () => ({ events: [cliObservation], complete: true, observedAt: EARLIER })
  });
  const auditDerived = await reader({ accounts: [auditAccount], adapters: [auditAdapter] }).readAll();
  assert.equal(auditDerived[0].provenance, PROVENANCE.DERIVED);
  assert.equal(auditDerived[0].used, 24);
  assert.equal(auditDerived[0].remaining, null);
  assert.equal(auditDerived[0].scope, SCOPE.LOCAL_SYSTEM_ONLY);

  const partialAuditAdapter = createAuditedLocalLedgerAdapter({
    readAuditLedger: async () => ({ events: [cliObservation], complete: false, observedAt: EARLIER })
  });
  const partialAudit = await reader({ accounts: [auditAccount], adapters: [partialAuditAdapter] }).readAll();
  assert.equal(partialAudit[0].provenance, PROVENANCE.UNKNOWN);
  assert.equal(partialAudit[0].reason, UNKNOWN_REASONS.AUDIT_LEDGER_INCOMPLETE);
  assert.equal(partialAudit[0].used, null, 'partial local evidence must not be converted into a confident zero or total');

  // The lane-churn ledger is parsed as a closed, call-id-deduplicated JSONL
  // evidence format.  Unknown legacy shapes fail closed rather than guessed.
  const churnAccount = account({
    accountId: 'vertex-local', provider: 'vertex', lane: 'credit', adapterId: 'audited-local-ledger', derivationSource: 'agent-churn-ledger'
  });
  const churnText = JSON.stringify({
    schemaVersion: 1,
    kind: 'audited-local-usage',
    callId: 'call-0001',
    accountId: 'vertex-local',
    provider: 'vertex',
    lane: 'credit',
    used: 7,
    unit: 'tokens',
    observedAt: EARLIER
  });
  const churnAdapter = createAuditedLocalLedgerAdapter({
    readChurnLedger: async () => ({ text: churnText, complete: true, observedAt: EARLIER })
  });
  const churnDerived = await reader({ accounts: [churnAccount], adapters: [churnAdapter] }).readAll();
  assert.equal(churnDerived[0].provenance, PROVENANCE.DERIVED);
  assert.equal(churnDerived[0].used, 7);
  assert.equal(churnDerived[0].remaining, null);

  const invalidChurnAdapter = createAuditedLocalLedgerAdapter({
    readChurnLedger: async () => ({ text: '{not-json}', complete: true, observedAt: EARLIER })
  });
  const invalidChurn = await reader({ accounts: [churnAccount], adapters: [invalidChurnAdapter] }).readAll();
  assert.equal(invalidChurn[0].provenance, PROVENANCE.UNKNOWN);
  assert.equal(invalidChurn[0].used, null);
  assert.equal(invalidChurn[0].reason, UNKNOWN_REASONS.CHURN_LEDGER_INCOMPLETE);

  console.log('Usage reader tests passed (provider provenance, staleness, missing/malformed adapters, and audited local derivation).');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
