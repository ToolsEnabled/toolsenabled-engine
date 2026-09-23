'use strict';

// MAY AN AGENT FILE ONE OF THE PERSON'S STANDING RULES? Decided here and
// nowhere else. The r_ledger.* tools in tool-registry.js ask this module; the
// product host reads the same answer to choose which contract paragraph an
// agent is handed at session start, so the authority door and the judgement
// door cannot drift apart.
//
// THE STARTING POINT, MEASURED (O7, 2026-08-19). The four R ledgers
// (src/lib/r-ledger.js) had NO agent tool: the only write path was the person
// typing /Request in the chat, and the paragraph the host hands every agent
// said "you need no tool for that and should not act on the command
// yourself". Meanwhile the settings catalogue had shipped the row
// `rules.capture_spoken` ("Turning something you said into a standing rule")
// with `enforcedBy: ""` since it was drafted -- a control a person could set
// that changed nothing. The owner's rule for that shape, 2026-08-11: "every
// failure which there exists a system for or to prevent; that doesnt do its
// job according to user settings, is vieweed as software fialure". This
// module is that row's enforcer.
//
// THE THREE RULES are the research gate's (src/lib/research/settings-gate.js
// :55-91), copied by name because they answer the same failure histories:
//
// 1. ABSENCE IS OFF, NEVER CONSENT. A row missing from the registry, a value
//    missing from the person's file, null, "" -- all resolve to off.
// 2. A VALUE OUTSIDE THE OPTIONS IS OFF. The row used to offer "Capture and
//    show me" / "Only when I say remember this" / "Never"; a stored legacy
//    value fails src/lib/settings.js validation and reads back as the default,
//    which is off. That is the safe direction: nothing a person chose under
//    the old words can become consent for a ledger write under the new ones.
// 3. A NON-USER DEFAULT CANNOT TURN IT ON. Only `user` and `installer`
//    provenance count as a choice. Flipping the default in the registry JSON
//    cannot let agents start filing rules behind the person's back.
//
// THE MODE NAMES ARE INTERNAL; THE OPTION WORDS ARE THE PERSON'S. The select
// offers three plain phrases (OPTIONS below). The engine and the host speak in
// `off` / `propose` / `auto`; OPTION_TO_MODE is the only place the two meet.
//
// WHAT THIS SWITCH DOES NOT GOVERN. Only the R / RS / RT / RTH ledgers through
// r_ledger.*. memory.set (agent-coord notes), research.*, task.* and
// agent_comms.* have their own tools and are untouched: none of those records
// is read as a standing rule at boot (collectStack reads the four markdown
// ledgers only). The row's consequence text says so in the person's words.
//
// THREE MORE DOORS ON THE SAME PATH (O7 improvements, owner 2026-08-22):
//
// VERBATIM OR NOTHING. The words an agent files must be an exact contiguous
// slice of something the person typed -- whitespace aside, no case folding,
// no paraphrase -- measured against the turns the product spooled
// (owner-capture-spool, mode ingress). With a session id on the call the
// measure is that session's turns; WITHOUT one (the host does not control
// the arguments an agent passes, so the id is often absent) the measure is
// every turn the person typed to this ACTOR, in any session -- the actor is
// transport-bound on the call, so an agent cannot widen the check by leaving
// the id out, and another actor's turns never count. The check is skipped,
// with the result saying 'skipped: no spool', ONLY when this computer has no
// spool directory at all (a CLI or development context, not the product). A
// bare "ok"/"yes"/"no" and anything that looks like a secret are refused
// outright, the secret shape judged by the audit module's own scrubber so
// there is one definition of "looks like a secret" in this program.
//
// DUPLICATES NEST, THEY DO NOT BOUNCE. Words already standing in the same
// ledger answer with that entry's id and nothing is written; words that
// contain, or are contained by, a standing entry's words are a refinement
// and file as its child (R3.1 under R3 -- r-ledger.js, the dotted grammar of
// request-id.js). "the ledger use a . system doesn't it? you should respect
// that existing structure."
//
// ASK ME WHEN UNSURE. A sub-setting of the switch (rules.ask_when_unsure,
// default off, the person's choice only): with it on, the contract paragraph
// tells the agent that doubt files nothing and ends the reply with one short
// question, and that the person's yes files their ORIGINAL sentence. Off, the
// paragraph reads exactly as before.
//
// APPROVE BEFORE IT COUNTS (owner, 2026-09-02: one ledger, managed on the
// Ledger page). A second sub-setting, rules.agent_filed_needs_approval, read
// by the same three rules: with it on, a rule an agent files lands 'proposed'
// and waits for the person's approval before any agent reads it at boot; the
// paragraph says so. Off (the default), an agent-filed rule counts at once.
// src/lib/owner-request-store.js enforces it; this module only reads the row.
//
// ONE LEDGER. r_ledger.file and r_ledger.propose both write the canonical
// record through src/lib/owner-request-store.js (via the r-ledger adapter):
// file lands 'open' (or 'proposed' under the setting above), propose always
// lands 'proposed'. The spool that used to hold proposals is no longer written.

const AGENT_FILING_SETTING_ID = 'rules.capture_spoken';
const ASK_WHEN_UNSURE_SETTING_ID = 'rules.ask_when_unsure';
const NEEDS_APPROVAL_SETTING_ID = 'rules.agent_filed_needs_approval';

