'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, createAuditStore, DEFAULT_AUDIT_DB, MAX_EVENT_BYTES, ZERO_HASH, sha256, eventHashInput, publicKeyHash, withReadOnlyLedger } = require('./audit-store');
const { rootPath, ensureDir, getSecret, getOrCreateSecret, setMonotonicSecret, vaultContentDigest } = require('./runtime');
const { resolveVaultLocation } = require('./vault-location');
const { emitCheckpoint } = require('./audit-checkpoint');
const { loadPolicy } = require('./policy');
const { knownProviderCredentialPattern } = require('./secret-patterns');
const { resolvePreset, retentionPlan } = require('./audit-retention');
const maintenance = require('./audit-maintenance-guard');

const SIGNING_VAULT_KEY = 'toolsenabled_audit_signing_key_v1';
const HEAD_VAULT_KEY = 'toolsenabled_audit_head_v1';
const HEAD_DOMAIN = 'toolsenabled.audit.head.v1';
// Distinct from HEAD_DOMAIN on purpose. Both are signed by the same audit key
// over canonical JSON, so without separate domains a head anchor could be
// presented as an archive boundary or the reverse. Domain separation is what
// makes "signed by us" mean "signed by us AS THIS KIND OF CLAIM".
const ARCHIVE_BOUNDARY_DOMAIN = 'toolsenabled.audit.archive-boundary.v1';
const ARCHIVE_BOUNDARY_METADATA_KEY = 'archive-boundary-v1';
const AUDIT_RETENTION_SETTING_ID = 'audit.retention';
const LEGACY_METADATA_KEY = 'legacy-jsonl-import-v1';
const EMERGENCY_PREFIX = 'audit-emergency';
const MAX_EMERGENCY_BYTES = 10 * 1024 * 1024;
// AUDIT-F-03 / CRED-F7: emergency-spool entries are wrapped with an
// authentication tag before they ever touch disk, so ingestEmergency() can
// tell "a line this process itself spooled" apart from arbitrary
// attacker-writable bytes later dropped into the same directory (a lower-
// privileged same-user process, a restored backup, a hand-edited "recovery"
// file).  Without this, ingestEmergency() had no way to distinguish the two
// and canonicalized and signed whatever it found there: a signing oracle.
// The tag is derived from the same trusted Ed25519 audit signer every
// canonical write already requires, rather than a second vault secret --
// see deriveSpoolMacKey() below for why.  A valid mac proves provenance; it
// does not by itself prove the content is still safe to canonicalize, which
// is what re-scrubbing at ingestion (CRED-F7) is for.
const SPOOL_ENVELOPE_DOMAIN = 'toolsenabled.audit.spool.v1';
const SPOOL_MAC_CHALLENGE = Buffer.from('toolsenabled.audit.spool.mac.v1', 'utf8');
// Durability health signal.  A failed canonical write is already fail-safe:
// record() spools to emergency storage and returns ok:false/durable:false
// rather than throwing, because throwing would take the whole system down on a
// transient lock.  Nothing observed that return value, so non-durable writes
// spread over hours produced only one stderr line each and no health state
// anywhere.  These constants bound a small sidecar file that remembers a breach
// *after* the spool drains: prepare() ingests the spool on the very next
// record(), so an instantaneous spool-depth probe reads green within seconds of
// a non-durable write and can never describe a window.
const DURABILITY_STATE_BASENAME = 'audit-durability.json';
// Required refusals, append-only and never evicted. The sidecar above keeps a
// 200-row rolling window, which is right for the noisy best-effort class and
// wrong for the one class that represents an operation the person ASKED FOR and
// did not get. Measured 2026-09-07: totalBreachCount 440 against 200 retained,
// so 240 rows were already gone with no rotated copy. This does not recover
// them -- nothing can -- it stops the next 240 from going the same way.
const DURABILITY_REFUSALS_BASENAME = 'audit-refusals.jsonl';
const MAX_DURABILITY_BREACHES = 200;
// Breaches closer together than this belong to one non-durable window.
const DURABILITY_CLUSTER_GAP_MS = 30 * 60 * 1000;
const DURABILITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DURABILITY_HEARTBEAT_MS = 60 * 1000;
const DURABILITY_CRITICAL_WINDOW_MS = 60 * 60 * 1000;
const DURABILITY_CRITICAL_COUNT = 5;
const MAX_PROJECTION_BYTES = 128 * 1024 * 1024;
const FULL_VERIFY_EVERY = 200;
// HOW FAR A PROJECTION FILE MAY DURABLY LEAD THE COMMITTED LEDGER HEAD.
//
// projectSinks() appends a sink's line with a plain durable fs append and only
// then marks the cursor, both inside the writer transaction record() holds.
// Between the append and the commit the file legitimately holds lines whose
// events no other connection can see yet -- and every OTHER process in the
// fleet verifies its own admission OUTSIDE that lock, so it reads exactly that
// intermediate file. On this install a writer can sit inside that window for
// seconds at a time (the in-lock anchor reconciliation reads the vault, which
// spawns powershell.exe), so the reader observes a file ahead of the head that
// is completely STABLE across its whole verification -- indistinguishable from
// corruption to a check that requires exact equality, which is why the live
// ledger kept reporting AUDIT_PROJECTION_DIVERGED after 96fc6ec.
//
// Tolerating the lead loses nothing: projectSinks()'s own untrusted path
// re-parses the file, finds it does not match the committed window, and
// REBUILDS it from the database -- so any line past the committed head is
// erased, never read back as ledger truth. The bound exists so an unbounded
// tail is still a refusal rather than a silently accepted file.
const MAX_UNCOMMITTED_PROJECTION_OVERHANG = 1024;
const ATOMIC_RENAME_ATTEMPTS = 6;
const ATOMIC_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

// Match both well-known credential fields and generic snake/kebab/camel-case
// names ending in token or secret. Capability handles must be scrubbed too.
const sensitiveKey = /(?:^(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|authentication|auth|password|passphrase|cookie|set[_-]?cookie|cvc|cvv|security[_-]?code|securityCode|pin|number|card[_-]?number|private[_-]?key|privateKey|credential|credentials|session|session[_-]?id|stripe_(?:secret|restricted)_key)$|(?:^|[_-])(?:token|secret|credential|session)(?:$|[_-])|(?:token|secret|credential|session|privateKey)$)/i;
const privateKeyValue = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const bearerValue = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi;
const providerTokenValue = knownProviderCredentialPattern('g');

let defaultStore = null;
let defaultSigner = null;
let defaultInitialized = false;
let defaultAnchorLoaded = false;
let defaultAnchorCache = null;
// The sha256 of the vault file's own bytes, captured immediately BEFORE the
// real vault read that produced defaultAnchorCache. Never a credential, never
// written to disk; see anchorVaultDigest() below for what it is allowed to
// decide. null means "unknown", which always forces a real read.
let defaultAnchorVaultDigest = null;
const projectionVerifyCache = new Map();
// A STABLE DIVERGENCE IS DECIDED ONCE, NOT ON EVERY TOOL CALL.
//
// validateProjectionState() reads and re-parses BOTH projection files in full
// on every cache-missing admission. MEASURED 2026-09-04 against the owner's
// real Live ledger (10,053 live events, actions.jsonl 12.0 MB + actions.log
// 7.0 MB): 0.64 s per call, on the main process, synchronously. When the
// answer is a refusal AND nothing that could change that answer has moved --
// the same two files at the same size and mtime, the same ledger head, the
// same archive boundary, the same sink cursor -- re-deriving it is 0.64 s
// spent to reprint a verdict this process already has. This memo holds that
// verdict, keyed on every input the verdict depends on, so a genuinely wedged
// projection refuses at fingerprint cost instead of parse cost. It only ever
// caches a REFUSAL; a pass is never memoized, and any fingerprint difference
// re-runs the whole check.
const projectionDivergenceMemo = new Map();
const anchorReadCounters = { real: 0, cached: 0, writes: 0 };

class AuditRequiredError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'AuditRequiredError';
    this.code = code;
    this.details = details;
  }
}

function scrubText(value, maximum = 4000) {
  const limit = Number.isSafeInteger(maximum) && maximum >= 1 ? maximum : 4000;
  return String(value)
    .replace(privateKeyValue, '[REDACTED PRIVATE KEY]')
    .replace(bearerValue, '$1 REDACTED')
    .replace(providerTokenValue, 'REDACTED')
    .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|authorization|cookie|cvc|cvv|security[_-]?code|securityCode|private[_-]?key|credential|[A-Za-z][A-Za-z0-9_-]*(?:token|secret))\s*[=:]\s*)[^\s,}&]+/gi, '$1REDACTED')
    .slice(0, limit);
}

function scrub(value, depth = 0, options = {}) {
  const complete = options.complete === true;
  const maximum = complete && Number.isSafeInteger(options.maximum) && options.maximum > 0 && options.maximum <= 16384
    ? options.maximum : 4000;
  const refuseLimit = () => { throw Object.assign(new RangeError('The complete redacted value exceeds the display limit.'), { code: 'AUDIT_SCRUB_LIMIT' }); };
  // Audit projections remain compact. A confirmation may explicitly require
  // a complete bounded value; omissions cannot stand in for reviewed inputs.
  if (depth > 12) { if (complete) refuseLimit(); return '[TRUNCATED_DEPTH]'; }
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') { if (complete && value.length > maximum) refuseLimit(); return scrubText(value, maximum); }
  if (Array.isArray(value)) {
    if (complete && value.length > 100) refuseLimit();
    return value.slice(0, 100).map(entry => scrub(entry, depth + 1, options));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (complete && entries.length > 100) refuseLimit();
    return Object.fromEntries(entries.slice(0, 100)
      .map(([key, entry]) => [key, sensitiveKey.test(key) ? 'REDACTED' : scrub(entry, depth + 1, options)]));
  }
  const text = String(value);
  if (complete && text.length > maximum) refuseLimit();
  return text.slice(0, maximum);
}

// Rendering must be TOTAL: redact() is called while building projection lines,
// and a projection line that throws does not lose one line, it wedges that sink
// permanently. JSON.stringify returns undefined -- not a string -- for
// undefined, functions and symbols, so the previous unconditional .slice() threw
// TypeError on any of them. Live consequence on 2026-08-10: five events recorded
// without a `target` (callers that passed a single object to record(), so
// `action` took the object and `target` took nothing) stalled the text
// projection at sequence 19985 with a 1197-event backlog, and because a diverged
// projection is what requireRecord() checks first, every external-write tool in
// the product stayed refused until this was made total.
function redact(value) {
  const safe = scrub(value);
  if (typeof safe === 'string') return safe;
  const encoded = JSON.stringify(safe);
  return (typeof encoded === 'string' ? encoded : String(safe)).slice(0, 4000);
}

// `throw` accepts any value, and `String()` is the IDENTITY FUNCTION for a
// primitive. The type name is the one thing about a thrown value that can
// always be said without saying any of its content.
function thrownTypeName(value) {
  return value === null ? 'null' : typeof value;
}

// RENDER BY TYPE WHEN THERE IS NO STRING MESSAGE, and do it HERE rather than at
// any caller.
//
// This function renders every link causeChain() walks, and errorEntry() renders
// the top-level error through it too. The old fallback was String(error), so a
// chain carrying a raw primitive -- `new Error('vault refused', { cause: x })`,
// a well-formed Error one link above a bare value -- wrote that value's content
// into the audit error entry. MEASURED through the status record() returns:
//   "cause":[{"message":"vault refused"},{"message":"<the value>"}]
// The signing-key path is only where that was found; the defect is every
// producer's, so the fix is the renderer's. Fixing callers one at a time is the
// same "leave the twin behind" mistake at scale.
//
// redact() is not a second line of defence here and it was measured, not
// assumed: its patterns match PEM blocks, bearer tokens and `key = value`
// shapes, so an opaque value carrying none of that framing passes through
// untouched.
//
// `error.message` is read EXACTLY ONCE -- it can be a getter that throws, or
// that answers differently on two reads -- and a link's own toString is never
// consulted, because a toString is content the thrown object chose.
function safeError(error) {
  try {
    let message;
    try { message = error === undefined || error === null ? undefined : error.message; }
    catch { message = undefined; }
    const text = typeof message === 'string' && message
      ? message
      : `the audit failure could not be described (${thrownTypeName(error)} thrown)`;
    return redact(text).replace(/\r?\n/g, ' ').slice(0, 1000);
  } catch { return 'Audit operation failed.'; }
}

// AN AUDIT FAILURE MUST SAY WHICH FAILURE IT WAS.
//
// Upstream, audit-store.js raises errors that carry three separate pieces of
// evidence: a mechanical `code`, a structured `details` object, and the
// original error as `cause`.  Everything below used to collapse that to
// `{ sink, message }` before a caller ever saw it, so an operator staring at
// a refused external write got "The audit ledger rejected a transaction."
// and could not tell a poisoned head anchor from a locked file from a full
// disk.  That is the same "generic message swallows a specific, actionable
// classification" defect this repo already fights in mcp-server.js, where
// the closed human-readable taxonomy is deliberately paired with machine
// codes in structuredContent rather than replacing them.
//
// Propagation here is deliberately NARROW, because audit details may carry
// event payloads: only a mechanical code shape, a bounded set of scrubbed
// structured fields, and a bounded scrubbed cause chain travel outward.
// Everything passes through the module's existing scrub()/redact() path --
// no second, weaker redactor is introduced for diagnostics.
const MECHANICAL_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_CAUSE_DEPTH = 5;
const MAX_DETAIL_FIELDS = 12;
const MAX_DETAIL_JSON = 2000;

function safeCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : null;
  return code && MECHANICAL_CODE.test(code) ? code : null;
}

// Structured detail fields are evidence, not payload: scrub() already
// redacts credential-shaped keys and token-shaped values, and the field and
// size caps below stop an oversized or hostile details object from becoming
// an exfiltration channel through a diagnostic surface.
function safeDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const scrubbed = scrub(value);
    const entries = Object.entries(scrubbed).slice(0, MAX_DETAIL_FIELDS);
    if (!entries.length) return null;
    const bounded = Object.fromEntries(entries);
    if (JSON.stringify(bounded).length > MAX_DETAIL_JSON) return { omitted: 'oversized' };
    return bounded;
  } catch { return null; }
}

function causeChain(error) {
  const chain = [];
  const seen = new Set([error]);
  let cursor = error && error.cause;
  while (cursor && chain.length < MAX_CAUSE_DEPTH && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = { message: safeError(cursor) };
    const code = safeCode(cursor);
    if (code) entry.code = code;
    const details = safeDetails(cursor.details);
    if (details) entry.details = details;
    chain.push(entry);
    cursor = cursor.cause;
  }
  return chain;
}

// The single shape every audit failure reaches a caller in.  `sink` and
// `message` are unchanged from the original contract so existing consumers
// keep working; `code`, `details` and `cause` are added only when there is
// something safe to say.
function errorEntry(sink, error) {
  const entry = { sink, message: safeError(error) };
  const code = safeCode(error);
  if (code) entry.code = code;
  const details = safeDetails(error && error.details);
  if (details) entry.details = details;
  const cause = causeChain(error);
  if (cause.length) entry.cause = cause;
  return entry;
}

// audit.js raises its own integrity refusals from inside store transactions.
// A bare Error carries no code, so audit-store.js's preservesClassification()
// cannot tell it apart from a driver fault and relabels it
// AUDIT_SQLITE_ERROR / "The audit ledger rejected a transaction." -- which is
// exactly how a projection divergence and a poisoned anchor both came out
// looking like SQLite contention. Every refusal below is tagged instead.
function auditFailure(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function timestampMilliseconds(value, fallback) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function configuredFile(environment, name, fallback, resolvePath) {
  const override = environment && typeof environment[name] === 'string' ? environment[name].trim() : '';
  if (override) {
    if (!path.isAbsolute(override)) throw new Error(`${name} must be an absolute path.`);
    return path.resolve(override);
  }
  return resolvePath(fallback);
}

function resolveFiles(policy, resolvePath = rootPath, environment = process.env) {
  return {
    jsonl: configuredFile(environment, 'TOOLSENABLED_AUDIT_JSONL_PATH', (policy.audit && policy.audit.jsonlFile) || 'logs/actions.jsonl', resolvePath),
    text: configuredFile(environment, 'TOOLSENABLED_AUDIT_TEXT_PATH', (policy.audit && policy.audit.textFile) || 'logs/actions.log', resolvePath),
    emergency: configuredFile(environment, 'TOOLSENABLED_AUDIT_EMERGENCY_PATH', (policy.audit && policy.audit.emergencyFile) || 'logs/audit-emergency.jsonl', resolvePath)
  };
}

function report(dependencies, message) {
  const reporter = Object.prototype.hasOwnProperty.call(dependencies, 'reportError')
    ? dependencies.reportError : value => process.stderr.write(`${value}\n`);
  if (typeof reporter === 'function') {
    try { reporter(message); } catch { /* diagnostics never replace the provider result */ }
  }
}

// READ THE CUSTOMER'S RETENTION CHOICE BEFORE THE AUDIT WRITER LOCK.
//
// settings.js is the one canonical settings reader. A missing settings file is
// a normal first-run state and therefore yields the registry default. Anything
// that means the file or this row was actually rejected, or that prevents the
// settings layer from answering at all, fails toward keeping every event. A
// damaged setting must never become authority to move more history than the
// customer chose.
function configuredRetention(dependencies = {}) {
  try {
    const loadSettings = dependencies.loadSettings || require('./settings').loadSettings;
    // Retention does not consume installation capability readbacks. Reading
    // just this row avoids reopening their machine/store graph per append,
    // while still rereading and validating the user's current settings file.
    const options = { ids: [AUDIT_RETENTION_SETTING_ID], env: dependencies.env, ...(dependencies.settingsOptions || {}) };
    const settings = loadSettings(options);
    const rejected = Array.isArray(settings && settings.rejected) ? settings.rejected : [];
    if (rejected.some(item => item && (item.id === '*' || item.id === AUDIT_RETENTION_SETTING_ID))) {
      return resolvePreset(null);
    }
    const values = settings && settings.values;
    return resolvePreset(values && values[AUDIT_RETENTION_SETTING_ID]);
  } catch {
    return resolvePreset(null);
  }
}

function getStore(dependencies) {
  if (dependencies.store) return dependencies.store;
  if (!defaultStore) {
    maintenance.assertAvailable(boundLedgerFile(dependencies));
    assertLedgerVaultBinding({ file: boundLedgerFile(dependencies) }, dependencies);
    preflightExistingSigningKey(dependencies);
    preflightOpaqueHistory(dependencies);
    defaultStore = createAuditStore(dependencies.storeOptions || {});
  }
  return defaultStore;
}

function preflightExistingSigningKey(dependencies) {
  if (dependencies.signer || defaultSigner) return;
  let privatePem;
  try { privatePem = (dependencies.getSecret || getSecret)(SIGNING_VAULT_KEY); }
  catch (error) {
    if (error?.code !== 'SECRET_NOT_CONFIGURED') throw signingKeyUnavailable('The audit signing key cannot be read in this operating-system identity or vault context.', error);
    // Opening SQLite can discard a torn WAL even when signing later fails.
    // Inspect an existing ledger through the disposable read-only snapshot
    // before any live connection can normalize those repair input bytes.
    const file = boundLedgerFile(dependencies);
    let stat = null;
    if (file !== ':memory:') {
      try { stat = fs.lstatSync(file); } catch (lookup) { if (lookup.code !== 'ENOENT') throw lookup; }
    }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw signingKeyUnavailable('The existing audit ledger is not a direct regular file.');
    if (stat?.size > 0 && withReadOnlyLedger(file, store => store.status()).headSequence > 0) {
      throw signingKeyUnavailable('The audit signing key is not configured for the existing canonical ledger; refusing to create a replacement key.');
    }
    // First-run provisioning still happens in keyMaterial only after the
    // database has successfully opened. A failed open cannot mint a key.
    return;
  }
  defaultSigner = signerFromPrivateKey(privatePem);
}

function preflightOpaqueHistory(dependencies) {
  const file = boundLedgerFile(dependencies);
  if (!require('./audit-wal-input').opaqueWalFingerprint(file)) return;
  // SQLite may retain obsolete or uncommitted WAL frames during healthy
  // operation. Unknown physical bytes alone are not evidence of corruption.
  // Before letting SQLite normalize them, prove the current committed ledger
  // and readable protected head on disposable read-only copies. In particular,
  // a refused startup must leave every repair input byte on the original path.
  const signer = dependencies.signer || defaultSigner;
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const anchor = readAnchor(dependencies, { fresh: true });
      withReadOnlyLedger(file, store => {
        if (store.integrity().join(',') !== 'ok') throw auditFailure('AUDIT_LEDGER_INVALID', 'The existing audit ledger failed its read-only integrity check.');
        const boundary = signer ? readArchiveBoundary(store, signer) : null;
        const checked = store.verify(boundary);
        if (!checked.verification.valid) throw auditFailure('AUDIT_LEDGER_INVALID', 'The existing audit history could not be verified before opening its original files.');
        if (anchor) validateAnchor(anchor, store);
        if (checked.status.headSequence > 0 && (!signer || checked.status.headKeyId !== signer.keyId
            || unanchoredSuffix(checked.events, anchor?.sequence || 0, boundary).some(row => row.keyId !== signer.keyId))) {
          throw anchorIntegrityAlarm('The committed audit history does not match the readable signing identity.');
        }
      });
      return;
    } catch (error) {
      last = error;
      // A copy can race an ordinary append/head update. Retry with a fresh
      // snapshot without touching the source or caching a failed proof.
      if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw last;
}

// A SIGNING-KEY REFUSAL MUST NAME ITS OWN CAUSE.
//
// MEASURED, the 1.0.45 cut of 2026-09-16: a settings batch failed with thirty
// identical {"ok":false,"code":"AUDIT_UNAVAILABLE"} entries and one diagnostic
// line -- "ToolsEnabled canonical audit failed for a batch of 30: The audit
// signing key could not be initialized in this operating-system identity or
// vault context." That sentence is this file's OWN fixed prose. The vault
// call's actual reason was in hand, one frame away, and was discarded by a
// bare `catch {}`. Nothing in the cut could say which failure it was.
//
// `cause` is not a new surface here: errorEntry()/causeChain() above already
// walk `error.cause`, bounded by MAX_CAUSE_DEPTH and passed through
// safeError(), which redact()s. But a cause alone would have left that cut
// line exactly as uninformative, because report() formats safeError(error) --
// the MESSAGE -- so the reason has to reach the message too.
//
// SAFE TO SURFACE. This relays the vault accessor's own `message` and nothing
// else, and every accessor that reaches here builds that message from fixed
// prose plus a KEY NAME: runtime.js readSecretFromVault throws "Secret
// '<key>' could not be read from the local vault.", getOrCreateSecret throws
// "Unable to get or create secret '<key>'.", and vault-linux failure() draws
// from a fixed MESSAGES table precisely because that seam refuses to "relay a
// child exception, stderr, malformed payload, or command object: each could
// contain a value." tools/secrets.ps1 throws fixed prose and key names only,
// and never echoes a value.
//
// It deliberately does NOT read `error.stderr`, where the sibling fix
// vaultSetterFailure() in runtime.js does. That one sits directly above
// tools/secrets.ps1 and had audited that script's output; here the vault
// accessors have ALREADY decided what is safe to relay and stripped stderr,
// so reading it back would reach around their decision.
//
// The text is clamped for the same reason the sibling clamps it: a message
// that can grow without bound is its own defect.
const MAX_SIGNING_KEY_REASON = 2000;

function signingKeyReason(cause) {
  // String(undefined) is the word "undefined", which would put "Underlying
  // cause: undefined" in front of a person. That is text, but it is not a
  // reason; let undescribableCause() say what actually happened instead.
  if (cause === undefined || cause === null) return '';
  // ONLY A STRING `message` IS EVER RELAYED, and there is no String(cause)
  // fallback, because String() is the IDENTITY FUNCTION for a thrown primitive:
  // `throw '<value>'` would put that value in the refusal message verbatim, and
  // a thrown object with a custom toString would do the same. Measured at the
  // previous bytes with a stand-in: the stand-in's content appeared in full.
  // Nothing in this tree throws a raw string today -- every accessor throws an
  // Error -- but this function now relays child diagnostics, so the first path
  // that hands a raw string or Buffer through as a cause would leak content on
  // its first run. A cause with no string message is described by TYPE instead,
  // which is the guarantee this file claims and must therefore keep.
  //
  // `cause.message` is read EXACTLY ONCE: it can be a getter, and a getter that
  // returns different values on two reads, or throws, must not decide what is
  // printed. A getter that throws must also not turn a refusal that explains
  // itself into a TypeError raised inside the failure handler.
  let raw;
  try { raw = cause === undefined || cause === null ? undefined : cause.message; }
  catch { raw = undefined; }
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNING_KEY_REASON);
}

// "There was no underlying failure" and "there was one and it could not be
// described" are different answers, and merging them is the same mistake as
// the bare catch this whole change exists to remove: both would print the
// fixed sentence alone, and a reader could not tell which had happened.
// `throw undefined`, `throw null`, `throw ''` and an object whose toString
// throws all render to nothing, so they get named as what they are -- by TYPE,
// never by content, which also keeps a thrown value out of the message.
function undescribableCause(cause) {
  // One type function, two sentences: the renderer above and this refusal must
  // not end up with two spellings of one rule.
  return `the underlying failure could not be described (${thrownTypeName(cause)} thrown)`;
}

// The rest parameter distinguishes "called with no cause" -- the deliberate
// policy refusals below, which have no underlying failure -- from "called with
// a cause that happens to be undefined". Only the first may print the fixed
// sentence on its own.
// A DESCRIBED CAUSE IS ATTACHED AS A SNAPSHOT, NOT AS A LIVE REFERENCE.
//
// "Read `message` exactly once" is a property of the DECISION, and it is not a
// guarantee about what a later reader sees. MEASURED: a cause whose `message`
// getter answers with ordinary prose on the first read and with other content
// afterwards produces a refusal whose message is built from read one -- correct
// -- while the attached chain, rendered later by causeChain(), carries the
// LATER read. The getter's counter reached three through `record()`.
//
// No change to the renderer can fix that: the renderer's own read IS the later
// read, and nothing it does can make a getter answer honestly. The only place
// the value can be frozen is where the foreign object is attached, which is
// here. So each link is read once, at throw time, and what was read is what is
// kept.
//
// SCOPE, stated so this is not mistaken for a general fix: this is one of TWO
// places `src/lib/audit.js` attaches a cause it did not create, and the only
// one of the two that freezes what it attaches. The other is readAnchor()'s
// vault-read catch, which does `unavailable.cause = error` on the caught value
// and hands on a live reference.
//
// An earlier version of this comment asserted this was the ONLY such place.
// That was false, and the way it became false is worth keeping: it was
// established by a single search for the object-literal form `{ cause`, which
// does not match assignment syntax at all. Two searches, one per form, find
// both sites. (`entry.cause` and `details.cause` also assign, but those take an
// already-rendered chain of strings from causeChain(), not a foreign object, so
// they are not a third site.)
//
// readAnchor()'s live reference is left as it is deliberately rather than by
// oversight: it never reads `message` before attaching, so there is no
// decision-time read there for a later read to contradict, and that
// contradiction is the specific defect this snapshot exists to close. Content
// reaching a rendered chain is covered separately by causeChain(), which names
// a thrown value's type and never its content. Freezing readAnchor() is a filed
// follow-up, not a prerequisite for this one.
//
// Every other chain the renderer walks was linked by the module that threw --
// sqlite, fs, the archive writer -- and those are still live references.
// Freezing them would have to happen where THEY attach. This closes the
// signing-key producer and nothing else.
//
// The depth is preserved rather than truncated to one link: collapsing a real
// nested failure into a single frozen message would trade one diagnosability
// defect for another, which is the whole subject of this file.
function snapshotCauseChain(cause, firstReason) {
  const seen = new Set();
  const read = (value, property) => { try { return value[property]; } catch { return undefined; } };
  let head = null;
  let tail = null;
  let cursor = cause;
  let depth = 0;
  while (cursor !== undefined && cursor !== null && !seen.has(cursor) && depth < MAX_CAUSE_DEPTH) {
    seen.add(cursor);
    // The first link's text was already read by the caller; reading it again
    // here would be the second read and would defeat the point.
    const reason = depth === 0 ? firstReason : signingKeyReason(cursor);
    const link = new Error(reason || undescribableCause(cursor));
    const code = read(cursor, 'code');
    if (typeof code === 'string' && code) link.code = code;
    const details = safeDetails(read(cursor, 'details'));
    if (details) link.details = details;
    if (tail) tail.cause = link; else head = link;
    tail = link;
    cursor = read(cursor, 'cause');
    depth += 1;
  }
  return head;
}

function signingKeyUnavailable(message, ...rest) {
  if (!rest.length) {
    const plain = new Error(message);
    plain.code = 'AUDIT_SIGNING_KEY_UNAVAILABLE';
    return plain;
  }
  const cause = rest[0];
  const described = signingKeyReason(cause);
  const reason = described || undescribableCause(cause);
  // KEEPING THE CONTENT OUT OF THE MESSAGE IS NOT ENOUGH ON ITS OWN. Attaching
  // the raw thrown value as `cause` would leak it by a second route:
  // causeChain() walks `error.cause` and renders each link with safeError(),
  // which falls back to String(cursor) when there is no string message -- the
  // identity function for a primitive again, and a custom toString for an
  // object. Measured: a stand-in thrown as a string stayed out of the message
  // and still arrived through the chain.
  //
  // So an undescribable cause is attached as a SURROGATE that says what
  // happened and holds nothing. The chain still records that there WAS an
  // underlying failure -- "no cause" and "a cause I could not describe" stay
  // different answers -- and no route can print the value.
  const attached = described ? snapshotCauseChain(cause, described) : new Error(reason);
  // Never print the same text twice. The sibling fix guards this because node
  // folds a piped child's stderr back into `message`; the analogue here is a
  // cause whose own prose already appears in the fixed sentence.
  const text = message.includes(reason) ? message : `${message} Underlying cause: ${reason}`;
  const error = new Error(text, { cause: attached });
  error.code = 'AUDIT_SIGNING_KEY_UNAVAILABLE';
  return error;
}

