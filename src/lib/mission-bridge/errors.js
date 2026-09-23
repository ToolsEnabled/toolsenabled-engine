'use strict';

class MissionBridgeError extends Error {
  constructor(code, message, { status = 400, details = null } = {}) {
    super(message);
    this.name = 'MissionBridgeError';
    this.code = code;
    this.status = status;
    if (details !== null) this.details = details;
  }
}

function refuse(code, message, options) {
  throw new MissionBridgeError(code, message, options);
}

/* THE SENTENCE OF LAST RESORT, AND IT USED TO BE THE ONLY SENTENCE.
 *
 * Every refusal that came through here was given this literal, whatever had
 * actually happened. It is true of every refusal in the product, which is
 * exactly what makes it useless: it names no cause, so it can start no repair.
 * The owner met it twice in one paragraph on the Codex Cloud panel and again
 * under the ledger's Claim and Close buttons, and called both screens
 * impossible to make meaning of. He was reading a constant.
 *
 * It is still here, and it is still right for one case: a refusal that arrived
 * carrying nothing a person could be shown. */
const DEPENDENCY_REFUSED = 'The audited dependency refused the action.';

/* WHAT MAY NOT TRAVEL WITH A REASON.
 *
 * The dashboard's own rule (src/refusal-copy.js over there) is that a machine
 * identifier rides on the element as data, never in the sentence -- but it can
 * only drop a reason that is a bare identifier ALL BY ITSELF. An identifier
 * sitting inside an otherwise-English sentence goes straight to the glass, and
 * so does a file path, and so does a loopback address. So this is the place
 * that has to guarantee it: everything below leaves the engine, and nothing
 * downstream looks again.
 *
 * Each pattern is here because a message on this tree really contains one:
 *   - a Windows or UNC path              (the account registry's own refusal)
 *   - a deep POSIX path                  (the same code, on the other platform)
 *   - a loopback URL                     (the capability layer's address)
 *   - a parenthesised code               (probe failures, environment readers)
 *   - a leading errno prefix             (anything Node's fs layer throws)
 *
 * A quoted path is removed WITH its quotes and with the preposition or verb
 * that introduced it, so "No account registry at C:\...\accounts.json." does
 * not become "No account registry at ." A path is machine detail; the clause
 * that points at it is machine detail too.
 *
 * THE REGISTRY'S REFUSAL IS STILL THE WORKED EXAMPLE and it is worth saying
 * what it says now: it names the path, for a log, and its remedy is "add an
 * account in ToolsEnabled", not "create this file". Scrubbing the path used to
 * leave a person holding an instruction to write JSON with the filename taken
 * out of it, which is the worst of both. */
const LEAD_IN = '(?:\\s*,)?\\s*(?:\\b(?:at|in|on|from|to|under|near|open|stat|read|write|scandir|lstat|unlink|mkdir|rmdir|copyfile|rename)\\b)?\\s*["\'(\u2018\u201c]?';
const TRAIL = '["\')\u2019\u201d]?';
/* A path may not swallow the full stop that ends the sentence it is in --
   "No account registry at C:\\...\\accounts.json. Add an account in ToolsEnabled
   and it will be written." must not become "No account registry Add an
   account". So the last character of a path is never sentence punctuation.

   THAT SENTENCE USED TO END "Create it before switching accounts", and the
   change is not editorial. It was the only on-ramp the product had for adding
   a cloud account, and it was an instruction to hand-author JSON: nothing in
   the product wrote that file. src/lib/multi-account/registry-write.js does
   now, so the refusal names an action a customer can take rather than a file
   they would have to invent. The scrubbing rule below is unchanged; only the
   example it is written against moved. */
