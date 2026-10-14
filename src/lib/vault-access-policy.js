'use strict';

/* THE OWNER'S PER-PRINCIPAL DECISIONS ABOUT HIS OWN VAULT RECORDS, AS READ BY
 * THE SIDE THAT ACTUALLY HANDS OUT VALUES.
 *
 * WHY THIS FILE EXISTS AT ALL -- the measured defect it closes. The desktop app
 * already shipped the owner-facing half of this feature: shell/vault-access-
 * policy.cjs writes the decisions, the #/vault page draws the checkboxes, and
 * shell/vault-presence.cjs consults them in `vaultRecordValues`. But
 * `vaultRecordValues` has exactly one non-test caller in that repository --
 * shell/google-signin-config.cjs -- and it deliberately passes no principal,
 * because it IS the installation reading its own credentials. An agent's
 * credential read does not go through it at all: it goes through this
 * repository's src/lib/runtime.js `getSecret` -> `readSecretFromVault`, which
 * before this file never loaded the policy and never knew a principal existed.
 *
 * So the switch the owner could see and toggle governed a code path no
 * assistant ever took. The app's own page comment claimed the opposite ("THE
 * MATRIX IS ENFORCED SOMEWHERE ELSE, WHICH IS THE POINT ... A switch that only
 * hid a row here would be a label on a door that does not lock"). It was a
 * label on a door that did not lock. This file is the lock.
 *
 * WHY A SECOND READER INSTEAD OF SHARING THE APP'S MODULE. The app and this
 * engine are separate repositories, cut separately, and the app ships a packed
 * copy of this tree rather than the reverse -- so there is no direction in which
 * one can require the other's module at runtime. What IS shared is the FILE: its
 * path and its bytes. This module therefore reads and decides only; it never
 * writes. The app remains the single writer, which is why there is no
 * `setAccess` here. The on-disk shape both sides depend on is pinned from both
 * sides by test, so a change to it cannot land on one side alone.
 *
 * THE DEFAULT IS ALLOW, MIRRORING THE WRITER, AND NOT BY PREFERENCE. An
 * opt-out list is what lets this change be promoted over an existing install
 * without locking every credential the owner never ruled on -- including the
 * ones sign-in reads. A deny the owner SET is honoured absolutely.
 *
 * AN UNREADABLE POLICY IS NOT AN ABSENT ONE. An absent file means "no decisions
 * yet" and allows. A file that EXISTS and cannot be parsed means the decisions
 * are on disk and unavailable, and allowing there would silently discard every
 * deny the owner set. So present-but-unreadable refuses, by name. Note where
 * that refusal can and cannot reach: it applies only to a read that NAMES a
 * principal. An installation read carries no principal and is never ruled on,
 * so a corrupted policy file cannot stop this product from signing itself in.
 */

const fs = require('node:fs');
const path = require('node:path');

/* The version this reader understands. A file declaring anything else is not
   "old and tolerable", it is a file written by software this one does not know:
   treated as unreadable, which refuses rather than guesses. */
const POLICY_VERSION = 1;

/* Kept identical to NAME_RE in the app's shell/vault-access-policy.cjs and to
   SECRET_KEY_RE's accepted shape here, so a name that is legal to store is
   legal to rule on and a rule cannot be written that no read can ever match. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/;

/* Who a rule may name: a bare role word ("builder"), or a tree identity, which
   carries a colon in `account:...` form and hyphens in node ids. */
const PRINCIPAL_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

const POLICY_CODES = Object.freeze({
  READ: 'VAULT_POLICY_READ',
  ABSENT: 'VAULT_POLICY_ABSENT',
  UNREADABLE: 'VAULT_POLICY_UNREADABLE',
  DENIED: 'VAULT_ACCESS_DENIED',
  NO_STATE_ROOT: 'VAULT_POLICY_NO_STATE_ROOT'
});

/* THE SENTENCES A DENIED CALLER RECEIVES. Fixed literals, declared once here
   rather than built at the throw site, because they are the only part of this
   refusal an agent -- or the person reading its transcript -- ever sees. They
   name the decision and never the record's value. */
const POLICY_MESSAGES = Object.freeze({
  [POLICY_CODES.DENIED]: 'The owner of this computer turned off your access to this credential.',
  [POLICY_CODES.UNREADABLE]: 'This computer holds the owner\'s decisions about which credentials may be read '
    + 'and could not read them, so nothing is handed over. That is not the same as having no rules.',
  [POLICY_CODES.NO_STATE_ROOT]: 'This computer cannot locate the owner\'s credential-access decisions, '
    + 'so nothing is handed over.'
});

/** Where the decisions live. Must agree byte-for-byte with the app's writer. */
function policyFilePath(stateRoot) {
  if (typeof stateRoot !== 'string' || !stateRoot) return null;
  return path.join(stateRoot, 'state', 'vault-access-policy.json');
}

/* The state root this engine was started under. The desktop app sets it (its
   shell/main.cjs assigns `process.env.TOOLSENABLED_STATE_ROOT =
   CAPABILITY_STATE_ROOT`), which is the same directory its writer puts the
   policy in -- that assignment is the whole reason the two halves meet. */