// WHO ADDS STANDING RULES (owner, 2026-09-15: "either manually on the ledger
// page only, or ledger page and /request, or agent and such like now"). One
// three-way choice over every door into the rules ledger. src/lib/settings.js
// keeps rules.capture_spoken in step with it (on only for "Agents too"), so the
// mode decision below still reads the switch it was built on; this module reads
// the choice itself for the one thing the switch cannot say -- whether the
// person may type /Request in a chat, or adds rules on the Ledger page alone.
const FILING_FROM_SETTING_ID = 'rules.filing_from';
const FILING_FROM = Object.freeze({
  PAGE: 'Ledger page only',
  PAGE_AND_CHAT: 'Ledger page and /Request',
  AGENTS: 'Agents too'
});

const fs = require('node:fs');
const path = require('node:path');

const MODES = Object.freeze({ OFF: 'off', PROPOSE: 'propose', AUTO: 'auto' });

// ONE SWITCH, ON OR OFF. The owner's ruling (2026-08-22): "i think just on or
// off is fine" -- agents manage the ledgers, or the person does. The row in
// config/settings-registry.json is a toggle; `true` is the only value that
// turns it on (the research gate's rule, value === true), and on means AUTO:
// the agent files. PROPOSE survives as an internal mode the tools still
// understand -- r_ledger.propose is where an agent that is unsure puts a
// suggestion while the switch is on -- but no setting selects it. The test in
// tests/r-ledger-agent-gate.test.js holds the row and this module in
// agreement.
const OPTIONS = Object.freeze({
  OFF: false,
  AUTO: true
});
function modeOfValue(value) {
  if (value === true) return MODES.AUTO;
  if (value === false) return MODES.OFF;
  return null;
}

const CHOOSING_PROVENANCE = Object.freeze(new Set(['user', 'installer']));

const GATE_STATE = Object.freeze({
  ENABLED: 'enabled',
  WITHHELD: 'withheld',
  UNCLASSIFIED: 'unclassified'
});

// Said to the AGENT, never to a person. The tools stay advertised at every
// level that admits local writes so this sentence can be informative; a tool
// that vanished would read as a breakage (the research.run_submit posture).
const REFUSAL_WHEN_OFF = 'Agents may not file standing rules on this computer: "Who adds standing rules" in Settings does not include agents. '
  + 'Nothing was filed. Do not ask the person whether to file it, do not suggest a rule, and do not offer to change the setting; '
  + 'the ledger is theirs to add to, on the Ledger page. Carry on with the work.';

// Reachable only through the internal PROPOSE mode (no setting selects it);
// kept so the tools answer sensibly if a host ever hands them that mode.
const REFUSAL_WHEN_PROPOSE_ONLY = 'Agents may suggest a standing rule here but not file one. '
  + 'Call r_ledger.propose with the same words; the person accepts or declines it in the rules panel.';

function provenanceOf(settings, settingId) {
  const recorded = settings && settings.provenance ? settings.provenance[settingId] : null;
  if (!recorded || typeof recorded !== 'object') return { source: 'default', atMs: 0, directive: null };
  return {
    source: typeof recorded.source === 'string' ? recorded.source : 'default',
    atMs: Number.isFinite(recorded.atMs) ? recorded.atMs : 0,
    directive: recorded.directive === undefined ? null : recorded.directive
  };
}

function classified(settings, settingId) {
  return Boolean(settings && settings.values
    && Object.prototype.hasOwnProperty.call(settings.values, settingId));
}

/* The nested sub-setting, read by the same three rules: absent is off, only
   the boolean true is on, and only user/installer provenance counts. */
function askWhenUnsureOf(settings) {
  if (!classified(settings, ASK_WHEN_UNSURE_SETTING_ID)) return false;
  if (settings.values[ASK_WHEN_UNSURE_SETTING_ID] !== true) return false;
  return CHOOSING_PROVENANCE.has(provenanceOf(settings, ASK_WHEN_UNSURE_SETTING_ID).source);
}

/* May the person type /Request in a chat, or do they add rules on the Ledger
   page alone? Read off the three-way choice by the same rules as its siblings:
   only a user/installer "Ledger page only" turns the chat command off; absent,
   unchosen or anything else leaves it on, because a person's own way of filing
   is not something silence should take away. */
function chatFilingOf(settings) {
  if (!classified(settings, FILING_FROM_SETTING_ID)) return true;
  if (settings.values[FILING_FROM_SETTING_ID] !== FILING_FROM.PAGE) return true;
  return !CHOOSING_PROVENANCE.has(provenanceOf(settings, FILING_FROM_SETTING_ID).source);
}

function filingFromOf(settings) {
  const value = classified(settings, FILING_FROM_SETTING_ID) ? settings.values[FILING_FROM_SETTING_ID] : undefined;
  return Object.values(FILING_FROM).includes(value) ? value : null;
}

/* Does a rule an agent files wait for the person's approval? The same three
   rules: absent is off, only the boolean true is on, and only user/installer
   provenance counts. The store reads this to choose 'proposed' over 'open'. */
