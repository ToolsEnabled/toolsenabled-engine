'use strict';

require('./lib/isolated-environment').activate('vertex-gemini-seat-refusals');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const identity = { alias: 'seat-test', email: 'seat-test@example.com', projectId: 'seat-test-project' };
const committedDigests = new Map([
  [identity.alias, 'cb22ca177814c1fcc43afbe3b37ff7ff875099d6c116169781ca503bdd81be07'],
  [identity.email, 'cdeb46d7d4fa662874dd4e760d8f48440f0314fda733f9d9696f3ad95732e0b8'],
  [identity.projectId, '5747bffb641d35270b5ae4ceda65752a6c9213f315fde02ae7ab691b92b4ff56']
]);
const realCreateHash = crypto.createHash;
crypto.createHash = function createHash(algorithm, options) {
  const hash = realCreateHash.call(this, algorithm, options);
  let input;
  const update = hash.update.bind(hash);
  hash.update = (value, encoding) => { input = String(value); update(value, encoding); return hash; };
  const digest = hash.digest.bind(hash);
  hash.digest = encoding => encoding === 'hex' && committedDigests.has(input)
    ? committedDigests.get(input) : digest(encoding);
  return hash;
};

// Keep import-time defaults inert. Calls below inject every effectful dependency.
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../audit' && parent && /[\\/]providers[\\/]/.test(parent.filename)) return { record() {}, scrubText: value => value };
  if (request === '../state-store' && parent && /[\\/]providers[\\/]/.test(parent.filename)) return { getStateStore: () => ({}) };
  return realLoad.call(this, request, parent, isMain);
};
const seat = require('../src/lib/providers/vertex-gemini-seat');
Module._load = realLoad;

function config() {
  return {
    version: 2, routeKind: 'vertex-seat', execution: 'enabled', ownerDeclaredSeat: true,
    runtimeVerified: true, accountAlias: identity.alias, accountEmail: identity.email,
    projectId: identity.projectId, location: 'global', model: seat.MODEL,
    thinkingLevel: 'HIGH', dailyCostCapUsd: 10,
    authEvidence: {
      gcloudUserCredential: 'observed', accountProjectBinding: 'direct-role-evidence',
      vertexAiServiceEnabled: 'observed', seatOrBillingEntitlement: 'owner-declared'
    }
  };
}

function registry(overrides = {}) {
  return {
    resolve: () => identity.alias,
    load: () => ({ accounts: { [identity.alias]: { email: identity.email } } }),
    list: () => [{ alias: identity.alias, email: identity.email }],
    ...overrides
  };
}

function fixture(finishReason, overrides = {}) {
  const effects = { requests: 0, spend: 0, usage: 0, audits: [] };
  const deps = {
    seatConfig: config(), accountRegistry: registry(), assertActive() {}, gcloudAvailable: () => true,
    run(_command, args) {
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ account: identity.email, status: 'ACTIVE' }]), stderr: '' };
      if (args[1] === 'print-access-token') return { status: 0, stdout: 'fixture-access-token', stderr: '' };
      throw new Error(`unexpected process request: ${args.join(' ')}`);
    },
    request: async () => {
      effects.requests += 1;
      return {
        candidates: [{ content: { parts: [{ text: 'provider refused this completion' }] }, finishReason }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }
      };
    },
    state: {
      recordSpend() { effects.spend += 1; },
      recordModelUsage() { effects.usage += 1; }
    },
    record: (...args) => effects.audits.push(args), usageAttribution: {}, now: () => 100,
    randomId: () => 'fixed', ...overrides
  };
  return { deps, effects };
}

const finishRefusals = [
  'BLOCKLIST', 'FINISH_REASON_UNSPECIFIED', 'IMAGE_OTHER', 'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION', 'IMAGE_SAFETY', 'MALFORMED_FUNCTION_CALL', 'MODEL_ARMOR',
  'PROHIBITED_CONTENT', 'RECITATION', 'SAFETY'
];

(async () => {
  for (const finishReason of finishRefusals) {
    const { deps, effects } = fixture(finishReason);
    await assert.rejects(
      seat.geminiSeatComplete({ prompt: 'A bounded, non-sensitive prompt.', maxOutputTokens: 256, selfReview: false }, deps),
      error => error && error.code === 'VERTEX_SEAT_INCOMPLETE_FINISH'
        && error.details.finishReason === finishReason
        && error.details.pass === 1,
      `${finishReason} must drive the incomplete-finish refusal with its provider reason preserved`
    );
    assert.equal(effects.requests, 1, `${finishReason}: no review request was spawned after refusal`);
    assert.equal(effects.usage, 0, `${finishReason}: refused output was not written to the usage ledger`);
    assert.equal(effects.spend, 1, `${finishReason}: only the mandatory pre-request reservation occurred`);
    assert.equal(effects.audits.length, 1, `${finishReason}: only the refusal audit was written`);
    assert.equal(effects.audits[0][0], 'vertex.gemini.seat_complete.failed');
    assert.equal(effects.audits[0][2].finishReason, finishReason);
  }

  const unavailable = fixture('STOP', { accountRegistry: registry({ load() { throw new Error('registry offline'); } }) });
  await assert.rejects(
    seat.geminiSeatComplete({ prompt: 'Do not leave the machine.', maxOutputTokens: 256, selfReview: false }, unavailable.deps),
    error => error && error.code === 'VERTEX_SEAT_ACCOUNT_REGISTRY_UNAVAILABLE'
  );
  assert.deepEqual(unavailable.effects, { requests: 0, spend: 0, usage: 0, audits: [] },
    'an unavailable identity registry refuses before requests, reservations, ledger writes, or audits');

  const status = seat.seatStatus({ seatConfig: config(), accountRegistry: registry({ list() { throw new Error('registry offline'); } }) });
  assert.equal(status.ready, false);
  assert.equal(status.canRunBoundedProbe, false);
  assert.deepEqual(status.missing.map(item => item.code), ['VERTEX_SEAT_ACCOUNT_REGISTRY_UNAVAILABLE']);

  console.log(`Vertex Gemini seat driven refusal tests passed (${finishRefusals.length + 1} refusal codes).`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
