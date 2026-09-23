'use strict';
// THE OWNER'S CART, AS IT ACTUALLY STANDS RIGHT NOW.
//
// The desktop app draws this queue at #/approvals and the website cannot reach
// it at all (see docs/design/PURCHASE-CART.md). This is the third reader, and
// the reason it exists is not convenience: it is the one that runs with no app
// build, no bridge port and no browser, so "what is in my cart and when does it
// die" has an answer even when both surfaces are down -- which is the state
// today.
//
// It reads. It does not enqueue, decide, retire or spend. Its only writing
// dependency would be the store, and it does not take one: it reads the state
// file the store owns and projects it through src/lib/purchase-cart-view.js,
// which itself requires nothing.
//
// `--json` prints the projection verbatim for a surface that wants to render it.
//
// ---------------------------------------------------------------------------
// THE 2026-08-12 22:04Z DIRECTIVE, AND WHICH PARTS OF IT THIS FILE CAN ANSWER
//
// He asked for four things at once: the cart in front of him IN HIS SIGNED-IN
// ACCOUNT, his CARD LOCKED IN THE VAULT, the whole thing PROVEN on a live
// session, and A LOUD SOUND whenever a question is posted that needs him.
//
// This file answers the ones it can MEASURE and refuses to answer the one it
// cannot, by name -- `--ready` prints all four either way:
//
//   the cart          measured. It reads the store and projects it. Always did.
//   the card          measured, WITHOUT READING IT. src/lib/vault-presence.js
//                     runs the vault's `present` action, which decrypts
//                     nothing and answers through an exit code with empty
//                     stdout. Present / absent / could-not-tell, never a
//                     boolean that turns a permissions error into "no card".
//   a question waits  measured. `questionCount` from the projection -- rows he
//                     can still answer, not rows that exist.
//   signed in as him  NOT MEASURABLE FROM HERE, and not faked. The signed-in
//                     session lives in the desktop app's main process and on
//                     disk only as product-session.enc, sealed by the OS
//                     keystore in that app's own userData directory. Reading
//                     it would mean prising open the app's account partition
//                     from outside; guessing it would mean this tool telling
//                     him he is signed in when nobody is. So it reports the
//                     absence and says which screen does hold the answer.
//
// AND THE SOUND IS REAL. `--alert` plays the product's own generic-ramp alert
// through src/lib/desktop.js -- the same call the Firebase and gcloud sign-in
// paths already make when they need him -- and only when `questionCount` is
// above zero. Beeping at an empty queue is how an alarm gets ignored.
//
// THE TWO NEW DEPENDENCIES ARE LOADED LAZILY, ON PURPOSE. Requiring them at
// the top would drag runtime + audit (and an sqlite handle) into every reader
// that imports this module for `readQueue`. Held behind the two functions that
// need them, the pure projection path stays exactly as pure as it was.

const fs = require('node:fs');
const path = require('node:path');

const view = require('../src/lib/purchase-cart-view.js');

const STATE_FILE = path.resolve(__dirname, '..', 'state', 'owner-public-prompts.json');

// The vault record the owner's card is kept under. Named here as a constant so
// the one thing this file ever asks the vault is greppable, and so it is
// obvious that the only verb applied to it is "is it there".
const CARD_KEY = 'payment_card_default';

// Not a measurement, and deliberately shaped like one so no caller mistakes it
// for a null answer it may collapse into `false`. See the header.
const ACCOUNT_UNKNOWN = Object.freeze({
  signedIn: null,
  readable: false,
  code: 'ACCOUNT_NOT_READABLE_FROM_HERE',
  detail: 'Whether you are signed in, and as whom, is held by the desktop app: '
    + 'in its main process while it runs, and on disk only as a session file sealed by this '
    + "computer's keystore. This tool does not open that, so it does not know and does not guess.",
  where: 'Open ToolsEnabled and go to Account. Your purchase list is drawn there, inside your '
    + 'signed-in account, from this same one queue -- and at Approvals, which is the screen you decide on.'
});

function money(amountCents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(amountCents / 100);
}