function agentFiledNeedsApprovalOf(settings) {
  if (!classified(settings, NEEDS_APPROVAL_SETTING_ID)) return false;
  if (settings.values[NEEDS_APPROVAL_SETTING_ID] !== true) return false;
  return CHOOSING_PROVENANCE.has(provenanceOf(settings, NEEDS_APPROVAL_SETTING_ID).source);
}

/**
 * The pure decision over a resolved settings document (src/lib/settings.js
 * loadSettings() shape). Returns { mode, state, value, provenance, why,
 * askWhenUnsure }. `mode` is the answer the tools act on; `askWhenUnsure` is
 * the sub-setting the contract paragraph reads; the rest is the sentence
 * behind the answer.
 */
/* WHY THE SETTINGS LAYER COULD NOT BE READ, when that is the reason.
 *
 * loadSettings does not throw on a damaged file -- it reports the failure in
 * `rejected`, under the id "*" for a document-level problem. This gate never
 * looked, so a truncated, locked, or directory-shaped settings.json produced the
 * SAME sentence as a person who had genuinely switched the feature off:
 * `"rules.agent_filing" is off.` Measured byte-identical across four states,
 * including first run with no file at all.
 *
 * The cost is not the refusal -- off is the right answer either way, and this
 * gate is correct to fail closed. The cost is the sentence: an agent tells the
 * person their switch is off in Settings and invites them to turn it on, while
 * their stored `true` has been discarded along with every other value in the
 * file, and the Settings page shows every row back at its default with no
 * explanation. Their likeliest reading is that the product forgot their choices.
 *
 * This gate's own docstring already promised the opposite: "Fails closed: an
 * unreadable registry or settings layer answers off WITH THE REASON, never a
 * throw." Half of that was true. */
function layerFailure(settings) {
  const entries = settings && Array.isArray(settings.rejected) ? settings.rejected : [];
  const document = entries.find(entry => entry && entry.id === '*');
  const reason = document && typeof document.reason === 'string' ? document.reason.trim() : '';
  return reason || null;
}

/* Appended rather than substituted: "off" is still the truthful state and the
 * caller still needs it. What changes is that the person is no longer told a
 * choice they did not make explains it. */
function withLayerFailure(why, settings) {
  const failure = layerFailure(settings);
  if (!failure) return why;
  return `${why} This computer's settings could not be read (${failure}), so no stored choice was available `
    + 'and every setting is reading as its default -- including this one. Nobody switched it off.';
}

function agentFilingMode({ settings } = {}) {
  const settingId = AGENT_FILING_SETTING_ID;
  const provenance = provenanceOf(settings, settingId);
  const askWhenUnsure = askWhenUnsureOf(settings);
  const needsApproval = agentFiledNeedsApprovalOf(settings);
  const chatFiling = chatFilingOf(settings);
  const filingFrom = filingFromOf(settings);
  // THE PERSON'S THREE-WAY CHOICE DECIDES WHEN THEY HAVE MADE IT. src/lib/
  // settings.js keeps the switch in step with it, but this decision must not
  // depend on that having run: a document handed in raw with the two rows
  // disagreeing answers from the row the person chose, never from the older
  // switch. "Agents too" is the switch's on; the other two are its off.
  if (filingFrom && CHOOSING_PROVENANCE.has(provenanceOf(settings, FILING_FROM_SETTING_ID).source)) {
    const chosen = provenanceOf(settings, FILING_FROM_SETTING_ID);
    if (filingFrom === FILING_FROM.AGENTS) {
      return Object.freeze({ settingId: FILING_FROM_SETTING_ID, mode: MODES.AUTO, state: GATE_STATE.ENABLED, value: filingFrom, provenance: chosen, askWhenUnsure, needsApproval, chatFiling, filingFrom, why: null });
    }
    return Object.freeze({
      settingId: FILING_FROM_SETTING_ID, mode: MODES.OFF, state: GATE_STATE.WITHHELD, value: filingFrom, provenance: chosen, askWhenUnsure, needsApproval, chatFiling, filingFrom,
      why: withLayerFailure(`"${FILING_FROM_SETTING_ID}" is "${filingFrom}", which keeps the rules ledger to the person.`, settings)
    });
  }
  if (!classified(settings, settingId)) {
    return Object.freeze({
      settingId, mode: MODES.OFF, state: GATE_STATE.UNCLASSIFIED, value: undefined, provenance, askWhenUnsure, needsApproval, chatFiling, filingFrom,
      why: withLayerFailure(`"${settingId}" has no entry in the settings registry, so there is no control a person could have used to allow this. `
        + 'An unclassified system is off, not enabled by silence.', settings)
    });
  }
  const value = settings.values[settingId];
  const mode = modeOfValue(value);
  if (mode === null) {
    return Object.freeze({
      settingId, mode: MODES.OFF, state: GATE_STATE.WITHHELD, value, provenance, askWhenUnsure, needsApproval, chatFiling, filingFrom,
      why: withLayerFailure(`"${settingId}" is set to ${JSON.stringify(value)}, which is not on or off. Anything but a real on is off.`, settings)
    });
  }
  if (mode === MODES.OFF) {
    return Object.freeze({ settingId, mode, state: GATE_STATE.WITHHELD, value, provenance, askWhenUnsure, needsApproval, chatFiling, filingFrom, why: withLayerFailure(`"${settingId}" is off.`, settings) });
  }
  if (!CHOOSING_PROVENANCE.has(provenance.source)) {
    return Object.freeze({
      settingId, mode: MODES.OFF, state: GATE_STATE.WITHHELD, value, provenance, askWhenUnsure, needsApproval, chatFiling, filingFrom,
      why: withLayerFailure(`"${settingId}" reads as "${value}", but its provenance is "${provenance.source}" -- a built-in default, not a choice this `
        + 'person or their installer made. A control enforcing a value nobody chose is a software failure, so this stays off '
        + 'until someone actually sets it.', settings)
    });
  }
  return Object.freeze({ settingId, mode, state: GATE_STATE.ENABLED, value, provenance, askWhenUnsure, needsApproval, chatFiling, filingFrom, why: null });
}

