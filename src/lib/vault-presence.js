'use strict';

// IS A RECORD ON FILE -- the question, and the three answers it can have.
//
// WHY THIS FILE EXISTS. `secretExists()` in src/lib/runtime.js answers presence
// by FETCHING the value and testing it for truthiness. For almost every key
// that is fine. For the two keys on tools/secrets.ps1's $VaultOracleDenylist it
// is not: the fetch is refused by design, the refusal is swallowed by the
// `catch { return false }`, and the product then states that no payment card
// is on file while a card record is sitting in the vault. Measured on a real
// vault before this file existed: `payment_method.card_status` -> `present:
// false` with a stored `payment_card_default` record in the vault file.
//
// THE DENYLIST IS CORRECT AND IS NOT WEAKENED HERE. Those two records carry a
// promise made by the vault's own capture dialogs -- that the record "is never
// returned to an agent, MCP response, log, or report". That promise is about
// CONTENT. This module never asks for content: it runs the `present` action,
// which reads nothing out of the record, decrypts nothing, and answers through
// an exit code with an empty stdout. Nothing that crosses this boundary could
// be a card number, a length, a digest or a ciphertext, because no such value
// is ever produced on the other side.
//
// THE THIRD ANSWER IS THE POINT. Presence is not a boolean; it is a boolean
// plus "could not tell". A vault that cannot be read is not a vault with
// nothing in it, and collapsing the two renders on the owner's screen as "no
// card on file" -- a false statement about the owner's money manufactured out
// of a permissions error or a half-written file. Callers get `present: null` with
// `readable: false` and must say so; there is no branch here that turns an
// unreadable vault into `present: false`.
//
// FAIL CLOSED MEANS FAIL UNKNOWN, NOT FAIL ABSENT. Every unexpected Windows
// exit code, a missing script, or a spawn that cannot start is UNREADABLE. An
// unsupported platform is also unknown about record presence, but it is a
// separate, certain, non-retryable state decided before any spawn. The only
// codes that produce a definite presence answer are those the script emits
// deliberately.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Requiring runtime is what publishes TOOLSENABLED_VAULT_PATH and
// TOOLSENABLED_STATE_ROOT into this process's environment on an installed
// payload, so the script spawned below resolves the SAME vault file this
// process would. Without it a packaged install reads one file and answers about
// another, which is the split-vault failure runtime.js documents at length.
const { rootPath } = require('./runtime');

// The child below is powershell.exe, a GENERAL INTERPRETER -- it is never
// exempt from the scrub, because whatever it runs inherits the same
// environment and can reach a provider CLI. The scrub removes credential names
// only, so TOOLSENABLED_VAULT_PATH and TOOLSENABLED_STATE_ROOT published by
// the require above still reach the script and it still reads the same vault.
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env.js');
const {
  VAULT_PLATFORM_UNSUPPORTED,
  VAULT_PLATFORM_UNSUPPORTED_MESSAGE,
  assertVaultPlatform,
  isVaultPlatformRefusal
} = require('./vault-platform');

// Exit codes of the `present` action in tools/secrets.ps1. Written here as
// named constants rather than bare numbers so a change on either side is a
// visible edit on both.
const PRESENT = 0;
const ABSENT = 3;
const UNREADABLE = 4;
const NO_STORE = 5;

const SECRET_KEY_RE = /^[A-Za-z0-9_.-]{1,120}$/;

const ANSWER_PRESENT = Object.freeze({
  present: true, readable: true, code: 'VAULT_RECORD_PRESENT',
  detail: 'A record is on file under this key. Nothing about its contents was read.'
});
const ANSWER_ABSENT = Object.freeze({
  present: false, readable: true, code: 'VAULT_RECORD_ABSENT',
  detail: 'The vault was read and holds no record under this key.'
});
const ANSWER_NO_STORE = Object.freeze({
  present: false, readable: true, code: 'VAULT_STORE_ABSENT',
  detail: 'This computer has no vault store yet, so nothing is on file.'
});
// `present: null`, never false. A caller that renders this as "no card on file"
// is stating something it was explicitly told was unknown.
const ANSWER_UNREADABLE = Object.freeze({
  present: null, readable: false, code: 'VAULT_UNREADABLE',
  detail: 'The vault exists on this computer and could not be read, so whether a record is on file is unknown. This is not the same as having none.'
});
const ANSWER_PLATFORM_UNSUPPORTED = Object.freeze({
  present: null,
  readable: false,
  retryable: false,
  code: VAULT_PLATFORM_UNSUPPORTED,
  detail: VAULT_PLATFORM_UNSUPPORTED_MESSAGE
});

// A DEFINITE PRESENCE ANSWER MAY BE REMEMBERED WHILE THE VAULT FILE'S BYTES
// ARE UNCHANGED. AN UNCERTAIN ONE MAY NOT.
//
// Every call below spawns a full powershell.exe -- measured ~600 ms on the
// owner's machine. google-accounts.oauthKeysFor() asks twice per call
// (client id, client secret) and list() asks once per registered account, so a
// single Google tool call or one system.status poll pays several of them back
// to back for an answer that cannot have changed in between.
//
// The key is the vault file's CONTENT digest, never size+mtime. That is the
// same reasoning readAnchor() records for the protected head: a record cannot
// change without the vault file changing, because every write re-encrypts the
// whole file, while both halves of a stat are attacker-controllable by an
// ordinary same-user process. Two identical digests mean identical bytes,
// so they mean an identical answer.
//
// Three rules this keeps, and each is load-bearing:
//   * The digest is taken BEFORE the probe, so a remembered pair can only ever
//     be (older-or-equal digest, this-or-newer answer) -- never the reverse,
//     which is the direction that could hide a concurrent writer.
//   * A digest that cannot be computed is UNKNOWN, never "unchanged": null
//     skips the cache entirely in both directions and probes for real.
//   * ONLY PRESENT AND ABSENT ARE REMEMBERED. Unreadable, no-store and
//     platform-unsupported all mean "I could not tell", and this file's whole
//     point (see the header) is that failing to look is never an answer about
//     the record. Caching one would turn a transient failure into a durable
//     claim -- exactly the lie the module exists to prevent.
const presenceCache = new Map();
let presenceCacheDigest = null;
const presenceMeasurements = { probes: 0, cacheHits: 0, expired: 0, invalidations: 0 };