// Which ledger file this call will bind the vault to, resolved WITHOUT opening
// anything: AuditStore's constructor creates the database, so the binding has
// to be settled before a store exists or the refusal leaves a stray ledger
// behind on every attempt.
function boundLedgerFile(dependencies = {}) {
  if (dependencies.store) return dependencies.store.file;
  if (dependencies.storeOptions && dependencies.storeOptions.file !== undefined) return dependencies.storeOptions.file;
  const environment = dependencies.env || process.env;
  const configured = environment.TOOLSENABLED_AUDIT_DB;
  return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_AUDIT_DB;
}

// A REDIRECTED LEDGER MAY NEVER BORROW THE INSTALLATION'S VAULT.
//
// The protected head anchor is a monotonic vault secret keyed only by
// sequence.  Nothing in the anchor identifies WHICH ledger it describes, and
// nothing can: a copy of the ledger is byte-identical to the original up to
// the point it was copied, so no hash, key id, or genesis fingerprint carried
// inside the anchor can tell a fork apart from the ledger it was forked from.
// The only thing that distinguishes them is which file they live in.
//
// That gap was not theoretical.  On 2026-08-10 a diagnostic probe copied
// state/audit.sqlite3 to a scratch directory and redirected
// TOOLSENABLED_AUDIT_DB at the copy, but left TOOLSENABLED_VAULT_PATH alone.
// The copy therefore signed with the real vault key and, being one event
// ahead of the ledger it was forked from, won the monotonic comparison and
// advanced the PRODUCTION anchor to an event that exists only in the copy.
// Production's own event already occupied that sequence, so from then on
// every fresh process failed validateAnchorEvent with
// AUDIT_ANCHOR_INTEGRITY_ALARM -- correctly, since the protected head really
// did stop describing the canonical ledger -- and requireRecord refused every
// external-write tool product-wide.  A monotonic anchor cannot be moved back,
// so the damage is not self-healing; prevention is the only real fix.
//
// The rule is mechanical and fails closed: if the ledger has been redirected
// away from this installation's own file, the vault must be redirected too.
// Production sets neither variable and is unaffected.  Isolated test runs
// (tests/lib/isolated-environment.js) set both and are unaffected.  What is
// refused is exactly the asymmetric combination that caused the incident --
// and it is refused BEFORE the signing key is read, so a forked ledger never
// reaches the vault at all, rather than being caught afterwards by an alarm
// that has already been armed against the wrong ledger.
//
// What this does NOT cover: two ledgers that legitimately share one isolated
// vault can still poison each other's anchor. Closing that needs the anchor to
// carry the ledger identity it describes, which is an anchor-format change and
// belongs to the audit-root write-path owner.
function assertLedgerVaultBinding(store, dependencies = {}) {
  // An injected secret plane is not the installation vault by construction.
  if (dependencies.anchorStore || dependencies.getSecret || dependencies.setMonotonicSecret) return;
  const environment = dependencies.env || process.env;
  const configuredVault = environment.TOOLSENABLED_VAULT_PATH;
  const file = store && store.file;
  if (typeof file !== 'string' || file === '') return;
  // Comparing resolved paths, not the raw variable: setting TOOLSENABLED_AUDIT_DB
  // to this installation's own ledger is not a redirect.
  if (file !== ':memory:' && path.resolve(file) === path.resolve(DEFAULT_AUDIT_DB)) return;

  if (typeof configuredVault === 'string' && configuredVault.trim() !== '') {
    // Installed runtime.js publishes the installation vault path into the
    // environment for helper programs.  Presence of the variable therefore
    // does not prove that an operator redirected the vault along with this
    // ledger.  Resolve the vault that this installation would use with the
    // override absent and only accept a genuinely different location.
    const withoutVaultOverride = { ...environment };
    for (const name of Object.keys(withoutVaultOverride)) {
      if (name.toUpperCase() === 'TOOLSENABLED_VAULT_PATH') delete withoutVaultOverride[name];
    }
    const installationVault = resolveVaultLocation({ environment: withoutVaultOverride }).file;
    const normalized = candidate => {
      const resolved = path.resolve(candidate);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (normalized(configuredVault.trim()) !== normalized(installationVault)) return;
  }
  const error = new Error('The audit ledger has been redirected away from this installation, so it may not use the installation vault; set TOOLSENABLED_VAULT_PATH as well.');
  error.code = 'AUDIT_LEDGER_VAULT_MISMATCH';
  throw error;
}

function keyMaterial(dependencies, store) {
  if (dependencies.signer) return dependencies.signer;
  if (defaultSigner) return defaultSigner;
  const readSecret = dependencies.getSecret || getSecret;
  const getOrCreate = dependencies.getOrCreateSecret || getOrCreateSecret;
  let privatePem;
  try {
    privatePem = readSecret(SIGNING_VAULT_KEY);
  } catch (error) {
    if (!error || error.code !== 'SECRET_NOT_CONFIGURED') {
      throw signingKeyUnavailable('The audit signing key cannot be read in this operating-system identity or vault context.', error);
    }
    // A different vault path or Windows DPAPI identity may look like a fresh
    // vault to this process.  Never create a replacement signing key after a
    // canonical ledger already exists: it cannot attest that ledger and would
    // strand a new key in the wrong vault context.
    if (store && store.status().headSequence > 0) {
      throw signingKeyUnavailable('The audit signing key is not configured for the existing canonical ledger; refusing to create a replacement key.');
    }
    const generated = crypto.generateKeyPairSync('ed25519');
    const candidate = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    try {
      privatePem = getOrCreate(SIGNING_VAULT_KEY, candidate);
    } catch (createError) {
      throw signingKeyUnavailable('The audit signing key could not be initialized in this operating-system identity or vault context.', createError);
    }
  }
  defaultSigner = signerFromPrivateKey(privatePem);
  return defaultSigner;
}

function signerFromPrivateKey(privatePem) {
  const privateKey = crypto.createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The audit vault key is not an Ed25519 private key.');
  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  return {
    keyId: `audit-ed25519-${fingerprint}`,
    publicKeyPem,
    sign: value => crypto.sign(null, value, privateKey)
  };
}

// Derive a symmetric mac key from the trusted Ed25519 audit signer rather
// than provisioning and managing a second vault secret. Ed25519 signing is
// deterministic (RFC 8032): the same signer, over this fixed and
// domain-separated challenge, always yields the same bytes, which are then
// hashed -- never used as a literal signature -- so a captured mac can
// never be replayed as (or confused with) a real ledger-event or
// head-anchor signature. This needs no vault round-trip beyond whatever
// prepare() already performed to obtain the canonical signer, and because
// every caller that wants to avoid touching the real vault already injects
// `dependencies.signer` (the established convention throughout this file
// and its tests), it inherits that same test isolation for free -- no
// separate key to fake, no risk of a test run provisioning a real secret.
function deriveSpoolMacKey(signer, dependencies) {
  if (dependencies && dependencies.spoolKey) return dependencies.spoolKey;
  return crypto.createHash('sha256').update(Buffer.from(signer.sign(SPOOL_MAC_CHALLENGE))).digest();
}

function spoolMac(item, key) {
  return crypto.createHmac('sha256', key).update(canonicalJson(item)).digest('hex');
}

// Wrap a spooled item with an authentication tag derived from the trusted
// audit signer. A same-user process without vault access can still write
// bytes into the spool directory, but it cannot forge this tag -- that is
// what turns "attacker-writable JSON" into something ingestEmergency() can
// safely refuse (AUDIT-F-03) instead of handing to the trusted canonical
// signer unexamined. `signerHint` is the signer prepare() already obtained
// for this call, when one is available; if it is not (the canonical store
// failed before a signer could be registered at all), this falls back to
// keyMaterial() directly, which still resolves instantly from the injected
// `dependencies.signer` or the in-process signer cache in every realistic
// case. If the signer truly cannot be produced (a total, otherwise-
// unobserved vault outage on the very first call in the process), the
// spool write still happens rather than being lost: it is recorded as
// explicitly unauthenticated, so verifySpoolEnvelope() refuses it and
// ingestEmergency() quarantines it for manual recovery instead of silently
// canonicalizing or silently discarding it.
function spoolEnvelope(item, dependencies, signerHint) {
  try {
    const signer = signerHint || keyMaterial(dependencies, getStore(dependencies));
    const key = deriveSpoolMacKey(signer, dependencies);
    return { version: 1, domain: SPOOL_ENVELOPE_DOMAIN, item, mac: spoolMac(item, key) };
  } catch (error) {
    return { version: 1, domain: SPOOL_ENVELOPE_DOMAIN, item, mac: null, authError: safeError(error) };
  }
}

// Returns the enclosed item only when the envelope's mac verifies against
// the current spool mac key, derived from `signer` -- the exact
// vault-trusted signer ingestEmergency()'s caller just registered against
// the canonical ledger. Anything else -- a bare pre-fix spool line, a
// hand-crafted "recovered" JSON file, a mac derived under a since-rotated
// signer, a mac that simply does not match -- is treated exactly like
// structurally-invalid JSON by the caller: quarantined, never appended to
// the canonical, signed ledger.
function verifySpoolEnvelope(record, signer, dependencies) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.version !== 1 || record.domain !== SPOOL_ENVELOPE_DOMAIN) return null;
  if (typeof record.mac !== 'string' || !/^[a-f0-9]{64}$/.test(record.mac)) return null;
  const item = record.item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  let expected;
  try { expected = spoolMac(item, deriveSpoolMacKey(signer, dependencies)); }
  catch { return null; }
  const left = Buffer.from(record.mac, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  return item;
}

// CRED-F7: even an authenticated spool item is untrusted disk content by the
// time it reaches ingestion -- re-run the same scrub() a fresh eventInput()
// would apply rather than trust that whatever produced the original spooled
// event object already did (or still does, if scrub()'s own patterns have
// since been tightened). This is deliberately independent of the mac check
// above: the mac only proves who wrote the bytes, not that the content is
// still safe to canonicalize into the permanent, signed ledger.
function rescrubSpoolItem(item) {
  if (typeof item.eventId !== 'string' || !EVENT_ID_RE.test(item.eventId)) return null;
  if (!Number.isSafeInteger(item.occurredAtMs) || item.occurredAtMs < 0) return null;
  if (!Number.isSafeInteger(item.createdAtMs) || item.createdAtMs < 0) return null;
  const source = item.event;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  return {
    eventId: item.eventId,
    occurredAtMs: item.occurredAtMs,
    createdAtMs: item.createdAtMs,
    event: {
      timestamp: typeof source.timestamp === 'string' ? source.timestamp : new Date(item.occurredAtMs).toISOString(),
      action: scrub(source.action),
      target: scrub(source.target),
      details: scrub(source.details)
    }
  };
}

function registerSigner(store, dependencies, now) {
  const signer = keyMaterial(dependencies, store);
  if (!signer || typeof signer.keyId !== 'string' || typeof signer.publicKeyPem !== 'string' || typeof signer.sign !== 'function') {
    throw new Error('The audit signer dependency is incomplete.');
  }
  store.registerKey({ keyId: signer.keyId, publicKeyPem: signer.publicKeyPem, createdAtMs: now });
  return signer;
}

// READ THE ARCHIVE BOUNDARY BACK, TRUSTING NOTHING UNTIL IT IS VERIFIED.
//
// `store.getMetadata` returns whatever bytes are in audit_metadata -- an
// ordinary table, writable by anything with database access. This function is
// the only place that is allowed to turn those bytes into something a
// verification path roots on, and it does so by handing them straight to
// verifiedArchiveBoundary() with the CALLER's vault-derived signer, never a
// key resolved from the ledger itself.
//
// Absent, malformed, or forged all return null identically -- the caller
// cannot distinguish "no boundary was ever set" from "someone tried to forge
// one", which is deliberate: both must produce the same fail-closed outcome,
// genesis rooting, with no side channel for a forgery attempt to behave
// differently from a quiet install that has never archived anything.
function readArchiveBoundary(store, signer) {
  let stored;
  try { stored = store.getMetadata(ARCHIVE_BOUNDARY_METADATA_KEY); }
  catch { return null; }
  if (!stored || typeof stored !== 'object') return null;
  return verifiedArchiveBoundary(stored.value, signer);
}

// COLD STORAGE: the flat file the archived events actually live in.
//
// One JSONL file, one archived event per line, each line the SAME row shape
// SQLite stores (sequence, eventId, occurredAtMs, eventJson AS A STRING,
// previousHash, eventHash, keyId, signature, createdAtMs) -- not the parsed
// `rowEvent()` shape, so eventHashInput() can be replayed against it verbatim
// with no re-serialization step to get subtly out of sync with what was
// actually signed.
const ARCHIVE_FILE_NAME = 'audit-archive.jsonl';

function defaultArchiveFile(dependencies) {
  const resolvePath = dependencies.rootPath || rootPath;
  return resolvePath('state', ARCHIVE_FILE_NAME);
}

function archiveEventLine(row) {
  return `${canonicalJson({
    sequence: row.sequence, eventId: row.eventId, occurredAtMs: row.occurredAtMs,
    eventJson: row.eventJson, previousHash: row.previousHash, eventHash: row.eventHash,
    keyId: row.keyId, signature: row.signature, createdAtMs: row.createdAtMs
  })}\n`;
}

// ONE LINE'S WORST-CASE SIZE ON DISK.
//
// TESTED, not assumed: archiveEventLine() serializes the WHOLE line --
// sequence, eventId, occurredAtMs, previousHash, eventHash, keyId,
// signature, createdAtMs, AND eventJson itself, embedded as an escaped
// string field -- through canonicalJson() (audit-store.js), which enforces
// MAX_EVENT_BYTES against that COMBINED object, not against eventJson
// alone. Framing is not added on top of the ceiling; it shares it.
// Building this lane's own large-batch test with eventJson near
// MAX_EVENT_BYTES hit exactly this: archiveEventLine() throws
// AUDIT_EVENT_TOO_LARGE before a line that big is ever written, so
// MAX_EVENT_BYTES is already the true per-line ceiling -- plus one byte for
// the trailing newline archiveEventLine() adds after the size check runs.
const ARCHIVE_LINE_MAX_BYTES = MAX_EVENT_BYTES + 1;

// HOW FAR BEHIND THE TAIL A RETRIED BATCH CAN LEGITIMATELY REACH.
//
// enforceRetentionAfterAppend() rolls its whole excess in one pass, and
// excess is bounded by eventWindowSlack()'s own ceiling (audit-retention.js:
// `Math.min(2000, ...)`) regardless of the configured retention value -- so
// no genuine retry can ever need to look back further than that many WORST-
// CASE lines from the tail to find the row it already archived. This is a
// hard ceiling derived by construction from the two numbers that actually
// bound it, not a tuned byte constant: a fixed guess sized for "small"
// lines undercounts the moment a batch's events approach MAX_EVENT_BYTES
// each, which is exactly the case this ceiling exists to still cover.
const ARCHIVE_RETRY_BATCH_CEILING = 2000;
const ARCHIVE_RETRY_LOOKBEHIND_HARD_CEILING_BYTES = ARCHIVE_RETRY_BATCH_CEILING * ARCHIVE_LINE_MAX_BYTES;

// Each backward step reads this many NEW bytes and no more -- never a
// window that gets thrown away and re-read larger, which is what this
// lane's first version of this function did (start small, re-read a bigger
// span from the same end point on every retry). For a genuine retry the
// target is within the last chunk, so the first read usually answers; nothing
// pays for a second chunk unless the first one did not already have it.
const ARCHIVE_LOOKBEHIND_CHUNK_BYTES = 256 * 1024;

// READ THE ARCHIVE BACKWARD, ONE FIXED CHUNK AT A TIME, NEVER RE-FETCHING A
// BYTE THIS FUNCTION HAS ALREADY READ.
//
// `onWindow(lines, finalWindow)` sees every line read so far -- the
// accumulated buffer, not just the newest chunk, since a target sequence
// found only after growing the buffer must still be scored against the
// caller's OWN "is there a lower sequence yet" rule over the whole thing it
// has seen -- and returns `undefined` to ask for the next chunk (only
// meaningful when `finalWindow` is false) or any other value, including
// `null`, as the definitive answer. Shared by archiveTailSequence() (wants
// the single last line; a parse failure before the final window means the
// line was truncated by too small a window, not that there is no tail) and
// archiveEventHashAtSequence() (wants one specific sequence and knows it
// has ruled it out for good, not just for this window, the moment a lower
// sequence appears). Growth stops, definitively, at `hardCeilingBytes` --
// neither one ever reads the whole file just because the file is large.
function readArchiveWindow(file, dependencies, hardCeilingBytes, onWindow) {
  const io = dependencies.fs || fs;
  if (!io.existsSync(file)) return onWindow([], true);
  if (io !== fs) {
    // Positional reads are only meaningful against the real filesystem; an
    // injected test double has no obligation to implement openSync/readSync,
    // and its files are small enough that one full read costs nothing --
    // same distinction streamedFileDigest() already draws. No chunk loop
    // needed: this is the only read that will happen.
    const content = io.readFileSync(file, 'utf8');
    return onWindow(content.split('\n').filter(Boolean), true);
  }
  const size = fs.statSync(file).size;
  if (size === 0) return onWindow([], true);
  const handle = fs.openSync(file, 'r');
  try {
    let bytesRead = 0;
    let buffer = '';
    while (true) {
      const remainingToCeiling = hardCeilingBytes - bytesRead;
      const remainingInFile = size - bytesRead;
      const chunkLength = Math.min(ARCHIVE_LOOKBEHIND_CHUNK_BYTES, remainingInFile, remainingToCeiling);
      const finalByCeiling = remainingToCeiling <= 0;
      if (chunkLength > 0) {
        const start = size - bytesRead - chunkLength;
        const raw = Buffer.allocUnsafe(chunkLength);
        fs.readSync(handle, raw, 0, chunkLength, start);
        // Prepend: this chunk is strictly OLDER (further from the tail)
        // than everything already in `buffer`.
        buffer = raw.toString('utf8') + buffer;
        bytesRead += chunkLength;
      }
      const reachedStart = bytesRead >= size;
      const finalWindow = reachedStart || finalByCeiling;
      const lines = buffer.split('\n').filter(Boolean);
      const result = onWindow(lines, finalWindow);
      if (result !== undefined || finalWindow) return result;
    }
  } finally { fs.closeSync(handle); }
}

// THE ARCHIVE'S OWN LAST SEQUENCE, READ CHEAPLY.
//
// rollOldestEventOut() always archives the single OLDEST live row, strictly
// in increasing sequence order -- appendArchiveEvent() is never asked to
// write anything but the next sequence after whatever the file already
// ends on, or a retry of that same one (see appendArchiveEvent below). So
// the only row this ever needs to compare against is the file's own tail.
// One worst-case line is the hard ceiling here: there is only ever one tail
// to find, never a batch to search -- a parse failure before the final
// window means the window was too small to hold the whole last line, not
// that the tail is unreadable, so it asks to grow rather than answering
// null early.
function archiveTailSequence(file, dependencies = {}) {
  return readArchiveWindow(file, dependencies, ARCHIVE_LINE_MAX_BYTES, (lines, finalWindow) => {
    if (!lines.length) return finalWindow ? null : undefined;
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      return Number.isSafeInteger(last.sequence) ? last.sequence : null;
    } catch { return finalWindow ? null : undefined; }
  });
}

// THE ARCHIVE'S OWN RECORD FOR ONE SEQUENCE AT OR BEHIND THE TAIL, IF ANY.
//
// Grows its read window (see readArchiveWindow above) until it finds
// `sequence`, definitively rules it out (a lower sequence appears in the
// window it already read -- lines are strictly increasing, so nothing
// earlier in the file can still be the target), or exhausts the hard
// ceiling. Returns the archived line's own eventHash when found, or null
// otherwise -- which a caller must treat as "cannot confirm this is the
// same row", not as "this row was never archived".
function archiveEventHashAtSequence(file, sequence, dependencies = {}) {
  return readArchiveWindow(file, dependencies, ARCHIVE_RETRY_LOOKBEHIND_HARD_CEILING_BYTES, (lines, finalWindow) => {
    // Scan from the end: the row being looked up is always close to the
    // tail for a genuine retry, so this is typically the first or second
    // line checked, not a full scan of the window.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let parsed;
      try { parsed = JSON.parse(lines[index]); } catch { continue; }
      if (parsed.sequence === sequence) return typeof parsed.eventHash === 'string' ? parsed.eventHash : null;
      // Lines are in increasing sequence order; once we pass below the
      // target there is nothing earlier in the file that could still match
      // it -- ruled out for good, not just for this window.
      if (Number.isSafeInteger(parsed.sequence) && parsed.sequence < sequence) return null;
    }
    return finalWindow ? null : undefined;
  });
}

function archiveBehindError(row, tail, archivedHash) {
  return auditFailure('AUDIT_ARCHIVE_BEHIND',
    'The archive already holds a different or unverifiable event at this sequence; refusing to silently skip or duplicate it.',
    { sequence: row.sequence, tailSequence: tail, archivedHash: archivedHash || null });
}

// APPEND ONLY, DURABLE BEFORE ANYTHING ELSE HAPPENS -- AND IDEMPOTENT BY
// SEQUENCE, BECAUSE THE CALLER'S RETRY CANNOT TELL THIS ALREADY HAPPENED.
//
// Mirrors the ordering the jsonl/text projections already use (audit.js
// projectSinks: append the file, THEN record success) for the same reason:
// the file write must be the first thing that can fail. Once this returns,
// the archived event exists on disk. Only after that may the caller delete
// the live row and advance the boundary -- so a crash between those two steps
// leaves the event durably in BOTH places (duplicated, still fully
// verifiable) rather than in neither. The reverse order could lose it.
//
// rollOldestEventOut() runs inside the caller's already-open admission
// transaction (a projection lock, or a fresh store._transaction if none is
// held), and a single admission rolls its whole excess in one pass when the
// live window is over its cap -- enforceRetentionAfterAppend() calls this
// once per row in that excess, all inside the same transaction, before
// either projection file is rebuilt. So when something LATER in that same
// transaction fails for an unrelated reason, EVERY SQL DELETE the whole
// batch made is rolled back, but every one of these durable fs appends
// already happened and none of them can be. The retry restarts the same
// batch from its first row -- so the row this call is asked to archive may
// be anywhere at or behind the file's own tail, not only exactly at it.
// MEASURED on the live install: one retried sequence range with 2-4
// byte-identical duplicate lines per sequence, tapering either side of the
// window that was retried -- a multi-row batch, which is why comparing
// against only an exact tail match (this function's first version) still
// missed every row in the batch except the last. This is that fix, not a
// workaround: a caller retrying the same logical roll is expected and
// already safe everywhere else in this file (record() itself spools and
// retries on the same principle), so an operation named "append the
// archived row for this sequence" should already have been idempotent in
// that sequence, and now is.
//
// SEQUENCE ALONE IS NOT ENOUGH TO TRUST A SKIP.
//
// row.sequence <= tail is also what a fresh or re-genesised audit.sqlite3
// would produce sitting next to an OLD archive file that was never reset
// with it -- the two are separate files on separate paths, coupled only by
// a signed boundary that lives INSIDE the database, so nothing at genesis
// cross-checks a fresh DB's sequence range against a pre-existing archive's
// tail (readArchiveBoundary() only ever reads that small metadata record,
// never opens the archive file). Skipping on position alone in that state
// would let the roll's SQL delete the row from live while never archiving
// it: silent loss the pre-fix code could not produce. So a row at or behind
// the tail is only ever skipped once verified BYTE-IDENTICAL to what the
// archive already holds at that exact sequence (matching eventHash, looked
// up within the bounded retry window above); anything else -- a mismatch,
// or nothing found in that window at all -- refuses loudly instead.
function appendArchiveEvent(row, dependencies = {}) {
  const io = dependencies.fs || fs;
  const makeDirectory = dependencies.ensureDir || ensureDir;
  const append = dependencies.appendFileSync || io.appendFileSync.bind(io);
  const file = dependencies.archiveFile || defaultArchiveFile(dependencies);
  makeDirectory(path.dirname(file));
  const tail = archiveTailSequence(file, dependencies);
  if (tail !== null && row.sequence <= tail) {
    const archivedHash = archiveEventHashAtSequence(file, row.sequence, dependencies);
    if (archivedHash !== null && archivedHash === row.eventHash) return file;
    throw archiveBehindError(row, tail, archivedHash);
  }
  append(file, archiveEventLine(row), 'utf8');
  return file;
}

// WALK THE ARCHIVE THE SAME WAY THE LIVE LEDGER IS WALKED.
//
// Same five checks _verifySnapshot runs on every live row -- sequence
// contiguity from genesis, previousHash chain, canonical-JSON form, hash
// recompute, key-identity binding (public-key-identity) -- plus the
// signature. This is deliberately the expensive, complete check: it is NOT
// meant to run on every process start (that would just relocate the
// unbounded-growth problem into cold storage). It is the on-demand "an
// auditor can still run a complete verification and every signature checks"
// path -- legal's requirement -- for the events that have left the live
// table.
//
// `keys` is an array of {keyId, publicKeyPem, algorithm}, the same shape
// AuditStore.getKey()/listKeys() rows carry, so a caller can pass either the
// live ledger's current key set or an independently-held copy for a fully
// offline check.
function verifyArchiveSegment(file, keys, dependencies = {}) {
  const io = dependencies.fs || fs;
  if (!io.existsSync(file)) return { valid: true, entries: 0, tailSequence: 0, tailHash: ZERO_HASH };
  let content;
  try { content = io.readFileSync(file, 'utf8'); }
  catch (error) { return { valid: false, entries: 0, reason: 'archive-unreadable', error: safeError(error) }; }
  const lines = content.length ? content.replace(/\n$/, '').split('\n') : [];

  const keyObjects = new Map();
  for (const key of (Array.isArray(keys) ? keys : [])) {
    let inspected;
    try { inspected = publicKeyHash(key.publicKeyPem); }
    catch { return { valid: false, entries: lines.length, reason: 'public-key' }; }
    if (key.algorithm !== 'ed25519' || key.publicKeyHash !== inspected.hash) {
      return { valid: false, entries: lines.length, reason: 'public-key-hash', keyId: key.keyId };
    }
    // Same rule as _verifySnapshot: a key claiming the derived audit-ed25519-
    // form must actually be that material, or the archive's history could be
    // rewound onto substituted key material the same way the live ledger's
    // could.
    if (key.keyId.startsWith('audit-ed25519-') && key.keyId !== `audit-ed25519-${inspected.hash}`) {
      return { valid: false, entries: lines.length, reason: 'public-key-identity', keyId: key.keyId };
    }
    keyObjects.set(key.keyId, inspected.key);
  }

  // How far back a tolerated repeat may reach. rollArchiveOnce's caller
  // (enforceRetentionAfterAppend) never rolls more than the live window
  // holds, so a retried batch can never re-archive a sequence further back
  // than one retention cap plus its roll slack -- the same 10,000 + 500
  // Controller 4 named. Bounding the lookback keeps a genuinely ancient,
  // unrelated sequence number from ever being accepted as "just a repeat".
  const MAX_TOLERATED_REPEAT_LOOKBACK = 10500;
  let previousHash = ZERO_HASH;
  let expectedSequence = 1;
  const acceptedBySequence = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    let row;
    try { row = JSON.parse(lines[index]); }
    catch { return { valid: false, entries: lines.length, invalidSequence: expectedSequence, reason: 'archive-line-malformed' }; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { valid: false, entries: lines.length, invalidSequence: expectedSequence, reason: 'archive-line-malformed' };
    }
    // A RETRIED RETENTION-ROLL BATCH CAN DURABLY RE-ARCHIVE A WHOLE RANGE,
    // NOT JUST THE ONE LINE ADJACENT TO IT.
    //
    // appendArchiveEvent() is a plain fs write outside the SQL transaction
    // that deletes the corresponding live rows (audit-store.js
    // rollOldestEventOut: "Durable write + boundary FIRST. Anything this
    // throws aborts the transaction with the row still present."). When that
    // transaction is the caller's own outer writer-lock transaction
    // (published via _projectionDb) and it later rolls back for an unrelated
    // reason, the fs writes survive but the SQL deletes do not -- so a retry
    // of the same batched admission re-selects the same still-live rows, IN
    // ORDER, and re-archives all of them. MEASURED against the live archive
    // (Worker 6's full census, W4/REPORT-archive-duplicates-full-20260907.md):
    // copy 2 of a repeated sequence sits ~501 lines after copy 1 -- the width
    // of the retried batch, not the next line -- so a check that only
    // compares a line to the ONE immediately before it never recognizes the
    // repeat at all. Remembering every accepted row by its own sequence,
    // instead of just the last one, is what makes the comparison correct
    // regardless of how wide the retried batch was.
    //
    // A byte-identical repeat of an already-accepted sequence is a benign
    // no-op: skip it without moving previousHash or expectedSequence. A
    // same-sequence line that differs in even one field, or a repeat of a
    // sequence too old to still be remembered, is not this case -- both fall
    // straight through to the sequence-gap refusal below, exactly as before.
    if (row.sequence < expectedSequence) {
      const accepted = acceptedBySequence.get(row.sequence);
      if (accepted && row.eventId === accepted.eventId && row.occurredAtMs === accepted.occurredAtMs
          && row.eventJson === accepted.eventJson && row.previousHash === accepted.previousHash
          && row.eventHash === accepted.eventHash && row.keyId === accepted.keyId
          && row.signature === accepted.signature && row.createdAtMs === accepted.createdAtMs) {
        continue;
      }
    }
    if (row.sequence !== expectedSequence) {
      return { valid: false, entries: lines.length, invalidSequence: expectedSequence, reason: 'sequence-gap' };
    }
    if (row.previousHash !== previousHash) {
      return { valid: false, entries: lines.length, invalidSequence: row.sequence, reason: 'previous-hash' };
    }
    const keyObject = keyObjects.get(row.keyId);
    if (!keyObject) {
      return { valid: false, entries: lines.length, invalidSequence: row.sequence, reason: 'missing-key' };
    }
    let expectedHash;
    try {
      if (canonicalJson(JSON.parse(row.eventJson)) !== row.eventJson) {
        return { valid: false, entries: lines.length, invalidSequence: row.sequence, reason: 'event-json-canonical' };
      }
      expectedHash = sha256(eventHashInput(row));
    } catch {
      return { valid: false, entries: lines.length, invalidSequence: row.sequence, reason: 'event-json' };
    }
    if (row.eventHash !== expectedHash) {
      return { valid: false, entries: lines.length, invalidSequence: row.sequence, reason: 'event-hash' };
    }
    let validSignature = false;
    try {
      validSignature = crypto.verify(null, Buffer.from(row.eventHash, 'hex'), keyObject, Buffer.from(row.signature, 'base64'));
    } catch { validSignature = false; }
    if (!validSignature) {
      return { valid: false, entries: lines.length, invalidSequence: row.sequence, reason: 'signature' };
    }
    previousHash = row.eventHash;
    acceptedBySequence.set(row.sequence, row);
    // Map iteration order is insertion order, which is accepted-sequence
    // order here, so the single oldest entry is always the correct one to
    // drop first.
    if (acceptedBySequence.size > MAX_TOLERATED_REPEAT_LOOKBACK) {
      acceptedBySequence.delete(acceptedBySequence.keys().next().value);
    }
    expectedSequence += 1;
  }
  return {
    valid: true, entries: lines.length,
    tailSequence: lines.length ? expectedSequence - 1 : 0,
    tailHash: previousHash
  };
}