/**
 * The decision against the live settings files. Fails closed: an unreadable
 * registry or settings layer answers off with the reason, never a throw -- a
 * session must not fail to start over this, and a tool must not file over it.
 */
function loadAgentFilingMode({ valuesPath, env } = {}) {
  try {
    const { loadSettings } = require('./settings');
    return agentFilingMode({ settings: loadSettings({ valuesPath, env }) });
  } catch (error) {
    return Object.freeze({
      settingId: AGENT_FILING_SETTING_ID, mode: MODES.OFF, state: GATE_STATE.WITHHELD, value: undefined,
      provenance: { source: 'default', atMs: 0, directive: null }, askWhenUnsure: false, needsApproval: false, chatFiling: true, filingFrom: null,
      why: `the settings could not be read (${error && error.code ? error.code : 'unreadable'}); agent filing stays off.`
    });
  }
}

// ---------------------------------------------------------------------------
// THE JUDGEMENT DOOR: the paragraph the host hands an agent with its standing
// requests. One text per mode, exported from the engine so the host and the
// onboarding packet cannot drift. The `off` text is the host's pre-O7
// constant byte-for-byte (shell/agent-host.cjs REQUEST_CONTRACT_PARAGRAPH):
// a session with the switch off must read exactly as it did before.
// ---------------------------------------------------------------------------

// Said to an agent whose person keeps the ledger to themselves (rules.filing_from
// is not "Agents too"). The owner, 2026-09-15: "agents shouldnt ask if its
// disabled either" -- off means no filing, no proposing and no asking, so the
// closing sentence is the same in both forms; only the door the person uses
// differs. The first form is the host's pre-O7 constant with that sentence
// appended; the second is for a person who types no /Request at all.
const PARAGRAPH_NO_ASKING = 'Agents do not file, propose or ask about standing rules on this computer: when something the person says sounds like a rule, do not offer to record it and do not end your reply with a question about it — carry on with the work and leave the ledger to them.';

const PARAGRAPH_OFF = 'If the person types /Request, /RequestSession, /RequestTree, or /RequestThread here, ToolsEnabled itself files their words as a standing rule — you need no tool for that and should not act on the command yourself; the chat shows the person the confirmation, and the rules above are read again at each session start. '
  + PARAGRAPH_NO_ASKING;

const PARAGRAPH_OFF_PAGE_ONLY = 'The person adds standing rules by hand on the Ledger page; the typed rule commands are turned off in their Settings, so do not suggest typing one. '
  + PARAGRAPH_NO_ASKING;

const PARAGRAPH_OPENING = 'If the person types /Request, /RequestSession, /RequestTree, or /RequestThread here, ToolsEnabled itself files their words — do not act on the command yourself.';

const PARAGRAPH_JUDGEMENT = 'Never propose or file the task at hand, an "ok", your own inference, a paraphrase, or anything that looks like a secret, password, key or token (say you did not file it). '
  + 'A fact with evidence goes to research.finding_save; a piece of work for later goes in your reply as "I would queue that".';

const PARAGRAPH_PROPOSE = `${PARAGRAPH_OPENING} `
  + 'You may also SUGGEST a rule: when the person says, in their own words, something meant to hold beyond this reply — a preference, a limit, a way they want things done — '
  + 'call r_ledger.propose with their exact words, the scope and key named in the block above (global; session <id>; tree <anchor>; thread <id>), and one line saying why. '
  + 'The person sees the suggestion and accepts or declines it; nothing is filed until they do. '
  + `${PARAGRAPH_JUDGEMENT} If unsure, ask in one sentence.`;

const PARAGRAPH_AUTO_LEAD = `${PARAGRAPH_OPENING} `
  + 'You file the person\'s standing rules for them: when the person says, in their own words, something meant to hold beyond this reply — a preference, a limit, a way they want things done — '
  + 'call r_ledger.file with their exact words, the scope and key named in the block above, and one line saying why; the chat shows them what you filed and where, and every later session reads it. '
  + 'Scope: meant for all agents → global; "this session" or "today" → session; "you and your helpers" → tree; "in this conversation" → thread; ';

const PARAGRAPH_AUTO = `${PARAGRAPH_AUTO_LEAD}`
  + 'unclear → the narrowest, and say so. '
  + `${PARAGRAPH_JUDGEMENT} If unsure, call r_ledger.propose instead.`;

// The same paragraph with the person's "ask me when unsure" sub-setting on
// (rules.ask_when_unsure): doubt files nothing and ends the reply with one
// question; the person's yes files their original sentence, never a rewrite.
const PARAGRAPH_AUTO_ASK = `${PARAGRAPH_AUTO_LEAD}`
  + 'unclear or unsure → file nothing; end your reply with ONE short question; when the person answers yes, file their ORIGINAL sentence. '
  + `${PARAGRAPH_JUDGEMENT}`;