// Lazy: runtime.js requires this module from inside secretExists(), so reading
// vaultContentDigest through a top-level destructure could bind undefined
// during that cycle. By call time the graph is loaded.
function vaultDigestNow() {
  try {
    const digest = require('./runtime').vaultContentDigest();
    return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
  } catch { return null; }
}

function rememberedPresence(key, digest) {
  if (digest === null) return null;
  if (digest !== presenceCacheDigest) {
    if (presenceCacheDigest !== null) presenceMeasurements.invalidations += 1;
    presenceCache.clear();
    presenceCacheDigest = digest;
    return null;
  }
  const entry = presenceCache.get(key);
  if (!entry) return null;
  const seconds = require('./tool-performance-settings').performanceSettings()['tools.credential_check_interval_seconds'];
  if (seconds > 0 && Date.now() - entry.at >= seconds * 1000) {
    presenceMeasurements.expired += 1;
    return null;
  }
  presenceMeasurements.cacheHits += 1;
  return entry.answer;
}

function rememberPresence(key, digest, answer) {
  if (digest === null || digest !== presenceCacheDigest) return answer;
  if (answer !== ANSWER_PRESENT && answer !== ANSWER_ABSENT) return answer;
  presenceCache.set(key, { answer, at: Date.now() });
  return answer;
}

// Exists so a suite can drive the same process across a changed vault without
// depending on digest timing. Not part of the capability surface.
function resetVaultPresenceCache() {
  presenceCache.clear();
  presenceCacheDigest = null;
  for (const key of Object.keys(presenceMeasurements)) presenceMeasurements[key] = 0;
}

// Local process counters only: no keys, values, digests or timestamps are
// exposed. Used to verify that saved tuning changes real helper invocations.
function vaultPresenceMeasurements() { return Object.freeze({ ...presenceMeasurements }); }

/**
 * Ask whether the vault holds a record under `key`.
 *
 * Never throws, never returns a value from the record, and never returns
 * `present: false` for a failure it did not positively measure.
 */
function vaultRecordPresence(key) {
  try {
    assertVaultPlatform();
  } catch (error) {
    if (isVaultPlatformRefusal(error)) return ANSWER_PLATFORM_UNSUPPORTED;
    throw error;
  }
  if (typeof key !== 'string' || !SECRET_KEY_RE.test(key)) return ANSWER_UNREADABLE;
  // Captured before either platform's probe below, so the remembered pairing
  // can never bind a superseded answer to a current digest.
  const digest = vaultDigestNow();
  if (process.platform === 'linux') {
    const remembered = rememberedPresence(key, digest);
    if (remembered) return remembered;
    try {
      presenceMeasurements.probes += 1;
      const answer = require('./vault-linux').presence(key);
      if (answer === 'present') return rememberPresence(key, digest, ANSWER_PRESENT);
      if (answer === 'absent') return rememberPresence(key, digest, ANSWER_ABSENT);
      if (answer === 'no-store') return ANSWER_NO_STORE;
    } catch { /* inability to consult Linux custody remains unknown */ }
    return ANSWER_UNREADABLE;
  }
  const remembered = rememberedPresence(key, digest);
  if (remembered) return remembered;
  let script;
  try {
    script = rootPath('tools', 'secrets.ps1');
    if (!fs.existsSync(script)) return ANSWER_UNREADABLE;
  } catch {
    return ANSWER_UNREADABLE;
  }
  let status;
  try {
    presenceMeasurements.probes += 1;
    execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'present', key
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      shell: false,
      env: safeLaunchEnvironment(process.env, { context: 'vault presence probe' })
    });
    status = 0;
  } catch (error) {
    // execFileSync throws on any non-zero exit, which is the normal path for
    // three of the four answers. `status` is null when the process could not be
    // started at all -- that is unreadable, not absent.
    status = error && Number.isInteger(error.status) ? error.status : null;
  }
  // Only the two definite answers are offered to the cache; rememberPresence
  // refuses the rest, and refuses any answer whose digest moved under it.
  if (status === PRESENT) return rememberPresence(key, digest, ANSWER_PRESENT);
  if (status === ABSENT) return rememberPresence(key, digest, ANSWER_ABSENT);
  if (status === NO_STORE) return ANSWER_NO_STORE;
  if (status === UNREADABLE) return ANSWER_UNREADABLE;
  return ANSWER_UNREADABLE;
}

module.exports = {
  vaultRecordPresence,
  resetVaultPresenceCache,
  vaultPresenceMeasurements,
  PRESENT_EXIT: PRESENT,
  ABSENT_EXIT: ABSENT,
  UNREADABLE_EXIT: UNREADABLE,
  NO_STORE_EXIT: NO_STORE,
  ANSWER_PRESENT,
  ANSWER_ABSENT,
  ANSWER_NO_STORE,
  ANSWER_UNREADABLE,
  ANSWER_PLATFORM_UNSUPPORTED
};