// THE ROLL: one event out of the live ledger, into cold storage, atomically.
//
// Orchestrates the two halves that cannot live in one place: audit-store.js
// owns the writer transaction and the delete but has no vault access, so it
// cannot sign a boundary; audit.js has the signer but must not reach into the
// ledger's transaction machinery. rollOldestEventOut() closes that by calling
// back here, between its guards and its delete, with the writer lock held.
//
// Everything this callback does must be durable or transactional:
//   - appendArchiveEvent writes the event to cold storage and returns only
//     once it is on disk
//   - setMetadata records the new signed boundary inside the same transaction
//     as the delete, so the boundary and the ledger can never disagree about
//     what has been archived
//
// Returns the store's roll result, with the minted boundary attached when one
// actually happened. A refusal (window not exceeded, a sink still behind) is a
// normal outcome, not an error.
function rollArchiveOnce(store, signer, dependencies = {}, { nowMs, minimumRetained = 1 } = {}) {
  if (!signer || typeof signer.sign !== 'function' || typeof signer.keyId !== 'string') {
    throw auditFailure('AUDIT_ARCHIVE_ROLL_UNAVAILABLE', 'Rolling the audit archive requires the vault signer.');
  }
  const now = nowMs === undefined ? (dependencies.clock || Date.now)() : nowMs;
  let minted = null;
  const result = store.rollOldestEventOut({ nowMs: now, minimumRetained }, (row, lockedStore, at) => {
    appendArchiveEvent(row, dependencies);
    // The boundary names the event that just left: its sequence becomes
    // archivedThroughSequence, and its own event_hash becomes what the live
    // chain's new first row must chain back to.
    minted = makeArchiveBoundary({ archivedThroughSequence: row.sequence, eventHash: row.eventHash }, signer);
    lockedStore.setMetadata(ARCHIVE_BOUNDARY_METADATA_KEY, minted, at);
  });
  return minted ? { ...result, boundary: minted } : result;
}

function anchorPayload(anchor) {
  return {
    domain: HEAD_DOMAIN,
    version: 1,
    sequence: anchor.sequence,
    eventHash: anchor.eventHash,
    keyId: anchor.keyId
  };
}

function makeAnchor(event, signer) {
  const payload = anchorPayload({ sequence: event.sequence, eventHash: event.eventHash, keyId: event.keyId });
  return { ...payload, signature: signer.sign(Buffer.from(canonicalJson(payload), 'utf8')).toString('base64') };
}

// THE ARCHIVE BOUNDARY: WHERE THE LIVE CHAIN IS ROOTED ONCE OLD EVENTS MOVE OUT.
//
// The audit ledger is unbounded today -- measured 1,527 events/day, ~557,000
// after a year -- and every short-lived process re-verifies all of it. Moving
// the oldest events to signed cold storage is what bounds that. A boundary is
// the claim "everything through sequence M is archived, and event M hashed to
// H", which lets audit-store root the live chain at (M, H) instead of at
// genesis.
//
// It is the load-bearing piece of the whole scheme: without it, removing the
// oldest events would simply make front-truncation undetectable, which trades
// the customer's CPU for the exact property the ledger exists to provide.
//
// NO SEPARATE SEGMENT DIGEST. An earlier draft carried a `segmentDigest`
// meant to pin the archive file's content. It was redundant and dropped
// before anything depended on it: `eventHash` already commits to the archived
// chain's tail via the identical previousHash formula live events use, so it
// transitively covers every archived event back to true genesis. An archive
// file needs no separate whole-file digest -- it is verified the same way the
// live ledger is, by walking it and checking that chain, and confirming the
// last line's (sequence, eventHash) equals the boundary's own. A content
// digest would also have meant re-hashing a permanently growing file on every
// mint, which is exactly the unbounded cost this whole mechanism exists to
// remove.
function archiveBoundaryPayload(boundary) {
  return {
    domain: ARCHIVE_BOUNDARY_DOMAIN,
    version: 1,
    archivedThroughSequence: boundary.archivedThroughSequence,
    eventHash: boundary.eventHash,
    keyId: boundary.keyId
  };
}

function makeArchiveBoundary({ archivedThroughSequence, eventHash }, signer) {
  const payload = archiveBoundaryPayload({ archivedThroughSequence, eventHash, keyId: signer.keyId });
  return { ...payload, signature: signer.sign(Buffer.from(canonicalJson(payload), 'utf8')).toString('base64') };
}

// THE VERIFYING KEY COMES FROM THE VAULT, NOT FROM audit_keys.
//
// validateAnchorSignature() resolves its key with store.getKey(anchor.keyId) --
// out of the same database it is auditing. For the head anchor that is tolerable
// because the anchor itself lives in the DPAPI vault, so forging one already
// requires vault write access. A boundary lives in audit_metadata, which is an
// ordinary table an attacker with database access can write. If its verifying
// key also came from that database, an attacker could register a key and sign
// their own boundary: the root of trust would sit inside the surface it audits.
//
// So the signer is a REQUIRED argument and its publicKeyPem is vault-derived
// (see getSigner: the pem is exported from the private key read out of
// SIGNING_VAULT_KEY). No store, no getKey, no lookup.
//
// EVERY failure returns null, and null means "root at genesis" -- today's
// behaviour. That is deliberate and it is fail-closed rather than fail-open: if
// events really have been archived and the boundary is missing, corrupt, or
// forged, genesis rooting makes the live rows start above sequence 1 and
// verification fails with sequence-gap. A tampered boundary can never widen what
// verification accepts; it can only fail to narrow it.
function verifiedArchiveBoundary(raw, signer) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!signer || typeof signer.publicKeyPem !== 'string' || !signer.publicKeyPem) return null;
  if (raw.domain !== ARCHIVE_BOUNDARY_DOMAIN || raw.version !== 1) return null;
  if (!Number.isSafeInteger(raw.archivedThroughSequence) || raw.archivedThroughSequence < 1) return null;
  if (typeof raw.eventHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.eventHash)) return null;
  if (typeof raw.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(raw.keyId)) return null;
  if (typeof raw.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.signature)) return null;
  // A boundary signed by some other key is not this installation's boundary,
  // even if that signature is internally valid.
  if (raw.keyId !== signer.keyId) return null;
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(canonicalJson(archiveBoundaryPayload(raw)), 'utf8'),
      crypto.createPublicKey(signer.publicKeyPem), Buffer.from(raw.signature, 'base64'));
  } catch { valid = false; }
  if (!valid) return null;
  // Only the two fields audit-store roots the chain on are handed onward, so a
  // future field cannot silently acquire meaning inside the verifier.
  return Object.freeze({
    archivedThroughSequence: raw.archivedThroughSequence,
    eventHash: raw.eventHash
  });
}

// WHY A FRESH ANCHOR READ MAY EVER BE SKIPPED, AND ON WHAT EVIDENCE.
//
// readAnchor(fresh) is the audit write path's witness read: it exists so the
// admission sequence can prove the protected head did not change underneath
// it. Every one of those reads used to spawn a full powershell.exe against
// the DPAPI vault. Measured on this machine 2026-08-11 with a private ledger
// and a private vault: SIX of them plus one anchor write per external-write
// record(), ~606 ms each, and all but one of the seven happened INSIDE the
// ledger's BEGIN IMMEDIATE transaction -- ~3.6 s of held single-writer lock
// per record, which is why concurrent agents exhausted the 5,000 ms busy
// retry budget and every external-write tool refused with "Durable audit
// intent could not be recorded".
//
// The anchor is a value stored inside the vault file. If that file's BYTES
// are unchanged since the read that produced the cached anchor, the anchor is
// unchanged: there is no path by which a vault value changes without the file
// changing, because every write re-encrypts the whole file under DPAPI. So a
// content digest of the vault file is a sound witness that a fresh read would
// return exactly what is already in hand.
//
// Three properties this deliberately keeps:
//   * The key is the file's CONTENT hash, never size+mtime. Both halves of a
//     stat are attacker-controllable by an ordinary same-user process, so a
//     stat-keyed cache can be made to serve a remembered anchor over a
//     replaced one -- which would let a rolled-back ledger pass the very
//     check the anchor exists to perform. (Same reasoning as
//     shell/spawn-record.cjs's verdictCache.)
//   * A digest that cannot be computed is UNKNOWN, never "unchanged": null
//     falls through to the real vault read. Failing to look is not evidence.
//   * The digest is captured BEFORE the real read, so the remembered pair can
//     only ever be (older-or-equal digest, this-or-newer anchor). It can
//     never be (current digest, superseded anchor), which is the one
//     direction that could hide a concurrent writer's advance.
// Writes invalidate it outright (see writeAnchor): after this process stores
// an anchor, another process may already have stored a higher one, and
// pairing the current digest with our own value is exactly the stale-low
// binding the point above rules out.
function anchorVaultDigest(dependencies) {
  const reader = dependencies.vaultContentDigest || vaultContentDigest;
  try {
    const digest = reader();
    return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
  } catch { return null; }
}

function readAnchor(dependencies, { fresh = false } = {}) {
  const cacheable = !dependencies.anchorStore && !dependencies.getSecret && !dependencies.setMonotonicSecret;
  if (cacheable && defaultAnchorLoaded && !fresh) return defaultAnchorCache;
  // Captured before the read below so the remembered pairing can never bind a
  // superseded anchor to a current digest.
  const observedDigest = cacheable ? anchorVaultDigest(dependencies) : null;
  if (cacheable && fresh && defaultAnchorLoaded
      && observedDigest !== null && observedDigest === defaultAnchorVaultDigest) {
    anchorReadCounters.cached += 1;
    return defaultAnchorCache;
  }
  anchorReadCounters.real += 1;
  let raw;
  try {
    raw = dependencies.anchorStore
      ? dependencies.anchorStore.get()
      : (dependencies.getSecret || getSecret)(HEAD_VAULT_KEY);
  } catch (error) {
    // Only the vault's mechanical absence classification proves that there is
    // no protected head.  In particular, an I/O/resource failure may inherit
    // text such as "key not found" from a failed helper process; treating that
    // prose as absence both returns a definite null and latches it below.
    if (error && error.code === 'SECRET_NOT_CONFIGURED') {
      if (cacheable) { defaultAnchorLoaded = true; defaultAnchorCache = null; defaultAnchorVaultDigest = observedDigest; }
      return null;
    }
    const unavailable = auditFailure('AUDIT_ANCHOR_READ_UNAVAILABLE',
      'The protected audit head could not be read; this does not claim that the anchor is absent.');
    unavailable.cause = error;
    throw unavailable;
  }
  if (raw === null || raw === undefined || raw === '') {
    if (cacheable) { defaultAnchorLoaded = true; defaultAnchorCache = null; defaultAnchorVaultDigest = observedDigest; }
    return null;
  }
  let anchor;
  // CODED, SO THE DIAGNOSIS SURVIVES THE LOCK.
  //
  // These two throws used to be bare Errors. That was harmless only while every
  // readAnchor() on a failing path happened outside a ledger transaction: a bare
  // Error carries no AUDIT_* code, so preservesClassification()
  // (audit-store.js:315-319) rejects it and _transaction rewrites it as
  // AUDIT_SQLITE_ERROR / "The audit ledger rejected a transaction." -- erasing
  // "the protected audit head anchor is malformed", which is the one sentence
  // that tells an operator what actually broke. That is exactly the
  // generic-error-swallows-a-specific-classification failure the comment at
  // audit-store.js:300-314 exists to prevent.
  //
  // verify() now reads the anchor inside withProjectionLock, so the erasure is
  // reachable. Coding them fixes it at the source for every caller, present and
  // future, instead of depending on where the read happens to sit.
  //
  // Deliberately NOT AUDIT_ANCHOR_INTEGRITY_ALARM: callers treat that code as
  // "genuine audit-integrity evidence, alarm" (see the classification comment
  // above), and an unparseable vault value is not yet that finding.
  try { anchor = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw auditFailure('AUDIT_ANCHOR_MALFORMED', 'The protected audit head anchor is malformed.'); }
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor) || anchor.domain !== HEAD_DOMAIN || anchor.version !== 1 ||
      !Number.isSafeInteger(anchor.sequence) || anchor.sequence < 1 || !/^[a-f0-9]{64}$/.test(anchor.eventHash || '') ||
      typeof anchor.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(anchor.keyId) ||
      typeof anchor.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(anchor.signature)) {
    throw auditFailure('AUDIT_ANCHOR_INVALID', 'The protected audit head anchor is invalid.');
  }
  if (cacheable) { defaultAnchorLoaded = true; defaultAnchorCache = anchor; defaultAnchorVaultDigest = observedDigest; }
  return anchor;
}

// Mechanical classification, not prose: a caller (system-status.js's
// auditState(), or anything future) can check
// `error.code === 'AUDIT_ANCHOR_INTEGRITY_ALARM'` to tell "this is genuine
// audit-integrity evidence, alarm" apart from every other kind of failure
// (disabled audit, I/O error, a busy/locked SQLite connection past its
// timeout, ...), instead of pattern-matching error text -- the same
// "generic error swallows a specific, actionable classification" failure
// already documented for lock contention elsewhere in this codebase
// (agent-coord key help-answer/q33-sqlite-contention-diagnosis-20260729).
// Every throw site reachable ONLY once a benign concurrent-writer race has
// already been ruled out (see reconcileAnchor below) is tagged with this
// code; nothing benign or retryable ever carries it.
// THE EVENTS PAST THE PROTECTED HEAD, SLICED BY POSITION AND NOT BY SEQUENCE.
//
// `events` is the LIVE window: events[i] is sequence (boundary + i + 1), not
// (i + 1). `anchoredSequence` is absolute. Subtracting the boundary is what
// converts one into the other, and while nothing had ever been archived the
// two were the same number -- so slicing by the raw sequence read correctly
// until the first retention roll and silently stopped afterwards.
//
// What that cost was not speed, it was the check this feeds. Measured on the
// owner's install (boundary 981, anchor near sequence 11069, 10,088 live
// rows): the old expression sliced past the end of the array and produced [],
// so the caller's `suffix.some(event => event.keyId !== signer.keyId)` had
// nothing to look at. The alarm for unanchored events signed by some key other
// than the vault-trusted one could not fire on any install that had ever
// rolled -- which, with a bounded default retention, is every install
// eventually. Same arithmetic as audit-store's advanceVerificationCache, which
// carried the same bug and is fixed the same way.
//
// Named and exported so the arithmetic itself is pinned. Building the
// integration case needs a second registered signing key, and the archive
// boundary is deliberately bound to ONE signer identity (verifiedArchiveBoundary
// returns null for a boundary signed by any other key), so a two-signer ledger
// roots at genesis and fails with sequence-gap long before it reaches here.
// The arithmetic is the defect; this is the honest place to hold it.
function unanchoredSuffix(events, anchoredSequence, boundary) {
  const rooted = boundary ? boundary.archivedThroughSequence : 0;
  return events.slice(Math.max(0, anchoredSequence - rooted));
}

function anchorIntegrityAlarm(message) {
  const error = new Error(message);
  error.code = 'AUDIT_ANCHOR_INTEGRITY_ALARM';
  return error;
}

// Self-contained: verifies the anchor's own Ed25519 signature against its
// registered key. This never races a concurrent writer -- the anchor row and
// its key are already in hand -- so it is safe to run immediately, before
// this reader's own ledger snapshot is known to contain the anchor's
// sequence.
function validateAnchorSignature(anchor, store) {
  const key = store.getKey(anchor.keyId);
  if (!key) throw anchorIntegrityAlarm('The protected audit head references an unknown signing key.');
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(canonicalJson(anchorPayload(anchor)), 'utf8'),
      crypto.createPublicKey(key.publicKeyPem), Buffer.from(anchor.signature, 'base64'));
  } catch { valid = false; }
  if (!valid) throw anchorIntegrityAlarm('The protected audit head signature is invalid.');
}

// Only safe to call once the caller has established that `anchor.sequence`
// is actually contained in the ledger snapshot `store` is being checked
// against for this call (i.e. current.sequence <= that snapshot's head
// sequence -- see reconcileAnchor's ordering below). A verification-cache
// read can legitimately lag a concurrently-advanced anchor for a few
// milliseconds under sustained concurrent writers; calling this before that
// gap is resolved reports a benign, self-correcting race as ledger
// tampering, which is precisely the false alarm this split exists to avoid.
function validateAnchorEvent(anchor, store) {
  const event = store.getEvent({ sequence: anchor.sequence });
  if (!event || event.eventHash !== anchor.eventHash || event.keyId !== anchor.keyId) {
    throw anchorIntegrityAlarm('The protected audit head does not match the canonical ledger.');
  }
  return { anchor, event };
}

function validateAnchor(anchor, store) {
  validateAnchorSignature(anchor, store);
  return validateAnchorEvent(anchor, store);
}

function writeAnchor(anchor, store, dependencies) {
  const encoded = canonicalJson(anchor);
  const writer = dependencies.anchorStore
    ? (value, sequence) => dependencies.anchorStore.set(value, sequence)
    : (value, sequence) => (dependencies.setMonotonicSecret || setMonotonicSecret)(HEAD_VAULT_KEY, value, sequence);
  anchorReadCounters.writes += 1;
  try {
    const written = writer(encoded, anchor.sequence);
    if (!dependencies.anchorStore && !dependencies.getSecret && !dependencies.setMonotonicSecret) {
      defaultAnchorLoaded = true;
      defaultAnchorCache = anchor;
      // FAIL CLOSED, NOT FAST -- with one exact exception. A digest taken HERE,
      // after the vault released its lock, could pair a superseded anchor with
      // the live file (another process may already have stored a higher one)
      // and let a later reader miss that advance. So nothing taken here is
      // ever used. What IS used is the digest the vault helper reports from
      // INSIDE its own lock (tools/secrets.ps1 Write-VaultContentDigest): it
      // names a vault holding exactly this anchor and nothing after it, so no
      // writer can have interleaved. Anything else stays null -- unknown, and
      // the next fresh read pays one real vault read and is correct.
      defaultAnchorVaultDigest = typeof written === 'string' && /^[a-f0-9]{64}$/.test(written) ? written : null;
    }
    return { anchor, advanced: true, dominated: false };
  } catch (error) {
    // Another process may have advanced farther while this process was delayed.
    // A valid higher anchor dominates this update and is a successful outcome.
    let current;
    try { current = readAnchor(dependencies, { fresh: true }); } catch { throw error; }
    if (current && current.sequence >= anchor.sequence) {
      validateAnchor(current, store);
      if (current.sequence > anchor.sequence || current.eventHash === anchor.eventHash) {
        return { anchor: current, advanced: false, dominated: current.sequence > anchor.sequence };
      }
    }
    throw error;
  }
}

function reconcileAnchor(store, signer, dependencies, snapshot, {
  advance = true, fresh = false, boundary = readArchiveBoundary(store, signer)
} = {}) {
  const files = dependencies.verificationFiles;
  let current = readAnchor(dependencies, { fresh });
  // A SUPPLIED SNAPSHOT MAKES THIS DIGEST DEAD WORK, AND IT IS NOT CHEAP.
  //
  // verificationExternal() reads and SHA-256s BOTH projection files in full.
  // Measured on an 8000-event ledger that is 6.7 MB of projection, one call
  // is ~13 ms, and this one runs INSIDE the writer lock on every record()
  // (appendVerifiedUnderLock passes its already-trusted snapshot here).
  //
  // With a snapshot supplied it feeds exactly two things, and neither can
  // read it: `verified` is short-circuited by `snapshot ||` below, and
  // `stableExternal` is only ever read inside the retry loop under
  // !snapshotConsumed -- which is false for the whole call once a snapshot
  // was supplied. Every later external witness in this function
  // (refreshedExternal, candidateExternal, reboundExternal) is read fresh
  // rather than derived from this one, so nothing downstream weakens: the
  // same comparisons happen against the same freshly-read digests.
  const initialExternal = snapshot ? null : verificationExternal(files, dependencies, current);
  const cacheStateBefore = !snapshot && typeof store.verificationCacheStatus === 'function'
    ? store.verificationCacheStatus() : null;
  const hadTrustedFastPath = Boolean(cacheStateBefore && cacheStateBefore.cached);
  let verified = snapshot || store.verifyWithEvents({
    external: initialExternal,
    uncached: dependencies.auditVerificationUncached === true,
    boundary
  });
  if (!verified.verification.valid) throw auditFailure('AUDIT_LEDGER_INVALID', `The canonical audit ledger is invalid (${verified.verification.reason}).`, { reason: verified.verification.reason });
  let stableExternal = initialExternal;
  let retryCount = 0;
  let snapshotConsumed = Boolean(snapshot);
  while (true) {
    if (!snapshotConsumed && files && hadTrustedFastPath) {
      const refreshedAnchor = readAnchor(dependencies, { fresh: true });
      const refreshedExternal = verificationExternal(files, dependencies, refreshedAnchor);
      if (!verificationExternalEqual(stableExternal, refreshedExternal)) {
        if (retryCount >= 3) throw new Error('The audit verification inputs changed during the canonical check.');
        retryCount += 1;
        stableExternal = refreshedExternal;
        if (typeof store.invalidateVerificationCache === 'function') store.invalidateVerificationCache();
        verified = store.verifyWithEvents({ external: stableExternal, uncached: true, boundary });
        if (!verified.verification.valid) throw auditFailure('AUDIT_LEDGER_INVALID', `The canonical audit ledger is invalid (${verified.verification.reason}).`, { reason: verified.verification.reason });
        continue;
      }
      current = refreshedAnchor;
    }
    const verificationStatsAfter = !snapshotConsumed && typeof store.verificationCacheStatus === 'function'
      ? store.verificationCacheStatus() : null;
    if (!snapshotConsumed && files && hadTrustedFastPath && dependencies.verificationCacheDisabled !== true
        && dependencies.auditVerificationUncached !== true
        && verificationStatsAfter && verificationStatsAfter.lastResult !== 'cache-hit') {
      try { validateProjectionState(files, verified.events, verified.verification, dependencies, boundary); }
      catch (error) {
        const candidateAnchor = readAnchor(dependencies, { fresh: true });
        const candidateExternal = verificationExternal(files, dependencies, candidateAnchor);
        if (!verificationExternalEqual(stableExternal, candidateExternal) && retryCount < 3) {
          retryCount += 1;
          stableExternal = candidateExternal;
          if (typeof store.invalidateVerificationCache === 'function') store.invalidateVerificationCache();
          verified = store.verifyWithEvents({ external: stableExternal, uncached: true, boundary });
          if (!verified.verification.valid) throw auditFailure('AUDIT_LEDGER_INVALID', `The canonical audit ledger is invalid (${verified.verification.reason}).`, { reason: verified.verification.reason });
          continue;
        }
        if (typeof store.invalidateVerificationCache === 'function') store.invalidateVerificationCache();
        throw error;
      }
    }
    break;
  }
  let events = verified.events;
  let head = events[events.length - 1] || null;
  const trustedKey = store.getKey(signer.keyId);
  if (!trustedKey || trustedKey.publicKeyPem !== signer.publicKeyPem) {
    throw anchorIntegrityAlarm('The canonical audit ledger does not contain the vault-trusted signing key.');
  }
  // Signature check first: self-contained, never races a concurrent writer.
  // The event-hash check (validateAnchorEvent) is deliberately deferred past
  // the ahead-of-head recovery below -- see that function's comment.
  if (current) validateAnchorSignature(current, store);
  if (!head) {
    if (current) throw anchorIntegrityAlarm('The protected audit head is ahead of an empty canonical ledger.');
    const result = { present: false, sequence: 0, eventHash: ZERO_HASH, reconciled: false };
    Object.defineProperty(result, 'verificationSnapshot', { value: verified, enumerable: false });
    return result;
  }
  if (current && current.sequence > head.sequence) {
    // A concurrent writer can append and protect a new head after our first
    // read snapshot (or after this snapshot came from a verification cache
    // that has not yet observed that write). Retry a bounded number of times
    // -- matching the retryCount pattern earlier in this function -- before
    // treating the difference as rollback: under sustained concurrent
    // writers (measured: ~16 agents writing continuously) a single retry is
    // not always enough headroom for a second writer to not leapfrog it
    // again inside the same narrow window.
    let aheadAttempts = 0;
    while (current.sequence > head.sequence) {
      if (aheadAttempts >= 3) throw anchorIntegrityAlarm('The canonical audit ledger was rolled back behind its protected head.');
      aheadAttempts += 1;
      const refreshedExternal = verificationExternal(files, dependencies, current);
      verified = store.verifyWithEvents({ external: refreshedExternal, uncached: true, boundary });
      if (!verified.verification.valid) throw auditFailure('AUDIT_LEDGER_INVALID', `The canonical audit ledger is invalid (${verified.verification.reason}).`, { reason: verified.verification.reason });
      events = verified.events;
      head = events[events.length - 1] || null;
      if (!head) throw anchorIntegrityAlarm('The canonical audit ledger was rolled back behind its protected head.');
    }
  }
  // current.sequence <= head.sequence is now guaranteed whenever current is
  // present: this snapshot is known to contain the anchor's own recorded
  // event, so a mismatch found now is a genuine hash/keyId conflict -- real
  // tamper or truncation evidence -- never a same-process view trailing a
  // concurrent writer's already-committed anchor.
  // A FORKED ANCHOR IS HEALED, NOT ALARMED.
  //
  // MEASURED 2026-09-02 on an installed 1.0.41 with twelve agent processes:
  // the anchor is stored inside the BEGIN IMMEDIATE transaction, before
  // COMMIT (deliberately -- a refused external write must leave no event
  // behind). One COMMIT lost a race and rolled back AFTER its anchor for
  // event 10268 was in the vault; a sibling then committed its own 10268.
  // From that moment every admission on the machine failed closed with
  // "the protected audit head does not match the canonical ledger" until the
  // anchor was rewritten by hand -- an outage, not evidence.
  //
  // The fork has a signature tampering cannot fake without the signing key:
  // the anchor's own signature verifies under the trusted key (checked
  // above), the ledger row at that sequence exists, was signed by the same
  // trusted key, and the whole ledger from its root to its head verifies
  // (`verified` above). An attacker without the key cannot produce a row
  // that verifies; one WITH the key could produce anything, anchors
  // included. So this is the one mismatch that is proven not to be a rollback
  // and not to be a rewrite, and it is healed by anchoring the real head.
  // When the fork sits AT the head, the vault refuses a different value at the
  // same sequence, so the heal is carried by the next append: the caller is
  // told `forked` and anchors the event it is about to write.
  let forkIntent = null;
  const forked = Boolean(current) && (() => {
    const row = store.getEvent({ sequence: current.sequence });
    if (!row || row.eventHash === current.eventHash || row.keyId !== signer.keyId
        || current.keyId !== signer.keyId || verified.verification.valid !== true) return false;
    forkIntent = intentNamingAnchor(current, dependencies);
    return Boolean(forkIntent);
  })();
  if (forked) {
    report(dependencies, `ToolsEnabled audit anchor named an uncommitted event at sequence ${current.sequence}; re-anchoring the canonical head.`);
  } else if (current) {
    validateAnchorEvent(current, store);
  }
  if (current && current.sequence === head.sequence) {
    if (forked) {
      const result = { present: true, sequence: current.sequence, eventHash: head.eventHash, keyId: head.keyId, reconciled: false, forked: true, pending: 0, forkIntentFile: forkIntent.file };
      Object.defineProperty(result, 'verificationSnapshot', { value: verified, enumerable: false });
      return result;
    }
    if (current.eventHash !== head.eventHash) throw anchorIntegrityAlarm('The canonical audit head conflicts with its protected anchor.');
    const result = { present: true, sequence: current.sequence, eventHash: current.eventHash, keyId: current.keyId, reconciled: false };
    Object.defineProperty(result, 'verificationSnapshot', { value: verified, enumerable: false });
    return result;
  }
  // SLICE BY POSITION IN THE LIVE WINDOW, NOT BY ABSOLUTE SEQUENCE.
  //
  // `events` is the live window: events[i] is sequence (boundary + i + 1), not
  // (i + 1). `anchoredSequence` is absolute. Subtracting the boundary is what
  // turns one into the other, and while nothing had ever been archived the two
  // were the same number, so this read correctly until the first retention roll
  // and silently stopped afterwards.
  //
  // What it cost was not speed, it was the check below. On the owner's install
  // (boundary 981, anchor near sequence 11069, 10,088 live rows) the old
  // expression sliced past the end of the array and produced [], so
  // `suffix.some(...)` had nothing to look at: the alarm for unanchored events
  // signed by some other key could not fire on any install that had ever
  // rolled -- which, with a bounded default retention, is every install
  // eventually. Same arithmetic bug as audit-store's advanceVerificationCache;
  // fixed there too.
  //
  // The suffix is normally short (the anchor tracks the head within ~31
  // events), so restoring it costs a handful of string compares, not a scan.
  const anchoredSequence = current ? current.sequence : 0;
  const suffix = unanchoredSuffix(events, anchoredSequence, boundary);
  if (suffix.some(event => event.keyId !== signer.keyId)) {
    throw anchorIntegrityAlarm('Unanchored audit events were not signed by the current vault-trusted key.');
  }
  if (!advance) {
    const result = {
      present: Boolean(current), sequence: anchoredSequence,
      eventHash: current ? current.eventHash : ZERO_HASH, keyId: current ? current.keyId : null,
      reconciled: false, pending: suffix.length, forked, forkIntentFile: forked ? forkIntent.file : null
    };
    Object.defineProperty(result, 'verificationSnapshot', { value: verified, enumerable: false });
    return result;
  }
  const written = writeAnchor(makeAnchor(head, signer), store, dependencies);
  if (forked) consumeAnchorIntent(forkIntent.file, dependencies);
  const result = {
    present: true, sequence: written.anchor.sequence, eventHash: written.anchor.eventHash,
    keyId: written.anchor.keyId, reconciled: true, dominated: written.dominated, healed: forked
  };
  Object.defineProperty(result, 'verificationSnapshot', { value: verified, enumerable: false });
  if (files) {
    const reboundExternal = verificationExternal(files, dependencies, written.anchor);
    try { store.rebindVerificationCache({ prior: verified, external: reboundExternal, boundary }); }
    catch { /* cache maintenance is fail-closed and never replaces the audit result */ }
  }
  return result;
}