const PARAGRAPH_WITHHELD = 'The person has asked agents to watch for standing rules, but this permission level withholds the filing tool. '
  + 'When something they say is meant to hold from now on, say so plainly and suggest they type /Request, /RequestSession, /RequestTree or /RequestThread — ToolsEnabled files it. Do not look for another route.';

const PARAGRAPH_WITHHELD_PAGE_ONLY = 'The person has asked agents to watch for standing rules, but this permission level withholds the filing tool. '
  + 'When something they say is meant to hold from now on, say so plainly and suggest they add it on the Ledger page. Do not look for another route.';

// Appended to the auto paragraphs when the person's "approve first" sub-setting
// is on (rules.agent_filed_needs_approval): the agent must not act as if a
// rule it filed already held.
const PARAGRAPH_NEEDS_APPROVAL = ' A rule you file waits for the person\'s approval on the Ledger page before it counts.';

/**
 * @param {string} mode   'off' | 'propose' | 'auto' (anything else reads as off)
 * @param {{canFile?: boolean, askWhenUnsure?: boolean, needsApproval?: boolean, chatFiling?: boolean}} options
 *        whether this session actually carries the r_ledger tools (servers
 *        running, profile not read-only), whether the person's "ask me when
 *        unsure" sub-setting is on (loadAgentFilingMode().askWhenUnsure),
 *        whether an agent-filed rule waits for approval
 *        (loadAgentFilingMode().needsApproval), and whether the person may type
 *        /Request in a chat at all (loadAgentFilingMode().chatFiling; false is
 *        "Ledger page only", where the commands must not be suggested)
 */
function requestContractParagraph(mode, { canFile = false, askWhenUnsure = false, needsApproval = false, chatFiling = true } = {}) {
  if (mode !== MODES.PROPOSE && mode !== MODES.AUTO) return chatFiling === false ? PARAGRAPH_OFF_PAGE_ONLY : PARAGRAPH_OFF;
  if (!canFile) return chatFiling === false ? PARAGRAPH_WITHHELD_PAGE_ONLY : PARAGRAPH_WITHHELD;
  if (mode !== MODES.AUTO) return PARAGRAPH_PROPOSE;
  const paragraph = askWhenUnsure === true ? PARAGRAPH_AUTO_ASK : PARAGRAPH_AUTO;
  return needsApproval === true ? `${paragraph}${PARAGRAPH_NEEDS_APPROVAL}` : paragraph;
}

// ---------------------------------------------------------------------------
// THE WORDS DOOR: pure judgements over the words an agent offers, exported so
// the tests and any other reader can hold them to account without a ledger,
// a spool or a settings file in hand.
// ---------------------------------------------------------------------------

/* Whitespace is the only thing normalised, anywhere in this module: runs of
   it collapse to one space and the ends are trimmed. Case, punctuation and
   spelling are the person's and are compared as typed. */
function normaliseForMatch(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

// A bare assent or refusal is an answer to something, not a rule. Three words
// at most, every one of them from this list, and the whole thing is refused.
const ASSENT_WORDS = Object.freeze(new Set([
  'ok', 'okay', 'k', 'kk', 'yes', 'yep', 'yeah', 'yup', 'y', 'ya', 'sure', 'no', 'nope', 'nah', 'n',
  'fine', 'right', 'agreed', 'agree', 'go', 'ahead', 'do', 'it', 'please', 'pls', 'thanks', 'thank', 'you',
  'alright', 'correct', 'affirmative', 'negative', 'good', 'great', 'cool', 'sounds', 'proceed', 'continue'
]));

function isAssent(words) {
  const tokens = normaliseForMatch(words).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 3 && tokens.every(token => ASSENT_WORDS.has(token));
}

/* "Looks like a secret" is the audit module's scrubber's call first: if
   scrubbing the words would change them, they carry something shaped like a
   password, key or token, and they are not filed. The scrubber is injectable
   for the tests; the default is audit's, loaded lazily so the host can read
   the paragraph above without paying for it. Two narrow shapes the scrubber
   lets through are added here and nowhere else: a bare "token:" / "secret:"
   style prefix with a value after it (the scrubber wants a word before
   "token"), and one unbroken run of forty or more letters-and-digits, which
   is a key's shape and not a sentence's. */
const BARE_SECRET_PREFIX = /\b(?:token|secret|password|passwd|pwd|passphrase|otp)\s*[=:]\s*\S+/i;
const LONG_TOKEN_RUN = /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}/;
function looksSecretShaped(words, { scrub } = {}) {
  const text = String(words === undefined || words === null ? '' : words);
  if (!text) return false;
  const cleaner = typeof scrub === 'function' ? scrub : value => require('./audit').scrubText(value, Math.max(1, value.length));
  return cleaner(text) !== text || BARE_SECRET_PREFIX.test(text) || LONG_TOKEN_RUN.test(text);
}

/* Verbatim: after whitespace normalisation only, the words are a contiguous
   slice of at least one of the person's turns. */
