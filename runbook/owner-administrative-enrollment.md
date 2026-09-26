# Linux owner-administrative enrollment boundary

This is an explicit administrative protocol, separate from browser claim/poll.
It does not log into an account, reset a password, create a browser session,
create a native identity, grant browser-drive consent, or release the native
disconnect fence. The shipped CLI currently supports Linux only.

The native main controller owns the fixed profile and protected configuration,
loads the purpose-specific issuer public key delivered over pinned administrative
SSH, reserves its lifecycle ticket, and launches `tools/online-fra-admin-cli.js`
through the existing owned process/terminal-receipt boundary. Do not place a
credential or transport private key in arguments, files, logs, or renderer IPC.

## Input and trust

The CLI accepts one compact JSON object, at most64KiB, on private stdin. It
requires an absolute `TOOLSENABLED_STATE_ROOT`, and the selected vault must be
exactly `<resolved-state-root>/vault/secrets.json`. The normal Linux custody
checks still enforce owner identity, private paths/files, persistent encrypted
GNOME login keyring, current service ownership, and the vault lock.

Every input contains `version:1`, `action`, and exact `context` fields:
`operationId`, `accountId`, `email`, `name`, `publicKey`, `profile`,
`issuerPublicKey`. Operation ID is48 lowercase hex characters. Profile is
SHA256 of UTF8 `path.resolve(stateRoot)`. Both public keys are canonical
base64url SPKI DER Ed25519. Context and reply selection belong to protected
main-process configuration, not the renderer.

Actions:

- `identity`: context publicKey must be null. Returns the existing native
  public key; does not create an identity, operation, grant or fence.
- `prepare`: checks absence/conflicts, generates a3072-bit RSA transport key,
  stores it encrypted before returning the native-signed enrollment request.
  Exact retries return the same request/key; a different operation refuses.
- `import`: requires `reply`, the issuer-signed sealed grant. Stores the exact
  validated grant and operation receipt in one conditional vault replacement,
  removing the transport private key in that same replacement. Returns a
  native-signed collection request and a stored receipt, not remote authority.
- `finalize`: requires a fresh signed collection `reply`, matching the exact
  stored credential hash, current account/key/device and operation binding.
  Returns a finalized receipt; only main's current lifecycle ticket and
  authenticated quiescent terminal receipt may release its fence afterward.
- `resume`: verifies existing key/grant and syncs the durable record. Prepared
  operations return their original request; stored/finalized operations return
  a fresh collection request with serverCollected false. A restart cannot
  reuse an old collection attestation as fresh authority.
- `pair-request`: requires actual main-owned `webDriveEnabled:true` and current
  `capabilityDigest`. Verifies the stored collection attestation at its recorded
  finalization time and signs a fresh pair request. The server must recheck
  current token/key/account/collection and actual consent binding. Historical
  collection evidence is not a claim of current relay authorization.
- `cancel`: retires only the exact operation when the device grant is absent;
  any present grant refuses. It preserves native identity and every unrelated
  vault record. Main must keep remote access blocked and require quiescence.

## Cryptographic and persistence contract

Requests sign UTF8 `ToolsEnabled owner administrative enrollment v1\n` followed
by their exact JSON bytes. Replies sign UTF8
`ToolsEnabled owner administrative reply v1\n` followed by the fixed ordered
unsigned reply object. Reply signatures bind issuance/expiry, operation,
account, native key, profile, enrollment request hash, and the sealed envelope
or exact current collection/pair facts.

Envelope decryption uses RSA-OAEP-SHA256 and AES-256-GCM with request-hash AAD.
The credential has exactly pairId/deviceId/name/certificatePem/privateKeyPem/
deviceToken/claimedAtMs, with both PEM fields null. `credentialHash` is SHA256
of UTF8 JSON.stringify of those fields in that order. Fresh server collection
must compare it to the issued grant and independently verify the current
device token hash, account/key binding and unrevoked state before attesting.

The fixed vault operation compares the current native identity, current
operation digest and any existing grant inside its existing kernel lock.
Stored grant plus operation state are one encrypted replacement. Data and
directory flushes and readback are checked. Outcomes distinguish
NOT_ATTEMPTED, STORED_SYNCED and UNCERTAIN; no power-loss guarantee is implied.
A later exact authenticated read and fresh file/directory sync can reconcile
lost replies. Removed/replaced grants refuse replay rather than reappearing.
The CLI waits for its vault helper to close before returning success; main
still owns proof that the entire process family is quiescent.

## Qualification

`node --test tests/online-fra-admin-enrollment.test.js` exercises protocol
binding, issuer signature, expiry, current credential hash, replay, delayed
pairing, output privacy and input bounds. `node tests/online-fra-admin-linux-vault.test.js`
creates a disposable private D-Bus/GNOME keyring for actual CLI, storage,
concurrent writers and restart proof. `node tests/linux-vault.test.js` includes
the native custody and injected pre/post-replacement failure boundaries.
Both new suites are part of `tests/linux-native.js`; protocol tests also join
the ordinary online-surface suite. App lifecycle/fence and real server
interoperation qualification remain companion requirements.