function defaultStateRoot(environment = process.env) {
  const value = environment && environment.TOOLSENABLED_STATE_ROOT;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function validRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const access = Object.create(null);
  if (entry.access && typeof entry.access === 'object' && !Array.isArray(entry.access)) {
    for (const [principal, allowed] of Object.entries(entry.access)) {
      /* Only a real boolean is a decision. A truthy string in this position is
         a malformed file, and reading it as "allow" would invent consent. */
      if (PRINCIPAL_RE.test(principal) && typeof allowed === 'boolean') access[principal] = allowed;
    }
  }
  return { access };
}

/**
 * Read the owner's decisions.
 *
 * Total: it never throws. A caller must be able to ask "may this be read" on
 * the hot path of every secret read without wrapping it in a try.
 *
 * @param {string|null} [stateRoot] defaults to TOOLSENABLED_STATE_ROOT
 * @param {{fileSystem?: object, environment?: object, file?: string}} [options]
 *   `file` names the policy file outright, for the caller that has already
 *   resolved it. src/lib/runtime.js passes `rootPath('state',
 *   'vault-access-policy.json')`, which is this repository's one authority on
 *   where a redirected state root actually is -- deriving the path a second
 *   time from the environment variable would be a second answer to a question
 *   that must have exactly one.
 * @returns {{readable: boolean, code: string, policy: object|null, file: string|null}}
 *   `readable:false` with UNREADABLE means decisions exist and could not be
 *   read. A caller must treat that as a refusal, never as "no rules".
 */
function readPolicy(stateRoot = undefined, options = {}) {
  const { fileSystem = fs, environment = process.env, file: named = null } = options || {};
  const root = stateRoot === undefined ? defaultStateRoot(environment) : stateRoot;
  const file = typeof named === 'string' && named ? named : policyFilePath(root);
  if (!file) return { readable: false, code: POLICY_CODES.NO_STATE_ROOT, policy: null, file: null };
  let raw;
  try {
    raw = fileSystem.readFileSync(file, 'utf8');
  } catch (error) {
    /* ENOENT is the ordinary first-run answer and the ONLY failure that means
       "no decisions yet". Every other read error -- a permission denial, a
       directory where a file should be, an I/O fault -- means the file is there
       and we could not have it. */
    if (error && error.code === 'ENOENT') {
      return { readable: true, code: POLICY_CODES.ABSENT, policy: { records: Object.create(null) }, file };
    }
    return { readable: false, code: POLICY_CODES.UNREADABLE, policy: null, file };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { readable: false, code: POLICY_CODES.UNREADABLE, policy: null, file };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.version !== POLICY_VERSION
    || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) {
    return { readable: false, code: POLICY_CODES.UNREADABLE, policy: null, file };
  }
  const records = Object.create(null);
  for (const [name, entry] of Object.entries(parsed.records)) {
    if (!NAME_RE.test(name)) continue;
    const record = validRecord(entry);
    if (record) records[name] = record;
  }
  return { readable: true, code: POLICY_CODES.READ, policy: { records }, file };
}

/**
 * THE DECISION. May this caller read this record?
 *
 * WHY A LIST OF PRINCIPALS RATHER THAN ONE. A single agent read is attributable
 * in more than one way at once -- it has a role ("builder") and it has its own
 * tree identity -- and the owner may have ruled on either. The rule is that ANY
 * deny among the caller's identities denies the read: a record turned off for
 * the Builder role is not reopened by the fact that this particular builder was
 * never named, and a record turned off for one named agent is not reopened by
 * its role still being allowed. Narrowing to the most specific match would let
 * a role-wide deny be escaped by naming the agent, which is backwards.
 *
 * Pure and total: it takes the answer `readPolicy` already gave, so the hot
 * path reads the file once for a whole batch and this decides per key.
 *
 * @param {{readable: boolean, code: string, policy: object|null}} read
 * @param {string} name the vault record
 * @param {Array<string>} principals every identity this read is attributable to
 * @returns {{allowed: boolean, code: string, detail: string}}
 */
function mayRead(read, name, principals) {
  if (!read || read.readable !== true) {
    const code = read && read.code === POLICY_CODES.NO_STATE_ROOT
      ? POLICY_CODES.NO_STATE_ROOT
      : POLICY_CODES.UNREADABLE;
    return { allowed: false, code, detail: POLICY_MESSAGES[code] };
  }
  const named = (Array.isArray(principals) ? principals : [principals])
    .filter(value => typeof value === 'string' && value !== '');
  /* A read that names nobody is not ruled on. That is the installation reading
     its own credentials to do its own work, and the owner's per-agent switches
     are about assistants, not about whether the product may sign itself in.
     Every agent-facing caller MUST name a principal; that is what makes the
     switch real, and it is asserted by test rather than trusted. */
  if (named.length === 0) {
    return { allowed: true, code: POLICY_CODES.ABSENT, detail: 'This read names no principal, so no rule applies to it.' };
  }
  const record = read.policy && read.policy.records ? read.policy.records[name] : undefined;
  if (!record) return { allowed: true, code: POLICY_CODES.ABSENT, detail: 'No rule names this credential.' };
  for (const principal of named) {
    if (record.access[principal] === false) {
      return { allowed: false, code: POLICY_CODES.DENIED, detail: POLICY_MESSAGES[POLICY_CODES.DENIED] };
    }
  }
  return { allowed: true, code: POLICY_CODES.READ, detail: 'The owner has not turned this one off for you.' };
}

module.exports = {
  POLICY_VERSION,
  POLICY_CODES,
  POLICY_MESSAGES,
  NAME_RE,
  PRINCIPAL_RE,
  policyFilePath,
  defaultStateRoot,
  readPolicy,
  mayRead
};