function isVerbatimSlice(words, turns) {
  const needle = normaliseForMatch(words);
  if (!needle) return false;
  return (Array.isArray(turns) ? turns : []).some(turn => normaliseForMatch(turn).includes(needle));
}

/* Against the entries already standing in one ledger: { kind: 'equal', entry }
   when the normalised words are the same (nothing new to write);
   { kind: 'refinement', entry } when the new words contain, or are contained
   by, a standing entry's words (file under it); null otherwise. An exact
   match wins over a refinement; among refinements the closest fit -- the
   standing entry nearest the new words in length, so a refinement of a
   refinement nests under the refinement, not the root -- is the parent, and
   ties go to reading order. */
function findStanding(entries, words) {
  const needle = normaliseForMatch(words);
  if (!needle) return null;
  const list = Array.isArray(entries) ? entries : [];
  const exact = list.find(entry => normaliseForMatch(entry && entry.words) === needle);
  if (exact) return Object.freeze({ kind: 'equal', entry: exact });
  let related = null;
  let distance = Infinity;
  for (const entry of list) {
    const standing = normaliseForMatch(entry && entry.words);
    if (!standing || !(standing.includes(needle) || needle.includes(standing))) continue;
    const apart = Math.abs(standing.length - needle.length);
    if (apart < distance) { related = entry; distance = apart; }
  }
  return related ? Object.freeze({ kind: 'refinement', entry: related }) : null;
}

/* Which agent a spooled turn was typed to. The product's record names the
   agent actor directly when it has one; the engine's own ingress hook names
   the harness in `source` ("claude-code/UserPromptSubmit", "codex/..."), and
   the harness family is the actor. A record that names neither belongs to no
   actor and never counts for one. */
const AGENT_ACTORS = Object.freeze(new Set(['human', 'codex', 'claude', 'gemini', 'grok', 'local']));
function recordActor(record) {
  const direct = String(record && record.actor ? record.actor : '').trim().toLowerCase();
  if (AGENT_ACTORS.has(direct)) return direct;
  const family = String(record && record.source ? record.source : '').split('/')[0].split('-')[0].trim().toLowerCase();
  return AGENT_ACTORS.has(family) ? family : null;
}

/* The person's turns as the product spooled them -- every owner-capture
   record, pending and reconciled alike, with mode "ingress" -- read from the
   spool beside the R ledgers (the r-ledger-proposals anchor). With a session
   id: that session's turns (a turn that names a different actor still does
   not count). Without one: every turn typed to this actor, in any session,
   and nothing typed to another actor. Returns null ONLY when there is no
   spool directory at all -- the one case the caller may skip the check in --
   and otherwise an array, empty when nothing matches. Any failure to inspect
   an existing spool throws: an unreadable spool cannot honestly prove that
   the person's words are absent. */
function spooledTurns({ sessionId = null, actor = null } = {}, options = {}) {
  const spool = require('./owner-capture-spool');
  const anchor = require('./r-ledger-proposals').anchorFile(options);
  const fsImpl = options.fsImpl || fs;
  const spoolDirectory = spool.spoolDirectory(anchor);
  let spoolStat;
  try { spoolStat = fsImpl.statSync(spoolDirectory); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw spoolReadError(spoolDirectory, error);
  }
  if (!spoolStat.isDirectory()) throw spoolReadError(spoolDirectory, new Error('spool path is not a directory'));
  const wantedSession = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  const who = typeof actor === 'string' && actor.trim() ? actor.trim().toLowerCase() : null;
  const texts = [];
  for (const directory of [spool.pendingDirectory(anchor), spool.reconciledDirectory(anchor)]) {
    let names;
    try { names = fsImpl.readdirSync(directory); }
    catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw spoolReadError(directory, error);
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let record;
      const recordFile = path.join(directory, name);
      try { record = JSON.parse(fsImpl.readFileSync(recordFile, 'utf8')); }
      catch (error) { throw spoolReadError(recordFile, error); }
      if (!record || record.mode !== 'ingress' || typeof record.text !== 'string' || !record.text.trim()) continue;
      const typedTo = recordActor(record);
      if (who && typedTo && typedTo !== who) continue;
      if (wantedSession ? record.threadId === wantedSession : (who !== null && typedTo === who)) texts.push(record.text);
    }
  }
  return texts;
}

function spoolReadError(target, cause) {
  const error = new Error(`The person's turn spool could not be read at ${target}; verbatim presence is unknown.`);
  error.code = 'R_LEDGER_SPOOL_UNREADABLE';
  error.cause = cause;
  return error;
}

// ---------------------------------------------------------------------------
// THE AUTHORITY DOOR: what the r_ledger.* tools actually run. Order, fixed:
// audit intent first (refuse unless durably recorded, the providers/research.js
// posture -- a write nobody can later find is a write nobody authorised), then
// the gate, then the ledger. Dependencies are injectable so the tests prove
// the door without a live settings file or audit ledger; the registry builds
// the default with the live ones. Requires are lazy: the host loads this
// module for the paragraph alone and must not pay for audit or SQLite.
// ---------------------------------------------------------------------------

// Every refusal on this door ends by naming the next move, because the turn it
// interrupts is the person's request and an agent that is only told "no" files
// nothing and says nothing -- which is how the person's words came to settle as
// "agent read it and filed nothing" 228 times (measured 2026-09-03).
const REFUSAL_ASSENT = 'A bare yes, no or ok is an answer, not a standing rule; nothing was filed. '
  + 'If the person meant a rule, file the sentence they actually typed, or tell them what you would have filed.';