// The stored record is not the wire record. The store adds `defaultDecision` and
// folds `ownerRequestIds` into a text stamp on `description` on the way out
// (owner-prompts.js wirePrompt/wireItem). This reader holds the record, so it
// does NOT re-create that stamp -- re-creating it wrongly would put a false
// provenance label on the owner's lines, which is the exact failure that made
// him reject four earlier carts. It passes provenanceSource: 'record' instead,
// and the projection reads the structural field the record still has. Only
// `defaultDecision` is derived, from the store's own stated rule.
function readQueue(stateFile) {
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!raw || !Array.isArray(raw.prompts)) {
    throw new Error(`owner prompt queue has no prompts array (${stateFile})`);
  }
  return {
    ok: true,
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    theme: { defaultTheme: 'black' },
    prompts: raw.prompts.map(prompt => ({
      ...prompt,
      defaultDecision: prompt.kind === 'notice' ? 'acknowledge' : 'deny'
    }))
  };
}

/**
 * Is his card on file -- asked of the vault, never read out of it.
 *
 * Delegates to src/lib/vault-presence.js, which runs the vault's `present`
 * action: no decryption, no stdout, an exit code only. That module never
 * throws and never converts an unreadable vault into "absent"; this wrapper
 * adds a guard purely so a checkout that has no vault tooling at all still
 * renders the cart instead of failing on the card line.
 */
function cardStanding(overrides = {}) {
  const probe = overrides.vaultRecordPresence
    || (() => require('../src/lib/vault-presence.js').vaultRecordPresence)();
  let answer;
  try { answer = probe(CARD_KEY); }
  catch { answer = null; }
  if (!answer || typeof answer !== 'object'
      || answer.readable !== true
      || (answer.present !== true && answer.present !== false)) {
    return Object.freeze({ key: CARD_KEY, present: null, readable: false, code: 'VAULT_UNREADABLE',
      detail: 'The vault could not be asked on this checkout, so whether your card is on file is unknown. This is not the same as having none.' });
  }
  return Object.freeze({ key: CARD_KEY, present: answer.present, readable: answer.readable, code: answer.code, detail: answer.detail });
}

function cardSentence(card) {
  if (card.present === true) return 'Your card is on file in this computer\'s vault. Nothing about it was read to say so.';
  if (card.present === false) return 'No card is on file in this computer\'s vault.';
  return `Whether your card is on file could not be determined. ${card.detail}`;
}

/**
 * The loud sound he asked for, played only when something actually needs him.
 *
 * `generic-ramp` is the product's four-tone alert that rises in amplitude --
 * the same one src/lib/tool-registry.js already plays for the Firebase and
 * gcloud sign-in prompts, chosen here for the same reason: it is the one that
 * carries across a room.
 *
 * IT NEVER THROWS. A speaker that is muted, absent or busy must not take down
 * the reading of his cart; the return value says whether the sound happened,
 * and the caller prints that rather than assuming it.
 */
function alertIfNeeded(result, overrides = {}) {
  if (result.questionCount === 0) {
    return Object.freeze({ played: false, reason: 'Nothing on the queue is waiting for an answer from you, so no alert was played.', questionCount: 0 });
  }
  const play = overrides.soundPlay
    || (() => require('../src/lib/desktop.js').soundPlay)();
  try {
    play({ sound: 'generic-ramp' });
    return Object.freeze({ played: true, reason: null, questionCount: result.questionCount });
  } catch (error) {
    return Object.freeze({
      played: false,
      reason: `The alert could not be played on this computer (${error && error.message}). The questions below are still waiting.`,
      questionCount: result.questionCount
    });
  }
}

/**
 * The four facts of the 22:04Z directive, in one block, each with its standing.
 *
 * Printed as a block rather than folded into prose because the point of it is
 * that a reader can see WHICH of the four is not yet true.
 */
function renderReadiness(result, card, account) {
  const out = [];
  out.push('THE STATE OF THE PAID PATH, AS MEASURED JUST NOW');
  out.push('');
  out.push(`  cart readable       yes -- ${result.cartCount} cart(s), ${result.lineCount} line(s), ${result.waitingCount} row(s) on the queue`);
  out.push(`  card in the vault   ${card.present === true ? 'yes' : card.present === false ? 'no' : 'unknown'} -- ${cardSentence(card)}`);
  out.push(`  waiting on you      ${result.questionCount} question(s) you can still answer`
    + (result.expiredCount ? `, and ${result.expiredCount} row(s) already past their date` : ''));
  out.push('  signed-in account   not readable from here');
  out.push(`                      ${account.detail}`);
  out.push(`                      ${account.where}`);
  out.push('');
  return out.join('\n');
}

