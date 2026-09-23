'use strict';

// Q51 package-owned runner for the metadata-only credential boundary. The
// flat entrypoint remains a compatibility path used by npm test.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const result = spawnSync(process.execPath, [
  path.join(root, 'tests', 'run-isolated.js'),
  'tests/secrets/credential-capture.js',
  // The presence half of the same boundary: credential-capture.js proves the
  // vault does not hand a protected record back, this proves the product can
  // still tell whether one is on file -- and that "could not read the vault"
  // never renders as "nothing on file".
  'tests/secrets/vault-presence.js',
  // The consumer half: runtime.secretExists() must separate MISSING (a definite
  // false) from UNREADABLE (a typed throw), so a vault read error can never
  // again masquerade as "not configured".
  'tests/secrets/secret-exists-unreadable.js',
  // Linux is an explicit non-retryable UNSUPPORTED state for this version,
  // distinct from both an absent record and a vault that should be readable but
  // is not. On Windows this simulates Linux; Docker runs the same assertions on
  // the real platform and proves all five seams refuse before process spawn.
  'tests/vault-platform-unsupported.test.js',
  // The one destructive verb on the vault the product itself runs: clearing
  // this computer's account connection is key-bound, asks presence first,
  // and carries neither the key nor a path out in its refusal.
  'tests/secrets/device-credential-clear.js',
  // The fixed Windows transaction must report its actual storage outcome and
  // retain the machine identity and other DPAPI records in a disposable vault.
  'tests/secrets/windows-device-credential-clear.js',
  // The general owner-facing path is a destructive, approval-gated registry
  // action backed by the existing lifecycle manager. It removes one exact key,
  // emits metadata only, leaves no replacement backup, and refuses records
  // which already have a dedicated or self-managed lifecycle.
  'tests/secrets/credential-removal.js',
  // The card half: what a stored payment card is ACTUALLY protected by. Proves
  // the record is DPAPI ciphertext on disk, that no spelling of the PAN reaches
  // the vault directory, the access log, the audit sinks, a refusal message or
  // a decrypt/parse diagnostic -- and that every action which reads, opens or
  // destroys the record leaves an access-log line. The last three of those
  // failed when this suite was written (exists, verify and del were silent).
  'tests/secrets/payment-card-vault-safety.js',
  // The launch gate on that record: the card SECURITY CODE is never stored.
  // A source fence on tools/secrets.ps1 (no security-code key in any persisted
  // payload, none reachable by any Protect-PlainText argument, no field that
  // asks for one), the public form contract agents read, and the
  // scrub-payment-card-cvc verb that cleans a record captured before the
  // invariant -- all measured against the scratch vault, never the real one.
  'tests/secrets/payment-card-security-code-never-stored.js',
  // The WRITE half of the same access log. The suite above proves every action
  // that reads, opens or destroys a record leaves a line; this proves the same
  // of every action that REPLACES one. It was the inverted half of the posture:
  // looking at the owner's card was audited and silently overwriting it was
  // not, so the destructive direction was the invisible one.
  'tests/secrets/vault-write-visibility.js',
  // The credential store's own suite, which was orphaned: no aggregate reached
  // it, so it did not run with the credential package.
  //
  // 2026-09-03: a second path was listed beside it, 'tests/secret-escrow.test.js',
  // described as the escrow half of the same boundary. NO SUCH FILE HAS EVER
  // EXISTED -- not at this tip, not anywhere in this repository's history, and
  // the word "escrow" appears in no other file under src, tests or tools. The
  // runner requires every path it is given, so naming one that is not there
  // ended this suite with MODULE_NOT_FOUND before a single assertion ran, and
  // `npm run test:secrets` could not pass on any commit since the line was
  // added. It is removed rather than stubbed: a placeholder file would turn a
  // loud failure into a suite that passes while proving nothing, and there is
  // no escrow feature in this codebase for it to be about.
  'tests/secret-store.js',
  // WHICH FILE. Every suite above proves something about a vault; this one
  // proves the halves of the product are talking about the SAME vault. The
  // lifecycle half (src/lib/secret-store -> tools/secrets-manager.ps1) had
  // neither the state-root branch nor the published vault path that the read
  // and write half has, so on an installed payload `secret-doctor` inspected a
  // file beside the program while the credentials lived under the per-user
  // state root -- "not configured" reported about a vault that was full.
  'tests/secrets/vault-path-agreement.js',
  // THE LOG MUST NEVER BRING THE VAULT BACK. The access log's own append used
  // to initialize the store first, which resurrected the vault directory after
  // the product's local-data reset had deleted it (the one survivor
  // uninstall-reset-packaged-qa kept finding). Read verbs against a deleted
  // store now leave it deleted; mutations still create it.
  'tests/secrets/vault-access-log-never-resurrects-store.js',
  // BOTH HALVES THAT WRITE THIS VAULT MUST SURVIVE A CRASH MID-WRITE. The
  // 2026-09-02 crash-safety fix (commit 9a6c79c) touched tools/secrets.ps1's
  // Write-Vault only; tools/secrets-manager.ps1's Write-Vault -- every add,
  // replace, rotate, remove -- still wrote the vault's temp file with a bare
  // WriteAllText and no flush before the same atomic rename, so it could still
  // leave the vault as the exact all-NUL file the sibling fix exists to
  // prevent. Source-fences both Write-Vault functions and proves the fixed
  // manager still round-trips a real value through the same vault file.
  'tests/secrets/vault-write-crash-safety.js'
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
