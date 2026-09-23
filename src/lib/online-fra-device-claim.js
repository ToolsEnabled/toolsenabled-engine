'use strict';

// THE MACHINE'S HALF OF JOINING AN ACCOUNT.
//
// The account service's claim flow (their `device-claims.js`) runs the way a
// TV signs in: this machine opens a claim and shows a short code; the person
// types it on the website, where they are already signed in, and proves a
// second factor; this machine polls, shows which account reserved it, and the
// person at this machine explicitly accepts or declines. After acceptance a
// later poll collects what was minted for it. The machine NEVER holds the
// account password and never holds a web session -- what it ends up holding
// is precisely its own:
//
//   - its Ed25519 identity (it already had that: ensureDeviceIdentity)
//   - its device row (pairId, deviceId)
//   - its client certificate, when the deployment has a CA
//   - its DEVICE TOKEN -- the machine's own standing at the account API,
//     scoped to reading its introduction and minting its own leases
//
// All of it lands in the vault under one key, because it is one fact: "this
// machine is connected to an account." The absence of that key IS the
// is-this-machine-connected predicate; there is no separate flag to drift.
//
// clearConnection handles only local credential storage; the app separately
// owns durable disconnect intent, live relay quiescence and fresh consent.
// What goes: this credential -- the device row,
// the certificate, the device token. What stays: the machine's long-lived
// identity key (a separate record, never touched -- re-enrolment is a new
// introduction, not a key update); the machine's device row on the account,
// which stays listed until the person removes it on the account page; and
// the account's seat count, which that removal is what changes. Re-joining
// after a clear is a new introduction: a fresh claim, a fresh code, a fresh
// credential. The machine never tells the service it left -- it holds no
// session to end, and the service's own view is corrected on the account
// page, by a person.
//
// The polling contract: the service names an interval and the claim expires in
// minutes. `pollOnce` is a single question on purpose -- the SURFACE (tray,
// panel, walkthrough) owns the loop, because it also owns telling the person
// the code and noticing they gave up. A library that loops forever behind a
// button is how a UI freezes with no one to blame.

const { ensureDeviceIdentity } = require('./online-fra-device-identity');
const { fetchAccountJson, validAccountTimeout, closedAccountRequestOutcome, accountRequestGuidance, ACCOUNT_REQUEST_UNCERTAIN } = require('./online-fra-account-response');

const DEVICE_CREDENTIAL_VAULT_KEY = 'custom.online_fra_device_credential_v1';
const DEFAULT_TIMEOUT_MS = 15_000;

class OnlineFraDeviceClaimError extends Error {
  constructor(code, message, requestOutcome) {
    super(message || code);
    this.name = 'OnlineFraDeviceClaimError';
    this.code = code;
    if (requestOutcome === 'NOT_ATTEMPTED' || requestOutcome === 'UNCERTAIN') this.requestOutcome = requestOutcome;
  }
}

function fail(code, message, requestOutcome) { throw new OnlineFraDeviceClaimError(code, message, requestOutcome); }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function nonemptyString(value) { return typeof value === 'string' && value.length > 0; }
function responseInvalid() {
  fail('DEVICE_CLAIM_RESPONSE_INVALID',
    `The account service returned an incomplete or unreadable claim response. ${ACCOUNT_REQUEST_UNCERTAIN}`, 'UNCERTAIN');
}

/**
 * What this machine holds, or null. Exposed as a top-level function (not only
 * on the client) because "is this machine connected" is asked by surfaces
 * that have no business constructing an HTTP client to find out.
 */
function connectionState(vault) {
  if (!vault || typeof vault.getSecret !== 'function') {
    fail('DEVICE_CLAIM_CONFIG_INVALID', 'Vault access is required.');
  }
  let raw = null;
  try { raw = vault.getSecret(DEVICE_CREDENTIAL_VAULT_KEY); }
  catch (error) {
    if (!error || error.code !== 'SECRET_NOT_CONFIGURED') throw error;
    return Object.freeze({ connected: false });
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    fail('DEVICE_CLAIM_CREDENTIAL_INVALID',
      `The value at ${DEVICE_CREDENTIAL_VAULT_KEY} is not readable. Re-claim this machine.`);
  }
  if (!parsed || typeof parsed.pairId !== 'string' || typeof parsed.deviceToken !== 'string') {
    fail('DEVICE_CLAIM_CREDENTIAL_INVALID',
      `The value at ${DEVICE_CREDENTIAL_VAULT_KEY} is missing its identity. Re-claim this machine.`);
  }
  return Object.freeze({
    connected: true,
    pairId: parsed.pairId,
    deviceId: parsed.deviceId,
    name: parsed.name,
    deviceToken: parsed.deviceToken,
    certificatePem: parsed.certificatePem || null,
    privateKeyPem: parsed.privateKeyPem || null,
    claimedAtMs: parsed.claimedAtMs
  });
}

