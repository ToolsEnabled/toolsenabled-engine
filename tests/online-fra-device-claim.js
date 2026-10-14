// NOTHING FOUND
// report: testcanfail-tests-online-fra-device-claim-js
//
// Mutation audit (mutations were made only in a scratch copy of the repository):
// - Suspect: refusalCode catches the subject's rejection. Mutation: changed the
//   code under test's DEVICE_CLAIM_GONE rejection to MUTATED_CLAIM_GONE. RED:
//     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//     + actual - expected
//     + 'MUTATED_CLAIM_GONE'
//     - 'DEVICE_CLAIM_GONE'
//   The exact-code assertions discriminate; an arbitrary rejection cannot pass.
// - Suspect: the peer-key assertion signs its own challenge. Mutation: made the
//   scratch introduction client parse a different valid Ed25519 public key. RED:
//     AssertionError [ERR_ASSERTION]: and the introduced key still works as a key
//     false !== true
//   The assertion therefore discriminates the returned key from another key.
// - NOT-FOUND (1): no assertion is inside a loop/forEach over a possibly empty
//   collection.
// - NOT-FOUND (2): no exit-status or generic truthy-return assertion is used as
//   a substitute for checking the subject's own output.
// - NOT-FOUND (3): no try/catch or optional chain swallows the tested failure;
//   refusalCode returns null on resolution and exact expected codes on rejection.
// - NOT-FOUND (4): the fetch and vault fakes are boundaries, not mocks of either
//   client under test; assertions inspect client requests, state, and results.
// - NOT-FOUND (5): this file has no skip or platform precondition guard.
// - NOT-FOUND (6): expected values are fixtures/constants independent of the
//   production transformations they check.
// - Preconditions not met: none.
// - Restoration: production source hashes in the working tree remained
//   affa857c...f28f8 and 419b4db...fa27d; after mutation testing, the untouched
//   working tree was GREEN: "online-fra-device-claim: 71 assertions passed".

'use strict';

// The machine's half of the device claim: open, show, poll, store. The wire
// contract is proven against the paid lane's real server code in
// online-fra-device-claim.real-server.js; what is pinned HERE is what the
// CLIENT does -- what it sends, what it stores, and what it refuses.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createDeviceClaimClient, connectionState, DEVICE_CREDENTIAL_VAULT_KEY
} = require('../src/lib/online-fra-device-claim');
const { createPeerIntroductionClient } = require('../src/lib/online-fra-peer-introduction');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
async function refusalCode(fn) { try { await fn(); } catch (error) { return error.code; } return null; }

function vault() {
  const store = new Map();
  return {
    store,
    getSecret: key => {
      if (!store.has(key)) { const error = new Error('absent'); error.code = 'SECRET_NOT_CONFIGURED'; throw error; }
      return store.get(key);
    },
    setSecret: (key, value) => store.set(key, value),
    // Shaped like runtime.clearDeviceCredential(): key-bound, takes no key,
    // answers by what it actually removed.
    clearDeviceCredential: () => {
      const status = store.delete(DEVICE_CREDENTIAL_VAULT_KEY) ? 'cleared' : 'absent';
      return { key: DEVICE_CREDENTIAL_VAULT_KEY, status };
    }
  };
}

function recorder(answers) {
  const seen = [];
  const queue = [...answers];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = queue.shift();
    if (!next) throw new Error(`no scripted answer for ${url}`);
    return { status: next.status, json: async () => next.body };
  };
  return { seen, fetchImpl };
}

const BASE = 'https://app.toolsenabled.ai';
const DEVICE = { pairId: `pair-${'a'.repeat(32)}`, deviceId: 'device-1', name: 'Desk PC' };