// ANCHOR INTENTS: HOW A FORK IS PROVEN HONEST.
//
// The anchor is stored inside the ledger transaction, before COMMIT, on
// purpose (a refused external write must leave no event behind). A process
// that dies between the two -- MEASURED 2026-09-02, an agent stopped while
// its MCP server was mid-admission -- leaves an anchor for an event SQLite
// then rolls back; a sibling commits its own event at that sequence, and
// the anchor no longer matches the ledger. From the ledger alone that state
// is indistinguishable from a rewritten row, so it alarmed, and no agent on
// the machine could start until the anchor was repaired by hand.
//
// The intent record is the missing witness. Written beside the ledger just
// before the in-lock anchor write and removed just after COMMIT, it names the
// exact anchor (sequence, event hash) an admission was about to store. A
// mismatch whose anchor an intent names is a fork this installation's own
// writer left behind, and reconcileAnchor heals it by anchoring the real
// head. A mismatch no intent names is still an alarm, every time.
const ANCHOR_INTENT_DIRECTORY = 'audit-anchor-intents';

function anchorIntentDirectory(dependencies) {
  const root = dependencies.rootPath || rootPath;
  return path.join(root('state'), ANCHOR_INTENT_DIRECTORY);
}

function anchorIntentPath(dependencies) {
  return path.join(anchorIntentDirectory(dependencies), `${process.pid}.json`);
}

function writeAnchorIntent(anchor, dependencies) {
  const io = dependencies.fs || fs;
  const file = anchorIntentPath(dependencies);
  (dependencies.ensureDir || ensureDir)(path.dirname(file));
  const record = { version: 1, sequence: anchor.sequence, eventHash: anchor.eventHash, keyId: anchor.keyId, pid: process.pid, atMs: Date.now() };
  writeAtomic(file, `${canonicalJson(record)}\n`, io);
  return file;
}

function clearAnchorIntent(dependencies) {
  const io = dependencies.fs || fs;
  try { io.rmSync(anchorIntentPath(dependencies), { force: true }); } catch { /* a stale intent is harmless: it names a committed anchor */ }
}

function readAnchorIntents(dependencies) {
  const io = dependencies.fs || fs;
  const directory = anchorIntentDirectory(dependencies);
  let names = [];
  try { names = io.readdirSync(directory); } catch { return []; }
  const intents = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const parsed = JSON.parse(io.readFileSync(file, 'utf8'));
      if (parsed && Number.isSafeInteger(parsed.sequence) && typeof parsed.eventHash === 'string') intents.push({ ...parsed, file });
    } catch { /* an unreadable intent proves nothing */ }
  }
  return intents;
}

// The intent that proved a fork is removed only once the anchor has actually
// moved past it; until then it must keep proving the same fork to every reader.
function consumeAnchorIntent(file, dependencies) {
  if (!file) return;
  try { (dependencies.fs || fs).rmSync(file, { force: true }); } catch { /* consumed on the next heal instead */ }
}

function intentNamingAnchor(anchor, dependencies) {
  return readAnchorIntents(dependencies).find(intent => intent.sequence === anchor.sequence && intent.eventHash === anchor.eventHash) || null;
}

function appendDurably(store, signer, input, dependencies, { anchor = true } = {}) {
  const appended = store.appendEvent(input, signer);
  let anchored = null;
  if (anchor) {
    const next = makeAnchor(appended.event, signer);
    writeAnchorIntent(next, dependencies);
    anchored = writeAnchor(next, store, dependencies);
  }
  return { ...appended, anchor: anchored };
}

function projectionObject(event) {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    timestamp: event.event.timestamp,
    action: event.event.action,
    target: event.event.target,
    details: event.event.details,
    occurredAtMs: event.occurredAtMs,
    previousHash: event.previousHash,
    eventHash: event.eventHash,
    keyId: event.keyId,
    signature: event.signature,
    createdAtMs: event.createdAtMs
  };
}

function projectionLine(sink, event) {
  const item = projectionObject(event);
  if (sink === 'jsonl') return `${JSON.stringify(item)}\n`;
  const field = value => redact(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `${item.sequence} | ${item.eventHash} | ${field(item.timestamp)} | ${field(item.action)} | ${field(item.target)} | ${field(item.details)}\n`;
}

function allEvents(store, afterSequence = 0) {
  const events = [];
  let cursor = afterSequence;
  while (true) {
    const batch = store.listEvents({ afterSequence: cursor, limit: 1000 });
    if (!batch.length) break;
    events.push(...batch);
    cursor = batch[batch.length - 1].sequence;
    if (batch.length < 1000) break;
  }
  return events;
}

function projectionVerifyCacheKey(sink, file) {
  return `${sink}\u0000${path.resolve(file)}`;
}

function resetProjectionVerifyCache() {
  projectionVerifyCache.clear();
  projectionParseMemo.clear();
  projectionDivergenceMemo.clear();
}

function invalidateProjectionVerifyCache(sink, file) {
  projectionVerifyCache.delete(projectionVerifyCacheKey(sink, file));
  projectionDivergenceMemo.delete(projectionVerifyCacheKey(sink, file));
  forgetDigest(file);
  // The digest above is what makes the remembered rows correct; dropping them
  // here as well means a rewrite by THIS process never even has to be caught by
  // a digest comparison. Same rule, same moment, as forgetDigest.
  forgetParsedProjection(file);
}

function projectionFileFingerprint(file, io) {
  try {
    const stat = io.statSync(file);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtimeMs) || stat.mtimeMs < 0) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function rememberProjectionVerification(sink, file, state, io, checksSinceFullVerify) {
  const fingerprint = projectionFileFingerprint(file, io);
  const validState = state && Number.isSafeInteger(state.lastSequence) && state.lastSequence >= 0
    && typeof state.lastHash === 'string' && /^[a-f0-9]{64}$/.test(state.lastHash);
  if (!fingerprint || !validState) {
    invalidateProjectionVerifyCache(sink, file);
    return false;
  }
  projectionVerifyCache.set(projectionVerifyCacheKey(sink, file), {
    ...fingerprint,
    io,
    sequence: state.lastSequence,
    eventHash: state.lastHash,
    checksSinceFullVerify
  });
  return true;
}

function trustedProjectionVerification(sink, file, state, io) {
  const key = projectionVerifyCacheKey(sink, file);
  const cached = projectionVerifyCache.get(key);
  if (!cached || cached.io !== io || !state
      || state.lastSequence !== cached.sequence || state.lastHash !== cached.eventHash
      || !Number.isSafeInteger(cached.checksSinceFullVerify)
      || cached.checksSinceFullVerify < 0
      || cached.checksSinceFullVerify >= FULL_VERIFY_EVERY - 1) {
    if (cached) projectionVerifyCache.delete(key);
    return null;
  }
  const current = projectionFileFingerprint(file, io);
  if (!current || current.size !== cached.size || current.mtimeMs !== cached.mtimeMs) {
    projectionVerifyCache.delete(key);
    return null;
  }
  return { checksSinceFullVerify: cached.checksSinceFullVerify + 1 };
}

// THE PARSED PROJECTION, REMEMBERED WHILE ITS BYTES ARE UNCHANGED.
//
// WHY. validateProjectionState() is on the admission path -- every audited
// action in the Electron main process and in every MCP server goes through it
// whenever the store's verification cache is not a hit -- and it parsed both
// projection files from scratch each time. MEASURED 2026-09-03 on a copy of the
// owner's Live install (actions.jsonl 11.49 MB / 10,053 rows, actions.log
// 6.63 MB), node v22.14.0, this machine, five runs each:
//
//   parsedProjection(actions.jsonl, 'jsonl') ...... med 117.2 ms
//   parsedProjection(actions.log,   'text')  ...... med  40.5 ms
//   both sinks, i.e. one validateProjectionState .. med 186.1 ms
//
// All of it synchronous, all of it on the thread that also serves every other
// session's IPC. The owner's install saw up to 64 admissions in a minute
// (evidence/E/audit-frequency.txt), and its durability sidecar records 70
// retained AUDIT_PROJECTION_DIVERGED and 114 AUDIT_LEDGER_INVALID breaches --
// every one of which clears the store's verification cache and therefore sends
// the NEXT admission down this path again.
//
// THE KEY IS THE FILE'S CONTENT DIGEST, NOT ITS SIZE AND MTIME, and that choice
// is the whole safety argument -- the same one shell/spawn-record.cjs makes for
// its verdictCache and runtime.js makes for its secret cache. An in-place
// rewrite that preserves length with the timestamp put back is exactly the
// tamper this parse exists to expose, and a size+mtime key would serve the
// remembered rows over it. Identical digest means identical bytes means the
// same rows, with no assumption about anything.
//
// IT REUSES digestFileSet's OWN ROW, deliberately: verificationExternal()
// digests these same two files microseconds before or after this call, through
// the same 1.5 s stat-gated memo (digestMemo), so on the ordinary path this
// costs a statSync and nothing more. Sharing that memo also means there is ONE
// identity rule for these files rather than two that can drift apart.
//
// ONLY THE REAL FILESYSTEM IS MEMOISED. A caller that injected dependencies.fs
// gets the parse it has always had, on every call: an injected double is only
// obliged to implement readFileSync, and more than one suite counts precisely
// those calls to pin how many real reads an admission performs.
//
// The rows are never mutated by any caller (projectionMatches and the four
// length/index reads are the whole surface), so one array is safely shared.
const projectionParseMemo = new Map();

function forgetParsedProjection(file) {
  try { projectionParseMemo.delete(path.resolve(file)); } catch { /* a path that cannot resolve was never remembered */ }
}

function parsedProjection(file, sink, io = fs) {
  if (!io.existsSync(file)) return [];
  if (io === fs) {
    const row = fileDigestRow(file, io);
    if (row.exists) {
      const remembered = projectionParseMemo.get(row.path);
      if (remembered && remembered.sink === sink && remembered.digest === row.digest) return remembered.rows;
      const rows = parseProjectionBytes(file, sink, io);
      projectionParseMemo.set(row.path, { sink, digest: row.digest, rows });
      return rows;
    }
  }
  return parseProjectionBytes(file, sink, io);
}

function parseProjectionBytes(file, sink, io = fs) {
  const stat = io.statSync(file);
  if (stat.size > MAX_PROJECTION_BYTES) throw new Error(`Audit ${sink} projection exceeds the rebuild limit.`);
  const content = io.readFileSync(file, 'utf8');
  if (content.includes('\r') || (content.length > 0 && !content.endsWith('\n'))) {
    throw new Error(`Audit ${sink} projection does not use canonical line endings.`);
  }
  const lines = content.length ? content.slice(0, -1).split('\n') : [];
  return lines.map((line, index) => {
    if (sink === 'jsonl') {
      let item;
      try { item = JSON.parse(line); } catch { throw new Error(`Audit JSONL projection is malformed at line ${index + 1}.`); }
      if (!Number.isSafeInteger(item.sequence) || !/^[a-f0-9]{64}$/.test(item.eventHash || '')) {
        throw new Error(`Audit JSONL projection is not canonical at line ${index + 1}.`);
      }
      return { sequence: item.sequence, eventHash: item.eventHash, line: `${line}\n` };
    }
    const match = /^(\d+) \| ([a-f0-9]{64}) \|/.exec(line);
    if (!match) throw new Error(`Audit text projection is not canonical at line ${index + 1}.`);
    return { sequence: Number(match[1]), eventHash: match[2], line: `${line}\n` };
  });
}

function projectionMatches(rows, events, sink) {
  return rows.length <= events.length && rows.every((row, index) =>
    row.sequence === events[index].sequence && row.eventHash === events[index].eventHash &&
    row.line === projectionLine(sink, events[index]));
}

// COMPARE BY WINDOW POSITION, NOT BY ABSOLUTE LENGTH.
//
// This is the _verifyIncremental model (src/lib/audit-store.js): the live
// window is addressed by its offset from the archive boundary, and the trusted
// prefix is extended rather than re-decided. projectionMatches() above is the
// strict form projectSinks() needs -- it answers "may this file be appended to
// as-is", and anything else must be rebuilt. validateProjectionState() is
// asking a different question ("is this file evidence of loss") and needs the
// positional form: every row the file and the committed window BOTH hold must
// be identical, and the rows past the committed head must be a sequence-
// contiguous continuation of it.
//
// Returns the number of rows the file holds beyond the committed live window,
// or null when the file is not a faithful, position-aligned continuation --
// which is a real divergence and still refuses.
function projectionWindowOverhang(rows, events, sink, boundarySequence) {
  const shared = Math.min(rows.length, events.length);
  for (let index = 0; index < shared; index += 1) {
    const row = rows[index];
    const event = events[index];
    if (row.sequence !== event.sequence || row.eventHash !== event.eventHash
        || row.line !== projectionLine(sink, event)) return null;
  }
  if (rows.length <= events.length) return 0;
  // The overhang is only tolerable as the tail of an in-flight append: it has
  // to continue the sequence the shared prefix ended on, with no gap and no
  // repeat. A file whose extra lines jump, repeat or renumber is not a writer
  // mid-transaction and still refuses.
  let expected = shared > 0
    ? rows[shared - 1].sequence + 1
    : (Number.isSafeInteger(boundarySequence) ? boundarySequence : 0) + 1;
  for (let index = shared; index < rows.length; index += 1) {
    if (rows[index].sequence !== expected) return null;
    expected += 1;
  }
  return rows.length - events.length;
}

function renameAtomicWithRetry(io, temporary, file) {
  for (let attempt = 0; attempt < ATOMIC_RENAME_ATTEMPTS; attempt += 1) {
    try {
      io.renameSync(temporary, file);
      return;
    } catch (error) {
      if (!ATOMIC_RENAME_RETRY_CODES.has(error?.code) || attempt + 1 >= ATOMIC_RENAME_ATTEMPTS) throw error;
      // Antivirus, indexers, and Explorer preview panes can transiently hold a
      // Windows projection target. The temp file remains the same immutable
      // candidate; retrying its atomic rename never appends or corrupts either
      // projection. This is deliberately bounded inside the projection lease.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

function writeAtomic(file, content, io = fs) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    io.writeFileSync(temporary, content, 'utf8');
    renameAtomicWithRetry(io, temporary, file);
  } finally {
    if (io.existsSync(temporary)) { try { io.unlinkSync(temporary); } catch { /* retain original failure */ } }
  }
}

function rebuildProjection(store, sink, file, events, dependencies, now, boundary = null) {
  const io = dependencies.fs || fs;
  invalidateProjectionVerifyCache(sink, file);
  const lines = events.map(event => projectionLine(sink, event));
  const content = lines.join('');
  if (Buffer.byteLength(content, 'utf8') > MAX_PROJECTION_BYTES) throw new Error(`Audit ${sink} projection exceeds the rebuild limit.`);
  writeAtomic(file, content, io);
  /* THE PROCESS THAT WROTE THE FILE KNOWS WHAT IS IN IT. Remember the rows
     and the digest of exactly these bytes, so this process's next admission
     does not read and parse back what it just wrote. MEASURED 2026-09-04:
     that re-parse was ~50 MB of allocation a minute in the audit worker at
     the retention cap. Only for the real filesystem, like parsedProjection. */
  if (io === fs) {
    const identity = path.resolve(file);
    const digest = sha256(Buffer.from(content, 'utf8'));
    projectionParseMemo.set(identity, {
      sink, digest,
      rows: events.map((event, index) => ({ sequence: event.sequence, eventHash: event.eventHash, line: lines[index] }))
    });
    try {
      const stat = fs.statSync(file);
      digestMemo.set(identity, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, atMs: Date.now(), row: { path: identity, exists: true, bytes: stat.size, digest } });
    } catch { /* the digest memo is a cost saving, not a correctness input */ }
  }
  const head = events[events.length - 1];
  return store.setSinkPosition({
    sink,
    sequence: head ? head.sequence : boundary ? boundary.archivedThroughSequence : 0,
    eventHash: head ? head.eventHash : boundary ? boundary.eventHash : ZERO_HASH,
    updatedAtMs: now
  });
}

// THE PROJECTION BODY, SEPARATED FROM THE LOCK THAT LETS IT RUN.
//
// This used to be inlined inside flushInternal's own withProjectionLock, which
// meant a record() paid TWO cross-process BEGIN IMMEDIATE transactions: one to
// admit and append the canonical event, and a second, immediately afterwards,
// to write that same event's two projection lines.  Separating the body from
// the lock lets the caller that ALREADY owns the projection lease run it
// in-place (see appendVerifiedUnderLock) instead of dropping the lease and
// competing for it again a millisecond later.
//
// `projectionStore` must be a store that already holds the lease -- either the
// one withProjectionLock handed its callback, or the same store inside that
// callback.  Every mutation below (setSinkPosition, markSinkSuccess,
// markSinkFailure, rebuildProjection) routes through AuditStore's
// _projectionDb, so it joins the caller's transaction rather than opening a
// nested one, which AuditStore refuses outright.
//
// It is total by contract: a failing sink is recorded through markSinkFailure
// and reported in `errors`, never thrown, because a throw here would now abort
// the caller's append transaction and destroy an event that was already
// admitted.
function projectSinks(projectionStore, files, dependencies, { force = false, now, boundary = null } = {}) {
  const io = dependencies.fs || fs;
  const append = dependencies.appendFileSync || io.appendFileSync.bind(io);
  const makeDirectory = dependencies.ensureDir || ensureDir;
  let completeEvents = null;
  const loadCompleteEvents = () => {
    if (completeEvents === null) completeEvents = allEvents(projectionStore);
    return completeEvents;
  };
  const result = { sinks: {}, errors: [] };
  for (const sink of ['jsonl', 'text']) {
    try {
      let state = projectionStore.status().sinks[sink];
      if (!force && state.retryAtMs !== null && state.retryAtMs > now) {
        result.sinks[sink] = state;
        continue;
      }
      const trusted = force ? null : trustedProjectionVerification(sink, files[sink], state, io);
      let events;
      let checksSinceFullVerify;
      if (trusted) {
        events = allEvents(projectionStore, state.lastSequence);
        checksSinceFullVerify = trusted.checksSinceFullVerify;
      } else {
        invalidateProjectionVerifyCache(sink, files[sink]);
        events = loadCompleteEvents();
        checksSinceFullVerify = 0;
        let rows;
        try { rows = parsedProjection(files[sink], sink, io); }
        catch { rows = null; }
        if (!rows || !projectionMatches(rows, events, sink)) {
          state = rebuildProjection(projectionStore, sink, files[sink], events, dependencies, now, boundary);
          rememberProjectionVerification(sink, files[sink], state, io, checksSinceFullVerify);
          result.sinks[sink] = state;
          continue;
        }
        const projectedHead = rows[rows.length - 1];
        const expectedSequence = projectedHead ? projectedHead.sequence
          : boundary ? boundary.archivedThroughSequence : 0;
        const expectedHash = projectedHead ? projectedHead.eventHash
          : boundary ? boundary.eventHash : ZERO_HASH;
        if (state.lastSequence !== expectedSequence || state.lastHash !== expectedHash) {
          const last = rows[rows.length - 1];
          state = projectionStore.setSinkPosition({
            sink,
            sequence: last ? last.sequence : boundary ? boundary.archivedThroughSequence : 0,
            eventHash: last ? last.eventHash : boundary ? boundary.eventHash : ZERO_HASH,
            updatedAtMs: now
          });
        }
        events = events.filter(event => event.sequence > state.lastSequence);
      }
      for (const event of events) {
        makeDirectory(path.dirname(files[sink]));
        append(files[sink], projectionLine(sink, event), 'utf8');
        state = projectionStore.markSinkSuccess({ sink, sequence: event.sequence, eventHash: event.eventHash, updatedAtMs: now });
        rememberProjectionVerification(sink, files[sink], state, io, checksSinceFullVerify);
      }
      rememberProjectionVerification(sink, files[sink], state, io, checksSinceFullVerify);
      result.sinks[sink] = state;
    } catch (error) {
      invalidateProjectionVerifyCache(sink, files[sink]);
      const message = safeError(error);
      const prior = projectionStore.status().sinks[sink];
      const delay = Math.min(60_000, 1000 * (2 ** Math.min(prior.failureCount, 6)));
      try { result.sinks[sink] = projectionStore.markSinkFailure({ sink, error: message, retryAtMs: now + delay, updatedAtMs: now }); }
      catch { result.sinks[sink] = prior; }
      result.errors.push(errorEntry(sink, error));
      report(dependencies, `ToolsEnabled audit ${sink} projection failed: ${message}`);
    }
  }
  result.pending = Object.values(result.sinks).reduce((sum, sink) => sum + (sink ? sink.backlog : 0), 0);
  result.projected = result.errors.length === 0 && result.pending === 0;
  return result;
}

function flushInternal(store, files, dependencies, { force = false, boundary = null } = {}) {
  const now = (dependencies.clock || Date.now)();
  const ownerId = dependencies.projectionOwnerId || `projection-${process.pid}-${crypto.randomUUID()}`;
  return store.withProjectionLock({ ownerId, nowMs: now }, (projectionStore, lease) =>
    ({ ...projectSinks(projectionStore, files, dependencies, { force, now, boundary }), lease }));
}

function copyArchive(source, destination, io = fs) {
  if (io.existsSync(destination)) {
    if (sha256(io.readFileSync(destination)) !== sha256(io.readFileSync(source))) {
      throw new Error(`Existing audit archive conflicts with ${path.basename(source)}.`);
    }
    return;
  }
  io.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function legacyItem(line, index, digest, now, sourceType = 'jsonl') {
  if (sourceType === 'text') {
    const occurredAtMs = now + index;
    return {
      eventId: `legacy-${digest.slice(0, 24)}-${String(index + 1).padStart(8, '0')}`,
      occurredAtMs, createdAtMs: occurredAtMs,
      event: {
        timestamp: new Date(occurredAtMs).toISOString(), action: 'legacy.text', target: 'legacy',
        details: { summary: redact(line) }, legacy: { digest, line: index + 1, sourceType: 'text' }
      }
    };
  }
  let parsed;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  const fallbackTimestamp = now + index;
  const occurredAtMs = parsed ? timestampMilliseconds(parsed.timestamp, fallbackTimestamp) : fallbackTimestamp;
  return {
    eventId: `legacy-${digest.slice(0, 24)}-${String(index + 1).padStart(8, '0')}`,
    occurredAtMs,
    createdAtMs: occurredAtMs,
    event: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? {
      timestamp: new Date(occurredAtMs).toISOString(),
      action: scrub(parsed.action === undefined ? 'legacy.unknown' : parsed.action),
      target: scrub(parsed.target === undefined ? 'legacy' : parsed.target),
      details: scrub(parsed.details === undefined ? {} : parsed.details),
      legacy: { digest, line: index + 1 }
    } : {
      timestamp: new Date(occurredAtMs).toISOString(), action: 'legacy.malformed', target: 'legacy',
      details: { malformed: true, summary: redact(line) }, legacy: { digest, line: index + 1 }
    }
  };
}

// A canonical projection is already a replayable representation of the
// ledger, not another legacy source. Re-archiving it on every fresh store is
// both unnecessary and unbounded: importing a legacy archive changes the
// projection's event IDs and hashes, so its content digest changes even when
// the logical events do not. Require both independently written projections
// to match exactly before taking the no-copy path; any absent, malformed, or
// divergent field falls back to the ordinary archive-first migration.
function canonicalProjectionSource(sourceBytes, files, hasText, io = fs) {
  if (!hasText || !Buffer.isBuffer(sourceBytes)) return false;
  const content = sourceBytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(sourceBytes) || content.includes('\r') || !content.endsWith('\n')) return false;
  const lines = content.slice(0, -1).split('\n');
  if (!lines.length || lines.some(line => !line)) return false;
  let textRows;
  try { textRows = parsedProjection(files.text, 'text', io); }
  catch { return false; }
  if (textRows.length !== lines.length) return false;
  const keys = [
    'sequence', 'eventId', 'timestamp', 'action', 'target', 'details', 'occurredAtMs',
    'previousHash', 'eventHash', 'keyId', 'signature', 'createdAtMs'
  ];
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    let item;
    try { item = JSON.parse(lines[index]); } catch { return false; }
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).length !== keys.length || keys.some((key, keyIndex) => Object.keys(item)[keyIndex] !== key) ||
        item.sequence !== index + 1 || typeof item.eventId !== 'string' || !EVENT_ID_RE.test(item.eventId) ||
        !Number.isSafeInteger(item.occurredAtMs) || item.occurredAtMs < 0 ||
        !Number.isSafeInteger(item.createdAtMs) || item.createdAtMs < 0 ||
        item.previousHash !== previousHash || !/^[a-f0-9]{64}$/.test(item.eventHash || '') ||
        typeof item.keyId !== 'string' || !EVENT_ID_RE.test(item.keyId) ||
        typeof item.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.signature)) return false;
    const signature = Buffer.from(item.signature, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== item.signature) return false;
    const event = {
      sequence: item.sequence, eventId: item.eventId, occurredAtMs: item.occurredAtMs,
      event: { timestamp: item.timestamp, action: item.action, target: item.target, details: item.details },
      previousHash: item.previousHash, eventHash: item.eventHash, keyId: item.keyId,
      signature: item.signature, createdAtMs: item.createdAtMs
    };
    if (projectionLine('jsonl', event) !== `${lines[index]}\n` ||
        textRows[index].line !== projectionLine('text', event) ||
        textRows[index].sequence !== item.sequence || textRows[index].eventHash !== item.eventHash) return false;
    previousHash = item.eventHash;
  }
  return true;
}

function projectionReplayItem(line) {
  const item = JSON.parse(line);
  return {
    eventId: item.eventId,
    occurredAtMs: item.occurredAtMs,
    createdAtMs: item.createdAtMs,
    event: {
      timestamp: item.timestamp,
      action: item.action,
      target: item.target,
      details: item.details
    }
  };
}

function migrateLegacy(store, signer, files, dependencies) {
  const io = dependencies.fs || fs;
  const now = (dependencies.clock || Date.now)();
  let metadata = store.getMetadata(LEGACY_METADATA_KEY);
  if (!metadata) {
    const hasJsonl = io.existsSync(files.jsonl) && io.statSync(files.jsonl).size > 0;
    const hasText = io.existsSync(files.text) && io.statSync(files.text).size > 0;
    if (!hasJsonl && !hasText) {
      store.setMetadata(LEGACY_METADATA_KEY, { status: 'complete', digest: null, records: 0 }, now);
      return { imported: 0 };
    }
    const sourceType = hasJsonl ? 'jsonl' : 'text';
    const sourceFile = sourceType === 'jsonl' ? files.jsonl : files.text;
    const sourceBytes = io.readFileSync(sourceFile);
    if (sourceBytes.length > MAX_PROJECTION_BYTES) throw new Error(`Legacy audit ${sourceType} exceeds the migration limit.`);
    const digest = sha256(sourceBytes);
    const sourceIsProjection = sourceType === 'jsonl' && canonicalProjectionSource(sourceBytes, files, hasText, io);
    const sourceArchive = sourceIsProjection ? null : `${sourceFile}.legacy-${digest.slice(0, 16)}`;
    if (sourceArchive) copyArchive(sourceFile, sourceArchive, io);
    let jsonlArchive = sourceType === 'jsonl' && !sourceIsProjection ? sourceArchive : null;
    let textArchive = null;
    if (hasText && !sourceIsProjection) {
      const textDigest = sha256(io.readFileSync(files.text));
      textArchive = `${files.text}.legacy-${textDigest.slice(0, 16)}`;
      copyArchive(files.text, textArchive, io);
    }
    if (hasJsonl && !jsonlArchive && !sourceIsProjection) {
      const jsonlDigest = sha256(io.readFileSync(files.jsonl));
      jsonlArchive = `${files.jsonl}.legacy-${jsonlDigest.slice(0, 16)}`;
      copyArchive(files.jsonl, jsonlArchive, io);
    }
    store.setMetadata(LEGACY_METADATA_KEY, {
      status: 'importing', digest, sourceType, sourceFile: sourceIsProjection ? sourceFile : null,
      sourceArchive, jsonlArchive, textArchive, sourceIsProjection
    }, now);
    metadata = store.getMetadata(LEGACY_METADATA_KEY);
  }
  if (metadata.value.status === 'complete') return { imported: metadata.value.records || 0, replayed: true };
  const source = metadata.value.sourceIsProjection ? metadata.value.sourceFile : metadata.value.sourceArchive;
  if (!source || !io.existsSync(source)) {
    throw new Error(metadata.value.sourceIsProjection
      ? 'The canonical audit projection recovery source is missing.'
      : 'The archived legacy audit source is missing.');
  }
  const bytes = io.readFileSync(source);
  if (sha256(bytes) !== metadata.value.digest) {
    throw new Error(metadata.value.sourceIsProjection
      ? 'The canonical audit projection recovery source digest changed.'
      : 'The archived legacy audit source digest changed.');
  }
  const lines = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const item = metadata.value.sourceIsProjection
      ? projectionReplayItem(lines[index])
      : legacyItem(lines[index], index, metadata.value.digest, now, metadata.value.sourceType || 'jsonl');
    appendDurably(store, signer, item, dependencies, { anchor: false });
  }
  store.setMetadata(LEGACY_METADATA_KEY, {
    ...metadata.value, status: 'complete', records: lines.length, completedAt: new Date(now).toISOString()
  }, now);
  return { imported: lines.length };
}

