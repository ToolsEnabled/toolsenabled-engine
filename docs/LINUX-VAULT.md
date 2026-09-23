# Linux vault and signed audit

The engine's secret read/write and signed-audit paths now use a Linux backend
when `process.platform` is `linux`. The Windows DPAPI backend remains separate.
Linux credential capture dialogs, payment-card/identity capture, and the
PowerShell lifecycle manager are still unavailable. This increment does not
claim full credential-management or desktop account parity.

The production owner-host startup calls a fixed Linux payment-card hygiene
check. A securely resolved missing vault returns only
`{ key: 'payment_card_default', status: 'absent' }` without contacting a keyring.
An existing native vault must pass its normal GNOME trust, format, and
service-key metadata checks. Any protected card record, including a case
alias, refuses for local review or a future supported migration; Linux never
reports that record clean, decrypts its contents, or rewrites it. Unknown,
legacy, malformed, unsafe, and unreadable stores refuse. This no-store rule is
limited to the fixed startup hygiene operation; generic credential presence
still requires a usable backend and remains unknown when custody is unavailable.

The supported Linux backend is the current non-root user's GNOME Keyring login
collection. It must already be running on the session D-Bus, unlocked, and
persisted in GNOME's encrypted binary format. A passwordless plaintext keyring,
session-only collection, different Secret Service implementation, locked
collection, missing dependency, and unknown service identity all refuse.
The helper never unlocks a collection, starts a daemon, invokes a prompt,
changes a keyring password, resets a keyring, or selects a plaintext fallback.

`src/linux-vault.py` uses system Python 3, PyGObject, libsecret, and Python
cryptography. On the measured Ubuntu host these are supplied by `python3`,
`python3-gi`, `gir1.2-secret-1`, `libsecret-1-0`, `python3-cryptography`, and
`gnome-keyring`. The trusted computing base includes the root-administered
`/usr/bin/python3`, its system modules/native libraries, and
`/usr/bin/gnome-keyring-daemon`. Python runs with `-I`; the child environment
retains only D-Bus/runtime-directory, locale, and bounded lock-timeout fields,
then applies the shared credential scrub. Caller-selected Python, GI, and
dynamic-library search paths do not cross that boundary. Root and mismatched
real/effective UIDs refuse. Before trusting D-Bus service-owner claims, the
underlying UNIX socket must report this same non-root UID through kernel peer
credentials. Missing, unknown, non-UNIX, and foreign peers refuse. This reads
socket metadata without consuming D-Bus protocol bytes. The measured D-Bus
service owner must also have the same UID and
the fixed GNOME daemon executable; the connection is pinned to that unique
owner. Only the daemon's HOME/XDG data-directory metadata is retained from its
process environment to locate its real backing keyring; no process environment
or secret is returned in diagnostics.

Each application vault has a random AES-256 key in that collection, selected
by the absolute vault path's digest and a random vault identity. The application
file contains AES-GCM ciphertext per record with a fresh 96-bit nonce. The
format, vault identity, and record name are authenticated as associated data.
The master key is never written to the application file or returned through
the helper protocol. Records and candidates travel only over private
stdin/stdout pipes, never command arguments or environment variables. Errors
use a closed set of literal codes/messages; Python exceptions and stderr are
not relayed to callers. Core dumps are disabled for the helper. This is disk
encryption, not a guarantee that application-process memory cannot be paged or
examined by the same account.

Vault paths are resolved by `src/lib/vault-location.js`. The helper walks
directories from an open root descriptor using descriptor-relative operations
and refuses symlinks. Ancestors must be owned by root or the calling UID and
must not be group/other-writable; root-owned sticky temporary directories are
the sole exception. The final vault directory must be owned by the calling UID
and private (`0700`). Existing vault/lock files must be private regular files
with one hard link. The best-effort access log also refuses unsafe log files.
Unsafe existing permissions are refused, not changed.
New directories/files are created with `0700`/`0600`. Writes hold an exclusive
kernel `flock`, fsync a private encrypted temporary file, atomically replace the
vault, and fsync its directory. There are no replacement backups or stale-lock
deletion heuristics. If initial key creation succeeds but file commit fails, an
unused random service key can remain; this helper has no generic key-deletion
or recovery operation.

The shared runtime-state bootstrap also supplies `0700` for newly created
Linux-owned directories, even under a permissive caller umask. This does not
chmod existing directories or repair a user-selected root. A preexisting unsafe
directory continues to fail custody checks. The LIVE launcher's separately
private-umask provisioning is not evidence that every generic bootstrap path
was already correct.

The normal runtime supports reads, batched reads, writes, coupled pair/triple
writes, create-once selection, monotonic checkpoint writes, enumeration, and
presence. Generic reads/creation/enumeration preserve the payment-card and
owner-identity oracle denylist; Linux generic writes also refuse those records
until their owner-only capture paths exist. Access logs contain operation/key
metadata only. Presence checks inspect record and service-key metadata without
decrypting record contents; they do not claim the ciphertext is authenticated.
An unavailable keyring or missing service key produces unknown/unreadable,
never a confident absence. Existing non-Linux files are refused without
migration. Relocating an encrypted vault requires a future explicit key-binding
migration; copying the file alone cannot move its service key.