const REFUSAL_SECRET = 'Those words look like a password, key or token, so they were not filed. Tell the person you did not file them.';
const REFUSAL_NOT_VERBATIM = 'Those words are not an exact slice of anything the person typed to you, so they were not filed. '
  + 'File the sentence exactly as they typed it, or tell them what you would have filed.';
const NOTE_SKIPPED_NO_SPOOL = ' Verbatim check skipped: this computer keeps no spool of the person\'s turns to check against.';
const VERBATIM_CHECKED_SESSION = 'checked: this session';
const VERBATIM_CHECKED_ACTOR = 'checked: every session of yours';
const VERBATIM_SKIPPED_NO_SPOOL = 'skipped: no spool';

class RLedgerAgentControl {
  constructor(dependencies = {}) {
    this.gate = dependencies.gate || (() => loadAgentFilingMode());
    this.auditRequire = dependencies.auditRequire || ((...args) => require('./audit').requireRecord(...args));
    this.auditEnabled = dependencies.auditEnabled || (() => require('./operation-audit').configured({ loadSettings: dependencies.loadSettings }));
    this.ledger = dependencies.ledger || require('./r-ledger');
    // The proposal spool is no longer written: a proposal is a 'proposed'
    // record in the one ledger. The dependency stays accepted so an older
    // host that still passes it is not refused.
    this.proposals = dependencies.proposals || null;
    this.ledgerOptions = dependencies.ledgerOptions || {};
    // The person's spooled turns and the secret scrubber are injectable so
    // the tests prove the door without a spool or the audit module; the
    // defaults read the product's spool and audit's scrubber. A turns reader
    // answers null for "no spool at all" and an array otherwise.
    this.turns = dependencies.turns || (selector => spooledTurns(selector, this.ledgerOptions));
    this.scrub = dependencies.scrub || null;
  }

  /* The words door, in order: a bare assent, a secret shape, then verbatim
     against the person's turns -- this session's when the call names one,
     else every session of this actor's. Returns how the verbatim check went
     so the result can say so; throws a typed refusal otherwise. The only
     skip is a computer with no spool at all. */
  _checkWords(args) {
    const { RLedgerError } = this.ledger;
    if (isAssent(args.words)) throw new RLedgerError('R_LEDGER_WORDS_REFUSED', REFUSAL_ASSENT);
    if (looksSecretShaped(args.words, { scrub: this.scrub })) throw new RLedgerError('R_LEDGER_WORDS_REFUSED', REFUSAL_SECRET);
    const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : null;
    const turns = this.turns({ sessionId, actor: args.actor });
    if (turns === null) return { verbatim: VERBATIM_SKIPPED_NO_SPOOL, note: NOTE_SKIPPED_NO_SPOOL };
    if (!isVerbatimSlice(args.words, turns)) throw new RLedgerError('R_LEDGER_WORDS_NOT_VERBATIM', REFUSAL_NOT_VERBATIM);
    return { verbatim: sessionId ? VERBATIM_CHECKED_SESSION : VERBATIM_CHECKED_ACTOR, note: '' };
  }

  _audit(action, target, details) {
    if (!this.auditEnabled()) return require('./operation-audit').skippedStatus(action, target);
    const intent = this.auditRequire(action, target, details);
    if (!intent || intent.durable !== true) {
      const { RLedgerError } = this.ledger;
      throw new RLedgerError('R_LEDGER_AUDIT_REQUIRED', 'The standing rule was not filed because its audit intent was not durably recorded.');
    }
    return intent;
  }

  _decide(tool, args) {
    // Bounded tokens only in the audit row: the scope word, the key's length
    // class and the actor -- never the words themselves (they may be anything
    // the person said) and never the key (a session or thread id).
    this._audit(tool, `r-ledger:${args.scope}`, { actor: args.actor, scope: args.scope, keyed: args.scope !== 'global' });
    const decision = this.gate();
    if (decision.mode === MODES.OFF) {
      const { RLedgerError } = this.ledger;
      throw new RLedgerError('R_LEDGER_AGENT_FILING_OFF', `${REFUSAL_WHEN_OFF} (${decision.why || 'off'})`);
    }
    return decision;
  }