function emergencyFiles(files, io = fs) {
  const directory = path.dirname(files.emergency);
  const base = path.basename(files.emergency, path.extname(files.emergency));
  const extension = path.extname(files.emergency) || '.jsonl';
  const pending = [];
  if (io.existsSync(files.emergency)) pending.push(files.emergency);
  if (io.existsSync(directory)) {
    for (const name of io.readdirSync(directory)) {
      if (name.startsWith(`${base}.ingest-`) && name.endsWith(extension)) pending.push(path.join(directory, name));
    }
  }
  return [...new Set(pending)];
}

function quarantineFiles(files, io = fs) {
  const directory = path.dirname(files.emergency);
  const base = path.basename(files.emergency);
  if (!io.existsSync(directory)) return [];
  return io.readdirSync(directory)
    .filter(name => name.startsWith(`${base}.quarantine-`))
    .map(name => path.join(directory, name));
}

// THE PROJECTION WITNESS, PAID ONCE PER RECORD RATHER THAN SIX TIMES.
//
// MEASURED 2026-09-02 on an installed 1.0.41: the two projection files were
// 11.5 MB and 6.7 MB, and one audited tool call digested both of them SIX
// times (two witness reads before the lock, four inside it), 108 MB of
// SHA-256 per record, inside a writer lock twelve agent processes queue on.
//
// The memo below remembers a file's digest for a short time, keyed by its
// resolved path, size, mtime and inode, and it is dropped the moment this
// process writes the file (invalidateProjectionVerifyCache). This is the same
// class of key the projection PARSE cache in this file already uses
// (projectionFileFingerprint), and it is deliberately short-lived: the
// witness reads it serves are the ones taken milliseconds apart within a
// single admission, where the question is "did the file change under us",
// and a same-user rewrite that also restores size and mtime inside that
// window is outside what any of these witnesses could ever prove anyway.
// Cross-record, the digest is real again after the memo expires.
const DIGEST_MEMO_TTL_MS = 1500;
const digestMemo = new Map();

function rememberedDigest(identity, stat) {
  const entry = digestMemo.get(identity);
  if (!entry) return null;
  if (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs || entry.ino !== stat.ino
      || Date.now() - entry.atMs > DIGEST_MEMO_TTL_MS) {
    digestMemo.delete(identity);
    return null;
  }
  return entry.row;
}

function forgetDigest(file) {
  try { digestMemo.delete(path.resolve(file)); } catch { /* a path that cannot resolve was never remembered */ }
}

// READ THE PROJECTION IN FULL, BUT NEVER HOLD IT IN FULL.
//
// digestFileSet is the hot loop of an audit admission. verificationExternal()
// calls it, record() reaches verificationExternal six times per event, and the
// memo above collapses those six to one -- so what remains is one complete
// pass over both projection files per record. On the owner's install those
// files are 11.0 MB and 6.4 MB, and each pass allocated, filled and then
// discarded a Buffer of exactly that size.
//
// MEASURED 2026-09-03 on the owner's machine, over those two real files:
//   readFileSync + sha256 of both ................. 73.7 ms
//   the same digest through one 256 KB buffer ..... 61.3 ms
// The saving is not in the hashing. This is a Haswell without the SHA
// extensions, so sha256 runs at about 320 MB/s whichever way the bytes arrive;
// what goes away is 17.3 MB of allocation and collection on every record, and
// the cache pressure of streaming 17.3 MB through L2 instead of main memory.
//
// WHAT DOES NOT CHANGE. The digest is the same value: the same bytes, in the
// same order, through the same sha256. The file is still read from beginning
// to end on every memo miss, which is the property that makes a rewrite that
// preserves both size and mtime detectable at all -- the memo deliberately
// trusts a stat for at most DIGEST_MEMO_TTL_MS and nothing else does (see
// tests/audit-projection-verify-cost.test.js, disguised-tamper case). Reading
// in pieces witnesses exactly what reading in one piece witnessed, and
// tests/audit-digest-streaming.test.js pins that equality against a whole-file
// read it performs itself, including on the far side of an archive roll.
//
// Only the real filesystem streams. A caller that injected dependencies.fs
// gets the whole-file read it has always had: an injected double is only
// obliged to implement readFileSync, and more than one suite counts precisely
// those calls to pin how many real reads an admission performs.
const DIGEST_CHUNK_BYTES = 256 * 1024;

function streamedFileDigest(file) {
  // Allocated per call rather than reused across calls: 256 KB per file is a
  // rounding error next to the 17.3 MB this exists to stop allocating, and a
  // shared scratch buffer would be one re-entrant caller away from hashing
  // another file's bytes.
  const chunk = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
  const handle = fs.openSync(file, 'r');
  try {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    while (true) {
      const read = fs.readSync(handle, chunk, 0, DIGEST_CHUNK_BYTES, null);
      if (read <= 0) break;
      hash.update(read === DIGEST_CHUNK_BYTES ? chunk : chunk.subarray(0, read));
      bytes += read;
    }
    return { bytes, digest: hash.digest('hex') };
  } finally {
    fs.closeSync(handle);
  }
}

// ONE FILE'S DIGEST ROW. Lifted out of digestFileSet's loop unchanged so that
// parsedProjection() can ask the SAME question, through the SAME memo, rather
// than growing a second identity rule for the same two files.
function fileDigestRow(file, io = fs) {
  const identity = path.resolve(file);
  if (!io.existsSync(file)) return { path: identity, exists: false };
  let stat = null;
  if (io === fs) { try { stat = fs.statSync(file); } catch { stat = null; } }
  const remembered = stat ? rememberedDigest(identity, stat) : null;
  if (remembered) return remembered;
  let row;
  if (io === fs) {
    const streamed = streamedFileDigest(file);
    row = { path: identity, exists: true, bytes: streamed.bytes, digest: streamed.digest };
  } else {
    const bytes = io.readFileSync(file);
    row = {
      path: identity,
      exists: true,
      bytes: Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(String(bytes), 'utf8'),
      digest: sha256(bytes)
    };
  }
  if (stat) digestMemo.set(identity, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, atMs: Date.now(), row });
  return row;
}

function digestFileSet(files, io = fs) {
  const rows = [];
  for (const file of [...new Set(files)].sort()) rows.push(fileDigestRow(file, io));
  return sha256(canonicalJson(rows));
}

function verificationExternal(files, dependencies, anchor) {
  if (!files) return undefined;
  const io = dependencies.fs || fs;
  const projectionDigest = digestFileSet([files.jsonl, files.text], io);
  const emergencyDigest = digestFileSet(emergencyFiles(files, io), io);
  const anchorSummary = anchor ? {
    digest: sha256(canonicalJson(anchor)), sequence: anchor.sequence,
    eventHash: anchor.eventHash, keyId: anchor.keyId
  } : null;
  return {
    version: 1, cacheable: dependencies.verificationCacheDisabled !== true, anchor: anchorSummary,
    projectionDigest, emergencyDigest
  };
}

// WHY A REMEMBERED REFUSAL IS STILL SOUND AFTER THE HEAD MOVES.
//
// A wedged ledger keeps admitting nothing and spooling instead, so the live
// window keeps GROWING while the projection file stands still -- which is why
// keying this on the head would never hit on the install it exists for. It is
// keyed on the inputs the refusal actually depends on instead: the file
// (size + mtime), the archive boundary the window is rooted on, and the sink
// cursor. With those three fixed, each refusal reason stays true as the window
// grows:
//   - an out-of-range cursor is a fact about the cursor, which is in the key;
//   - `rows.length < cursor - boundarySequence` reads only pinned values;
//   - a positional mismatch is a fact about an immutable prefix position, and
//     a non-contiguous tail can only be compared against the strictly
//     contiguous events that later cover it, so it fails again.
// The ONE reason that can stop being true is an overhang that is merely too
// long: that shrinks as the window grows, so it is deliberately not
// remembered. A pass is never remembered either -- only refusals, and any
// change to the file, the boundary or the cursor re-runs the whole check.
const PROJECTION_DIVERGENCE_MEMOIZABLE = new Set(['cursor-range', 'behind-cursor', 'not-a-continuation']);

function projectionDivergenceReason(rows, events, sink, cursor, boundarySequence, headSequence) {
  if (!Number.isSafeInteger(cursor) || cursor < boundarySequence || cursor > headSequence) return 'cursor-range';
  if (rows.length < cursor - boundarySequence) return 'behind-cursor';
  const overhang = projectionWindowOverhang(rows, events, sink, boundarySequence);
  if (overhang === null) return 'not-a-continuation';
  if (overhang > MAX_UNCOMMITTED_PROJECTION_OVERHANG) return 'overhang-too-long';
  return null;
}

function validateProjectionState(files, events, verification, dependencies, boundary = null) {
  const io = dependencies.fs || fs;
  for (const sink of ['jsonl', 'text']) {
    const cursor = verification && verification.sinks && verification.sinks[sink]
      ? verification.sinks[sink].lastSequence : null;
    const boundarySequence = boundary ? boundary.archivedThroughSequence : 0;
    const headSequence = events.length ? events[events.length - 1].sequence : boundarySequence;
    // Only the real filesystem is memoized. An injected dependencies.fs is a
    // test double whose exact read count is what several suites assert, and a
    // double is under no obligation to report a meaningful stat.
    const memoKey = io === fs ? projectionVerifyCacheKey(sink, files[sink]) : null;
    const fingerprint = memoKey ? projectionFileFingerprint(files[sink], io) : null;
    if (memoKey && fingerprint) {
      const remembered = projectionDivergenceMemo.get(memoKey);
      if (remembered && remembered.size === fingerprint.size && remembered.mtimeMs === fingerprint.mtimeMs
          && remembered.boundarySequence === boundarySequence && remembered.cursor === cursor
          && events.length >= remembered.events) {
        throw auditFailure('AUDIT_PROJECTION_DIVERGED', 'The audit projection diverged during admission verification.',
          { sink, projectionLines: remembered.projectionLines, sinkCursor: cursor, memoized: true, reason: remembered.reason });
      }
      if (remembered) projectionDivergenceMemo.delete(memoKey);
    }
    let rows;
    try { rows = parsedProjection(files[sink], sink, io); }
    catch { throw auditFailure('AUDIT_PROJECTION_UNREADABLE', 'The audit projection could not be parsed during admission verification.', { sink }); }
    // THE FILE MAY LEGITIMATELY BE AHEAD OF THE DB'S OWN CURSOR CACHE.
    //
    // projectSinks() appends a sink's line and marks its cursor inside the same
    // writer-lock transaction record() uses for the append and, when the
    // window is over its limit, the retention roll. The file append is a plain
    // durable fs write; the cursor mark is one more row in that SQL
    // transaction. If anything LATER in that same transaction throws (a roll
    // refusal, a witness mismatch), SQLite rolls the cursor mark back but the
    // already-written file line stays -- MEASURED 2026-09-03: reproduced by
    // injecting one transient fault into a retention roll. That gap is
    // supposed to be self-healing (projectSinks' own untrusted path re-derives
    // the cursor from the file's real last row and catches the DB up), and
    // requiring exact equality here defeated that: every later admission threw
    // AUDIT_PROJECTION_DIVERGED before projectSinks ever ran again to heal it.
    //
    // So only a file that is BEHIND its cursor is fatal here -- durable content
    // the DB believes exists but the file does not, which is real loss, not a
    // caching lag. A file that is ahead is safe to accept PROVIDED every row up
    // to what it actually holds still verifies against the real, already
    // signature-checked event chain.
    //
    // 96fc6ec LOOSENED ONLY THE CURSOR COMPARISON, AND THAT WAS NOT ENOUGH.
    //
    // MEASURED 2026-09-04 against a copy of the owner's Live ledger (boundary
    // 8356, cursor 18409, 10,053 live events, actions.jsonl 12.0 MB): with the
    // committed head rolled back by one and the projection line for that head
    // still on disk -- exactly what projectSinks() leaves behind between its
    // durable append and the transaction's commit, which every other process
    // in the fleet reads while verifying its own admission outside the lock --
    // `rows.length < cursor - boundarySequence` is 10053 < 10052, false, so the
    // loosened cursor check passes. The refusal moved one clause to the right
    // instead of going away: projectionMatches() requires
    // `rows.length <= events.length`, which is the SAME "durably ahead"
    // condition re-tested absolutely, and it still threw
    // AUDIT_PROJECTION_DIVERGED { projectionLines: 10053, sinkCursor: 18408 }.
    //
    // projectionWindowOverhang() is the _verifyIncremental model instead: the
    // shared prefix is compared by WINDOW POSITION, row by row, against the
    // real signature-checked events, and what the file holds past the committed
    // head has to be a sequence-contiguous continuation of that prefix and no
    // longer than one in-flight append can produce. A forged or stray line
    // fails the positional compare or the contiguity check and still refuses;
    // a tolerated overhang is never read back as ledger truth, because
    // projectSinks()' own untrusted path rebuilds the file from the database
    // the next time it runs under the writer lock.
    const reason = projectionDivergenceReason(rows, events, sink, cursor, boundarySequence, headSequence);
    if (reason) {
      if (memoKey && fingerprint && PROJECTION_DIVERGENCE_MEMOIZABLE.has(reason)) {
        projectionDivergenceMemo.set(memoKey, {
          size: fingerprint.size, mtimeMs: fingerprint.mtimeMs, boundarySequence, cursor,
          events: events.length, projectionLines: rows.length, reason
        });
      }
      // WHICH CHECK REFUSED IS PART OF THE REFUSAL, NOT A DEBUGGING EXTRA.
      // This value used to be computed here and thrown away, so an operator
      // reading AUDIT_PROJECTION_DIVERGED in the ledger could not tell a
      // writer's in-flight file from durable content the file had lost -- and
      // neither could the admission path itself, which is why it could not
      // safely retry either. Carrying it is what makes the distinction below
      // in verifyAdmissionOutsideLock possible at all.
      throw auditFailure('AUDIT_PROJECTION_DIVERGED', 'The audit projection diverged during admission verification.',
        { sink, projectionLines: rows.length, sinkCursor: cursor, reason });
    }
    if (memoKey) projectionDivergenceMemo.delete(memoKey);
  }
  const pendingEmergency = emergencyFiles(files, io)
    .reduce((count, file) => count + io.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length, 0);
  if (pendingEmergency > 0) {
    throw auditFailure('AUDIT_EMERGENCY_SPOOL_PENDING', 'The audit emergency spool is not empty during admission verification.',
      { pendingEmergency });
  }
}

function verificationExternalEqual(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); }
  catch { return false; }
}

function spoolEmergency(files, item, dependencies, signerHint) {
  const io = dependencies.fs || fs;
  const append = dependencies.appendFileSync || io.appendFileSync.bind(io);
  const makeDirectory = dependencies.ensureDir || ensureDir;
  makeDirectory(path.dirname(files.emergency));
  const current = io.existsSync(files.emergency) ? io.statSync(files.emergency).size : 0;
  // AUDIT-F-03: the raw item is never written bare. It is wrapped with a
  // mac derived from the trusted audit signer so ingestEmergency() can tell
  // "this process's own emergency write" apart from arbitrary attacker-
  // writable bytes dropped into the same directory later.
  const line = `${JSON.stringify(spoolEnvelope(item, dependencies, signerHint))}\n`;
  if (current + Buffer.byteLength(line) > MAX_EMERGENCY_BYTES) throw new Error('The bounded emergency audit spool is full.');
  append(files.emergency, line, 'utf8');
}

function durabilityStatePath(files) {
  return path.join(path.dirname(files.emergency), DURABILITY_STATE_BASENAME);
}

function durabilityRefusalsPath(files) {
  return path.join(path.dirname(files.emergency), DURABILITY_REFUSALS_BASENAME);
}

// The lifetime count of required refusals, or NULL when the record could not be
// read. Never 0 on a read failure: "could not look" and "not there" are
// different answers, and reporting 0 here would be a lie about a lost refusal --
// the exact class of lie the durability signal exists to prevent.
function countRefusalRecords(files, io) {
  const file = durabilityRefusalsPath(files);
  try {
    if (!io.existsSync(file)) return 0;
    return io.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch { return null; }
}

// Never throws. This runs AFTER the breach is already recorded in the sidecar,
// so a refusals-record that cannot be written must not change the refusal, the
// sidecar, or what the caller sees. The row is the same already-scrubbed record
// the sidecar just stored -- scrubText/safeDetails have already run on it, so
// this cannot become a second, unscrubbed copy of untrusted caller input.
function appendRefusalRecord(files, row, dependencies = {}) {
  try {
    const io = dependencies.fs || fs;
    io.appendFileSync(durabilityRefusalsPath(files), `${JSON.stringify(row)}\n`);
    return true;
  } catch { return false; }
}

// Returns readable:false when the sidecar exists but cannot be read or parsed.
// A health check must be able to tell "no breach was ever recorded" from "I
// could not see the record"; collapsing those into one green answer is exactly
// the class of lie this signal exists to prevent.
function readDurabilityState(files, dependencies = {}) {
  const io = dependencies.fs || fs;
  const empty = { present: false, readable: true, breaches: [], lastDurableAtMs: null, totalBreachCount: 0 };
  const file = durabilityStatePath(files);
  let raw;
  try {
    if (!io.existsSync(file)) return empty;
    raw = io.readFileSync(file, 'utf8');
  } catch (error) {
    return { ...empty, present: true, readable: false, reason: safeError(error) };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { return { ...empty, present: true, readable: false, reason: safeError(error) }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.breaches)) {
    return { ...empty, present: true, readable: false, reason: 'The audit durability state is not canonical.' };
  }
  // CRED-F6: re-scrub on every read, not just on write. A sidecar file
  // written by a pre-fix build (or hand-edited) may still carry an
  // unsanitized action on disk; scrubbing here means the very next breach
  // that reads-then-rewrites this file (noteDurabilityBreach) launders that
  // stale entry rather than perpetuating it.
  const breaches = parsed.breaches
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && Number.isSafeInteger(entry.atMs) && entry.atMs >= 0)
    .map(entry => ({
      atMs: entry.atMs,
      action: typeof entry.action === 'string' ? scrubText(entry.action, 160) : null,
      code: typeof entry.code === 'string' && MECHANICAL_CODE.test(entry.code) ? entry.code : null,
      message: typeof entry.message === 'string' ? scrubText(entry.message, 1000) : null,
      spooled: entry.spooled === true,
      // Absent in a sidecar written before this field existed, which is exactly
      // the ambiguous case: default to false so an unknown-provenance entry is
      // never counted as a refused external write it cannot be shown to be.
      required: entry.required === true,
      // ...BUT THAT DEFAULT IS NOT A FACT, AND IT MUST NOT BE COUNTED AS ONE.
      //
      // Defaulting the unknown to false is the right way to COUNT. Reporting
      // the result as "0 external writes were refused" is a different claim,
      // and on 2026-08-11 it was made about 200 retained breaches of which
      // exactly zero could be classified: every one had been written by a
      // long-lived process still running an audit.js from before the
      // classification fields existed (five mcp-server.js processes on this
      // host had been up since 2026-08-09, the fields landed 2026-08-10).
      // That is this codebase's recurring absence-read-as-consent defect
      // wearing a diagnostic hat -- and it is the reason the sidecar could not
      // answer WHY the writes went non-durable. `required` now round-trips as
      // null when it was never recorded, so unknown stays unknown across the
      // read-rewrite that noteDurabilityBreach performs on every breach.
      requiredKnown: entry.required === true || entry.required === false,
      // The mechanical classification, likewise: `null` here means "this entry
      // names no failure", which is a gap to report, not a clean bill.
      classified: typeof entry.code === 'string' && MECHANICAL_CODE.test(entry.code),
      // CRED-F6, same as every other field here: re-validate on every read,
      // not just on write, so a pre-fix or hand-edited sidecar entry cannot
      // reach a caller as a fabricated object. safeDetails() re-applies the
      // same scrub/size bound the write side already used.
      detail: safeDetails(entry.detail)
    }))
    .sort((left, right) => left.atMs - right.atMs)
    .slice(-MAX_DURABILITY_BREACHES);
  return {
    present: true, readable: true, breaches,
    lastDurableAtMs: Number.isSafeInteger(parsed.lastDurableAtMs) ? parsed.lastDurableAtMs : null,
    totalBreachCount: Number.isSafeInteger(parsed.totalBreachCount) ? parsed.totalBreachCount : breaches.length
  };
}

// The persisted shape, from the in-memory shape. `requiredKnown`/`classified`
// are derived facts and are never stored; what IS stored is `required: null`
// for an entry whose provenance was never recorded, so that the next reader
// reaches the same conclusion instead of inheriting this reader's default.
function durabilityBreachRecord(breach) {
  return {
    atMs: breach.atMs,
    action: breach.action,
    code: breach.code,
    message: breach.message,
    spooled: breach.spooled === true,
    required: breach.requiredKnown === false ? null : breach.required === true,
    // Additive only: null for every breach that is not a projection
    // divergence (unchanged shape for every existing record), and
    // { sink, reason, sinkCursor, projectionLines } -- already scrubbed and
    // size-bounded by safeDetails() at the call site -- when it is. This is
    // the one place validateProjectionState()'s classifier result survives
    // past the single throw that computed it.
    detail: breach.detail !== undefined ? breach.detail : null
  };
}

function writeDurabilityState(files, state, dependencies = {}) {
  const persisted = Array.isArray(state.breaches)
    ? { ...state, breaches: state.breaches.map(durabilityBreachRecord) }
    : state;
  writeAtomic(durabilityStatePath(files), `${JSON.stringify(persisted)}\n`, dependencies.fs || fs);
}

// Never throws.  The durability signal is diagnostics: it must not be able to
// turn a spooled-but-recoverable write into a failed one.
function noteDurabilityBreach(files, entry, dependencies = {}) {
  try {
    const prior = readDurabilityState(files, dependencies);
    // CRED-F6: the caller's action string is arbitrary, untrusted input --
    // e.g. a caller that mistakenly interpolated a secret into an action
    // name -- and this sidecar is a plain, unsigned JSON file, not the
    // scrubbed-and-canonicalized ledger. Never persist it raw.
    const row = {
      atMs: entry.atMs,
      action: typeof entry.action === 'string' ? scrubText(entry.action, 160) : null,
      // The mechanical classification is the whole point of this trace: a
      // window full of "The audit ledger rejected a transaction." tells a
      // later reader nothing about which failure it was actually looking at.
      code: typeof entry.code === 'string' && MECHANICAL_CODE.test(entry.code) ? entry.code : null,
      message: typeof entry.message === 'string' ? scrubText(entry.message, 1000) : null,
      spooled: entry.spooled === true,
      // THE DISTINCTION THAT WAS MISSING. A best-effort record() that spools is
      // recovered on the next prepare() and blocks nothing. A requireRecord()
      // that fails REFUSES an external write. Both landed here as one
      // undifferentiated "breach", so a window of harmless post-hoc diagnostic
      // spools was indistinguishable from external writes actually being
      // refused -- and readers reasonably assumed the worse of the two.
      required: entry.required === true,
      // This build looked, so whatever it concluded is a fact about this
      // entry. Only entries inherited from a build that could not look carry
      // an unknown provenance.
      requiredKnown: true,
      classified: typeof entry.code === 'string' && MECHANICAL_CODE.test(entry.code),
      // Additive: null unless the caller supplied one (today, only the
      // AUDIT_PROJECTION_DIVERGED path does). Already scrubbed by
      // safeDetails() at the call site, but re-bounded here too since this
      // entry is untrusted input to this function like every other field.
      detail: safeDetails(entry.detail)
    };
    const breaches = (prior.readable ? prior.breaches : []).concat([row]).slice(-MAX_DURABILITY_BREACHES);
    // An unreadable prior file must not silently reset the lifetime counter to
    // zero, so fall back to the retained-window length rather than claiming a
    // clean history we cannot actually see.
    const priorTotal = prior.readable ? prior.totalBreachCount : Math.max(prior.totalBreachCount, breaches.length - 1);
    writeDurabilityState(files, {
      version: 1,
      breaches,
      totalBreachCount: priorTotal + 1,
      lastDurableAtMs: prior.readable ? prior.lastDurableAtMs : null,
      updatedAtMs: entry.atMs
    }, dependencies);
    // A required refusal is the one class of breach that represents a real
    // operation the person asked for and did not get, so it also goes into the
    // uncapped record that the rolling window above cannot evict. Strictly
    // after the sidecar write, and it cannot fail into this path.
    if (row.required === true) appendRefusalRecord(files, row, dependencies);
    return true;
  } catch { return false; }
}

// Records that durable writing is working again.  It only touches the sidecar
// once that file already exists, and at most once per heartbeat interval, so
// the ordinary durable path keeps its current cost on a busy ledger.
function noteDurableSuccess(files, nowMs, dependencies = {}) {
  try {
    const io = dependencies.fs || fs;
    if (!io.existsSync(durabilityStatePath(files))) return false;
    const prior = readDurabilityState(files, dependencies);
    if (!prior.readable) return false;
    // Stop heartbeating once every breach has aged out of the retention window.
    // Otherwise a single breach would keep rewriting this file once a minute
    // forever. The record is kept rather than deleted so the history survives.
    if (!prior.breaches.some(breach => nowMs - breach.atMs <= DURABILITY_RETENTION_MS)) return false;
    if (Number.isSafeInteger(prior.lastDurableAtMs) && nowMs - prior.lastDurableAtMs < DURABILITY_HEARTBEAT_MS) return false;
    writeDurabilityState(files, {
      version: 1, breaches: prior.breaches, totalBreachCount: prior.totalBreachCount,
      lastDurableAtMs: nowMs, updatedAtMs: nowMs
    }, dependencies);
    return true;
  } catch { return false; }
}

// Group breaches into non-durable windows.  Today's failure mode was twelve
// scattered breaches, each recovered within seconds, so a naive open/close
// window would have reported twelve zero-length blips instead of one long
// degraded period.  Clustering is what makes a multi-hour window visible.
function durabilityWindows(breaches, gapMs = DURABILITY_CLUSTER_GAP_MS) {
  const windows = [];
  for (const breach of breaches) {
    const last = windows[windows.length - 1];
    const required = breach.required === true ? 1 : 0;
    if (last && breach.atMs - last.endMs <= gapMs) {
      last.endMs = breach.atMs;
      last.count += 1;
      last.requiredCount += required;
    } else {
      windows.push({ startMs: breach.atMs, endMs: breach.atMs, count: 1, requiredCount: required });
    }
  }
  return windows.map(window => ({ ...window, durationMs: window.endMs - window.startMs }));
}