const PATH_BODY = '[^\\s"\'()<>|]*[^\\s"\'()<>|.,;:!?]';
const WINDOWS_PATH = new RegExp(`${LEAD_IN}(?:[A-Za-z]:[\\\\/]|\\\\\\\\)(?:${PATH_BODY})?${TRAIL}`, 'g');
/* WHAT THE DRIVE-ROOTED RULE ABOVE LEAVES BEHIND. A Windows path can contain a
   space -- "C:\\Program Files\\nodejs\\codex.cmd" -- and stopping at whitespace
   leaves "Files\\nodejs\\codex.cmd" sitting in the sentence. Anything still
   carrying a backslash between two segments is the rest of a path. */
const PATH_REMNANT = new RegExp(`${LEAD_IN}[\\w.$~%+-]+(?:\\\\[\\w.$~%+-]+)+${TRAIL}`, 'g');
/* The lookbehind is load-bearing: without it this eats the useful half of
   "chatgpt.com/codex/cloud/settings/environment/<id>", which is an address a
   person is meant to visit rather than a path on their disk. */
const POSIX_PATH = new RegExp(`${LEAD_IN}(?<![\\w.@%+-])\\/(?:[\\w.@%+-]+\\/){2,}[\\w.@%+-]*${TRAIL}`, 'g');
const LOOPBACK_URL = new RegExp(`${LEAD_IN}https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?[^\\s"'()<>]*${TRAIL}`, 'g');
const PARENTHESISED_CODE = /\s*\(\s*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\s*\)/g;
const ERRNO_PREFIX = /^[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*:\s*/;
const EMBEDDED_IDENTIFIER = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

/* The shortest thing that can still be a sentence with a cause in it. Below
   this a scrubbed message is a fragment, and a fragment is worse than the
   constant because it reads like a bug rather than like an answer. */
const MIN_REASON_CHARS = 20;

/**
 * The underlying reason, if it can be shown to a person; otherwise nothing.
 *
 * Returns null rather than a fragment. The caller then uses the constant, which
 * is a real loss and the right one: a vague sentence is better than one with a
 * stranger's file path in it.
 */
function publicReason(value) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  text = text.replace(ERRNO_PREFIX, '');
  text = text.replace(WINDOWS_PATH, '').replace(PATH_REMNANT, '').replace(POSIX_PATH, '').replace(LOOPBACK_URL, '');
  text = text.replace(PARENTHESISED_CODE, '');
  // Tidy what the removals left behind: doubled spaces, a space before a stop,
  // a stranded comma, an empty bracket.
  text = text
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/,\s*\./g, '.')
    .replace(/\.{2,}/g, '.')
    .trim();
  if (text.length < MIN_REASON_CHARS) return null;
  // Still carrying a code, or carrying no lower case at all: not English, and
  // not something to put in front of somebody.
  if (EMBEDDED_IDENTIFIER.test(text)) return null;
  if (!/[a-z]/.test(text)) return null;
  return /[.!?\u2026]$/.test(text) ? text : `${text}.`;
}

/**
 * A thrown dependency failure, as something the bridge can answer with.
 *
 * The CODE was always kept. The MESSAGE is now kept too, scrubbed of anything a
 * person cannot use, because a refusal that does not say what happened cannot
 * be acted on -- and this function is the single door every dependency refusal
 * in the product comes through.
 *
 * The bridge's OWN errors are returned untouched. Those are the ~70 curated
 * sentences refuse() throws, already written for a reader, and rewriting them
 * here would be this function reaching into copy it does not own.
 */
function typedError(error) {
  if (error instanceof MissionBridgeError) return error;
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{3,80}$/.test(error.code)
    ? error.code : 'BRIDGE_DEPENDENCY_REFUSED';
  return new MissionBridgeError(code, publicReason(error?.message) || DEPENDENCY_REFUSED, {
    status: code.includes('UNAUTH') ? 401 : 409,
    details: error?.details && typeof error.details === 'object' ? error.details : null
  });
}

module.exports = Object.freeze({ MissionBridgeError, DEPENDENCY_REFUSED, publicReason, refuse, typedError });