/**
 * `baseUrl`   the account service origin (https://app.toolsenabled.ai)
 * `vault`     { getSecret, setSecret } -- identity in, credential out.
 *             `clearDeviceCredential` (key-bound; runtime.js exports one) is
 *             required by clearConnection only: a vault without it makes
 *             clearConnection refuse, typed, and nothing else changes.
 * `origin`    the Origin mutating requests assert; defaults to the service's
 *             own origin (measured against the live box: nothing else admits)
 * `fetchImpl` injectable for tests
 */
function createDeviceClaimClient({ baseUrl, vault, origin, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, signal } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    fail('DEVICE_CLAIM_CONFIG_INVALID', 'An http(s) account service origin is required.');
  }
  if (!vault || typeof vault.getSecret !== 'function' || typeof vault.setSecret !== 'function') {
    fail('DEVICE_CLAIM_CONFIG_INVALID', 'Vault access (getSecret, setSecret) is required.');
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') fail('DEVICE_CLAIM_CONFIG_INVALID', 'No fetch implementation available.');
  if (!validAccountTimeout(timeoutMs)) fail('DEVICE_CLAIM_CONFIG_INVALID', 'The account timeout must be a positive bounded integer.');
  const assertedOrigin = origin || new URL(baseUrl).origin;

  async function call(path, body, statusOnly = []) {
    try {
      return await fetchAccountJson(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: assertedOrigin },
        body: JSON.stringify(body),
        signal
      }, { fetchImpl: doFetch, timeoutMs, statusOnly });
    } catch (error) {
      const requestOutcome = closedAccountRequestOutcome(error);
      fail('DEVICE_CLAIM_UNREACHABLE', `The account response could not be completed. ${accountRequestGuidance(requestOutcome)}`,
        requestOutcome);
    }
  }

  /**
   * Open a claim. Returns what the SURFACE needs: the code to show, when it
   * dies, and how often to poll. The poll token rides along because the
   * surface hands it back to pollOnce; it is never shown to anyone.
   */
  async function openClaim({ name } = {}) {
    if (connectionState(vault).connected) {
      fail('DEVICE_CLAIM_ALREADY_CONNECTED',
        'This machine is already connected to an account. Remove it on the account page first, '
        + 'or clear its credential, before claiming again.');
    }
    const identity = ensureDeviceIdentity(vault);
    const { status, body } = await call('/v1/devices/claim-code', {
      name,
      ed25519PublicKey: identity.publicKeyWire
    });
    if (status !== 201) {
      const code = (body && body.error && body.error.code) || 'DEVICE_CLAIM_REFUSED';
      fail(code, (body && body.error && body.error.message) || `The claim was refused (${status}).`);
    }
    if (!record(body) || !record(body.claim)
        || !nonemptyString(body.claim.code) || !nonemptyString(body.claim.pollToken)) responseInvalid();
    return Object.freeze({
      code: body.claim.code,
      pollToken: body.claim.pollToken,
      expiresAtMs: body.claim.expiresAtMs,
      intervalSeconds: body.claim.intervalSeconds
    });
  }

  function requirePollToken(pollToken) {
    if (typeof pollToken !== 'string' || pollToken.length === 0) {
      fail('DEVICE_CLAIM_CONFIG_INVALID', 'The poll token from openClaim is required.');
    }
  }

  function claimGone() {
    fail('DEVICE_CLAIM_GONE',
      'The claim is no longer open -- it expired, or was already collected. Open a new one.');
  }

  /**
   * One poll. Four honest answers:
   *
   *   { state: 'pending' }             keep showing the code
   *   { state: 'reserved', account }   show account.email as untrusted text
   *                                    and ask the person to decide
   *   { state: 'connected', device }   done -- the credential is in the vault
   *   throws DEVICE_CLAIM_GONE         the claim expired, was declined, or
   *                                    was already collected; open a new one
   *
   * The service deliberately cannot say WHICH of expired/declined/collected/
   * never it was, and this client does not guess. A reserved poll never makes
   * the decision: only decideClaim sends `accept`.
   */
  async function pollOnce({ pollToken } = {}) {
    requirePollToken(pollToken);
    const { status, body } = await call('/v1/devices/claim-code/status', { pollToken }, [404]);
    if (status === 404) claimGone();
    if (status !== 200) {
      fail('DEVICE_CLAIM_REFUSED', `The claim status could not be read (${status}).`);
    }
    if (!record(body)) responseInvalid();
    if (body.state === 'pending') {
      return Object.freeze({ state: 'pending', intervalSeconds: body.intervalSeconds });
    }
    if (body.state === 'reserved') {
      if (!record(body.account) || !nonemptyString(body.account.email)) responseInvalid();
      /* Do not format, interpolate, log or otherwise interpret this value.
         It is wire input for the surface to render as text, never markup. */
      return Object.freeze({
        state: 'reserved',
        account: Object.freeze({ email: body.account.email }),
        intervalSeconds: body.intervalSeconds
      });
    }
    if (body.state !== 'granted'
        || !record(body.device)
        || !nonemptyString(body.device.pairId)
        || !nonemptyString(body.device.deviceId)
        || !nonemptyString(body.deviceToken)) responseInvalid();

    /* STORED BEFORE REPORTED, like the identity key: a machine that told its
       surface "connected" and then failed to persist would greet the next
       launch disconnected with no way back but a re-claim someone believes
       already happened. */
    vault.setSecret(DEVICE_CREDENTIAL_VAULT_KEY, JSON.stringify({
      pairId: body.device.pairId,
      deviceId: body.device.deviceId,
      name: body.device.name,
      certificatePem: (body.credential && body.credential.certificatePem) || null,
      privateKeyPem: (body.credential && body.credential.privateKeyPem) || null,
      deviceToken: body.deviceToken,
      claimedAtMs: now()
    }));
    return Object.freeze({ state: 'connected', device: body.device });
  }

  /**
   * Send the PERSON'S explicit decision about the reserved account. This call
   * never collects a grant: after acceptance, pollOnce collects it so a lost
   * acceptance response cannot strand the new credential.
   */
  async function decideClaim({ pollToken, accept } = {}) {
    requirePollToken(pollToken);
    if (typeof accept !== 'boolean') {
      fail('DEVICE_CLAIM_CONFIG_INVALID', 'An explicit accept or decline decision is required.');
    }
    const { status, body } = await call('/v1/devices/claim-code/status', { pollToken, accept }, [404]);
    if (status === 404) claimGone();

    const expectedStatus = accept ? 202 : 200;
    const expectedState = accept ? 'accepted' : 'rejected';
    if (status !== expectedStatus) {
      const code = (body && body.error && body.error.code) || 'DEVICE_CLAIM_REFUSED';
      fail(code, (body && body.error && body.error.message)
        || `The claim decision was refused (${status}).`);
    }
    if (!record(body) || body.state !== expectedState) responseInvalid();
    return Object.freeze({ state: expectedState });
  }

  /**
   * Disconnect this computer: remove the stored credential, and only that.
   * Offline on purpose -- see the header for what goes, what stays, and why
   * the service is not told. Answers
   *
   *   { cleared: true, wasConnected: boolean, mutationOutcome }
   *
   * `wasConnected` is decided by what the vault actually removed, not by
   * reading the credential: a record this module could not parse (the
   * DEVICE_CLAIM_CREDENTIAL_INVALID case, whose only remedy is this call) is
   * still cleared, and a second press answers wasConnected:false honestly.
   * The old Windows key/status receipt is retained as UNCERTAIN, not invented
   * directory-sync proof. `cleared` is a compatibility observation, not full
   * disconnection or reconciliation of an earlier uncertain operation.
   */
  function clearConnection() {
    if (typeof vault.clearDeviceCredential !== 'function') {
      fail('DEVICE_CLAIM_CONFIG_INVALID', 'Vault access (clearDeviceCredential) is required to disconnect this machine.');
    }
    const result = vault.clearDeviceCredential();
    let status, mutationOutcome;
    try {
      const shape = result && typeof result === 'object' && !Array.isArray(result)
        ? Object.keys(result).sort().join(',') : '';
      status = result && result.status;
      if (result.key !== DEVICE_CREDENTIAL_VAULT_KEY || !['cleared', 'absent'].includes(status)) throw new Error();
      if (shape === 'key,status') mutationOutcome = 'UNCERTAIN';
      else if (shape === 'key,mutationOutcome,status') {
        const observedOutcome = result.mutationOutcome;
        if (!((status === 'cleared' && observedOutcome === 'REMOVED_SYNCED')
            || (status === 'absent' && observedOutcome === 'NOT_ATTEMPTED'))) throw new Error();
        mutationOutcome = observedOutcome;
      } else throw new Error();
    } catch {
      const error = new OnlineFraDeviceClaimError('DEVICE_CLAIM_CONFIG_INVALID', 'The vault did not confirm this machine\'s credential-clear outcome.');
      error.mutationOutcome = 'UNCERTAIN';
      error.localCause = 'SECRET_HELPER_PROTOCOL_INVALID';
      throw error;
    }
    return Object.freeze({ cleared: true, wasConnected: status === 'cleared', mutationOutcome });
  }

  return Object.freeze({ openClaim, pollOnce, decideClaim, clearConnection, connectionState: () => connectionState(vault) });
}

module.exports = Object.freeze({
  OnlineFraDeviceClaimError,
  DEVICE_CREDENTIAL_VAULT_KEY,
  connectionState,
  createDeviceClaimClient
});
