'use strict';

// Telling the owner that Duo is waiting on him (owner request R84, which
// supersedes R60's "send me an email with the 3 digit code").
//
// WHAT IS ACTUALLY RELAYABLE. This is the whole design question, and getting
// it wrong would mean promising him something that never arrives:
//
//   * DUO DESKTOP (the preferred route, src/lib/ucr-sso.js). The browser page
//     says "Check Duo Desktop for a login request" and the approval itself
//     happens in Duo's own signed Windows application, over its local
//     TrustedPeer/broker channel. There is NO code on that screen and nothing
//     an agent can read, capture, or forward. On the normal owner-presence
//     route, the only honest message is "a Duo approval is waiting -- approve
//     it in Duo Desktop on this PC." The bounded R86 exact-actuation route
//     suppresses this relay only after its own signed-process, exact-button
//     actuator has returned invoked, so it never tells the owner to repeat a
//     click that was already attempted.
//
//   * VERIFIED PUSH / NUMBER MATCHING. When a Duo tenant uses verified push,
//     the BROWSER renders a short verification number that the owner types
//     into the push notification on his phone. That number IS on a page this
//     process can see, and it is exactly the R60 fallback he described. So
//     when -- and only when -- the caller actually read such a number off the
//     live page, it is included. It is never generated, guessed, remembered,
//     or carried over from a previous prompt: no code read means no code sent.
//
//   * HARDWARE TOKENS / SMS PASSCODES are typed INTO the browser, not read
//     out of it, so there is nothing to relay and this module never pretends
//     otherwise.
//
// CREDENTIAL DISCIPLINE. A Duo verification number is a short-lived second
// factor. It travels vault-free, in memory, straight to the owner's pinned
// chat, and it is NEVER written anywhere else: not to the audit payload (the
// provider records a character count, never the text), not to the delivery
// record in state/owner-delivery.json (purpose + length + outcome only), not
// to a log line, and not to the ucr-login step list (which is a fixed
// allow-listed vocabulary of step names). The relayed flag says a code was
// relayed; nothing anywhere says what it was.

const ownerDelivery = require('./owner-delivery');

const DUO_DESKTOP_NOTICE = 'A Duo approval is waiting for you. Approve it in Duo Desktop on this PC — '
  + 'it is a provider-owned Windows prompt, so there is no code to relay and nothing to reply here.';
const CODE_RE = /^\d{1,8}$/;

/**
 * Build the owner-facing text.
 *
 * `code` is included ONLY when the caller genuinely read one. Anything that is
 * not a short run of digits is discarded rather than forwarded, so a scraped
 * label, an empty string, or a stray page fragment can never be presented to
 * him as his second factor.
 */
function renderDuoMessage({ code = null, account = null, route = 'duo_desktop' } = {}) {
  const relayable = typeof code === 'string' && CODE_RE.test(code.trim());
  const who = account ? ` (${account})` : '';
  if (relayable) {
    return {
      relayed: 'code',
      text: `Duo verification code: ${code.trim()}\n`
        + `Enter this number in the Duo push notification on your phone to approve the UCR sign-in${who}.\n`
        + 'It expires in about a minute. Nobody should ever ask you for it — if you did not start a sign-in, deny it.'
    };
  }
  return {
    relayed: 'notice',
    text: route === 'duo_desktop'
      ? `${DUO_DESKTOP_NOTICE}${who ? ` Sign-in${who}.` : ''}`
      : `Duo is waiting on you for the UCR sign-in${who}. Approve it in Duo Mobile or Duo Desktop — `
        + 'no code was shown on the page, so there is nothing to relay here.'
  };
}

/**
 * Deliver the Duo prompt to the owner over the configured channel.
 *
 * Always resolves; never throws. A Duo sign-in is already blocked on the owner
 * when this runs, and turning a notification failure into an exception would
 * take down the sign-in attempt as well. The failure is recorded, surfaced in
 * `--status`, and returned to the caller instead.
 */
async function notifyOwnerOfDuoPrompt({
  code = null, account = null, route = 'duo_desktop'
} = {}, dependencies = {}) {
  const delivery = dependencies.delivery || ownerDelivery;
  const message = renderDuoMessage({ code, account, route });
  const purpose = message.relayed === 'code' ? 'duo-code' : 'duo-notice';

  let resolved;
  try {
    resolved = delivery.resolveChannel(dependencies.channelOptions || {});
  } catch (error) {
    const failureCode = delivery.safeCode(error);
    delivery.recordDelivery({ purpose, channel: 'unknown', ok: false, code: failureCode }, dependencies);
    return { delivered: false, channel: null, relayed: message.relayed, failureCode };
  }

  try {
    // THE TELEGRAM BRANCH WAS REMOVED 2026-08-23 with the connector. It sent this
    // as plain text even on the image channels, because a screenshot of "someone
    // is waiting for you" is slower to read and impossible to act on from a lock
    // screen -- that reasoning is kept because it constrains whatever channel
    // replaces it: this relay must stay TEXT.
    //
    // THIS IS THE SECOND-FACTOR PATH AND IT JUST GOT SLOWER. R84 moved the Duo
    // code off email precisely because a push beats a mailbox when someone is
    // standing at a login prompt; it is now back on email until the owner picks a
    // channel. Nothing about the code itself changed: it is still never persisted
    // (recordDelivery below stores purpose, channel, outcome and a character
    // COUNT, never the text).
    await delivery.sendEmailToOwner({
      subject: message.relayed === 'code' ? 'Duo verification code' : 'Duo approval waiting',
      text: message.text,
      account: resolved.config ? resolved.config.emailAccount : null
    }, dependencies);
    delivery.recordDelivery({
      purpose, channel: resolved.channel, ok: true, rendered: 'text', characters: message.text.length
    }, dependencies);
    return { delivered: true, channel: resolved.channel, relayed: message.relayed, failureCode: null };
  } catch (error) {
    const failureCode = delivery.safeCode(error);
    delivery.recordDelivery({ purpose, channel: resolved.channel, ok: false, code: failureCode }, dependencies);
    return { delivered: false, channel: resolved.channel, relayed: message.relayed, failureCode };
  }
}

module.exports = {
  CODE_RE, DUO_DESKTOP_NOTICE,
  notifyOwnerOfDuoPrompt, renderDuoMessage
};