`clearDeviceCredential()` supports the fixed local “Disconnect this computer”
operation. It authenticates and removes only
`custom.online_fra_device_credential_v1` under the normal kernel lock, retaining
the machine identity, master key and all other ciphertext. A repeated call
answers `absent`; it never creates a vault or accepts a caller-selected key.
Locked or missing custody, tampered ciphertext and failed writes refuse. No
credential value leaves the helper, and this local removal does not claim
server-side revocation or deletion from historical disk snapshots.

Fixed-clear responses include `mutationOutcome`:

- `status: cleared, mutationOutcome: REMOVED_SYNCED`: the file replacement and
  directory sync calls returned successfully. This is not a power-loss guarantee.
- `status: absent, mutationOutcome: NOT_ATTEMPTED`: absence was observed by
  this operation and no credential replacement was attempted. An existing vault
  directory is checked under its lock; the safely resolved no-directory path
  can return absence without creating a directory or acquiring that lock.
- A failure before the replacement attempt carries `NOT_ATTEMPTED`; errors
  from the replacement attempt onward carry `UNCERTAIN`. In particular, a
  successful replacement followed by directory-fsync failure is
  `SECRET_VAULT_WRITE_UNCERTAIN`, not a claim that nothing changed.

The adapter accepts only the exact fixed-key/status/outcome envelopes. A
missing, malformed, contradictory or lost receipt, terminated helper, timeout
or unknown cause is uncertain. Failure retains the compatibility code
`DEVICE_CREDENTIAL_CLEAR_FAILED` with only the closed `localCause` and
`mutationOutcome` fields; exception prose and stderr are not copied. The claim
client and disconnect CLI preserve these fields. The Windows legacy key/status
receipt is explicitly `UNCERTAIN`; no Linux sync result is invented for it.
`cleared: true` in the compatibility CLI envelope is not full-disconnect proof.

A later `absent` is a new observation, never retroactive durability proof for
an uncertain write. Disk removal also does not revoke an already admitted relay
that retained the credential. The app must independently gate dispatch and all
restart paths, persist narrow disconnect intent, invalidate claim generations
and connection-bound consent, and observe owned process-tree quiescence. Lost
receipt or persistence uncertainty must remain visible until reconciled; this
engine increment alone does not qualify that app lifecycle or authorize retries.

The desktop can call `createReader({ stateRoot, environment })` exported by
`src/lib/vault-linux.js`. Its asynchronous `presence(key)` returns `present`,
`absent`, or `no-store`; `getMany(keys)` returns a Map containing only found
values. Failures reject with a typed closed error. The reader uses the location
authority to bind `stateRoot/vault/secrets.json`, excludes an ambient vault-path
override, and never changes `process.env`. Its subprocess has a bounded timeout
and output size. Runtime audit callers retain synchronous APIs.

Audit events retain the existing Ed25519 signatures, canonical hash chain,
signed protected heads, and pre-effect admission checks. Kernel serialization
ensures competing create-once callers select one signer and monotonic updates
refuse lower sequences or different values at the same sequence. Linux vault
content-digest caches are disabled because a keyring can lock or lose its key
while application ciphertext stays unchanged. A warm signer cannot bypass a
failed protected-head read. Restoring an older ledger while its protected head
remains current is detected. Restoring both the ledger and its encrypted
vault/anchor is outside this local tamper-evidence boundary, as with DPAPI;
neither file encryption nor monotonic compare-and-set is hardware anti-rollback.

Run the real integration proof with Node 22 or newer:

```sh
node tests/linux-vault.test.js
```

It creates fresh private D-Bus sessions and disposable GNOME daemons with
isolated data/config/runtime directories. Generated test passwords are supplied
only on stdin. It verifies persistence across processes and a complete daemon
restart, async desktop
reads, concurrent creation, coupled writes, kernel-lock crash release,
ciphertext and record-substitution refusal, unsafe path rejection, Ed25519 audit
restart and ledger rollback detection, service-key loss, locking, and refusal
of a real passwordless keyring. No owner keyring or credentials are used. Each
test daemon is stopped and its disposable keyring/vault is removed afterwards.
The same suite injects file-fsync, replacement and directory-fsync errors on
its real disposable encrypted vault and simulates a lost result after completed
replacement. It inspects actual remaining ciphertext and checks temporary-file
cleanup. These cases prove current contents and error classification, not
power-loss durability. `tests/device-credential-clear-outcome.test.js` separately
tests hostile/legacy protocol receipts and the real CLI's projection with an
in-memory vault dependency; it is portable unit evidence, not native custody.

The implementation follows libsecret's [collection search flags](https://gnome.pages.gitlab.gnome.org/libsecret/method.Collection.search_sync.html)
without requesting unlock or secret loading for presence. Creation sends the
[Secret Service CreateItem request](https://specifications.freedesktop.org/secret-service/latest-single/)
using libsecret's encrypted session payload and refuses any returned prompt;
the high-level create API is avoided because it can handle prompts. The
persistent-format check uses GNOME's [encrypted keyring format header](https://github.com/GNOME/gnome-keyring/blob/main/pkcs11/secret-store/gkm-secret-binary.c).