  /** r_ledger.file: append the person's words under the agent's name -- or,
   *  when the same words already stand, answer with that entry; when they
   *  refine a standing entry, file under it. Words that pass are filed
   *  byte-identical (r-ledger.js trims the ends and nothing else). */
  file(args) {
    const decision = this._decide('r_ledger.file', args);
    if (decision.mode !== MODES.AUTO) {
      const { RLedgerError } = this.ledger;
      throw new RLedgerError('R_LEDGER_AGENT_FILING_PROPOSE_ONLY', REFUSAL_WHEN_PROPOSE_ONLY);
    }
    const check = this._checkWords(args);
    // The layer read here asks for rows still waiting for the person by name
    // (a plain read never hands them out), so the same words offered twice
    // while the first waits answer alreadyStanding instead of filing a second
    // waiting row -- and say that it waits, never that it is on file.
    const standing = this.ledger.readLedger(args.scope, args.key, { ...(this.ledgerOptions || {}), includeProposed: true });
    const match = findStanding(standing.entries, args.words);
    const appliesTo = this.ledger.SCOPE_WORD[args.scope];
    if (match && match.kind === 'equal') {
      const waiting = match.entry.status === 'proposed';
      return Object.freeze({
        filed: false, alreadyStanding: true, id: match.entry.id, scope: args.scope, key: standing.key, appliesTo, verbatim: check.verbatim,
        status: match.entry.status, awaitingApproval: waiting,
        note: waiting
          ? `Already filed as ${match.entry.id} and waiting for the person's approval on the Ledger page — nothing new was written. It does not count until they approve it; say so.${check.note}`
          : `Already standing as ${match.entry.id} — nothing new was written. Tell the person it was already on file.${check.note}`
      });
    }
    const parentId = match ? match.entry.id : null;
    // The gate decision already read the person's "approve first" row; hand
    // it to the store so the settings file is read once per call, by the one
    // door that reads it.
    const filed = this.ledger.fileRequest({
      scope: args.scope, key: args.key, words: args.words, filedBy: args.actor, parentId,
      source: `r_ledger.file by ${args.actor}; verbatim ${check.verbatim}`, why: args.why
    }, { ...this.ledgerOptions, needsApproval: decision.needsApproval === true });
    const awaitingApproval = filed.status === 'proposed';
    const what = parentId
      ? `Filed your refinement as ${filed.id} under ${parentId} — a standing rule for ${appliesTo}.`
      : `Filed ${filed.id} — a standing rule for ${appliesTo}.`;
    const note = awaitingApproval
      ? `${what} It waits for the person's approval on the Ledger page before it counts; say so.${check.note}`
      : `${what} Tell the person what you filed and where; they edit or delete it on the Ledger page.${check.note}`;
    return Object.freeze({
      filed: true, id: filed.id, parentId: filed.parentId, scope: filed.scope, key: filed.key, filedBy: filed.filedBy, stamp: filed.stamp,
      appliesTo, verbatim: check.verbatim, status: filed.status, awaitingApproval, note
    });
  }

  /** r_ledger.propose: file the person's words as a suggestion that waits for
   *  them on the Ledger page -- a 'proposed' record in the one ledger, never in
   *  force until they approve it. The same words door applies. */
  propose(args) {
    this._decide('r_ledger.propose', args);
    const check = this._checkWords(args);
    const standing = this.ledger.readLedger(args.scope, args.key, { ...(this.ledgerOptions || {}), includeProposed: true });
    const match = findStanding(standing.entries, args.words);
    const appliesTo = this.ledger.SCOPE_WORD[args.scope];
    if (match && match.kind === 'equal') {
      const waiting = match.entry.status === 'proposed';
      return Object.freeze({
        filed: false, alreadyStanding: true, id: match.entry.id, proposalId: match.entry.id, scope: args.scope, key: standing.key, appliesTo, verbatim: check.verbatim,
        status: match.entry.status, awaitingApproval: waiting,
        note: waiting
          ? `Already suggested as ${match.entry.id} and waiting for the person's approval on the Ledger page — nothing new was written. It does not count until they approve it; say so.${check.note}`
          : `Already on file as ${match.entry.id} — nothing new was written. Tell the person it was already there.${check.note}`
      });
    }
    const parentId = match ? match.entry.id : null;
    const filed = this.ledger.fileRequest({
      scope: args.scope, key: args.key, words: args.words, filedBy: args.actor, parentId, proposed: true,
      source: `r_ledger.propose by ${args.actor}; verbatim ${check.verbatim}`, why: args.why
    }, this.ledgerOptions);
    return Object.freeze({
      filed: false, proposalId: filed.id, id: filed.id, parentId: filed.parentId, scope: filed.scope, key: filed.key, proposedBy: args.actor,
      appliesTo, verbatim: check.verbatim, status: filed.status, awaitingApproval: true,
      note: `Suggested ${filed.id} — a standing rule for ${appliesTo}. It waits for the person to approve or decline it on the Ledger page; say so.${check.note}`
    });
  }
}

module.exports = Object.freeze({
  /* Exported for the cross-list pin in tests/owner-host-agent-actors.test.js.
     This set and the owner host's own are separate on purpose -- this one
     answers "who typed this turn", which includes the person as well as all
     supported model sessions -- they drifted apart unnoticed once, so the difference
     between them is now asserted rather than assumed. */
  AGENT_ACTORS,
  AGENT_FILING_SETTING_ID,
  ASK_WHEN_UNSURE_SETTING_ID,
  NEEDS_APPROVAL_SETTING_ID,
  FILING_FROM_SETTING_ID,
  FILING_FROM,
  agentFiledNeedsApprovalOf,
  chatFilingOf,
  filingFromOf,
  RLedgerAgentControl,
  CHOOSING_PROVENANCE,
  GATE_STATE,
  MODES,
  OPTIONS,
  modeOfValue,
  REFUSAL_WHEN_OFF,
  REFUSAL_WHEN_PROPOSE_ONLY,
  agentFilingMode,
  loadAgentFilingMode,
  requestContractParagraph,
  normaliseForMatch,
  isAssent,
  looksSecretShaped,
  isVerbatimSlice,
  findStanding,
  spooledTurns
});