function render(result) {
  const out = [];
  out.push('YOUR CART, AS IT STANDS NOW');
  out.push('');
  out.push(result.spendNotice);
  out.push('');

  if (result.cartCount === 0) {
    out.push('No purchase cart is waiting for you.');
  }

  for (const cart of result.carts) {
    out.push(`${cart.title}`);
    out.push(`  ${cart.deadline}  (${cart.expiresAt})`);
    out.push(`  ${cart.doNothing}`);
    out.push('');
    for (const item of cart.items) {
      const tag = item.provenance === 'owner'
        ? item.provenanceLabel
        : (item.provenance === 'agent-proposed' ? 'AGENT-PROPOSED - not traceable to your words' : 'provenance not recorded');
      out.push(`  ${money(item.amountCents, item.currency).padStart(10)}  ${item.text}`);
      out.push(`              ${item.merchant}  [${tag}]`);
    }
    out.push(`  ${'-'.repeat(10)}`);
    out.push(`  ${money(cart.totalCents, cart.currency).padStart(10)}  if you approve every line on this cart`);
    out.push(`              ${cart.ownerLineCount} from your words, ${cart.agentProposedLineCount} agent-proposed`
      + (cart.unknownProvenanceLineCount ? `, ${cart.unknownProvenanceLineCount} unrecorded` : ''));
    out.push('');
  }

  if (result.approveEverythingCents !== null && result.cartCount > 1) {
    out.push(`${money(result.approveEverythingCents, result.currency)} across all ${result.cartCount} carts, if you approve everything.`);
  } else if (result.approveEverythingUnavailableReason) {
    out.push(result.approveEverythingUnavailableReason);
  }
  // Never printed as a number, and the absence is named. See the projection's header.
  out.push(`Cost over twelve months: not shown. ${result.firstYearUnavailableReason}`);
  out.push('');

  const others = result.prompts.filter(prompt => prompt.kind !== 'purchase_batch');
  if (others.length) {
    out.push(`Also waiting on the same clock (${others.length}), not purchases:`);
    for (const prompt of others) {
      out.push(`  ${prompt.kind.padEnd(13)} ${prompt.deadline.padEnd(22)} ${prompt.title}`);
    }
    out.push('');
  }

  if (result.soonestExpiry) {
    out.push(`SOONEST: ${result.soonestExpiry.deadline}  ${result.soonestExpiry.title}`);
  }
  out.push('');
  out.push('Decide these in the desktop app at Approvals. Nothing here bought anything.');
  return out.join('\n');
}

// WHICH FLAG COSTS WHAT, stated so the default stays the cheap pure read it
// has always been. `--ready` and `--json` ask the vault, which spawns a
// PowerShell probe; `--alert` reaches the speakers. Plain `node
// tools/purchase-cart.js` still touches one file and nothing else.
const USAGE = 'node tools/purchase-cart.js [--json] [--ready] [--alert]\n'
  + '  --ready  also print the four facts of the paid path: cart, card, questions waiting, account\n'
  + '  --alert  play the loud alert if -- and only if -- a question is waiting for an answer\n'
  + '  --json   print the whole projection, readiness included, for a surface to render\n';

function main(argv, overrides = {}) {
  const stateFile = STATE_FILE;
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!fs.existsSync(stateFile)) {
    process.stderr.write(`No owner prompt queue exists on this machine (${stateFile}).\n`);
    return 1;
  }
  const result = view.cartView(readQueue(stateFile), { provenanceSource: 'record' });
  const wantsJson = argv.includes('--json');
  const wantsReady = argv.includes('--ready');
  const wantsAlert = argv.includes('--alert');

  // Measured BEFORE anything is printed, so the alert and the printed state
  // describe the same instant rather than the state either side of a probe.
  const card = wantsJson || wantsReady ? cardStanding(overrides) : null;
  const alert = wantsAlert ? alertIfNeeded(result, overrides) : null;

  if (wantsJson) {
    process.stdout.write(`${JSON.stringify({ ...result, card, account: ACCOUNT_UNKNOWN, alert }, null, 2)}\n`);
    return 0;
  }
  const out = [];
  if (wantsReady) out.push(renderReadiness(result, card, ACCOUNT_UNKNOWN));
  out.push(render(result));
  if (alert) {
    out.push('');
    out.push(alert.played
      ? `Alert played on the speakers: ${alert.questionCount} question(s) are waiting for you.`
      : alert.reason);
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv); }
  catch (error) {
    process.stderr.write(`purchase-cart failed: ${error && error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  readQueue, render, renderReadiness, cardStanding, cardSentence, alertIfNeeded, main,
  STATE_FILE, CARD_KEY, ACCOUNT_UNKNOWN, USAGE
});
