'use strict';

/* A CONVERSATION BELONGS TO THE PROGRAM THAT MINTED IT.
 *
 * Thread ids from both providers are UUID-shaped and `validateThreadId` is a
 * string-length check, so no syntactic test could ever tell a Codex-minted id
 * from a Claude-minted one -- and nothing compared their ORIGIN. Measured: a
 * Claude id handed to the Codex adapter spawned the wrong CLI, which took about
 * three seconds to exit with "No conversation found with session ID", and the
 * failure return had the same shape as a success. The caller could not tell.
 *
 * This module owns the one rule, so the two adapters cannot drift apart on it,
 * and so the app can put the same sentence in front of a person. It deliberately
 * does NOT throw: each process module raises its own error type
 * (ClaudeCliError / CodexAdapterError) so a caller's existing `instanceof` and
 * code handling keep working. This returns the refusal, or null to proceed.
 *
 * ABSENT IS NOT MISMATCHED, and that distinction is the whole compatibility
 * story. Every thread minted before 1.0.42 has no recorded provider, and every
 * existing resume test in the engine and the app resumes exactly such a thread.
 * "Unknown is refused" and "existing suites stay green unmodified" cannot both
 * be true, so the rule is:
 *
 *   absent            -> permitted (a pre-1.0.42 thread), and protected instead
 *                        by the failure now being failure-shaped
 *   same provider     -> permitted
 *   a different KNOWN provider -> refused, naming both
 *   anything else     -> refused as unidentifiable, never assumed to match
 */

/* The names a person sees. Keyed by the identifier the product stores, which is
   the lowercase one the confinement plan and the session record already use. */
const PROVIDER_DISPLAY_NAMES = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  local: 'the local model',
});

const RESUME_PROVIDER_MISMATCH = 'RESUME_PROVIDER_MISMATCH';
const RESUME_PROVIDER_UNKNOWN = 'RESUME_PROVIDER_UNKNOWN';

/* Compared by identity, not by the casing or padding it happened to be stored
   with: the record is written by more than one surface, and a false refusal over
   whitespace would be this fix causing the outage it exists to prevent. */
function normalizeProvider(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function displayName(provider) {
  return PROVIDER_DISPLAY_NAMES[provider] || provider;
}

/**
 * The refusal for resuming `threadProvider`'s conversation on `adapterProvider`,
 * or null when the resume may proceed.
 *
 * Returned rather than thrown -- see the note above.
 */
function resumeRefusalFor({ adapterProvider, threadProvider } = {}) {
  const adapter = normalizeProvider(adapterProvider);
  const thread = normalizeProvider(threadProvider);

  /* A pre-1.0.42 thread. Permitted, deliberately. */
  if (thread === null) return null;
  if (adapter !== null && thread === adapter) return null;

  const adapterLabel = displayName(adapter || 'this provider');

  if (!Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_NAMES, thread)) {
    /* NOT ASSUMED TO MATCH. A provider name this build does not recognise is a
       record written by something we cannot reason about -- a newer build, or a
       damaged record. Proceeding would spawn a program on a guess. The name is
       not echoed back into the sentence: it is not a name the person would
       recognise either, and it is already in the code. */
    return {
      code: RESUME_PROVIDER_UNKNOWN,
      message: `This conversation was started by a program this version does not recognise, so it cannot be resumed with ${adapterLabel}. Starting a new conversation will work.`,
    };
  }

  return {
    code: RESUME_PROVIDER_MISMATCH,
    message: `This conversation belongs to ${displayName(thread)} and cannot be resumed with ${adapterLabel}. Starting a new conversation with ${adapterLabel} will work.`,
  };
}

module.exports = {
  PROVIDER_DISPLAY_NAMES,
  RESUME_PROVIDER_MISMATCH,
  RESUME_PROVIDER_UNKNOWN,
  normalizeProvider,
  resumeRefusalFor,
};