(async () => {

  // A machine with no stored credential is simply not connected -- the absence
  // of the vault key IS the predicate, with no separate flag to drift.
  {
    equal(connectionState(vault()).connected, false, 'no credential, not connected');
  }

  /* OPENING A CLAIM sends this machine's real identity key and an Origin, and
     hands the surface exactly what it needs: the code for the screen, the
     expiry, the interval, and the poll token it will hand back. */
  {
    const v = vault();
    const rec = recorder([{
      status: 201,
      body: { claim: { code: 'TC-K7QP-4M2X', pollToken: 'poll-1', expiresAtMs: 999, intervalSeconds: 5 } }
    }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    const opened = await client.openClaim({ name: 'Desk PC' });

    equal(rec.seen[0].url, `${BASE}/v1/devices/claim-code`, 'the claim opens at the claim route');
    equal(rec.seen[0].headers.origin, BASE, 'asserting an Origin -- the live box refuses without one');
    const sent = JSON.parse(rec.seen[0].body);
    equal(sent.name, 'Desk PC');
    ok(/^[A-Za-z0-9_-]+$/.test(sent.ed25519PublicKey), 'carrying this machine\'s real identity key');
    ok(v.store.has('custom.online_fra_device_identity_v1'), 'which was minted into the vault on the way');
    equal(opened.code, 'TC-K7QP-4M2X', 'the code is for the screen');
    equal(opened.intervalSeconds, 5, 'and the interval is the service\'s to name');
  }

  // Pending is pending: nothing stored, nothing invented.
  {
    const v = vault();
    const rec = recorder([{ status: 200, body: { state: 'pending', intervalSeconds: 5 } }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    const result = await client.pollOnce({ pollToken: 'poll-1' });
    equal(result.state, 'pending');
    equal(connectionState(v).connected, false, 'a pending poll stores nothing');
    const sent = JSON.parse(rec.seen[0].body);
    equal(sent.pollToken, 'poll-1', 'the token travels in the BODY, never the URL -- logs must not see it');
  }

  /* RESERVED IS A QUESTION, NOT PERMISSION. The account email crosses the
     wire only as untrusted display text for the surface. Merely observing the
     reservation must not send `accept` or make a second request. */
  {
    const v = vault();
    const untrustedEmail = '<img src=x onerror="claim()">@example.com';
    const rec = recorder([{
      status: 200,
      body: { state: 'reserved', account: { email: untrustedEmail }, intervalSeconds: 5 }
    }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    const result = await client.pollOnce({ pollToken: 'poll-reserved' });

    equal(result.state, 'reserved');
    equal(result.account.email, untrustedEmail, 'wire text is returned as data, never interpolated by this layer');
    equal(result.intervalSeconds, 5);
    equal(rec.seen.length, 1, 'polling a reservation cannot auto-accept it');
    const sent = JSON.parse(rec.seen[0].body);
    equal(sent.pollToken, 'poll-reserved');
    equal(sent.accept, undefined, 'a poll has no decision field');
    equal(connectionState(v).connected, false, 'a reservation stores no credential');
    equal(await refusalCode(() => client.decideClaim({ pollToken: 'poll-reserved' })),
      'DEVICE_CLAIM_CONFIG_INVALID', 'the decision must be an explicit boolean');
    equal(rec.seen.length, 1, 'an absent decision is refused before the network');
  }

  // Acceptance is explicit and only parks the grant; it does not connect yet.
  {
    const v = vault();
    const rec = recorder([{ status: 202, body: { state: 'accepted' } }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    const result = await client.decideClaim({ pollToken: 'poll-accept', accept: true });

    equal(result.state, 'accepted');
    equal(rec.seen[0].url, `${BASE}/v1/devices/claim-code/status`, 'the decision uses the status route');
    const sent = JSON.parse(rec.seen[0].body);
    equal(sent.pollToken, 'poll-accept');
    equal(sent.accept, true, 'the person\'s acceptance is sent explicitly');
    equal(connectionState(v).connected, false, 'acceptance alone does not claim a stored credential');
  }

  /* Declining consumes the reservation. Its later 404 remains the same local
     answer as expired, collected and never-existed, so the token is no oracle. */
  {
    const v = vault();
    const rec = recorder([
      { status: 200, body: { state: 'rejected' } },
      { status: 404, body: { error: { code: 'CLAIM_UNKNOWN' } } }
    ]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    const result = await client.decideClaim({ pollToken: 'poll-decline', accept: false });

    equal(result.state, 'rejected');
    const sent = JSON.parse(rec.seen[0].body);
    equal(sent.pollToken, 'poll-decline');
    equal(sent.accept, false, 'the person\'s decline is sent explicitly');
    equal(await refusalCode(() => client.pollOnce({ pollToken: 'poll-decline' })), 'DEVICE_CLAIM_GONE');
    equal(connectionState(v).connected, false, 'declining stores nothing');
  }

  /* A LOST ACCEPTANCE RESPONSE is recoverable. The server may have enrolled
     and parked the grant before the socket failed; the next ordinary poll,
     with no repeated decision, collects and stores it. */
  {
    const v = vault();
    const seen = [];
    const fetchImpl = async (url, init) => {
      const sent = JSON.parse(init.body);
      seen.push({ url, sent });
      if (seen.length === 1) {
        equal(sent.accept, true, 'the lost request was the explicit acceptance');
        throw new Error('socket reset after server accepted');
      }
      return {
        status: 200,
        json: async () => ({
          state: 'granted', device: DEVICE,
          credential: { certificatePem: 'CERT-RECOVERED', privateKeyPem: 'KEY-RECOVERED' },
          deviceToken: 'dt_recovered-token'
        })
      };
    };
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl, now: () => 67890 });

    equal(await refusalCode(() => client.decideClaim({ pollToken: 'poll-recover', accept: true })),
      'DEVICE_CLAIM_UNREACHABLE', 'the lost response is reported honestly');
    const collected = await client.pollOnce({ pollToken: 'poll-recover' });
    equal(collected.state, 'connected');
    equal(seen.length, 2);
    equal(seen[1].sent.pollToken, 'poll-recover');
    equal(seen[1].sent.accept, undefined, 'recovery collects; it does not replay acceptance');
    equal(connectionState(v).deviceToken, 'dt_recovered-token');
    equal(connectionState(v).privateKeyPem, 'KEY-RECOVERED');
    equal(connectionState(v).claimedAtMs, 67890);
  }

  /* THE GRANT: stored before reported, and stored WHOLE -- device row,
     certificate, and the machine's own API token, under one vault key,
     because "connected to an account" is one fact. */
  {
    const v = vault();
    const rec = recorder([{
      status: 200,
      body: {
        state: 'granted',
        device: DEVICE,
        credential: { certificatePem: 'CERT', privateKeyPem: 'KEY' },
        deviceToken: 'dt_machine-token'
      }
    }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl, now: () => 12345 });
    const result = await client.pollOnce({ pollToken: 'poll-1' });
    equal(result.state, 'connected');

    const state = connectionState(v);
    equal(state.connected, true, 'the machine is now connected');
    equal(state.pairId, DEVICE.pairId);
    equal(state.deviceToken, 'dt_machine-token', 'holding its own standing at the API');
    equal(state.privateKeyPem, 'KEY', 'and its certificate\'s private half, which never travelled anywhere else');
    equal(state.claimedAtMs, 12345);

    // And a connected machine refuses to open a second claim -- two identities
    // for one machine is a support puzzle nobody needs.
    equal(await refusalCode(() => client.openClaim({ name: 'again' })), 'DEVICE_CLAIM_ALREADY_CONNECTED');
  }

  /* THE STORED CREDENTIAL DRIVES THE INTRODUCTION. This is the join the whole
     flow exists for: the introduction client runs on the machine's own token,
     no cookie anywhere, and the peer's key still verifies as a key. */
  {
    const peerKey = crypto.generateKeyPairSync('ed25519');
    const peerWire = peerKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const v = vault();
    v.setSecret(DEVICE_CREDENTIAL_VAULT_KEY, JSON.stringify({
      pairId: DEVICE.pairId, deviceId: DEVICE.deviceId, name: DEVICE.name,
      certificatePem: 'CERT', privateKeyPem: 'KEY', deviceToken: 'dt_machine-token', claimedAtMs: 1
    }));

    const state = connectionState(v);
    const rec = recorder([{
      status: 200,
      body: { peer: { peerPairId: `pair-${'b'.repeat(32)}`, peerDeviceId: 'device-2', peerEd25519PublicKey: peerWire, generation: 1, relayPairId: `pair-${'c'.repeat(32)}` } }
    }]);
    const introductions = createPeerIntroductionClient({
      baseUrl: BASE, deviceToken: state.deviceToken, vault: v, fetchImpl: rec.fetchImpl
    });
    const introduced = await introductions.fetchPeer({ pairId: state.pairId });

    equal(rec.seen[0].headers.authorization, 'Device dt_machine-token',
      'the machine authenticates as ITSELF, with the token it collected');
    equal(rec.seen[0].headers.cookie, undefined, 'no cookie exists anywhere in this path');
    const message = Buffer.from('proof');
    equal(crypto.verify(null, message, introduced.peerPublicKey, crypto.sign(null, message, peerKey.privateKey)), true,
      'and the introduced key still works as a key');
  }

  // Exactly one credential: both or neither is a configuration bug, named.
  {
    const v = vault();
    equal(await refusalCode(() => createPeerIntroductionClient({ baseUrl: BASE, vault: v })),
      'PEER_INTRODUCTION_CONFIG_INVALID', 'neither credential is refused');
    equal(await refusalCode(() => createPeerIntroductionClient({ baseUrl: BASE, vault: v, cookie: 'a=b', deviceToken: 'dt_x' })),
      'PEER_INTRODUCTION_CONFIG_INVALID', 'both at once is refused -- ambiguous authority is not resolved quietly');
    // And a machine (token) cannot enrol: enrolment is a person's act.
    const machine = createPeerIntroductionClient({ baseUrl: BASE, vault: v, deviceToken: 'dt_x', fetchImpl: async () => { throw new Error('must not be called'); } });
    equal(await refusalCode(() => machine.enrol({ name: 'x' })), 'PEER_INTRODUCTION_CONFIG_INVALID');
  }

  /* GONE IS ONE ANSWER. Expired, collected and never-existed all come back
     404 from the service, and the client hands its surface one instruction --
     open a new claim -- rather than a guess about which it was. */
  {
    const v = vault();
    const rec = recorder([{ status: 404, body: { error: { code: 'CLAIM_UNKNOWN' } } }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    equal(await refusalCode(() => client.pollOnce({ pollToken: 'poll-1' })), 'DEVICE_CLAIM_GONE');
  }

  // Refusals arrive by the service's own name; a dead service is not a refusal.
  {
    const v = vault();
    const refused = recorder([{ status: 503, body: { error: { code: 'CLAIM_CAPACITY', message: 'busy' } } }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: refused.fetchImpl });
    equal(await refusalCode(() => client.openClaim({ name: 'Desk' })), 'CLAIM_CAPACITY');

    const dead = createDeviceClaimClient({
      baseUrl: BASE, vault: vault(), fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });
    equal(await refusalCode(() => dead.openClaim({ name: 'Desk' })), 'DEVICE_CLAIM_UNREACHABLE');
  }

  // A corrupted stored credential is refused with instructions, never treated
  // as "not connected" -- silently rejoining would mint a second identity.
  {
    const v = vault();
    v.setSecret(DEVICE_CREDENTIAL_VAULT_KEY, 'not json');
    equal(await refusalCode(() => Promise.resolve(connectionState(v))), 'DEVICE_CLAIM_CREDENTIAL_INVALID');
  }

  /* DISCONNECT THIS COMPUTER. The credential goes; the identity key stays,
     because re-joining is a new introduction and not a key update; and the
     machine answers "not connected" from then on. */
  {
    const v = vault();
    const rec = recorder([{
      status: 200,
      body: { state: 'granted', device: DEVICE, credential: { certificatePem: 'CERT', privateKeyPem: 'KEY' }, deviceToken: 'dt_machine-token' }
    }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    await client.pollOnce({ pollToken: 'poll-1' });
    v.setSecret('custom.online_fra_device_identity_v1', 'identity-stays');
    equal(client.connectionState().connected, true, 'connected before the clear');

    const cleared = client.clearConnection();
    equal(cleared.cleared, true);
    equal(cleared.wasConnected, true, 'a connected machine reports it was connected');
    equal(cleared.mutationOutcome, 'UNCERTAIN', 'legacy key/status is not directory-sync evidence');
    equal(connectionState(v).connected, false, 'and is not connected afterwards');
    equal(client.connectionState().connected, false, 'by either route');
    equal(v.store.has(DEVICE_CREDENTIAL_VAULT_KEY), false, 'the credential is gone');
    equal(v.store.get('custom.online_fra_device_identity_v1'), 'identity-stays', 'the identity key is untouched');
    equal(rec.seen.length, 1, 'and the service was told nothing -- there is no session to end');

    // A second press is honest: nothing was there to clear.
    const again = client.clearConnection();
    equal(again.cleared, true);
    equal(again.wasConnected, false, 'a second press answers wasConnected:false');
    equal(again.mutationOutcome, 'UNCERTAIN', 'legacy absence is not reconciliation of an earlier operation');
  }

  // The "refuses to open a second claim" case inverts after a clear: the
  // machine can claim again, as a new introduction.
  {
    const v = vault();
    const rec = recorder([
      { status: 200, body: { state: 'granted', device: DEVICE, deviceToken: 'dt_machine-token' } },
      { status: 201, body: { claim: { code: 'TC-NEW1-CODE', pollToken: 'poll-2', expiresAtMs: 999, intervalSeconds: 5 } } }
    ]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    await client.pollOnce({ pollToken: 'poll-1' });
    equal(await refusalCode(() => client.openClaim({ name: 'again' })), 'DEVICE_CLAIM_ALREADY_CONNECTED', 'connected: refused');
    client.clearConnection();
    const reopened = await client.openClaim({ name: 'again' });
    equal(reopened.code, 'TC-NEW1-CODE', 'cleared: a new claim opens');
  }

  // A vault that cannot clear is refused, typed, by clearConnection ONLY --
  // the client still constructs and openClaim still works on it.
  {
    const v = vault();
    delete v.clearDeviceCredential;
    const rec = recorder([{
      status: 201, body: { claim: { code: 'TC-K7QP-4M2X', pollToken: 'poll-1', expiresAtMs: 999, intervalSeconds: 5 } }
    }]);
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v, fetchImpl: rec.fetchImpl });
    equal(await refusalCode(() => Promise.resolve(client.clearConnection())), 'DEVICE_CLAIM_CONFIG_INVALID');
    equal((await client.openClaim({ name: 'Desk PC' })).code, 'TC-K7QP-4M2X', 'openClaim is untouched by the missing verb');

    // And a vault that answers the disconnect in a shape this module does not
    // recognise is a configuration bug, not a silent "cleared".
    const odd = vault();
    odd.clearDeviceCredential = () => ({ status: 'maybe' });
    const oddClient = createDeviceClaimClient({ baseUrl: BASE, vault: odd, fetchImpl: rec.fetchImpl });
    equal(await refusalCode(() => Promise.resolve(oddClient.clearConnection())), 'DEVICE_CLAIM_CONFIG_INVALID');
  }

  // New Linux receipts retain evidence; malformed or inconsistent receipts
  // cannot silently upgrade a clear or erase its uncertainty.
  {
    const v = vault();
    const client = createDeviceClaimClient({ baseUrl: BASE, vault: v });
    for (const [status, mutationOutcome] of [['cleared', 'REMOVED_SYNCED'], ['absent', 'NOT_ATTEMPTED']]) {
      v.clearDeviceCredential = () => ({ key: DEVICE_CREDENTIAL_VAULT_KEY, status, mutationOutcome });
      equal(client.clearConnection().mutationOutcome, mutationOutcome);
    }
    for (const result of [
      { key: DEVICE_CREDENTIAL_VAULT_KEY, status: 'cleared', mutationOutcome: 'NOT_ATTEMPTED' },
      { key: DEVICE_CREDENTIAL_VAULT_KEY, status: 'absent', mutationOutcome: 'REMOVED_SYNCED' },
      { key: DEVICE_CREDENTIAL_VAULT_KEY, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED', value: 'private' },
      { key: 'custom.other', status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' }, null
    ]) {
      v.clearDeviceCredential = () => result;
      let caught;
      try { client.clearConnection(); } catch (error) { caught = error; }
      equal(caught && caught.code, 'DEVICE_CLAIM_CONFIG_INVALID');
      equal(caught && caught.mutationOutcome, 'UNCERTAIN');
      equal(caught && caught.localCause, 'SECRET_HELPER_PROTOCOL_INVALID');
    }
    for (const [status, mutationOutcome] of [['cleared', 'REMOVED_SYNCED'], ['absent', 'NOT_ATTEMPTED']]) {
      let reads = 0;
      v.clearDeviceCredential = () => ({ key: DEVICE_CREDENTIAL_VAULT_KEY, status,
        get mutationOutcome() { return ++reads === 1 ? mutationOutcome : 'synthetic-private-outcome'; } });
      equal(client.clearConnection().mutationOutcome, mutationOutcome);
      equal(reads, 1, 'outcome classification and projection use one captured value');
    }
    v.clearDeviceCredential = () => ({ key: DEVICE_CREDENTIAL_VAULT_KEY, status: 'cleared',
      get mutationOutcome() { throw new Error('synthetic-private-outcome'); } });
    let caught;
    try { client.clearConnection(); } catch (error) { caught = error; }
    equal(caught && caught.code, 'DEVICE_CLAIM_CONFIG_INVALID');
    equal(caught && caught.mutationOutcome, 'UNCERTAIN');
    equal(caught && caught.localCause, 'SECRET_HELPER_PROTOCOL_INVALID');
    equal(caught.message.includes('synthetic-private-outcome'), false);
  }

  console.log(`online-fra-device-claim: ${assertions} assertions passed`);
})().catch(error => { console.error(error); process.exit(1); });