function durabilitySummary(files, dependencies = {}, nowMs = (dependencies.clock || Date.now)()) {
  const io = dependencies.fs || fs;
  const state = readDurabilityState(files, dependencies);
  const summary = {
    state: 'ok', stateFile: durabilityStatePath(files),
    stateFilePresent: state.present, stateReadable: state.readable,
    pendingEmergency: null, breachCount: 0, totalBreachCount: state.totalBreachCount,
    lastBreachAtMs: null, lastDurableAtMs: state.lastDurableAtMs,
    openWindow: null, windows: [], reasons: []
  };
  // Spool depth is an independent observation and can fail on its own. An
  // unreadable spool directory is unknown, never zero.
  try {
    summary.pendingEmergency = emergencyFiles(files, io)
      .reduce((count, file) => count + io.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length, 0);
  } catch (error) {
    summary.reasons.push(`the emergency spool could not be read: ${safeError(error)}`);
  }
  if (!state.readable) {
    // A REAL, MEASURED "CRITICAL" MUST NEVER BE MASKED BY AN UNRELATED
    // "UNKNOWN". pendingEmergency and this breach-history sidecar are two
    // independent files with independent failure modes -- exactly the same
    // distinction that motivated moving the spool verdicts below the
    // current/historical build (see that comment). That fix only reordered
    // the checks INSIDE the state-readable path; this early return, taken
    // when the sidecar itself is corrupt, still reported 'unknown'
    // unconditionally -- even when pendingEmergency, read successfully
    // moments above, was positively non-empty. "Could not look" (this
    // sidecar) must never stand in for "not there" when the thing that WAS
    // looked at (the spool) already says otherwise: a positive count here
    // means the canonical chain is refusing writes RIGHT NOW, which is
    // strictly worse than losing the breach-history trend line.
    if (summary.pendingEmergency > 0) {
      summary.state = 'critical';
      summary.reasons.push(`${summary.pendingEmergency} audit event(s) are spooled to emergency storage and are not in the canonical chain`);
      summary.reasons.push(`the audit durability state could not be read: ${state.reason}`);
      return summary;
    }
    summary.state = 'unknown';
    summary.reasons.push(`the audit durability state could not be read: ${state.reason}`);
    return summary;
  }
  const retained = state.breaches.filter(breach => nowMs - breach.atMs <= DURABILITY_RETENTION_MS);
  summary.breachCount = retained.length;
  summary.lastBreachAtMs = retained.length ? retained[retained.length - 1].atMs : null;
  // The same entry lastBreachAtMs already reads, named for what caused it.
  // Scoped to the full retention window like lastBreachAtMs itself, not the
  // open window -- so a code stays visible once its incident has aged past
  // DURABILITY_CLUSTER_GAP_MS, the exact case a week-old-looking `current`
  // already goes quiet on.
  summary.newest = retained.length ? {
    code: retained[retained.length - 1].code,
    atMs: retained[retained.length - 1].atMs,
    action: retained[retained.length - 1].action,
    required: retained[retained.length - 1].required,
    message: retained[retained.length - 1].message
  } : null;
  const windows = durabilityWindows(retained);
  summary.windows = windows.slice(-5);
  const newest = windows[windows.length - 1] || null;
  if (newest && nowMs - newest.endMs <= DURABILITY_CLUSTER_GAP_MS) {
    summary.openWindow = { ...newest, ageMs: nowMs - newest.startMs };
  }
  // CURRENT HEALTH IS NOT THE SAME QUESTION AS SEVEN-DAY HISTORY.
  //
  // This block used to raise CRITICAL if ANY window in the 7-day retention was
  // severe. Because retention is 7 days and a severe window is only 5 breaches,
  // one bad hour latched exit code 2 for a week, and no amount of subsequent
  // healthy operation could clear it. Callers read exit 2 as "the audit is
  // broken right now" -- it is the gate they consult before an external write --
  // so a week-old incident kept presenting as a live outage. Measured
  // 2026-08-11: three lanes refused identity-bearing work on that reading.
  //
  // The history is not discarded and nothing is silenced: every window is still
  // reported, and `historical` below carries the full retention picture. What
  // changes is which question the STATE answers. State now describes the open
  // window -- breaches within DURABILITY_CLUSTER_GAP_MS of now -- so exit 2
  // means "failing now", while a recovered incident degrades to warn and says
  // so in words. An operator who wants the week reads `historical`.
  const isSevere = window =>
    window.durationMs >= DURABILITY_CRITICAL_WINDOW_MS || window.count >= DURABILITY_CRITICAL_COUNT;
  const severe = windows.filter(isSevere);
  const requiredIn = from => retained.filter(breach => breach.required && breach.atMs >= from).length;
  // The population the "refused" count could not actually be computed over.
  const unknownProvenanceIn = from =>
    retained.filter(breach => breach.requiredKnown === false && breach.atMs >= from).length;
  const uncodedIn = from =>
    retained.filter(breach => breach.classified !== true && breach.atMs >= from).length;
  // Count per code, open window only -- unclassified (code: null) breaches
  // are excluded here since `unclassified` above already reports that
  // count; a "null" bucket in `codes` would just duplicate it.
  const codesIn = from => retained
    .filter(breach => breach.atMs >= from && breach.code)
    .reduce((counts, breach) => {
      counts[breach.code] = (counts[breach.code] || 0) + 1;
      return counts;
    }, {});

  // Refused external writes are reported separately from spooled diagnostics
  // because only the former actually stopped anything from happening -- and
  // the count is reported NEXT TO the number of entries it could not be
  // computed over, because "0 refused out of 200 unclassifiable entries" and
  // "0 refused out of 200 entries we checked" are different answers and only
  // one of them is reassuring.
  summary.current = {
    failing: Boolean(summary.openWindow),
    quietForMs: summary.lastBreachAtMs === null ? null : nowMs - summary.lastBreachAtMs,
    breachCount: summary.openWindow ? summary.openWindow.count : 0,
    refusedExternalWrites: summary.openWindow ? requiredIn(summary.openWindow.startMs) : 0,
    unknownProvenance: summary.openWindow ? unknownProvenanceIn(summary.openWindow.startMs) : 0,
    unclassified: summary.openWindow ? uncodedIn(summary.openWindow.startMs) : 0,
    codes: summary.openWindow ? codesIn(summary.openWindow.startMs) : {}
  };
  const refusedLifetime = countRefusalRecords(files, io);
  if (refusedLifetime === null) {
    summary.reasons.push('the refusals record could not be read, so the lifetime refusal count is unknown');
  }
  summary.historical = {
    breachCount: retained.length,
    severeWindowCount: severe.length,
    refusedExternalWrites: requiredIn(0),
    // TWO NUMBERS, AND THE NAMES SAY WHICH IS WHICH. refusedExternalWrites is
    // over the RETAINED WINDOW and always was; a required refusal evicted by
    // the 200-row cap simply stops being counted there. This one is read from
    // the uncapped refusals record and is the lifetime figure. Null means the
    // record could not be read -- never 0, which would be a lie about a lost
    // refusal.
    refusedExternalWritesLifetime: refusedLifetime,
    // How many retained breaches predate the classification fields, and how
    // many name no failure code at all. A window that is entirely unclassified
    // cannot tell an operator WHY writing went non-durable, which is the only
    // thing this record exists to do.
    unknownProvenance: unknownProvenanceIn(0),
    unclassified: uncodedIn(0),
    worstWindow: severe.length ? severe[severe.length - 1] : null
  };

  // THE SPOOL VERDICTS COME AFTER THE HISTORY IS BUILT, NOT INSTEAD OF IT.
  //
  // These two returns used to sit above the block that fills `current` and
  // `historical`, so exactly when the audit was in its worst state -- events
  // spooled right now, or a spool directory that could not be read -- both
  // fields came back undefined. Every consumer then read `summary.historical`
  // as absent and printed nothing, which is how the one moment that most
  // needed a week of context showed the least of it. The verdicts below are
  // unchanged; only the order is.
  if (summary.pendingEmergency === null) {
    // THE SAME MASKING, MIRRORED. `openWindow` and its severity are built
    // entirely from the breach-history sidecar, which DID read successfully
    // to reach this point (see the `!state.readable` branch above, fixed the
    // same way for the opposite pairing). The spool is a different file with
    // a different failure mode; when the sidecar alone already proves an
    // open, severe non-durable window, that confirmed finding must stand --
    // an unreadable spool can only ADD unknown risk on top of a proven one,
    // never subtract the risk that was already proven.
    if (summary.openWindow && isSevere(summary.openWindow)) {
      summary.state = 'critical';
      summary.reasons.push(`${summary.openWindow.count} non-durable audit write(s) spanning ${Math.round(summary.openWindow.durationMs / 60000)} minute(s) from ${new Date(summary.openWindow.startMs).toISOString()} -- STILL OPEN, this is happening now`);
      summary.reasons.push('the emergency spool could not be read, so whether additional events are non-durable right now is unknown');
      return summary;
    }
    summary.state = 'unknown';
    return summary;
  }
  if (summary.pendingEmergency > 0) {
    summary.state = 'critical';
    summary.reasons.push(`${summary.pendingEmergency} audit event(s) are spooled to emergency storage and are not in the canonical chain`);
    return summary;
  }

  if (summary.openWindow && isSevere(summary.openWindow)) {
    summary.state = 'critical';
    summary.reasons.push(`${summary.openWindow.count} non-durable audit write(s) spanning ${Math.round(summary.openWindow.durationMs / 60000)} minute(s) from ${new Date(summary.openWindow.startMs).toISOString()} -- STILL OPEN, this is happening now`);
  } else if (summary.openWindow) {
    summary.state = 'warn';
    summary.reasons.push(`${summary.openWindow.count} non-durable audit write(s) since ${new Date(summary.openWindow.startMs).toISOString()}, below the critical threshold`);
  } else if (severe.length) {
    const worst = severe[severe.length - 1];
    summary.state = 'warn';
    summary.reasons.push(`HISTORICAL ONLY: the worst window in the last 7 days was ${worst.count} non-durable write(s) over ${Math.round(worst.durationMs / 60000)} minute(s) from ${new Date(worst.startMs).toISOString()}; durable writing has been quiet since ${new Date(summary.lastBreachAtMs).toISOString()}; this warn expires at ${new Date(summary.lastBreachAtMs + DURABILITY_RETENTION_MS).toISOString()} if nothing else breaches before then`);
  } else if (retained.length) {
    summary.state = 'warn';
    summary.reasons.push(`${retained.length} non-durable audit write(s) in the retention window; none recent`);
  }

  // Say plainly whether anything was actually refused. A window made entirely
  // of best-effort record() spools is recovered by the next prepare() and
  // blocked no external write; saying so stops a reader inferring an outage
  // from a diagnostic.
  if (summary.current.failing) {
    summary.reasons.push(summary.current.refusedExternalWrites > 0
      ? `${summary.current.refusedExternalWrites} external write(s) were REFUSED in the open window`
      : summary.current.unknownProvenance > 0
        ? `no external write in the open window is KNOWN to have been refused, but ${summary.current.unknownProvenance} of its ${summary.current.breachCount} breach(es) predate the field that records it, so this is not proof that none was`
        : 'no external write was refused in the open window: every breach in it was a best-effort record() that spooled and is recoverable');
  }
  // A record that cannot say which failure it was is a broken record, and the
  // check has to say so rather than let a clean-looking zero stand in for it.
  if (summary.historical.unclassified > 0) {
    summary.reasons.push(`${summary.historical.unclassified} of ${retained.length} retained breach(es) carry no failure code, so this record cannot say WHY writing went non-durable${summary.historical.unknownProvenance > 0
      ? ` (${summary.historical.unknownProvenance} of them were written before the classification fields existed -- typically a long-lived process still running an older build)`
      : ''}`);
  }
  return summary;
}

// Read-only durability health signal.  It deliberately does NOT call prepare():
// a health check must be able to observe a degraded ledger without taking the
// BEGIN IMMEDIATE write lock, and without itself triggering the emergency
// ingestion whose absence it is trying to report.
function durability(dependencies = {}) {
  const policy = (dependencies.loadPolicy || loadPolicy)();
  const files = resolveFiles(policy, dependencies.rootPath || rootPath, dependencies.env || process.env);
  if (policy.audit && policy.audit.enabled === false) {
    return {
      state: 'disabled', disabled: true, stateFile: durabilityStatePath(files),
      pendingEmergency: null, breachCount: 0, windows: [], openWindow: null,
      reasons: ['durable audit is disabled by policy']
    };
  }
  return durabilitySummary(files, dependencies);
}

// How many spooled records one drain transaction may carry.
//
// The drain is bounded rather than whole-file because the batch holds the
// ledger's single cross-process writer lock (BEGIN IMMEDIATE) for its whole
// duration. A spool grows one line per record for as long as the canonical
// ledger is unavailable, so "the whole file" has no useful upper bound, and
// an unbounded batch would convert a long outage into a correspondingly long
// stall for every other writer on the machine. 256 keeps the lock-hold per
// batch in the same order as a handful of today's per-record commits while
// still collapsing 256 fsyncs into one.
const SPOOL_INGEST_BATCH = 256;

// Run one drain chunk under a single commit when the store offers the seam.
//
// A store that does not (an older double, an injected test stand-in) keeps
// exactly today's behaviour: each appendDurably() inside opens its own
// transaction. This is a cost seam only -- it never decides whether a record
// is admissible -- so falling back cannot weaken anything.
function withAppendBatch(store, run) {
  return typeof store.withAppendBatch === 'function' ? store.withAppendBatch(() => run()) : run();
}

function ingestEmergency(store, signer, files, dependencies) {
  const io = dependencies.fs || fs;
  const directory = path.dirname(files.emergency);
  ensureDir(directory);
  if (io.existsSync(files.emergency)) {
    const extension = path.extname(files.emergency) || '.jsonl';
    const base = path.basename(files.emergency, extension);
    const ingest = path.join(directory, `${base}.ingest-${process.pid}-${crypto.randomUUID()}${extension}`);
    try { io.renameSync(files.emergency, ingest); } catch (error) {
      if (io.existsSync(files.emergency)) throw error;
    }
  }
  let ingested = 0;
  for (const file of emergencyFiles(files, io).filter(candidate => candidate !== files.emergency)) {
    if (!io.existsSync(file)) continue;
    const bytes = io.readFileSync(file);
    const lines = bytes.toString('utf8').split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const invalidLines = [];
    const unauthenticatedLines = [];
    // ONE COMMIT PER CHUNK, NOT ONE PER RECORD.
    //
    // Every appendDurably() below is anchor-free, so the only per-record cost
    // outside the append itself is the ledger's own BEGIN IMMEDIATE/COMMIT --
    // and COMMIT under `PRAGMA synchronous=FULL` is a real fsync.
    //
    // MEASURED 2026-09-03 (win32, node v22.14.0), draining a 200-record spool,
    // both sides run back to back on the same loaded machine:
    //   before  206 BEGIN / 206 COMMIT   flush 746-1028 ms   3.73-5.14 ms/record
    //           time inside COMMIT 243-255 ms  (1.22-1.27 ms/record)
    //   after     7 BEGIN /   7 COMMIT   flush 475- 542 ms   2.38-2.71 ms/record
    //           time inside COMMIT 8.0-9.8 ms  (0.04-0.05 ms/record)
    // The residue is per-record crypto and row work, not commits: it stays
    // linear in the record count, so there is no O(n^2) left behind here.
    //
    // Nothing about admission changes. Each line is still parsed, still
    // mac-verified against the trusted signer (AUDIT-F-03), still re-scrubbed
    // (CRED-F7), and still individually skipped into invalidLines /
    // unauthenticatedLines on its own merits. Only the commit boundary moves.
    //
    // A skipped line cannot poison the open transaction: every error class
    // caught below (AUDIT_INVALID_ARGUMENT, AUDIT_JSON_INVALID,
    // AUDIT_EVENT_TOO_LARGE, AUDIT_EVENT_CONFLICT) is raised by appendEvent()
    // before it inserts anything -- the first three during argument
    // canonicalization, the fourth from a SELECT that precedes the INSERT --
    // so the batch continues with no partial row to undo.
    //
    // CRASH SAFETY IS THE REASON THIS IS ALLOWED TO BATCH AT ALL. The ingest
    // file is unlinked only after the drain completes, below. A crash or a
    // thrown error mid-chunk rolls that chunk back and leaves the file, so
    // the next prepare() re-drains it; records that DID commit in an earlier
    // chunk replay through appendEvent()'s event_id idempotency and are not
    // duplicated. The pre-existing per-record path relied on exactly the same
    // re-drain, only with more partial state to reconcile, never less.
    const drainLine = index => {
      const line = lines[index];
      if (!line) return 0;
      let record;
      try { record = JSON.parse(line); }
      catch { invalidLines.push(index + 1); return 0; }
      // AUDIT-F-03: a line that does not carry a valid mac from the current
      // spool authentication key is never handed to the trusted canonical
      // signer -- attacker-writable JSON in this directory (or a bare
      // pre-fix spool line) is quarantined below exactly like malformed
      // JSON, not silently canonicalized.
      const envelopeItem = verifySpoolEnvelope(record, signer, dependencies);
      if (!envelopeItem) {
        unauthenticatedLines.push(index + 1);
        return 0;
      }
      // CRED-F7: re-scrub before it ever reaches the canonical, signed
      // ledger -- the mac only proves who wrote these bytes, not that the
      // content inside them is still safe to make permanent.
      const item = rescrubSpoolItem(envelopeItem);
      if (!item) {
        invalidLines.push(index + 1);
        return 0;
      }
      try {
        appendDurably(store, signer, item, dependencies, { anchor: false });
        return 1;
      } catch (error) {
        if (/^AUDIT_(?:INVALID_ARGUMENT|JSON_INVALID|EVENT_TOO_LARGE|EVENT_CONFLICT)$/.test(String(error && error.code))) {
          invalidLines.push(index + 1);
          return 0;
        }
        throw error;
      }
    };
    for (let start = 0; start < lines.length; start += SPOOL_INGEST_BATCH) {
      const end = Math.min(lines.length, start + SPOOL_INGEST_BATCH);
      // `ingested` advances only once the chunk has actually committed, so a
      // rolled-back chunk is never counted as drained.
      ingested += withAppendBatch(store, () => {
        let appended = 0;
        for (let index = start; index < end; index += 1) appended += drainLine(index);
        return appended;
      });
    }
    if (invalidLines.length || unauthenticatedLines.length) {
      const digest = sha256(bytes);
      const quarantine = `${files.emergency}.quarantine-${digest.slice(0, 16)}`;
      copyArchive(file, quarantine, io);
      const quarantinedAtMs = (dependencies.clock || Date.now)();
      appendDurably(store, signer, {
        eventId: `audit-quarantine-${digest.slice(0, 32)}`,
        occurredAtMs: quarantinedAtMs,
        createdAtMs: quarantinedAtMs,
        event: {
          timestamp: new Date(quarantinedAtMs).toISOString(),
          action: 'audit.emergency.quarantined', target: path.basename(quarantine),
          details: {
            digest,
            invalidLineCount: invalidLines.length,
            firstInvalidLine: invalidLines[0],
            unauthenticatedLineCount: unauthenticatedLines.length,
            firstUnauthenticatedLine: unauthenticatedLines[0]
          }
        }
      }, dependencies, { anchor: false });
      ingested++;
      report(dependencies, `ToolsEnabled quarantined ${invalidLines.length} invalid and ${unauthenticatedLines.length} unauthenticated emergency audit line(s) in ${path.basename(quarantine)}.`);
    }
    if (io.existsSync(file)) io.unlinkSync(file);
  }
  return ingested;
}

function prepare(dependencies = {}) {
  maintenance.assertAvailable(boundLedgerFile(dependencies));
  const policy = (dependencies.loadPolicy || loadPolicy)();
  const files = resolveFiles(policy, dependencies.rootPath || rootPath, dependencies.env || process.env);
  if (policy.audit && policy.audit.enabled === false) return { disabled: true, policy, files };
  const retention = configuredRetention(dependencies);
  // Before the ledger is opened, before the signing key is read, before
  // anything is appended: a ledger that is not this installation's own may not
  // touch this installation's vault.
  assertLedgerVaultBinding({ file: boundLedgerFile(dependencies) }, dependencies);
  const store = getStore(dependencies);
  const now = (dependencies.clock || Date.now)();
  const signer = registerSigner(store, dependencies, now);
  const boundary = readArchiveBoundary(store, signer);
  const isolated = Boolean(dependencies.store);
  let migration = { imported: 0 };
  if (isolated || !defaultInitialized) {
    const migrationOwner = dependencies.migrationOwnerId || `migration-${process.pid}-${crypto.randomUUID()}`;
    migration = store.withProjectionLock({ ownerId: migrationOwner, nowMs: now }, lockedStore =>
      migrateLegacy(lockedStore, signer, files, dependencies));
    if (!isolated) defaultInitialized = true;
    if ((migration.imported || 0) > 0) flushInternal(store, files, dependencies, { force: true, boundary });
  }
  // A transient canonical failure may create a spool after initialization, so
  // ingestion is checked on every entry rather than only at process startup.
  const ingested = ingestEmergency(store, signer, files, dependencies);
  const shouldAdvanceAnchor = Boolean((migration.imported || 0) > 0 || ingested > 0
    || (!isolated && defaultInitialized && !defaultAnchorLoaded));
  if (dependencies.deferReconciliation === true) {
    return {
      disabled: false, policy, files, store, signer, retention, boundary,
      anchor: null, verification: null, shouldAdvanceAnchor,
      reconciliationDeferred: true
    };
  }
  const reconciliation = reconcileAnchor(store, signer, {
    ...dependencies, verificationFiles: files,
    verificationCacheDisabled: dependencies.verificationCacheDisabled === true
      || Boolean(migration.imported || ingested)
  }, undefined, {
    advance: shouldAdvanceAnchor,
    fresh: dependencies.anchorFresh === true || dependencies.anchorRequired === true,
    boundary
  });
  return {
    disabled: false, policy, files, store, signer, retention, boundary,
    anchor: reconciliation, verification: reconciliation.verificationSnapshot,
    shouldAdvanceAnchor, reconciliationDeferred: false
  };
}

function eventInput(action, target, details, dependencies) {
  const now = (dependencies.clock || Date.now)();
  const idFactory = dependencies.eventIdFactory || (() => `audit-${crypto.randomUUID()}`);
  return {
    eventId: idFactory(), occurredAtMs: now, createdAtMs: now,
    event: {
      timestamp: new Date(now).toISOString(),
      action: scrub(action), target: scrub(target), details: scrub(details)
    }
  };
}

function baseStatus() {
  return {
    ok: false, durable: false, projected: false, recorded: false, partial: false,
    anchored: false, protectedSequence: null,
    disabled: false, eventId: null, sequence: null, eventHash: null,
    sinks: { jsonl: false, text: false }, pending: null, errors: []
  };
}

// Eleven resident audit-writing processes were measured on the production
// host. A synchronized burst can make all but one verifier stale per round,
// so the retry window must cover more than one full resident-process wave.
// The work remains bounded and every retry is still a full fail-closed check.
const DEFAULT_ADMISSION_RETRY_LIMIT = 32;

/* A PROJECTION RETRY IS NOT PRICED LIKE A WITNESS RETRY, SO IT DOES NOT GET
 * THE SAME BUDGET.
 *
 * The retries above re-read an anchor and compare a fingerprint. A projection
 * retry re-parses BOTH projection files in full -- measured at 186 ms per pass
 * on the owner's 19 MB of projections (see the comment above
 * validateProjectionState) -- and the one divergence reason that reaches the
 * retry is deliberately never memoized, so every pass pays that again. Giving
 * it the witness budget of 32 would spend six seconds of an agent's tool call
 * on a race that resolves in one or two passes or not at all. This bound is
 * separate, and small, on purpose. */
const DEFAULT_PROJECTION_DIVERGENCE_RETRY_LIMIT = 4;

function admissionRetry(phase, divergence = null) {
  const failure = auditFailure('AUDIT_ADMISSION_RETRY',
    'The audit verification witness changed before the canonical append lock was acquired.',
    { phase });
  // Carried on the error object, not in details: details are what a refusal
  // REPORTS, and this one is consumed by lockedAdmissionAppendMany and never
  // reaches a caller or the ledger. What it carries is the original divergence,
  // so that running out of retries can surface that instead of a generic
  // contention error.
  if (divergence) failure.projectionDivergence = divergence;
  return failure;
}

function retentionDecision(policy, priorEvents, input) {
  const replayedInput = priorEvents.some(event => event.eventId === input.eventId);
  const prospectiveOldest = priorEvents[0] || (replayedInput ? null : input);
  return retentionPlan({
    policy,
    total: priorEvents.length + (replayedInput ? 0 : 1),
    oldestOccurredAtMs: prospectiveOldest && prospectiveOldest.occurredAtMs,
    nowMs: input.occurredAtMs
  });
}

// One shared enforcement path for ordinary and conditional audit appends.
// The caller already owns the writer/projection transaction and has projected
// the new event. This invokes the sole archival primitive FIRST, and only
// once every roll it decided on has actually committed does it rewrite both
// fast views to the now-confirmed post-roll live window.
//
// ORDER IS LOAD-BEARING, NOT COSMETIC. rebuildProjection() is a plain
// filesystem rename: it is durable the instant it returns, and it is NOT
// part of the SQL transaction withProjectionLock/rollOldestEventOut run
// inside. rollArchiveOnce can still fail after that point -- a transient
// fault writing cold storage, a sink-behind or window-not-exceeded refusal --
// and when it does, the surrounding transaction rolls back the append, the
// sink-position advance, and any earlier-in-this-loop roll. A projection file
// already rewritten to the state that roll assumed would happen is not rolled
// back with it: every later admission's validateProjectionState() then finds
// the file permanently ahead of what the ledger actually contains and refuses
// with AUDIT_PROJECTION_DIVERGED forever, because that throw runs before
// projectSinks() ever gets a chance to notice the mismatch and repair it.
// MEASURED 2026-09-03 on a private isolated ledger: one simulated one-time
// transient fault on the archive write was enough to wedge every subsequent
// record() call. Rolling first means a failure here throws before either
// projection file has been touched, so the transaction rollback alone is
// sufficient to leave a consistent state.
//
// Rolling before rebuilding does not weaken the roll's own "sink-behind"
// guard: that guard reads the DB's sink_state row, which this call's own
// projectSinks() already advanced to the new head before
// enforceRetentionAfterAppend ever runs, not the projection file on disk.
function enforceRetentionAfterAppend({
  store, signer, files, dependencies, policy, boundary,
  priorEvents, input, appended, projection, decision
}) {
  const planned = decision || retentionDecision(policy, priorEvents, input);
  if (!planned.shouldRoll || appended.replayed || !projection.projected || projection.pending !== 0) {
    return { roll: { rolled: false, reason: planned.reason }, boundary };
  }
  // HOW MANY LEAVE. Time windows roll one at a time as before. An event
  // window rolls its whole excess in one pass: the plan only fires once the
  // live window is over the policy value by more than its slack (see
  // audit-retention.js eventWindowSlack), and then it brings the window back
  // to exactly the policy value. MEASURED 2026-09-02: at the default of
  // 10,000 events the old one-per-append roll rewrote both projection files
  // (11.5 MB and 6.7 MB) inside the writer lock on EVERY append, for as long
  // as the ledger stayed at its cap -- which is forever. The customer never
  // keeps fewer events than the policy promises; briefly, they keep a few more.
  const excess = policy.mode === 'events' && Number.isSafeInteger(planned.excess) && planned.excess > 0
    ? planned.excess : 1;
  const retainedEvents = [...priorEvents, appended.event].slice(excess);
  const minimumRetained = policy.mode === 'events' ? policy.value : 1;
  let roll = null;
  for (let rolled = 0; rolled < excess; rolled += 1) {
    roll = rollArchiveOnce(store, signer, dependencies, {
      nowMs: input.occurredAtMs,
      minimumRetained
    });
    if (!roll.rolled) {
      throw auditFailure('AUDIT_ARCHIVE_ROLL_FAILED',
        'The live audit window was over its configured limit but no event was archived.',
        { reason: roll.reason || null, rolled });
    }
  }
  const rolledBoundary = verifiedArchiveBoundary(roll.boundary, signer);
  for (const sink of ['jsonl', 'text']) {
    projection.sinks[sink] = rebuildProjection(
      store, sink, files[sink], retainedEvents, dependencies,
      (dependencies.clock || Date.now)(), rolledBoundary
    );
  }
  return { roll: { ...roll, rolledEvents: excess }, boundary: rolledBoundary };
}

// Pay the complete O(N) chain/signature/projection verification in a WAL read
// transaction, never inside BEGIN IMMEDIATE. The result is not authority by
// itself: AuditStore retains the exact trusted result identity and the caller
// must prove its complete fingerprint still matches after taking the writer
// lock. Any race is a retry outside the lock, never an admission pass.
// The archive boundary another writer may have moved since prepare() read it.
//
// MEASURED 2026-09-04 15:27-15:34Z on the owner's Live ledger (10,080 live rows
// at the 10,000-row cap, head 19,244, seventeen circles): six admissions were
// refused AUDIT_LEDGER_INVALID (sequence-gap) and spooled, every write tool
// paid the retry-then-refuse latency, and a verify() of the same ledger a
// minute later was VALID. Nothing was wrong with the chain. A concurrent
// admission had rolled the oldest rows to the archive and advanced the
// boundary; this process's context.boundary still named the old root, so the
// live rows started "late" against it and the walk called that a gap. At the
// cap every batch rolls, so the race stops being rare.
//
// A moved boundary is a retryable race, not a corrupt ledger: re-read it and
// verify again. A boundary that did NOT move and still leaves a gap is the
// real fault and is refused exactly as before.
function sameArchiveBoundary(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.archivedThroughSequence === right.archivedThroughSequence && left.eventHash === right.eventHash;
}

function refreshArchiveBoundary(context, phase) {
  const current = readArchiveBoundary(context.store, context.signer);
  if (sameArchiveBoundary(current, context.boundary)) return false;
  context.boundary = current;
  throw admissionRetry(phase);
}

function verifyAdmissionOutsideLock(context, dependencies) {
  refreshArchiveBoundary(context, 'boundary-advanced');
  const initialAnchor = readAnchor(dependencies, { fresh: true });
  const initialExternal = verificationExternal(context.files, dependencies, initialAnchor);
  const snapshot = context.store.verifyWithEvents({
    external: initialExternal,
    uncached: dependencies.auditVerificationUncached === true,
    boundary: context.boundary
  });
  if (!snapshot.verification.valid) {
    if (snapshot.verification.reason === 'sequence-gap') refreshArchiveBoundary(context, 'boundary-advanced-during-verification');
    throw auditFailure('AUDIT_LEDGER_INVALID',
      `The canonical audit ledger is invalid (${snapshot.verification.reason}).`,
      { reason: snapshot.verification.reason });
  }

  const cacheAfter = typeof context.store.verificationCacheStatus === 'function'
    ? context.store.verificationCacheStatus() : null;
  let projectionError = null;
  // ONCE THIS ADMISSION HAS SEEN A DIVERGENCE, THE CACHE-HIT SKIP MUST NOT
  // DECIDE THE NEXT PASS.
  //
  // The skip below is a cost optimisation: if the verification came straight
  // from cache then nothing about the ledger or the files moved, so re-parsing
  // both projections would answer the same question again. That reasoning
  // inverts the moment a retry is involved. A retry after a projection
  // divergence changes nothing by itself, so the very next pass IS a cache hit
  // -- and the check that refused would simply be skipped, and the admission
  // would proceed on the projection it had just refused. MEASURED while
  // building this: a projection stably 1,025 rows over its limit was refused on
  // the first pass and ADMITTED on the second. A retry that reaches the append
  // by not looking again is the exact thing "never widen what counts as
  // non-divergent" forbids, so once a divergence has been seen, every later
  // pass of this admission re-proves it gone.
  if (context.files && (context.projectionRecheckRequired
    || !cacheAfter || cacheAfter.lastResult !== 'cache-hit')) {
    try {
      validateProjectionState(
        context.files, snapshot.events, snapshot.verification, dependencies, context.boundary
      );
    }
    catch (error) { projectionError = error; }
  }

  // Verification and projection parsing are intentionally outside the writer
  // lock, so a legitimate concurrent append may complete during either. A
  // fresh external read plus the store's exact trusted-fingerprint comparison
  // distinguishes that retryable race from a stable corrupt projection.
  const confirmedAnchor = readAnchor(dependencies, { fresh: true });
  const confirmedExternal = verificationExternal(context.files, dependencies, confirmedAnchor);
  const externalStable = !context.files
    || verificationExternalEqual(initialExternal, confirmedExternal);
  const ledgerStable = typeof context.store.trustedVerificationMatches === 'function'
    && context.store.trustedVerificationMatches({
      prior: snapshot, external: confirmedExternal, boundary: context.boundary
    });
  if (!externalStable || !ledgerStable) throw admissionRetry('outside-lock-verification');
  if (projectionError) {
    // A DISAGREEING PROJECTION FILE IS NOT EVIDENCE ABOUT THE LEDGER CHAIN.
    //
    // This used to call invalidateVerificationCache(), which nulls the trusted
    // prefix _verifyIncremental() extends. Nothing about the chain, the keys or
    // the anchor is in question here -- only the sink file -- and throwing that
    // prefix away is the difference between a 3 ms admission and a full O(N)
    // row read and Ed25519 walk of the whole live window. MEASURED 2026-09-04
    // on a copy of the owner's Live ledger (10,053 live events): 3.2-3.5 ms
    // with the prefix kept, 3.1-4.4 s with it dropped -- and since the failed
    // admission spools and the NEXT one hits the same file, the ledger paid
    // that 3-4 s again on every following tool call for as long as the
    // disagreement lasted. That is a self-sustaining 100% CPU period on the
    // main process, which is what the owner's install kept dying in.
    //
    // Keeping the cache changes what is RECOMPUTED, never what is PROVEN --
    // the same argument trustedVerificationMatches() already makes for the
    // lost-race case. Every consumer re-proves the prefix against a freshly
    // read fingerprint before it may use it, this admission still fails closed
    // on the throw below, and the projection-side memo above makes the repeat
    // refusal cheap without making it any weaker.
    // A DIVERGENCE THAT CAN STOP BEING TRUE IS A RACE, AND THE LIST THAT SAYS
    // WHICH ONES THOSE ARE ALREADY EXISTS.
    //
    // Every other outside-the-lock race in this function is already routed
    // back through admissionRetry: a moved archive boundary, a changed external
    // witness, a lost trusted-fingerprint comparison. A projection divergence
    // was the one thrown straight at the caller, which is why
    // AUDIT_PROJECTION_DIVERGED refused agent spawns and restarts on this
    // machine while nothing was actually wrong -- the reader had looked at a
    // file another process was in the middle of writing.
    //
    // PROJECTION_DIVERGENCE_MEMOIZABLE is the argued set of reasons that CANNOT
    // stop being true for the same file, cursor, boundary and event count --
    // which is exactly why remembering them is sound. Its complement is the one
    // that can (an overhang that is merely too long shrinks as the window
    // grows). So this is not a new judgement about what is safe to retry; it is
    // the memo set's existing judgement, read the other way round, and it stays
    // correct by construction if that set ever changes.
    //
    // NOTHING HERE WIDENS WHAT COUNTS AS NON-DIVERGENT. No admission proceeds
    // on a projection that is still diverged: each retry re-runs this entire
    // fail-closed check from the top, the count is bounded, and when the bound
    // runs out the ORIGINAL divergence is what surfaces. A reason that is
    // missing or unrecognised is treated as fatal, not as retryable.
    const divergenceReason = projectionError.details && projectionError.details.reason;
    if (projectionError.code === 'AUDIT_PROJECTION_DIVERGED'
      && typeof divergenceReason === 'string'
      && !PROJECTION_DIVERGENCE_MEMOIZABLE.has(divergenceReason)) {
      // Latched for the rest of this admission, never cleared: see the
      // cache-hit comment above for why a retry must look again.
      context.projectionRecheckRequired = true;
      throw admissionRetry('projection-diverged-transient', projectionError);
    }
    throw projectionError;
  }
  return { snapshot, external: confirmedExternal };
}

