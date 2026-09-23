'use strict';

// Seam A's client half. This pins what the CLIENT does; the wire contract
// itself is proven against the paid lane's real server code in
// `online-fra-peer-introduction.real-server.js` and against the live service in
// `online-fra-peer-introduction.live.js`. Those two need another checkout and
// the public internet respectively, so the properties that can be pinned
// everywhere are pinned here, where every run of the suite checks them.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createPeerIntroductionClient, OnlineFraPeerIntroductionError
} = require('../src/lib/online-fra-peer-introduction');
const { ensureDeviceIdentity } = require('../src/lib/online-fra-device-identity');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
async function refusalCode(fn) { try { await fn(); } catch (error) { return error.code; } return null; }
async function refusal(fn) { try { await fn(); } catch (error) { return error; } return null; }

function vault() {
  const store = new Map();
  return {
    getSecret: key => {
      if (!store.has(key)) { const error = new Error('absent'); error.code = 'SECRET_NOT_CONFIGURED'; throw error; }
      return store.get(key);
    },
    setSecret: (key, value) => store.set(key, value)
  };
}

/** Records every request, answers from a queue. */
function recorder(answers) {
  const seen = [];
  const queue = [...answers];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body });
    const next = queue.shift();
    if (!next) throw new Error(`no scripted answer for ${url}`);
    if (next.throws) throw new Error(next.throws);
    return {
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new Error('no body');
        return next.body;
      }
    };
  };
  return { seen, fetchImpl };
}

const BASE = 'https://app.toolsenabled.ai';
function client(answers, overrides = {}) {
  const rec = recorder(answers);
  return {
    rec,
    api: createPeerIntroductionClient({
      baseUrl: BASE, cookie: 'toolsenabled_session=abc', vault: vault(), fetchImpl: rec.fetchImpl, ...overrides
    })
  };
}

const DEVICE = { pairId: `pair-${'a'.repeat(32)}`, deviceId: 'device-1' };

