'use strict';

// --- SAYING WHAT ACTUALLY HAPPENED WHEN ADMINISTRATOR RIGHTS WERE NOT GIVEN --
//
// R1534. An elevation that was refused, or that was never possible, currently
// surfaces in this codebase as one of four wrong things:
//
//   a silent failure   the step is skipped and something reports success.
//   a hang             a child waits on a prompt nobody can see, for 15 minutes.
//   a generic error    "Dependency install failed." with the real cause dropped.
//   a WRONG DIAGNOSIS  and this is the worst of the four. When a program with no
//                      desktop asks Windows for administrator rights, Windows
//                      cannot draw the approval box, so it fails the request
//                      with ERROR_CANCELLED (1223) and the text "The operation
//                      was canceled by the user". Nobody cancelled anything.
//                      Nobody was asked. Reporting that sentence to the person
//                      blames them for a decision they were never offered, and
//                      sends them looking for a prompt they will never find.
//
// So a refusal has to answer three questions, the same three R1529 requires of
// every withheld state: what happened, what would allow it, and what that costs.
//
// ABSENCE IS NEVER CONSENT (R1248), APPLIED TO ELEVATION. Every answer this
// module produces carries `granted: false`. There is no code path that returns
// `granted: true`, because this module only ever sees failures, and an
// elevation nobody granted must never be recorded as one. The one genuinely
// ambiguous case -- a timeout, where the operation may or may not have run --
// returns `outcomeUnknown: true` and still `granted: false`, because "we do not
// know" resolves to "not granted" and never the other way.

const WINDOWS_ERROR_CANCELLED = 1223;
const WINDOWS_ERROR_ACCESS_DENIED = 5;

/* The closed vocabulary. A caller styles or routes on these; nobody parses the
   prose. Adding a fifth is a visible act in a diff. */
const CODES = Object.freeze({
  DENIED: 'ELEVATION_DENIED',
  DECLINED: 'ELEVATION_PROMPT_DECLINED',
  UNAVAILABLE: 'ELEVATION_PROMPT_UNAVAILABLE',
  UNKNOWN: 'ELEVATION_OUTCOME_UNKNOWN',
});

const ACCESS_DENIED_PATTERNS = [
  /access is denied/i,
  /0x80070005/i,
  /\bERROR_ACCESS_DENIED\b/,
  /requires? (?:administrator|elevation|elevated)/i,
  /run (?:this )?as (?:an )?administrator/i,
  /must be run elevated/i,
  /\bEPERM\b/,
  /\bEACCES\b/,
];

const CANCELLED_PATTERNS = [
  /operation was cancell?ed by the user/i,
  /0x800704c7/i,
  /\bERROR_CANCELLED\b/,
];

function text(...parts) {
  return parts.filter((part) => typeof part === 'string' && part !== '').join('\n');
}

function matches(patterns, haystack) {
  return typeof haystack === 'string' && haystack !== '' && patterns.some((pattern) => pattern.test(haystack));
}

/**
 * Was this failure about administrator rights, and if so what really happened?
 *
 * @param signals.exitCode      the child's exit code, when there was one.
 * @param signals.stderr        child stderr.
 * @param signals.stdout        child stdout.
 * @param signals.errorCode     a Node error code (`ETIMEDOUT`, `EPERM`, ...).
 * @param signals.errorMessage  an error message, when there was no child.
 * @param signals.timedOut      true if the call was cut off by its own timeout.
 * @param signals.interactive   whether a person could have SEEN a Windows
 *          prompt: true only when this process has a desktop to draw one on.
 *          THIS IS THE FIELD THAT SEPARATES THE TWO MEANINGS OF THE SAME
 *          WINDOWS ERROR, and a caller that does not know must pass null rather
 *          than guessing, because guessing `true` is precisely how a person
 *          gets blamed for cancelling something nobody showed them.
 *
 * Returns null when nothing suggests administrator rights were involved, so a
 * caller can keep its own error rather than being handed an elevation story
 * about an unrelated failure.
 */