// BEGIN IMMEDIATE is held only for the exact-witness check, anchor
// reconciliation, final external witness reads, and append. The full chain
// walk above has already completed. SQLite now prevents any other ledger
// writer from changing that witnessed state until this transaction commits.
function appendVerifiedUnderLock(context, input, dependencies, preverified) {
  const admission = appendVerifiedUnderLockMany(context, [input], dependencies, preverified);
  return { ...admission, appended: admission.appendedList[0] };
}

// ONE LOCK, ONE VERIFICATION, ONE PROJECTION PASS, ONE ANCHOR -- FOR N EVENTS.
//
// The single-event path above is this function called with one input. Every
// admission check is identical: the same witness reads, the same exact
// trusted-fingerprint comparison, the same reconciliation. What changes is
// that the fixed cost of an admission (measured ~70-120 ms held lock on a
// real ledger, dominated by anchor reads, verification and the projection
// file handling) is paid once for the whole batch instead of once per event.
//
// Every event still gets its own sequence, its own hash chained to the one
// before it, and its own signature. The anchor, when one is written, names
// the LAST event of the batch, which by construction covers every earlier
// one -- exactly the reasoning the single path already uses when it lets an
// external mutation's own anchor supersede the reconciliation advance.
//
// Retention sees the batch as a whole: the plan counts every input, and the
// post-append rewrite of the projection files carries every event this batch
// appended, not only the last one. Passing only the last event there would
// have dropped its siblings from the fast views and the next admission's
// validateProjectionState() would have refused the ledger as diverged.
function appendVerifiedUnderLockMany(context, inputs, dependencies, preverified) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw auditFailure('AUDIT_INVALID_ARGUMENT', 'An admission batch must carry at least one event.', { field: 'inputs' });
  }
  const ownerId = dependencies.recordOwnerId
    || `record-${process.pid}-${crypto.randomUUID()}`;
  return context.store.withProjectionLock({
    ownerId, nowMs: (dependencies.clock || Date.now)()
  }, lockedStore => {
    const lockedAnchor = readAnchor(dependencies, { fresh: true });
    const lockedExternal = verificationExternal(context.files, dependencies, lockedAnchor);
    if (context.files && !verificationExternalEqual(preverified.external, lockedExternal)) {
      throw admissionRetry('writer-lock-external');
    }
    if (typeof lockedStore.trustedVerificationMatches !== 'function'
        || !lockedStore.trustedVerificationMatches({
          prior: preverified.snapshot,
          external: lockedExternal,
          boundary: context.boundary
        })) {
      throw admissionRetry('writer-lock-ledger');
    }

    let reconciliation;
    try {
      /* ONE ANCHOR WRITE PER EXTERNAL RECORD, WHICH IS WHAT THE BUDGET PINS.
       *
       * MEASURED 2026-09-02 by profiling the Electron main process through a
       * real agent start: two of the four PowerShell stacks in that fifteen
       * seconds were anchor writes for the SAME admission -- this advance,
       * and then the append's own anchor microseconds later. Each vault write
       * is a cold powershell.exe running DPAPI, about a second under load.
       *
       * The advance is only worth its cost when nothing else is about to
       * anchor. An external mutation always anchors its own event (anchorRequired
       * forces the checkpoint below), and that anchor names a HIGHER sequence
       * than this one would have, so it covers everything this advance would
       * have covered. Reconciliation still runs -- it validates the anchor
       * against the ledger, which is what refuses a rollback -- it just does
       * not pay to store an anchor that is superseded before it is read. A
       * failed append leaves the anchor exactly where it was, which is the
       * state it was already in. */
      const appendWillAnchor = dependencies.anchorRequired === true;
      reconciliation = reconcileAnchor(lockedStore, context.signer, {
        ...dependencies, verificationFiles: context.files
      }, preverified.snapshot, {
        advance: context.shouldAdvanceAnchor === true && !appendWillAnchor,
        fresh: true,
        boundary: context.boundary
      });
    } catch (error) {
      if (typeof lockedStore.invalidateVerificationCache === 'function') lockedStore.invalidateVerificationCache();
      throw error;
    }
    // Reconciliation may legitimately advance the protected anchor when an
    // emergency item was ingested or an unanchored suffix was checkpointed.
    // Capture that expected post-reconciliation witness before the final
    // re-read; a later anchor replacement must still fail closed.
    const reconciledAnchor = readAnchor(dependencies, { fresh: true });
    const reconciledExternal = verificationExternal(context.files, dependencies, reconciledAnchor);
    if (context.files && lockedExternal && reconciledExternal
        && (lockedExternal.projectionDigest !== reconciledExternal.projectionDigest
          || lockedExternal.emergencyDigest !== reconciledExternal.emergencyDigest)) {
      if (typeof lockedStore.invalidateVerificationCache === 'function') lockedStore.invalidateVerificationCache();
      throw auditFailure('AUDIT_WITNESS_CHANGED', 'The audit anchor, projection, or emergency witness changed during admission verification.', { phase: 'verification' });
    }
    const witnessAnchor = readAnchor(dependencies, { fresh: true });
    const witnessExternal = verificationExternal(context.files, dependencies, witnessAnchor);
    if (context.files && reconciledExternal && witnessExternal
        && !verificationExternalEqual(reconciledExternal, witnessExternal)) {
      if (typeof lockedStore.invalidateVerificationCache === 'function') lockedStore.invalidateVerificationCache();
      throw auditFailure('AUDIT_WITNESS_CHANGED', 'The audit anchor, projection, or emergency witness changed during admission verification.', { phase: 'verification' });
    }
    // Re-read the external witness immediately before the append.  The
    // preceding digest can finish just before an uncooperative projection
    // writer replaces a file; this last read closes that narrow synchronous
    // gap before the durable event is admitted.
    const appendAnchor = readAnchor(dependencies, { fresh: true });
    const appendExternal = verificationExternal(context.files, dependencies, appendAnchor);
    if (context.files && witnessExternal && appendExternal
        && !verificationExternalEqual(witnessExternal, appendExternal)) {
      if (typeof lockedStore.invalidateVerificationCache === 'function') lockedStore.invalidateVerificationCache();
      throw auditFailure('AUDIT_WITNESS_CHANGED', 'The audit anchor, projection, or emergency witness changed before admission append.', { phase: 'append' });
    }
    const pendingBeforeAppend = lockedStore.status().headSequence - reconciliation.sequence;
    const forceAnchor = dependencies.anchorRequired === true;
    const priorEvents = preverified.snapshot.events;
    const lastInput = inputs[inputs.length - 1];
    // The plan must count every event this batch admits, so the earlier
    // inputs stand in for the rows they are about to become: retentionDecision
    // reads only eventId and occurredAtMs from them, which an input carries.
    const priorForRetention = inputs.length === 1 ? priorEvents : [...priorEvents, ...inputs.slice(0, -1)];
    const retention = retentionDecision(context.retention, priorForRetention, lastInput);
    // A roll must never archive the protected head. Pin this append first so
    // even a one-event time window leaves the vault anchor on the live row.
    const checkpoint = forceAnchor || pendingBeforeAppend + inputs.length >= 31 || retention.shouldRoll || reconciliation.forked === true;
    const appendedList = inputs.map((input, index) => appendDurably(lockedStore, context.signer, input, dependencies, {
      anchor: checkpoint && index === inputs.length - 1
    }));
    const appended = appendedList[appendedList.length - 1];
    if (reconciliation.forked && appended.anchor) consumeAnchorIntent(reconciliation.forkIntentFile, dependencies);
    // PROJECT UNDER THE LEASE WE ALREADY HOLD, NOT UNDER A SECOND ONE.
    //
    // record() used to follow this transaction with a separate
    // flushInternal(), which is another BEGIN IMMEDIATE against the same
    // single-writer ledger, taken microseconds after this one committed and
    // for work that is entirely about the event this transaction just
    // appended.  Measured on an 8000-event ledger (5.0 MB jsonl + 1.6 MB
    // text): 2 exclusive lock acquisitions per record, 113 ms held by this
    // one and 7.6 ms by the flush.  Merging them is the "one lock
    // acquisition amortized over the work" change: one BEGIN IMMEDIATE, one
    // COMMIT (so one fsync under synchronous=FULL rather than two), and one
    // lease cycle instead of two.
    //
    // It also halves how often every OTHER process's admission witness is
    // invalidated.  A competitor's verifyAdmissionOutsideLock() is a
    // compare-and-swap over the whole ledger plus the projection files; the
    // append and the projection lines used to be two separately-observable
    // changes to that witness, and are now one.
    //
    // NO DURABILITY WINDOW IS CREATED. The caller is still told "durable"
    // only after this transaction commits, and the projection lines are on
    // disk before record() returns, exactly as before -- status.projected,
    // status.sinks and status.pending keep their existing meanings. What
    // changed is which lock the projection runs under, not when the caller
    // learns the answer.
    //
    // The pre-commit exposure is unchanged, not new: flushInternal already
    // appended projection bytes and advanced the sink cursor inside a
    // transaction that could still fail to COMMIT, so "file line written,
    // cursor not advanced" was always possible and is always repaired by the
    // next flush's parsedProjection/projectionMatches rebuild.
    const projection = projectSinks(lockedStore, context.files, dependencies, {
      now: (dependencies.clock || Date.now)(),
      boundary: context.boundary
    });
    const enforced = enforceRetentionAfterAppend({
      store: lockedStore, signer: context.signer, files: context.files, dependencies,
      policy: context.retention, boundary: context.boundary,
      // The live window after this batch is prior + every event appended
      // here; the rewrite of the fast views must carry all of them.
      priorEvents: appendedList.length === 1 ? priorEvents : [...priorEvents, ...appendedList.slice(0, -1).map(item => item.event)],
      input: lastInput, appended, projection, decision: retention
    });
    const retentionRoll = enforced.roll;
    context.boundary = enforced.boundary;
    return { snapshot: preverified.snapshot, reconciliation, appendedList, projection, retentionRoll };
  });
}

function lockedAdmissionAppend(context, input, dependencies) {
  const admission = lockedAdmissionAppendMany(context, [input], dependencies);
  return { ...admission, appended: admission.appendedList[0] };
}

function lockedAdmissionAppendMany(context, inputs, dependencies) {
  const configured = dependencies.auditAdmissionRetryLimit;
  const retryLimit = configured === undefined
    ? DEFAULT_ADMISSION_RETRY_LIMIT
    : Number.isSafeInteger(configured) && configured >= 0 && configured <= 100
      ? configured
      : DEFAULT_ADMISSION_RETRY_LIMIT;
  const configuredProjection = dependencies.auditProjectionDivergenceRetryLimit;
  const projectionRetryLimit = configuredProjection === undefined
    ? DEFAULT_PROJECTION_DIVERGENCE_RETRY_LIMIT
    : Number.isSafeInteger(configuredProjection) && configuredProjection >= 0 && configuredProjection <= 100
      ? configuredProjection
      : DEFAULT_PROJECTION_DIVERGENCE_RETRY_LIMIT;
  let retries = 0;
  let projectionRetries = 0;
  while (true) {
    try {
      const preverified = verifyAdmissionOutsideLock(context, dependencies);
      const admission = appendVerifiedUnderLockMany(context, inputs, dependencies, preverified);
      const last = admission.appendedList[admission.appendedList.length - 1];
      if (last && last.anchor) clearAnchorIntent(dependencies);
      return admission;
    } catch (error) {
      if (!error || error.code !== 'AUDIT_ADMISSION_RETRY') throw error;
      const divergence = error.projectionDivergence || null;
      if (divergence) {
        // Out of looks: surface the divergence ITSELF. Reporting
        // AUDIT_ADMISSION_CONTENTION here would trade a refusal that names
        // which projection check failed for one that names nothing, on the
        // exact path an operator reads when a ledger will not admit. Both
        // bounds apply, so retrying a projection can never outlast the overall
        // admission budget either.
        if (projectionRetries >= projectionRetryLimit || retries >= retryLimit) throw divergence;
        projectionRetries += 1;
        retries += 1;
        continue;
      }
      if (retries >= retryLimit) {
        throw auditFailure('AUDIT_ADMISSION_CONTENTION',
          'The audit ledger kept changing before a verified append could acquire the writer lock.',
          { retries, phase: error.details && error.details.phase || null });
      }
      retries += 1;
    }
  }
}

function record(action, target, details = {}, dependencies = {}) {
  const status = baseStatus();
  let context;
  let input;
  try {
    context = prepare({ ...dependencies, deferReconciliation: true });
    if (context.disabled) {
      status.disabled = true;
      status.ok = true;
      return status;
    }
    input = eventInput(action, target, details, dependencies);
    // PAY THE VAULT BEFORE TAKING THE LOCK, NOT WHILE HOLDING IT.
    //
    // lockedAdmissionAppend() below performs five fresh anchor reads inside
    // the ledger's single-writer BEGIN IMMEDIATE transaction. Warming the
    // anchor here means the first real vault read of this record -- the only
    // one that can be needed when nothing else has written the vault -- is
    // paid outside the lock, and the five in-lock reads resolve against the
    // vault file's content digest instead of spawning powershell.exe.
    //
    // This changes cost, not admission: it does NOT decide anything. If the
    // vault genuinely changed between here and any in-lock read, that read
    // still goes to the vault for real and the witness comparisons still fail
    // closed. A failure here is deliberately swallowed for the same reason --
    // the in-lock read is the authoritative one and re-raises it with its own
    // classification intact.
    //
    // Only for the real installation vault. A caller that supplied its own
    // secret plane has nothing here to warm -- the vault-content digest
    // describes the vault file and nothing else -- and its anchor store is a
    // test double whose exact call sequence is part of what its suite asserts
    // (tests/fra-audit-admission-cache.js drives a deterministic
    // anchor-change race by read ordinal). A free read is never free there.
    if (!dependencies.anchorStore && !dependencies.getSecret && !dependencies.setMonotonicSecret) {
      try { readAnchor(dependencies, { fresh: true }); }
      catch { /* advisory warm-up only; the in-lock read is authoritative */ }
    }
    const admission = lockedAdmissionAppend(context, input, dependencies);
    context.verification = admission.snapshot;
    context.anchor = admission.reconciliation;
    const appended = admission.appended;
    status.durable = true;
    status.anchored = Boolean(appended.anchor && appended.anchor.anchor.sequence >= appended.event.sequence);
    status.protectedSequence = appended.anchor ? appended.anchor.anchor.sequence : context.anchor.sequence;
    status.eventId = appended.event.eventId;
    status.sequence = appended.event.sequence;
    status.eventHash = appended.event.eventHash;
    // The projection already ran under the append's own lease; taking a second
    // cross-process writer lock here to redo it is the serialization this
    // change exists to remove.
    const projection = admission.projection;
    status.projected = projection.projected;
    status.recorded = projection.projected;
    status.pending = projection.pending;
    status.errors.push(...projection.errors);
    status.sinks = Object.fromEntries(['jsonl', 'text'].map(sink => [sink,
      Boolean(projection.sinks[sink] && projection.sinks[sink].backlog === 0)]));
    status.partial = Number(status.sinks.jsonl) + Number(status.sinks.text) === 1;
    if (context.verification && status.projected && status.pending === 0
        && !(admission.retentionRoll && admission.retentionRoll.rolled)
        && typeof context.store.advanceVerificationCache === 'function') {
      try {
        const nextAnchor = readAnchor(dependencies, { fresh: true });
        context.store.advanceVerificationCache({
          prior: context.verification, event: appended.event,
          external: verificationExternal(context.files, dependencies, nextAnchor),
          boundary: context.boundary
        });
      } catch { /* cache maintenance is fail-closed and never replaces a durable audit result */ }
    }
    status.ok = status.durable;
    noteDurableSuccess(context.files, (dependencies.clock || Date.now)(), dependencies);
    return status;
  } catch (error) {
    const message = safeError(error);
    status.errors.push(errorEntry('canonical', error));
    if (maintenance.isRefusal(error)) return status;
    report(dependencies, `ToolsEnabled canonical audit failed: ${message}`);
    let files = null;
    let spooled = false;
    try {
      if (!input) input = eventInput(action, target, details, dependencies);
      const policy = context ? context.policy : (dependencies.loadPolicy || loadPolicy)();
      files = context ? context.files : resolveFiles(policy, dependencies.rootPath || rootPath, dependencies.env || process.env);
      spoolEmergency(files, input, dependencies, context ? context.signer : undefined);
      status.pending = 1;
      spooled = true;
    } catch (spoolError) {
      const spoolMessage = safeError(spoolError);
      status.errors.push(errorEntry('emergency', spoolError));
      report(dependencies, `ToolsEnabled emergency audit spool failed: ${spoolMessage}`);
    }
    // Remember the breach so it outlives the spool.  This deliberately does not
    // change what record() returns or whether it throws: spool-and-continue is
    // the fail-safe, and the only thing that was missing was a durable trace
    // that something can observe once the spool has already been drained.
    if (files) {
      noteDurabilityBreach(files, {
        atMs: (dependencies.clock || Date.now)(),
        action: typeof action === 'string' ? action : null,
        code: safeCode(error),
        // anchorRequired is set by exactly one caller -- requireRecord() -- so
        // it is the precise, mechanical marker for "this failure refused an
        // external write" rather than "this failure spooled a diagnostic".
        required: dependencies.anchorRequired === true,
        message, spooled,
        // The one place a projection divergence's classified reason can still
        // be read after this throw is unwound. Only attached for that one
        // code; every other breach keeps carrying no detail at all.
        detail: safeCode(error) === 'AUDIT_PROJECTION_DIVERGED' ? safeDetails(error && error.details) : null
      }, dependencies);
    }
    return status;
  }
}

// GROUP COMMIT: N RECORDS, ONE ADMISSION.
//
// The per-record path above serializes the whole product on one cross-process
// writer lock and pays the admission's fixed cost for every event. That was
// measured as the reason a tool call cost 70-120 ms of held lock and the
// desktop app read as "laggy" under a handful of agents: every tool call from
// every agent lands here, and the owner host runs inside the desktop app's
// main process. src/lib/audit-admission.js coalesces concurrent records into
// batches and hands them here, so a burst of tool calls costs one lock, one
// verification, one projection pass and at most one anchor write.
//
// NOTHING IS TRADED FOR IT. Each item gets its own signed, hash-chained event
// with its own sequence; each caller learns `durable` only after the one
// transaction that carries its event has committed; an item that asked for
// the anchor (anchorRequired, the requireRecord() marker for an external
// mutation) is anchored because the batch's anchor names a sequence at or
// beyond its own. A batch that cannot be admitted spools every item to the
// emergency store and records one durability breach per item, with the
// `required` flag carried per item, exactly as record() does for one.
//
// items: [{ action, target, details, anchorRequired }]. Returns one status per
// item, in order, of the same shape record() returns.
function recordBatch(items, dependencies = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (items.length === 1) {
    const only = items[0];
    return [record(only.action, only.target, only.details || {}, only.anchorRequired
      ? { ...dependencies, anchorRequired: true } : dependencies)];
  }
  const anchorRequired = items.some(item => item && item.anchorRequired === true);
  const batchDependencies = anchorRequired ? { ...dependencies, anchorRequired: true } : dependencies;
  const statuses = items.map(() => baseStatus());
  let context;
  let inputs = null;
  try {
    context = prepare({ ...batchDependencies, deferReconciliation: true });
    if (context.disabled) {
      for (const status of statuses) { status.disabled = true; status.ok = true; }
      return statuses;
    }
    // An item may carry its own event id and time: coordinator audit events
    // derive their id from their content (coordinator-audit-events.js eventId)
    // and stamp the moment the decision was taken, and those must survive the
    // trip through the queue exactly as record() honours eventIdFactory/clock.
    inputs = items.map(item => eventInput(item.action, item.target, item.details || {}, {
      ...batchDependencies,
      ...(typeof item.eventId === 'string' && item.eventId ? { eventIdFactory: () => item.eventId } : {}),
      ...(Number.isSafeInteger(item.occurredAtMs) && item.occurredAtMs >= 0 ? { clock: () => item.occurredAtMs } : {})
    }));
    // Same advisory warm-up as record(): pay the vault before the lock.
    if (!batchDependencies.anchorStore && !batchDependencies.getSecret && !batchDependencies.setMonotonicSecret) {
      try { readAnchor(batchDependencies, { fresh: true }); }
      catch { /* advisory warm-up only; the in-lock read is authoritative */ }
    }
    const admission = lockedAdmissionAppendMany(context, inputs, batchDependencies);
    context.verification = admission.snapshot;
    context.anchor = admission.reconciliation;
    const appendedList = admission.appendedList;
    const last = appendedList[appendedList.length - 1];
    const anchorSequence = last.anchor ? last.anchor.anchor.sequence : context.anchor.sequence;
    const projection = admission.projection;
    const sinks = Object.fromEntries(['jsonl', 'text'].map(sink => [sink,
      Boolean(projection.sinks[sink] && projection.sinks[sink].backlog === 0)]));
    appendedList.forEach((appended, index) => {
      const status = statuses[index];
      status.durable = true;
      status.anchored = Boolean(last.anchor && last.anchor.anchor.sequence >= appended.event.sequence);
      status.protectedSequence = anchorSequence;
      status.eventId = appended.event.eventId;
      status.sequence = appended.event.sequence;
      status.eventHash = appended.event.eventHash;
      status.projected = projection.projected;
      status.recorded = projection.projected;
      status.pending = projection.pending;
      status.errors.push(...projection.errors);
      status.sinks = { ...sinks };
      status.partial = Number(sinks.jsonl) + Number(sinks.text) === 1;
      status.ok = status.durable;
    });
    if (context.verification && projection.projected && projection.pending === 0
        && !(admission.retentionRoll && admission.retentionRoll.rolled)
        && typeof context.store.advanceVerificationCache === 'function') {
      try {
        const nextAnchor = readAnchor(batchDependencies, { fresh: true });
        context.store.advanceVerificationCache({
          prior: context.verification, events: appendedList.map(item => item.event),
          external: verificationExternal(context.files, batchDependencies, nextAnchor),
          boundary: context.boundary
        });
      } catch { /* cache maintenance is fail-closed and never replaces a durable audit result */ }
    }
    noteDurableSuccess(context.files, (batchDependencies.clock || Date.now)(), batchDependencies);
    return statuses;
  } catch (error) {
    const message = safeError(error);
    if (maintenance.isRefusal(error)) {
      statuses.forEach(status => status.errors.push(errorEntry('canonical', error)));
      return statuses;
    }
    report(batchDependencies, `ToolsEnabled canonical audit failed for a batch of ${items.length}: ${message}`);
    let files = null;
    try {
      const policy = context ? context.policy : (batchDependencies.loadPolicy || loadPolicy)();
      files = context ? context.files : resolveFiles(policy, batchDependencies.rootPath || rootPath, batchDependencies.env || process.env);
    } catch (resolveError) {
      report(batchDependencies, `ToolsEnabled emergency audit spool could not resolve its files: ${safeError(resolveError)}`);
    }
    items.forEach((item, index) => {
      const status = statuses[index];
      status.errors.push(errorEntry('canonical', error));
      let spooled = false;
      try {
        const input = inputs ? inputs[index] : eventInput(item.action, item.target, item.details || {}, batchDependencies);
        if (!files) throw new Error('The emergency spool location could not be resolved.');
        spoolEmergency(files, input, batchDependencies, context ? context.signer : undefined);
        status.pending = 1;
        spooled = true;
      } catch (spoolError) {
        status.errors.push(errorEntry('emergency', spoolError));
        report(batchDependencies, `ToolsEnabled emergency audit spool failed: ${safeError(spoolError)}`);
      }
      if (files) {
        noteDurabilityBreach(files, {
          atMs: (batchDependencies.clock || Date.now)(),
          action: typeof item.action === 'string' ? item.action : null,
          code: safeCode(error),
          required: item.anchorRequired === true,
          message, spooled,
          detail: safeCode(error) === 'AUDIT_PROJECTION_DIVERGED' ? safeDetails(error && error.details) : null
        }, batchDependencies);
      }
    });
    return statuses;
  }
}

// The refusal a caller actually sees is AUDIT_UNAVAILABLE by contract, so
// the specific classification has to ride alongside it rather than replace
// it: `details.reason` is the machine code of the failure that caused the
// refusal, `details.cause` is that failure's redacted cause chain, and
// `details.errors` keeps the full per-sink list.  Without this, every
// distinct failure -- poisoned anchor, diverged projection, locked file,
// full disk -- arrives at the operator as the same sentence.
function primaryFailure(status) {
  const errors = Array.isArray(status.errors) ? status.errors : [];
  return errors.find(entry => entry && entry.sink === 'canonical')
    || errors.find(entry => entry && entry.code)
    || errors[0] || null;
}

function classifiedDetails(error) {
  const entry = errorEntry('canonical', error);
  const details = { message: entry.message };
  if (entry.code) details.reason = entry.code;
  if (entry.details) details.reasonDetails = entry.details;
  if (entry.cause) details.cause = entry.cause;
  return details;
}

function unavailableDetails(status) {
  const primary = primaryFailure(status);
  const details = { errors: status.errors };
  if (primary) {
    if (primary.code) details.reason = primary.code;
    if (primary.details) details.reasonDetails = primary.details;
    if (primary.cause && primary.cause.length) details.cause = primary.cause;
  }
  return details;
}

// THE SENTENCE HAS TO CARRY THE CLASSIFICATION AND THE ACTION.
//
// unavailableDetails() above puts `reason` on the thrown error, and the
// comment over primaryFailure() claims that stops "every distinct failure --
// poisoned anchor, diverged projection, locked file, full disk" arriving "at
// the operator as the same sentence".  It does not: nothing on the caller
// path reads `details.reason`.  Measured on this installation 2026-09-03, all
// 55 AUDIT_UNAVAILABLE refusals in capability/logs/actions.jsonl recorded
// exactly one string -- "Durable audit intent could not be recorded; the
// external mutation was not started." -- with no reason field anywhere in the
// record, because the tool failure path stores only `error.message`.
//
// So the classification is composed INTO the message, and the message names
// what to do next.  The action is not a guess: audit.status is the registered
// tool that reports "canonical audit head, signing keys, projection backlog,
// and emergency-spool health", which is precisely the per-sink verdict the
// caller needs to know which sink to repair.  `details.reason` still rides
// along unchanged for the machine readers that assert on it.
function unavailableRefusal(what, status) {
  const details = unavailableDetails(status);
  const reason = typeof details.reason === 'string' && details.reason ? details.reason : null;
  const cause = reason ? `${what} (${reason})` : `${what}, and the sink that failed did not report a code`;
  return new AuditRequiredError(
    'AUDIT_UNAVAILABLE',
    `${cause}, so the operation requiring this record cannot proceed. Run the audit.status tool to see which sink is failing and repair that sink, then retry; operations requiring durable audit records stay refused until recording returns.`,
    details
  );
}

function requireRecord(action, target, details = {}, dependencies = {}) {
  const status = record(action, target, details, { ...dependencies, anchorRequired: true });
  return requireDurableStatus(status);
}