(async () => {

  /* ENROLMENT CARRIES THE KEY THIS MACHINE ACTUALLY HOLDS -- and an Origin.
   *
   * The Origin is the one that would have bitten in production: the account
   * service refuses every mutating request whose Origin is absent or unlisted,
   * so a client that sent none was refused 403 at enrolment and never reached
   * the seam at all. Measured against the live deployment, not inferred. */
  {
    const { rec, api } = client([{ status: 201, body: { device: DEVICE, credential: null } }]);
    const result = await api.enrol({ name: 'This computer' });

    const request = rec.seen[0];
    equal(request.url, `${BASE}/v1/devices`, 'enrolment posts to the devices route');
    equal(request.method, 'POST', 'as a POST');
    equal(request.headers.origin, BASE,
      'carrying an Origin -- without it the live service answers 403 ORIGIN_REFUSED');
    equal(request.headers.cookie, 'toolsenabled_session=abc', "and this machine's own session");

    const sent = JSON.parse(request.body);
    equal(sent.name, 'This computer', 'the name is passed through');
    equal(sent.ed25519PublicKey, result.identity.publicKeyWire,
      'and the key sent is exactly the one this machine holds');
    ok(/^[A-Za-z0-9_-]+$/.test(sent.ed25519PublicKey),
      'in base64url, which is the format the account service parses and stores');
    equal(result.device.pairId, DEVICE.pairId, 'the enrolled machine comes back');
  }

  // The origin is overridable, because the allowlist is deployment configuration
  // and a deployment could legitimately name a different surface.
  {
    const { rec, api } = client([{ status: 201, body: { device: DEVICE } }], { origin: 'https://toolsenabled.com' });
    await api.enrol({ name: 'x' });
    equal(rec.seen[0].headers.origin, 'https://toolsenabled.com', 'a configured origin is asserted instead');
  }

  // A refusal is surfaced with the service's own code, not flattened -- a device
  // allowance refusal names the limit, and a person needs to read that.
  {
    const { api } = client([{
      status: 400,
      body: { error: { code: 'HOSTED_ALLOWANCE_REACHED', message: 'This account already has 2 computers connected.' } }
    }]);
    equal(await refusalCode(() => api.enrol({ name: 'third' })), 'HOSTED_ALLOWANCE_REACHED',
      "the service's refusal reaches the caller by name");
  }

  /* A refusal without a service-provided code takes the client's named
   * fallback. Drive the actual enrolment call with an injected HTTP response;
   * checking source text would not prove that this branch can execute. Start
   * with an already-persisted identity so the refusal cannot create or replace
   * vault state, and pin the single attempted request so no retry or follow-up
   * mutation can escape after the refusal. This module has no process-spawn
   * dependency or path; its observable effect boundary is vault + fetch. */
  {
    const persisted = new Map();
    const seeded = ensureDeviceIdentity({
      getSecret: key => {
        if (!persisted.has(key)) { const error = new Error('absent'); error.code = 'SECRET_NOT_CONFIGURED'; throw error; }
        return persisted.get(key);
      },
      setSecret: (key, value) => persisted.set(key, value)
    });
    let vaultWrites = 0;
    const existingVault = {
      getSecret: key => persisted.get(key),
      setSecret: () => { vaultWrites += 1; }
    };
    const rec = recorder([{ status: 503, body: { error: { message: 'enrolment is disabled' } } }]);
    const api = createPeerIntroductionClient({
      baseUrl: BASE,
      cookie: 'toolsenabled_session=abc',
      vault: existingVault,
      fetchImpl: rec.fetchImpl
    });

    const error = await refusal(() => api.enrol({ name: 'refused machine' }));
    ok(error instanceof OnlineFraPeerIntroductionError, 'a code-less enrolment refusal throws the public refusal error');
    equal(error.code, 'DEVICE_ENROL_REFUSED', 'a code-less service refusal reaches the fallback refusal branch');
    equal(error.message, 'enrolment is disabled', 'the service message accompanies the fallback refusal code');
    equal(vaultWrites, 0, 'refusal does not create or replace an already-persisted identity');
    equal(rec.seen.length, 1, 'refusal triggers no retry or follow-up request');
    equal(rec.seen[0].method, 'POST', 'the refusal was reached by driving enrolment over its injected transport');
    equal(seeded.publicKeyWire, JSON.parse(rec.seen[0].body).ed25519PublicKey,
      'the request used the pre-existing identity rather than replacing it');
  }

  // A success status is not enough when its JSON could not be read. In
  // particular, an empty 201 must not be collapsed into an absent credential
  // or device result.
  {
    const { api } = client([{ status: 201 }]);
    equal(await refusalCode(() => api.enrol({ name: 'x' })), 'PEER_INTRODUCTION_RESPONSE_INVALID',
      'an unreadable successful enrolment response is refused explicitly');
  }

  /* THE INTRODUCTION: the peer's key arrives parsed, and is USABLE.
   *
   * Comparing strings would only prove the client copied a field. Verifying a
   * real signature under the returned KeyObject proves the value survived the
   * round trip as a key, which is the only property the session cares about. */
  {
    const peer = ensureDeviceIdentity(vault());
    const { rec, api } = client([{
      status: 200,
      body: {
        peer: {
          peerPairId: `pair-${'b'.repeat(32)}`,
          peerDeviceId: 'device-2',
          peerEd25519PublicKey: peer.publicKeyWire,
          generation: 7,
          relayPairId: `pair-${'c'.repeat(32)}`
        }
      }
    }]);

    const introduction = await api.fetchPeer({ pairId: DEVICE.pairId });
    equal(rec.seen[0].url, `${BASE}/v1/devices/peer?pairId=${DEVICE.pairId}`,
      'the machine asks about ITSELF -- its own pair id is the whole query');
    equal(rec.seen[0].method, 'GET', 'as a read');

    const message = Buffer.from('proof');
    equal(crypto.verify(null, message, introduction.peerPublicKey, peer.sign(message)), true,
      "the peer's signature verifies under the introduced key");
    equal(introduction.generation, 7, 'the generation comes through for lease minting');
    equal(introduction.relayPairId, `pair-${'c'.repeat(32)}`, 'and the relay pair id the lease is scoped to');
  }

  /* 404 IS ONE ANSWER AND THIS CLIENT MUST NOT UNPICK IT.
   *
   * The account service returns an identical 404 NO_PEER for not-yours, no-pair,
   * peer-removed and peer-has-no-key -- deliberately, so the route is not an
   * oracle about somebody else's account. A client that inferred WHICH case it
   * was, or exposed the message, would hand back the distinction the service was
   * built to withhold. So every 404 becomes the same bare null.
   *
   * Pinned by giving the four cases four DIFFERENT bodies and requiring one
   * indistinguishable result. */
  {
    const bodies = [
      { error: { code: 'NO_PEER', message: 'No peer introduction is available for that machine.' } },
      { error: { code: 'NO_PEER', message: 'something else entirely' } },
      { error: { code: 'DIFFERENT_CODE', message: 'a service that started distinguishing' } },
      undefined
    ];
    for (const body of bodies) {
      const { api } = client([{ status: 404, body }]);
      const answer = await api.fetchPeer({ pairId: DEVICE.pairId });
      equal(answer, null, 'every 404 is the same bare null, with no reason attached');
    }
  }

  // Anything that is neither 200-with-a-peer nor 404 is a refusal rather than a
  // quiet null: "not signed in" must not read as "no peer yet", because the
  // first is fixable and the second is waiting.
  {
    for (const answer of [{ status: 401, body: { error: { code: 'NO_SESSION' } } }, { status: 500 }, { status: 200, body: {} }]) {
      const { api } = client([answer]);
      equal(await refusalCode(() => api.fetchPeer({ pairId: DEVICE.pairId })),
        answer.status === 200 ? 'PEER_INTRODUCTION_RESPONSE_INVALID' : 'PEER_INTRODUCTION_REFUSED',
        `a ${answer.status} without a peer is a typed error, not "no peer yet"`);
    }
  }

  /* A KEY THE SESSION WOULD REFUSE IS REFUSED HERE, at introduction, with a
   * named code -- rather than at the first handshake, far from the cause. The
   * non-canonical encoding case is the one worth pinning: it parses as a key and
   * still must not be accepted, because the e2e session re-encodes and compares. */
  {
    const real = ensureDeviceIdentity(vault()).publicKeyWire;
    const wrong = [
      'not base64url!!',
      Buffer.from(real, 'base64url').toString('base64'), // padded base64, not base64url
      crypto.randomBytes(44).toString('base64url'), // right length, not a key
      crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey
        .export({ type: 'spki', format: 'der' }).toString('base64url') // a key, wrong curve
    ];
    for (const peerEd25519PublicKey of wrong) {
      const { api } = client([{ status: 200, body: { peer: {
        peerEd25519PublicKey, peerDeviceId: 'd', peerPairId: 'peer-pair', relayPairId: 'relay-pair', generation: 1
      } } }]);
      equal(await refusalCode(() => api.fetchPeer({ pairId: DEVICE.pairId })), 'DEVICE_IDENTITY_PEER_INVALID',
        'an unusable peer key is refused at introduction, not at the first handshake');
    }
  }

  // A service that cannot be reached is distinguishable from one that refused --
  // the first is a cable, the second is an answer.
  {
    const { api } = client([{ throws: 'ECONNREFUSED' }]);
    equal(await refusalCode(() => api.enrol({ name: 'x' })), 'PEER_INTRODUCTION_UNREACHABLE',
      'an unreachable service is not a refusal');
  }

  // Configuration is checked at construction, where the mistake is.
  {
    const cases = [
      {},
      { baseUrl: 'app.toolsenabled.ai', cookie: 'a=b' },
      { baseUrl: BASE },
      { baseUrl: BASE, cookie: '' }
    ];
    for (const options of cases) {
      equal(await refusalCode(() => createPeerIntroductionClient({ vault: vault(), ...options })),
        'PEER_INTRODUCTION_CONFIG_INVALID', 'misconfiguration is refused at construction');
    }
  }

  // The surface is two calls and nothing else. No setter for a peer key, and no
  // way to ask about a pair id that is not this machine's -- both absences are
  // the property, so they are pinned.
  {
    const { api } = client([]);
    assert.deepEqual(Object.keys(api).sort(), ['enrol', 'fetchPeer'], 'two calls, no more');
    assertions += 1;
    ok(new OnlineFraPeerIntroductionError('X') instanceof Error, 'refusals are Errors');
  }

  console.log(`online-fra-peer-introduction: ${assertions} assertions passed`);
})().catch(error => { console.error(error); process.exit(1); });