function classify(signals = {}) {
  const { exitCode = null, stderr = '', stdout = '', errorCode = '', errorMessage = '', timedOut = false } = signals;
  const interactive = signals.interactive === true ? true : signals.interactive === false ? false : null;
  const haystack = text(String(stderr || ''), String(stdout || ''), String(errorMessage || ''));

  const cancelled = matches(CANCELLED_PATTERNS, haystack) || exitCode === WINDOWS_ERROR_CANCELLED;
  const denied = matches(ACCESS_DENIED_PATTERNS, haystack)
    || String(errorCode) === 'EPERM' || String(errorCode) === 'EACCES'
    || exitCode === WINDOWS_ERROR_ACCESS_DENIED;

  if (cancelled) {
    // The whole point of this module. Same error number, two opposite facts,
    // and only the caller's own knowledge of whether it has a desktop tells
    // them apart.
    if (interactive === true) {
      return answer(CODES.DECLINED,
        'Windows asked for permission to continue as an administrator, and that permission was not given.',
        'Running this step yourself from a window you opened as an administrator would let it finish.',
        'Approving it gives that one step full rights on this computer for as long as it runs. Declining it costs only this step; nothing else changes and nothing is left half-done by this program.');
    }
    if (interactive === false) {
      return answer(CODES.UNAVAILABLE,
        'Something this step ran asked Windows for administrator rights. Nothing was running where Windows could show you the approval box, so Windows refused the request on its own. You were not asked, and you did not decline it — Windows reports this refusal with the words "the operation was cancelled by the user", which is misleading here.',
        'Running the same step yourself, from a window you opened, would let Windows show you the approval box so you can decide.',
        'Nothing was changed on this computer. The cost of leaving it is that this step stays undone; the cost of doing it is that whatever it runs gets full rights on this computer while it runs.');
    }
    return answer(CODES.UNKNOWN,
      'Something this step ran asked Windows for administrator rights, and the request came back refused. This copy cannot tell whether you were shown the approval box and declined it, or whether there was nowhere to show it and Windows refused on its own.',
      'Running the same step yourself, from a window you opened, would show you the box if there is one.',
      'Nothing was changed on this computer either way.',
      { outcomeUnknown: true });
  }

  if (denied) {
    return answer(CODES.DENIED,
      'This step tried to change something on this computer that only an administrator may change, and Windows refused. It did not ask first, because nothing asked it to — this program never requests administrator rights for itself.',
      'Doing this part yourself, from a window you opened as an administrator, would let it through.',
      'Doing it gives that one command full rights on this computer while it runs. Not doing it costs only what that step would have enabled; everything else keeps working and nothing has been half-changed.');
  }

  if (timedOut || String(errorCode) === 'ETIMEDOUT') {
    // A child that stopped answering may have been waiting on an approval box.
    // It may equally have been slow. This does not decide, and it does not
    // report the step as done.
    return answer(CODES.UNKNOWN,
      'This step stopped answering and was cut off. One thing that causes that on Windows is a program waiting for an administrator approval box that nobody can see or answer.',
      'Running the same step yourself, from a window you opened, would show you anything that is waiting for an answer.',
      'This copy does not know whether the step finished, so it is not recording it as done. Nothing here has been marked complete on the strength of a guess.',
      { outcomeUnknown: true });
  }

  return null;
}

function answer(code, whatHappened, whatWouldEnable, whatItCosts, extra = {}) {
  return Object.freeze({
    code,
    elevation: true,
    // NEVER ANYTHING BUT FALSE, and a literal rather than a computed value.
    // This module is only ever reached by a failure; an elevation that was not
    // granted must not be able to be reported as granted by any path through
    // this file.
    granted: false,
    outcomeUnknown: extra.outcomeUnknown === true,
    whatHappened,
    whatWouldEnable,
    whatItCosts,
  });
}

/** The three answers as one plain paragraph, for a surface that has one line. */
function sentence(classified) {
  if (!classified) return '';
  return [classified.whatHappened, classified.whatWouldEnable, classified.whatItCosts].join(' ');
}

/**
 * An error message that says what happened instead of repeating a child's text.
 *
 * Keeps the original text -- a person debugging needs it -- but puts the honest
 * explanation first, so the first line a caller sees is never "the operation was
 * cancelled by the user" for an operation nobody was offered.
 */
function describeFailure(what, signals = {}) {
  const classified = classify(signals);
  const original = text(String(signals.stderr || '').trim(), String(signals.stdout || '').trim()).trim();
  if (!classified) return original || `${what} failed.`;
  return `${what} could not finish because it needed administrator rights. ${sentence(classified)}${original ? `\n\nWhat the step itself reported: ${original}` : ''}`;
}

/**
 * Could a person have SEEN a Windows approval box raised by something we run?
 *
 * true / false / null, and null is a real answer that callers must pass
 * through rather than resolve. Windows sets SESSIONNAME for a process attached
 * to a window station with a desktop -- "Console" at the machine, "RDP-Tcp#n"
 * over remote desktop -- and reports "Services" for session 0. Much of this
 * product's background work runs from scheduled tasks with no desktop, which
 * is exactly the case that produces the misleading "cancelled by the user".
 *
 * ABSENT IS NOT FALSE HERE. Windows omits the variable in several contexts and
 * its absence is not proof of anything, so it returns null and the classifier
 * says out loud that it cannot tell. Answering `true` on a guess is the one
 * error this whole module exists to prevent: it puts the blame for a refusal on
 * a person who was never shown a choice.
 */
function interactiveSession(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return null;
  const name = env && typeof env.SESSIONNAME === 'string' ? env.SESSIONNAME.trim() : '';
  if (name === '') return null;
  if (/^services$/i.test(name)) return false;
  if (/^(?:console|rdp-tcp#\d+)$/i.test(name)) return true;
  // An unfamiliar session name is not evidence that a desktop was available.
  // Preserve that uncertainty so ERROR_CANCELLED cannot be reported as a
  // person's definite decline merely because SESSIONNAME contained some value.
  return null;
}

module.exports = Object.freeze({
  CODES, classify, sentence, describeFailure, interactiveSession,
  WINDOWS_ERROR_CANCELLED, WINDOWS_ERROR_ACCESS_DENIED,
});