// The judgement requireRecord() passes on a status, separated so a record
// admitted through the group-commit queue (src/lib/audit-admission.js) is
// held to exactly the same three refusals as one admitted in-line.
function requireDurableStatus(status) {
  // A disabled ledger is a setting, not a fault, so its sentence names the
  // setting rather than sending the caller to audit.status.
  if (status.disabled) throw new AuditRequiredError('AUDIT_DISABLED', 'Durable audit is disabled, so the operation requiring this record cannot proceed. Set "audit": {"enabled": true} in config/toolsenabled.policy.json to allow operations requiring durable audit records again.');
  if (!status.durable) throw unavailableRefusal('Durable audit intent could not be recorded', status);
  if (!status.anchored) throw unavailableRefusal('The durable audit intent could not be protected by the monotonic head anchor', status);
  return status;
}

// Internal-only conditional append for small broker state machines whose
// correctness depends on a lookup and a single audit append being indivisible.
// It is not registered as a tool: the synchronous decide callback is supplied
// by trusted local code, receives only an exact selector for the same locked
// ledger, and may request at most one already-shaped audit event.
//
// The caller's precondition is re-verified *inside* the BEGIN IMMEDIATE lock,
// after prepare() has already verified/reconciled the canonical ledger.  This
// prevents a second writer from slipping a conflicting record between a
// replay check and an append.  Projection flushing intentionally happens once
// the database lock is released, exactly as ordinary audit.record() does.
function conditionalRecord({ action, target, eventId, decide } = {}, dependencies = {}) {
  if (typeof action !== 'string' || !action || action.length > 160 ||
      typeof target !== 'string' || !target || target.length > 240 ||
      typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId) ||
      typeof decide !== 'function') {
    throw new AuditRequiredError('AUDIT_INVALID_ARGUMENT', 'The conditional audit record request is invalid.');
  }

  let context;
  try {
    // Preserve the normal audit reader/writer precondition: canonical chain,
    // signatures, and the protected head must all verify before a state
    // machine can make a conditional decision.
    context = prepare({ ...dependencies, anchorFresh: true });
  } catch (error) {
    throw new AuditRequiredError('AUDIT_UNAVAILABLE', 'The canonical audit ledger could not be prepared for a conditional record.',
      classifiedDetails(error));
  }
  if (context.disabled) throw new AuditRequiredError('AUDIT_DISABLED', 'Durable audit is disabled; the conditional record was not started.');

  const now = (dependencies.clock || Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new AuditRequiredError('AUDIT_INVALID_ARGUMENT', 'The conditional audit clock is invalid.');
  }
  const ownerId = dependencies.conditionalOwnerId || `conditional-${process.pid}-${crypto.randomUUID()}`;
  let decision;
  let appended;
  let projection;
  let conditionalPrior;

  try {
    context.store.withProjectionLock({ ownerId, nowMs: now }, lockedStore => {
      // A writer may have advanced the ledger after prepare() and before this
      // lock was acquired. Verify and reconcile that exact locked snapshot
      // before handing any records to the decision callback.
      const lockedAnchor = readAnchor(dependencies, { fresh: true });
      const lockedExternal = verificationExternal(context.files, dependencies, lockedAnchor);
      const snapshot = lockedStore.verifyWithEvents({ external: lockedExternal, boundary: context.boundary });
      const reconciliation = reconcileAnchor(lockedStore, context.signer,
        { ...dependencies, verificationFiles: context.files }, snapshot, {
          advance: true, fresh: true, boundary: context.boundary
        });
      conditionalPrior = reconciliation.verificationSnapshot;
      const findExact = selector => {
        if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
          throw new AuditRequiredError('AUDIT_INVALID_ARGUMENT', 'The conditional audit selector is invalid.');
        }
        const { action: selectorAction, target: selectorTarget, limit = 100 } = selector;
        if (typeof selectorAction !== 'string' || !selectorAction || selectorAction.length > 160 ||
            typeof selectorTarget !== 'string' || !selectorTarget || selectorTarget.length > 240 ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          throw new AuditRequiredError('AUDIT_INVALID_ARGUMENT', 'The conditional audit selector is invalid.');
        }
        return lockedStore.findEvents({ action: selectorAction, target: selectorTarget, limit });
      };
      decision = decide(Object.freeze({ findEvents: findExact, nowMs: now }));
      if (!decision || typeof decision !== 'object' || Array.isArray(decision) ||
          !['record', 'refused'].includes(decision.kind)) {
        throw new AuditRequiredError('AUDIT_INVALID_ARGUMENT', 'The conditional audit decision is invalid.');
      }
      if (decision.kind === 'refused') return;
      if (!Object.prototype.hasOwnProperty.call(decision, 'details')) {
        throw new AuditRequiredError('AUDIT_INVALID_ARGUMENT', 'The conditional audit record is missing details.');
      }
      const input = eventInput(action, target, decision.details, {
        ...dependencies,
        clock: () => now,
        eventIdFactory: () => eventId
      });
      appended = appendDurably(lockedStore, context.signer, input, dependencies, { anchor: true });
      if (reconciliation.forked && appended.anchor) consumeAnchorIntent(reconciliation.forkIntentFile, dependencies);
      const anchored = Boolean(appended.anchor && appended.anchor.anchor.sequence >= appended.event.sequence);
      if (!anchored) throw new AuditRequiredError('AUDIT_UNAVAILABLE', 'The conditional audit record could not be protected by the monotonic head anchor.');
      projection = projectSinks(lockedStore, context.files, dependencies, {
        now,
        boundary: context.boundary
      });
      const enforced = enforceRetentionAfterAppend({
        store: lockedStore, signer: context.signer, files: context.files, dependencies,
        policy: context.retention, boundary: context.boundary,
        priorEvents: snapshot.events, input, appended, projection
      });
      context.boundary = enforced.boundary;
      appended.retentionRoll = enforced.roll;
    });
  } catch (error) {
    if (error instanceof AuditRequiredError) throw error;
    throw new AuditRequiredError('AUDIT_UNAVAILABLE', 'The conditional audit record could not be committed.',
      classifiedDetails(error));
  }
  if (appended && appended.anchor) clearAnchorIntent(dependencies);

  if (decision.kind === 'refused') {
    return Object.freeze({ recorded: false, refusal: decision.refusal || null });
  }

  if (conditionalPrior && appended && projection.projected && projection.pending === 0
      && !(appended.retentionRoll && appended.retentionRoll.rolled)
      && typeof context.store.advanceVerificationCache === 'function') {
    try {
      const nextAnchor = readAnchor(dependencies, { fresh: true });
      context.store.advanceVerificationCache({
        prior: conditionalPrior, event: appended.event,
        external: verificationExternal(context.files, dependencies, nextAnchor),
        boundary: context.boundary
      });
    } catch { /* cache maintenance is fail-closed and never replaces the durable result */ }
  }
  return Object.freeze({
    recorded: true,
    value: decision.value,
    durable: true,
    anchored: true,
    sequence: appended.event.sequence,
    eventHash: appended.event.eventHash,
    projected: Boolean(projection.projected),
    pending: projection.pending,
    sinks: projection.sinks,
    errors: projection.errors || []
  });
}

function flush(options = {}, dependencies = {}) {
  const context = prepare({ ...dependencies, anchorFresh: true, verificationCacheDisabled: true });
  if (context.disabled) return { disabled: true, projected: true, pending: 0, sinks: {}, errors: [] };
  return {
    disabled: false,
    ...flushInternal(context.store, context.files, dependencies, { ...options, boundary: context.boundary })
  };
}

// Startup-only warmup for a process that is about to advertise audit-backed
// readiness.  The warm result is created in this process, then the projections
// and emergency candidates are checked against it before the caller binds its
// listener.  A file change during the check fails closed and clears the cache.
function warm(dependencies = {}) {
  let context;
  try {
    context = prepare({ ...dependencies, anchorFresh: true });
    if (context.disabled) return { valid: true, disabled: true, entries: 0 };
    const anchor = readAnchor(dependencies, { fresh: true });
    const external = verificationExternal(context.files, dependencies, anchor);
    const checked = context.store.verifyWithEvents({ external, boundary: context.boundary });
    if (!checked.verification.valid) {
      throw new Error(`The canonical audit ledger is invalid (${checked.verification.reason}).`);
    }
    validateProjectionState(
      context.files, checked.events, checked.verification, dependencies, context.boundary
    );
    const after = verificationExternal(context.files, dependencies,
      readAnchor(dependencies, { fresh: true }));
    if (!verificationExternalEqual(external, after)) {
      throw new Error('The audit verification inputs changed during startup warmup.');
    }
    return checked.verification;
  } catch (error) {
    if (context && context.store && typeof context.store.invalidateVerificationCache === 'function') {
      context.store.invalidateVerificationCache();
    }
    throw error;
  }
}

// TAMPER-EVIDENCE THAT SURVIVES THE LEDGER IT DESCRIBES.
//
// WHY THIS EXISTS AT ALL. src/lib/audit-checkpoint.js was built, tested, and
// invoked by nothing but its own test -- the repository's signature defect,
// sitting inside the one system whose job is proving what happened. It cost
// something real on 2026-08-10: a probe forked state/audit.sqlite3 into a
// scratch directory, that fork won the monotonic anchor comparison, and the
// production head anchor was advanced to an event that exists only in the
// copy. Answering "fork or truncation?" then depended entirely on the scratch
// copy still happening to be on disk. ONE signed checkpoint would have
// answered it in seconds, because a checkpoint names the head hash that this
// installation's own ledger had at a known time.
//
// WHY IT DELIBERATELY DOES NOT CALL prepare(). prepare() migrates, ingests the
// emergency spool, and -- above all -- reconciles the head anchor. Every one
// of those is a WRITE, and reconcileAnchor is exactly what throws
// AUDIT_ANCHOR_INTEGRITY_ALARM while the anchor is poisoned. A checkpointer
// routed through prepare() would therefore be unavailable precisely when the
// evidence it produces is most needed, which is the same shape as being
// unwired. So this path is read + sign + write-one-file, and nothing else.
//
// WHAT IS DELIBERATELY KEPT. assertLedgerVaultBinding still runs first and
// still runs BEFORE the signing key is read, so a redirected ledger can never
// borrow this installation's vault to mint a checkpoint about itself -- that
// is the guard the 2026-08-10 incident produced and this must not become the
// hole in it. createCheckpoint() then refuses an invalid chain on its own.
//
// WHAT IS NOT CLAIMED. The default outbox is local (state/audit-checkpoints).
// A local checkpoint is NOT off-host durability: an attacker with the disk has
// both. The mechanism reports that honestly as pendingDelivery:true rather
// than calling an undelivered checkpoint safe, and an off-host destination can
// be supplied by the caller once that path is unblocked.
function checkpoint(dependencies = {}) {
  const policy = (dependencies.loadPolicy || loadPolicy)();
  if (policy.audit && policy.audit.enabled === false) {
    return Promise.resolve({ ok: false, disabled: true, reason: 'audit-disabled' });
  }
  assertLedgerVaultBinding({ file: boundLedgerFile(dependencies) }, dependencies);
  const store = getStore(dependencies);
  const signer = keyMaterial(dependencies, store);
  return emitCheckpoint({ ...dependencies, store, signer });
}

function status(dependencies = {}) {
  const context = prepare({ ...dependencies, anchorFresh: true });
  if (context.disabled) return { ok: true, disabled: true };
  const durable = context.store.status();
  const pendingEmergency = emergencyFiles(context.files, dependencies.fs || fs)
    .reduce((count, file) => count + (dependencies.fs || fs).readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length, 0);
  const quarantinedEmergencyFiles = quarantineFiles(context.files, dependencies.fs || fs).length;
  return {
    ...durable, disabled: false, pendingEmergency, quarantinedEmergencyFiles, anchor: context.anchor,
    durability: durabilitySummary(context.files, dependencies)
  };
}

function tail(limit = 20, dependencies = {}) {
  const context = prepare({ ...dependencies, anchorFresh: true });
  if (context.disabled) return [];
  const count = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const head = context.store.status().headSequence;
  return context.store.listEvents({ afterSequence: Math.max(0, head - count), limit: count }).map(flattenEvent);
}

function flattenEvent(event) {
  return {
    ...scrub(event.event), sequence: event.sequence, eventId: event.eventId, eventHash: event.eventHash, keyId: event.keyId
  };
}

// Internal-only view helper for browser-safe projections that need the
// immutable parent of a recent linked event.  It never accepts an arbitrary
// query: both actions are fixed by the caller, linked targets come only from
// the verified recent tail, and every exact parent lookup remains bounded.
//
// This lets a terminal receipt near the current head still be paired with its
// older launch record without expanding the normal 200-event metrics window
// into a whole-ledger history scan.  Parent rows are additive and capped at
// 20 * 2, so ordinary consumers can keep using the newest 200 rows unchanged.
function tailWithReferencedParents({
  limit = 200,
  childAction,
  parentAction,
  perTargetLimit = 2,
  maxTargets = 20
} = {}, dependencies = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      typeof childAction !== 'string' || !childAction || childAction.length > 160 ||
      typeof parentAction !== 'string' || !parentAction || parentAction.length > 160 ||
      !Number.isSafeInteger(perTargetLimit) || perTargetLimit < 1 || perTargetLimit > 2 ||
      !Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > 20) {
    throw new Error('audit linked-parent selector is invalid.');
  }
  const context = prepare({ ...dependencies, anchorFresh: true });
  if (context.disabled) return [];
  if (typeof context.store.findEvents !== 'function') throw new Error('audit linked-parent selector is unavailable.');
  const head = context.store.status().headSequence;
  const tailEvents = context.store.listEvents({ afterSequence: Math.max(0, head - limit), limit });
  const targets = [];
  const seenTargets = new Set();
  // Work from newest to oldest: the roster itself is bounded to the most
  // recent twenty launches, so parent coverage follows that same order.
  for (let index = tailEvents.length - 1; index >= 0 && targets.length < maxTargets; index -= 1) {
    const event = tailEvents[index]?.event;
    if (!event || event.action !== childAction || typeof event.target !== 'string' || !event.target || event.target.length > 240) continue;
    if (!seenTargets.has(event.target)) {
      seenTargets.add(event.target);
      targets.push(event.target);
    }
  }
  const combined = new Map(tailEvents.map(event => [event.sequence, event]));
  for (const target of targets) {
    for (const parent of context.store.findEvents({ action: parentAction, target, limit: perTargetLimit })) {
      combined.set(parent.sequence, parent);
    }
  }
  return [...combined.values()].sort((left, right) => left.sequence - right.sequence).map(flattenEvent);
}

// Internal-only exact audit lookup for broker components that need to bind a
// value-free materialized projection to an existing signed event. It is not
// registered as an MCP tool, deliberately exposes no broad search surface,
// and never grants authority to a returned event.
function getEvent({ sequence, eventHash } = {}, dependencies = {}) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || typeof eventHash !== 'string' || !/^[a-f0-9]{64}$/.test(eventHash)) {
    throw new Error('audit event selector is invalid.');
  }
  const context = prepare({ ...dependencies, anchorFresh: true });
  if (context.disabled) throw new Error('audit ledger is disabled.');
  const event = context.store.getEvent({ sequence });
  if (!event || event.eventHash !== eventHash) throw new Error('audit event selector does not match a canonical event.');
  return event;
}

// Internal broker helper.  It intentionally has no registry exposure: callers
// must still know the exact action and target they are looking for, and the
// returned signed records are for local attestation code rather than a general
// audit-data browsing surface.  prepare() still verifies the canonical chain
// and reconciles its protected head first; the store then uses its schema-owned
// exact-selector index, with the same <= 200 result bound.
function findEvents({ action, target, limit = 100 } = {}, dependencies = {}) {
  if (typeof action !== 'string' || !action || action.length > 160) throw new Error('audit event action selector is invalid.');
  if (typeof target !== 'string' || !target || target.length > 240) throw new Error('audit event target selector is invalid.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('audit event limit selector is invalid.');
  const context = prepare({ ...dependencies, anchorFresh: true });
  if (context.disabled) return [];
  if (typeof context.store.findEvents !== 'function') throw new Error('audit event selector is unavailable.');
  return context.store.findEvents({ action, target, limit });
}

function verifyEmptyInstall(store, dependencies, policy) {
  const files = resolveFiles(policy, dependencies.rootPath || rootPath, dependencies.env || process.env);
  const anchor = readAnchor(dependencies, { fresh: true });
  if (anchor) return { valid: false, entries: 0, reason: 'protected-anchor', anchor };

  const external = verificationExternal(files, dependencies, anchor);
  const snapshot = store.verifyWithEvents({ external, uncached: true });
  const chain = snapshot.verification;
  if (!chain.valid) return chain;

  const io = dependencies.fs || fs;
  for (const sink of ['jsonl', 'text']) {
    let rows;
    try { rows = parsedProjection(files[sink], sink, io); }
    catch (error) {
      return { ...chain, valid: false, reason: 'projection-malformed', sink, error: safeError(error) };
    }
    if (rows.length !== snapshot.events.length || !projectionMatches(rows, snapshot.events, sink)) {
      return { ...chain, valid: false, reason: 'projection-divergence', sink, projectedEntries: rows.length };
    }
  }

  const pendingEmergency = emergencyFiles(files, io)
    .reduce((count, file) => count + io.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length, 0);
  if (pendingEmergency > 0) return { ...chain, valid: false, pendingEmergency, reason: 'emergency-backlog' };

  const migration = store.getMetadata(LEGACY_METADATA_KEY);
  if (migration && (!migration.value || migration.value.status !== 'complete')) {
    return { ...chain, valid: false, reason: 'legacy-migration' };
  }
  return { valid: true, entries: 0, reason: 'fresh-install' };
}

function verify(dependencies = {}) {
  try {
    const policy = (dependencies.loadPolicy || loadPolicy)();
    if (policy.audit && policy.audit.enabled === false) return { valid: true, disabled: true, entries: 0 };
    const store = getStore(dependencies);
    if (!dependencies.signer && !defaultSigner && store.status().headSequence === 0) {
      const readSecret = dependencies.getSecret || getSecret;
      try {
        readSecret(SIGNING_VAULT_KEY);
      } catch (error) {
        if (error && error.code === 'SECRET_NOT_CONFIGURED') {
          return verifyEmptyInstall(store, dependencies, policy);
        }
      }
    }
    // VERIFY THE LEDGER ONCE, NOT TWICE.
    //
    // prepare() without deferReconciliation calls reconcileAnchor() with no
    // snapshot, which walks and signature-checks the whole ledger. This
    // function then takes the projection lock and immediately verifies again
    // with uncached:true, and hands THAT snapshot to reconcileAnchor() -- which
    // short-circuits on a supplied snapshot. So the prepare-time pass decided
    // nothing: its result is never read (context.anchor and context.verification
    // are both unused below), and the in-lock pass is the authoritative one
    // because only it is taken under the single-writer lock against a fresh
    // external witness.
    //
    // Measured on this machine 2026-08-17 against a 34,896-event ledger:
    // 69,794 Ed25519 verifications for 34,896 events -- exactly 2.00 per event,
    // 3,922 ms + 3,898 ms, out of a 9,884 ms audit.verify(). record() already
    // defers for the same reason (see its prepare() call).
    //
    // This changes cost, not conclusions. Anchor reconciliation still happens,
    // still advances, and still reads the vault fresh -- just once, under the
    // lock, against the snapshot that was actually verified there. An anchor
    // integrity alarm that would have been raised at prepare() time is raised
    // by that same call instead, which is strictly the better place for it.
    // A HEALTH READ MAY REUSE THE VERIFICATION THE WRITE PATH ALREADY TRUSTS.
    //
    // `cached: true` is opt-in and exists for the pollers -- system.status and
    // system.doctor call auditState() on a timer, and an unconditional full
    // signature walk there is a fixed tax on every poll that competes with the
    // tool calls the customer is actually waiting on. Measured on the owner's
    // install (10,019 live rows): 1.6 s per walk, against 2 ms for a cache hit
    // and ~55 ms for the incremental path.
    //
    // It weakens nothing. The cache is keyed on a fingerprint that covers the
    // ledger head, the key set, the archive boundary and the external witness,
    // so an unchanged answer is the same answer; and when anything HAS changed
    // the incremental path re-proves the whole prefix by hash and chain into
    // the vault-anchored head before it trusts the new rows. It is the same
    // verification record() itself admits on, so a health check that reported
    // differently would be the surprising one.
    //
    // The `audit.verify` TOOL deliberately does not pass this. Someone asking
    // the product to verify the ledger is asking for the full signature walk,
    // and that is what they get.
    const uncached = dependencies.cached !== true;
    const context = prepare({
      ...dependencies, anchorFresh: true, auditVerificationUncached: uncached, deferReconciliation: true
    });
    if (context.disabled) return { valid: true, disabled: true, entries: 0 };
    // PAY THE VAULT BEFORE TAKING THE LOCK -- the same debt record() pays, for
    // the same reason, and newly owed here because of the defer above.
    //
    // prepare() performs no anchor read before its deferReconciliation early
    // return, so without this the first fresh read of the process is the one at
    // the top of the lock body below. readAnchor's content-digest short circuit
    // only fires once defaultAnchorLoaded is set by a prior real read, so that
    // first read spawns a full powershell.exe -- measured 1,902 ms cold, ~618 ms
    // warm -- INSIDE the ledger's BEGIN IMMEDIATE. audit.js's lock-scope comment
    // above records what that costs in production: held-lock vault work is what
    // exhausted the 5,000 ms busy-retry budget and made every external-write
    // tool refuse with "Durable audit intent could not be recorded".
    //
    // Same shape as record()'s warm-up, including the guard: a caller that
    // supplied its own secret plane has nothing here to warm, and its anchor
    // store is a test double whose exact call sequence is asserted
    // (tests/fra-audit-admission-cache.js drives an anchor-change race by read
    // ordinal), so a free read is never free there.
    //
    // Advisory only. It decides nothing: the in-lock read is authoritative and
    // re-raises with its own classification intact -- which now survives the
    // transaction because those throws carry AUDIT_ANCHOR_MALFORMED /
    // AUDIT_ANCHOR_INVALID rather than being bare Errors.
    if (!dependencies.anchorStore && !dependencies.getSecret && !dependencies.setMonotonicSecret) {
      try { readAnchor(dependencies, { fresh: true }); }
      catch { /* advisory warm-up only; the in-lock read is authoritative */ }
    }
    const now = (dependencies.clock || Date.now)();
    const ownerId = dependencies.verificationOwnerId || `verification-${process.pid}-${crypto.randomUUID()}`;
    return context.store.withProjectionLock({ ownerId, nowMs: now }, lockedStore => {
      const lockedAnchor = readAnchor(dependencies, { fresh: true });
      const lockedExternal = verificationExternal(context.files, dependencies, lockedAnchor);
      const snapshot = lockedStore.verifyWithEvents({
        external: lockedExternal, uncached, boundary: context.boundary
      });
      const chain = snapshot.verification;
      if (!chain.valid) return chain;
      const anchor = reconcileAnchor(lockedStore, context.signer,
        { ...dependencies, verificationFiles: context.files }, snapshot, {
          advance: true, fresh: true, boundary: context.boundary
        });
      const events = snapshot.events;
      const io = dependencies.fs || fs;
      for (const sink of ['jsonl', 'text']) {
        let rows;
        try { rows = parsedProjection(context.files[sink], sink, io); }
        catch (error) { return { ...chain, valid: false, reason: 'projection-malformed', sink, error: safeError(error), anchor }; }
        if (rows.length !== events.length || !projectionMatches(rows, events, sink)) {
          return { ...chain, valid: false, reason: 'projection-divergence', sink, projectedEntries: rows.length, anchor };
        }
      }
      const pendingEmergency = emergencyFiles(context.files, io)
        .reduce((count, file) => count + io.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length, 0);
      const result = { ...chain, valid: pendingEmergency === 0, pendingEmergency, anchor,
        reason: pendingEmergency ? 'emergency-backlog' : undefined };
      // OPT-IN ONLY: THE BOUNDARY'S SIGNATURE IS NOT THE SAME CLAIM AS THE
      // ARCHIVE'S CONTENT.
      //
      // Everything above proves the live window and its own anchor. The
      // archive boundary that roots the live chain (context.boundary) is
      // itself a signed claim -- reconcileAnchor/readArchiveBoundary already
      // confirm ITS signature -- but that only proves the boundary was
      // minted by this installation's key, not that the bytes sitting in
      // audit-archive.jsonl between genesis and that boundary still match
      // what was actually signed. Nothing before this flag existed ever
      // checked that (W4/REPORT-archive-verify-exposure-20260907.md).
      //
      // Left off by default so every existing caller -- the system.status/
      // system.doctor poller above all, which calls this on a timer -- pays
      // nothing and sees no shape change: `result.archive` is only ever
      // present when the caller explicitly asked for it, and the field is
      // absent, not null or false, when they did not.
      if (dependencies.includeArchive === true) {
        const keyRows = lockedStore._open().prepare('SELECT * FROM audit_keys').all();
        const keys = keyRows.map(row => ({
          keyId: row.key_id, algorithm: row.algorithm,
          publicKeyPem: row.public_key_pem, publicKeyHash: row.public_key_hash
        }));
        const archive = verifyArchiveSegment(defaultArchiveFile(dependencies), keys, dependencies);
        // THE LINK NOTHING ELSE MAKES: the archive's own tail must be the
        // exact event the signed boundary claims it is. verifyArchiveSegment
        // alone cannot catch a wholesale-replaced-but-internally-consistent
        // archive (its own suite documents this: "an archive rewritten
        // wholesale to a shorter, internally-consistent prefix is still
        // refused via the boundary" -- refused BY THE CALLER comparing the
        // tail, which is exactly this comparison). No boundary yet minted
        // (context.boundary null, nothing ever archived) is consistent only
        // with an archive that is itself empty.
        const boundaryMatches = !archive.valid ? false
          : context.boundary
            ? archive.tailHash === context.boundary.eventHash && archive.tailSequence === context.boundary.archivedThroughSequence
            : archive.tailSequence === 0 && archive.tailHash === ZERO_HASH;
        result.archive = { ...archive, boundaryMatches };
        if (!archive.valid || !boundaryMatches) result.valid = false;
      }
      return result;
    });
  } catch (error) {
    return { valid: false, entries: 0, reason: 'audit-unavailable', error: safeError(error) };
  }
}

function resetForTests() {
  if (defaultStore) { try { defaultStore.close(); } catch { /* test reset */ } }
  defaultStore = null;
  defaultSigner = null;
  defaultInitialized = false;
  defaultAnchorLoaded = false;
  defaultAnchorCache = null;
  defaultAnchorVaultDigest = null;
  anchorReadCounters.real = 0;
  anchorReadCounters.cached = 0;
  anchorReadCounters.writes = 0;
  resetProjectionVerifyCache();
}

async function close() {
  if (defaultStore) defaultStore.close();
  resetForTests();
  await require('./vault-host-client').closeVaultHost();
  await require('./linux-vault-host-client').close();
}

function verifyReadOnlyProjections(events, files) {
  for (const sink of ['jsonl', 'text']) {
    const rows = parsedProjection(files[sink], sink, fs);
    if (rows.length !== events.length || !projectionMatches(rows, events, sink)) return false;
  }
  return emergencyFiles(files).every(file => fs.readFileSync(file, 'utf8').trim() === '');
}

// Counts only, never anchor or key material: how many protected-head reads
// went to the vault as a real powershell.exe process, how many were satisfied
// by the vault-content digest, and how many anchor writes were issued. This
// exists so a test can assert the lock-scope budget mechanically instead of
// inferring it from wall-clock timing, which is the kind of instrument that
// manufactures kills. See tests/audit-lock-scope.test.js.
function anchorVaultStats() {
  return { ...anchorReadCounters };
}

// COUNTS ONLY, SO THE COST OF VERIFYING IS OBSERVABLE IN PRODUCTION.
//
// anchorVaultStats() already answers "how many vault processes did this cost".
// This is the other half: how many times the ledger was walked in full, how
// many times a cached or incremental answer served instead, and what the last
// verification actually did. Without it, "the ledger is being re-verified on
// every call" can only be inferred from wall-clock latency or a CPU profile --
// which is how a full-walk regression went unnoticed long enough to make every
// tool call take ten seconds (see the boundary bug fixed in audit-store's
// advanceVerificationCache). A counter would have named it immediately.
//
// Never any event, hash, key or anchor material: integers and one enum string.
function verificationStats(dependencies = {}) {
  const store = getStore(dependencies);
  if (typeof store.verificationCacheStatus !== 'function') return null;
  const raw = store.verificationCacheStatus();
  if (!raw || typeof raw !== 'object') return null;
  // Explicitly projected, never spread: verificationCacheStatus() also carries
  // the cached head hash and the cached external witness digests, and a status
  // payload is the wrong place for either.
  return {
    fullVerifications: raw.fullVerifications, incrementalVerifications: raw.incrementalVerifications,
    cacheHits: raw.cacheHits, cacheMisses: raw.cacheMisses,
    cacheAdvances: raw.cacheAdvances, cacheRebinds: raw.cacheRebinds,
    cacheInvalidations: raw.cacheInvalidations,
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : null,
    cached: raw.cached === true
  };
}

module.exports = {
  operationAudit: require('./operation-audit'),
  close, HEAD_VAULT_KEY, signerFromPrivateKey, readAnchor, validateAnchor, resolveFiles, verifyReadOnlyProjections,
  verificationStats, unanchoredSuffix,
  ARCHIVE_BOUNDARY_DOMAIN, ARCHIVE_BOUNDARY_METADATA_KEY, makeArchiveBoundary, verifiedArchiveBoundary, readArchiveBoundary,
  ARCHIVE_FILE_NAME, defaultArchiveFile, appendArchiveEvent, verifyArchiveSegment, rollArchiveOnce,
  AuditRequiredError, SIGNING_VAULT_KEY, anchorVaultStats, assertLedgerVaultBinding, checkpoint,
  conditionalRecord, durability, durabilityWindows, flush, record, recordBatch,
  readDurabilityState, noteDurabilityBreach, redact, requireRecord, requireDurableStatus, findEvents, getEvent, resetForTests, resetProjectionVerifyCache, scrub, scrubText,
  status, tail, tailWithReferencedParents, verify, warm
};
