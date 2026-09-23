'use strict';
/**
 * WHICH RUNNING AGENTS SHOULD MOVE TO ANOTHER ACCOUNT, AND WHICH MUST NOT.
 *
 * The rest of this folder answers "which account should a start use". Once a
 * session is running its account is fixed: the confined home is pinned into the
 * plan and into the child's environment before the first turn, so nothing about
 * a session in flight can change its mind. When its account reaches a limit,
 * that session keeps spending an allowance the person has already said they
 * want left alone, and it keeps spending it until the work happens to end.
 *
 * The owner's words, 2026-09-03: "let them set a sliding percentage like 90% at
 * which point we begin moving agents over and checking first before dumping
 * them". This file is the "begin moving agents over" half, and the "checking
 * first" half is the rule it will not break.
 *
 * THE MOVE IS A CREDENTIAL SWAP UNDER A LIVE SESSION, NOT A RESTART, and the
 * difference is the entire point (owner, 2026-09-03: "our goal is to prevent
 * the session token change cost like vscode does. there is no recontexting").
 * Stopping a session and resuming its thread would move it, and it would cost
 * the conversation over again: a resumed session re-reads its transcript, comes
 * up with a cold prompt cache, and re-establishes everything it had already
 * established. Paying for the whole conversation a second time to save an
 * allowance is the trade this feature exists to avoid making. So the session's
 * process, its thread and its context all stay exactly where they are, and only
 * the credential underneath them changes.
 *
 * WHAT IS MISSING IS THE DECISION, WHICH IS WHAT THIS FILE IS -- which sessions,
 * to where, and when to refuse to move one. It is worth separating from the
 * machinery that carries it out, because this half can be proven at a desk and
 * that half cannot.
 *
 * AND FOR CLAUDE THAT MACHINERY CANNOT BE BUILT THE OBVIOUS WAY. MEASURED
 * 2026-09-03 on this machine, and it cost two sign-ins to learn:
 *
 *   * A CREDENTIAL USED IN A SECOND PLACE IS DESTROYED IN THE FIRST. Two
 *     accounts' homes were copied to scratch directories and a `claude` child
 *     was run against each copy. Within minutes BOTH original homes went from a
 *     509-byte signed-in credential to a 281-byte signed-out one, and the auth
 *     probe reported `signed_out` for both. The four accounts not copied were
 *     untouched. The CLI refreshes on start and the provider rotates the refresh
 *     token, so the copy wins and the original is dead. This is why
 *     prepareConfinedClaudeHome() is withheld from the shipped path; that note
 *     called it a risk, and it is now a measurement.
 *
 *   * A LIVE CHILD DOES NOT RE-READ ITS CREDENTIAL. One child was held open
 *     while its whole config directory was replaced with another account's --
 *     verified on disk by hashing the credential either side of the question --
 *     and its next zero-token `get_usage` still answered with the FIRST
 *     account's windows.
 *
 * WHY VS CODE APPEARS TO MANAGE IT, since the question is bound to come up
 * again. Read out of claude.exe 2.1.259: the control channel carries
 * `set_model` and `set_permission_mode`, so the CLI does change some things
 * mid-session -- but there is no `set_auth`, `set_credential`, `switch_account`
 * or `refresh_auth`, which is why replacing the file underneath it does
 * nothing. `accountSwitch` DOES exist inside the binary, beside `/login` and
 * `/logout`. So the CLI can change account in-process, and that interactive
 * flow is what VS Code drives. It needs a person and a browser, so it cannot
 * be driven by a threshold across six accounts, which is what was asked for.
 *
 * AND THAT LAST DOOR IS SHUT TOO, measured 2026-09-03 at no cost and with no
 * account harmed. Slash commands ARE text on the input stream and the CLI does
 * intercept them there: sending "/status" to a child in `-p --input-format
 * stream-json` mode came back "/status isn't available in this environment."
 * with total_cost_usd 0, so the CLI answered it rather than the model. Sending
 * "/login" the same way answered "/login isn't available in this environment.",
 * also for nothing, and the credential on disk was byte-identical either side.
 * The command is recognised and gated: auth is interactive-only, which is why
 * VS Code can offer it and a scheduler cannot.
 *
 * (Both probes had to pass the text through an environment variable. This shell
 * rewrites anything path-shaped, and it turned "/status" into
 * "C:/Program Files/Git/status", which the MODEL then answered as ordinary
 * prose -- a result that reads exactly like "the CLI ignores slash commands"
 * when nothing of the sort had been tested.)
 *
 * So a Claude session's account is fixed for the life of its process, and the
 * cost-free move this file was written for does not exist on this CLI today. What
 * remains true and useful is the decision itself: the same answer tells a person
 * which agents are sitting on a spent account, and it is what any later move --
 * by a provider that can be moved, or by a CLI that grows the ability -- would
 * be driven by. Nothing here acts on its own.
 *
 * NOTHING HERE HAS A CLOCK, A FILE OR A CHILD PROCESS. Everything it needs is
 * passed in, so every rule below is checkable in a test that starts no program.
 *
 * THE RULE THAT MATTERS MOST: A SESSION IS NEVER MOVED OFF AN ACCOUNT UNLESS
 * SOMEWHERE PROVEN BETTER EXISTS. A spent account still answers turns until its
 * window resets. Moving an agent to nowhere, or to an account nobody measured,
 * would turn "you are near your weekly limit" into "your work stopped", which
 * is a worse outcome than the one the limit exists to avoid. When there is no
 * proven target the session is HELD, with a reason a person can read, and it
 * carries on exactly as it was.
 */

const { spentWindow, windowLimits } = require('./usage-windows.js');

/* Why a session was moved or held. Codes rather than sentences, because the app
   says this in its own words on its own screen; a sentence here would be a
   second copy of the copy, free to drift from the one people read. */
const HANDOVER = Object.freeze({
  MOVED: 'HANDOVER_MOVED',
  HELD_NO_TARGET: 'HANDOVER_HELD_NO_TARGET',
  HELD_NOTHING_MEASURED: 'HANDOVER_HELD_NOTHING_MEASURED',
  /* THE TWO SILENCES A SESSION CAN SIT IN, and they are not "held". A held
     session was considered and left alone; these two were never judged at all,
     because nothing measured the account it is on. handoverPlan() drops them --
     draining(null) is false, correctly -- and a report that let them fall out
     the same way would show a fleet with nothing to move on a computer where
     the check simply never ran. */
  UNKNOWN_ACCOUNT_NOT_READ: 'HANDOVER_UNKNOWN_ACCOUNT_NOT_READ',
  UNKNOWN_NOTHING_READ: 'HANDOVER_UNKNOWN_NOTHING_READ',
});

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/* The reading for one account, however the caller keeps them: a Map, as
   rotation.js builds, or a plain table. An account nobody read has no reading,
   which is a different fact from a reading that says nothing is left. */
function readingLookup(readings) {
  if (readings instanceof Map) return name => readings.get(name) || null;
  if (plainObject(readings)) return name => readings[name] || null;
  return () => null;
}

/**
 * Is this account past a limit of its own?
 *
 * Two things count and they are not the same. A reading that says `canServe`
 * false is the account itself saying it has nothing left, which is true whether
 * or not it reported a percentage. A window past its own limit is the person's
 * rule, which stops an account that would still answer. Either is enough to
 * start moving work off it; neither is enough to move work ONTO it.
 *
 * An account nobody could read is NOT draining. Failing to look is not an
 * answer about the account, which is the rule this whole folder is built on --
 * and treating silence as "spent" would empty a fleet every time a probe
 * timed out.
 */
function draining(reading, limits) {
  if (!plainObject(reading)) return false;
  if (reading.canServe === false) return true;
  return spentWindow(reading.windows, limits) !== null;
}

/**
 * Is this account somewhere a session can be moved TO?
 *
 * A stricter question than "is it draining", deliberately. It must have said
 * out loud that it can serve, and it must not be past a limit of its own.
 * Silence disqualifies it: moving an agent onto an account nobody measured is
 * the guess this file exists to refuse.
 */
function ready(reading, limits) {
  if (!plainObject(reading)) return false;
  if (reading.canServe !== true) return false;
  return spentWindow(reading.windows, limits) === null;
}

/**
 * Which running sessions should hand over, and to which account.
 *
 *   readings  name -> the reading health.js produced for that account
 *   limits    the registry's three exhaustion fields
 *   sessions  [{ sessionId, account }] -- the sessions running right now and the
 *             account each one is on, which is exactly what the app host's
 *             sessionAccountRows() answers; `id` is accepted for sessionId
 *   order     account names in the order this computer prefers them, which is
 *             whatever orderAccounts() produced under the person's chosen mode
 *
 * WHERE A MOVED AGENT LANDS IS WHERE A NEW ONE WOULD. The head of the same
 * order a start walks, skipping anything not proven ready. That is one rule
 * rather than two: a person who set "keep them even" gets agents spread as they
 * move, and a person who set "least room left first" gets them packed, without
 * this file knowing which of those it is doing. Inventing a spreading rule here
 * would be a second, invisible mode competing with the one they chose.
 *
 * Returns { moves, held, draining, ready }. Sessions on an account that is not
 * draining appear in neither list: there is nothing to decide about them, and
 * listing them as "held" would read as though something had been considered
 * and refused.
 */
function handoverPlan({ readings = null, limits = null, sessions = [], order = [] } = {}) {
  const inForce = windowLimits(plainObject(limits) ? limits : {});
  const readingFor = readingLookup(readings);
  const names = Array.isArray(order) ? order.filter(nonEmptyString) : [];

  const drainingNames = names.filter(name => draining(readingFor(name), inForce));
  const readyNames = names.filter(name => ready(readingFor(name), inForce));

  const moves = [];
  const held = [];
  const live = Array.isArray(sessions) ? sessions : [];
  for (const session of live) {
    if (!plainObject(session)) continue;
    /* `sessionId` is what the app's host calls it and what this function
       answers with, so it is the name read first. `id` is accepted beside it
       because the shape is obvious enough to write either way, and a plan that
       silently skipped every session over a field name would look exactly like
       a fleet with nothing to move. */
    const sessionId = nonEmptyString(session.sessionId) ? session.sessionId : session.id;
    if (!nonEmptyString(sessionId) || !nonEmptyString(session.account)) continue;
    if (!draining(readingFor(session.account), inForce)) continue;

    const target = readyNames.find(name => name !== session.account) || null;
    if (target === null) {
      /* Two different silences, told apart, because the answer a person needs
         is different. Nothing measured at all means the check could not run and
         is worth retrying; measured and none ready means every account is at
         its limit, and the honest next step is to raise a limit or wait for a
         window to reset. */
      const anyMeasured = names.some(name => plainObject(readingFor(name)));
      held.push({
        sessionId,
        from: session.account,
        why: anyMeasured ? HANDOVER.HELD_NO_TARGET : HANDOVER.HELD_NOTHING_MEASURED,
      });
      continue;
    }
    moves.push({ sessionId, from: session.account, to: target, why: HANDOVER.MOVED });
  }

  return Object.freeze({
    moves: Object.freeze(moves),
    held: Object.freeze(held),
    draining: Object.freeze(drainingNames),
    ready: Object.freeze(readyNames),
  });
}

/**
 * THE SAME DECISION, TOLD AS A REPORT, FOR EVERY PROGRAM AT ONCE.
 *
 * handoverPlan() above answers about ONE list of accounts in ONE preferred
 * order. What a person is looking at is a whole computer: some sessions on
 * Codex accounts, some on Claude, each program with its own order and its own
 * rule. This walks readAccountUsage()'s answer, runs that same decision once
 * per program, and stamps the program onto every row it produces.
 *
 * ONE PROGRAM AT A TIME IS THE POINT, not a convenience. handoverPlan matches
 * accounts by NAME, and two programs may both have an account called "work".
 * Handed one merged table this would answer that a Claude session should move
 * onto a Codex account, which registry.js calls a category error and is right
 * to. The split is here rather than in each caller so that rule is kept in one
 * place, beside the decision it protects.
 *
 * IT REPORTS AND IT MOVES NOTHING, which is the same promise handoverPlan
 * makes and, on this CLI, the only one that can be kept: a Claude session's
 * account is fixed for the life of its process (measured, at the top of this
 * file). Nothing here has a clock, a file or a child process either -- the
 * usage answer is passed in, so a surface calling this starts no program.
 *
 *   usage     the answer readAccountUsage() gave, however recently. Its
 *             `accounts` rows ARE the readings, its `orders` carry each
 *             program's preferred order, and its `policy` carries the limits.
 *   sessions  [{ sessionId, agentId, account, provider }] -- what the app
 *             host's sessionAccountRows() answers.
 *
 * Returns { ok, code, readAt, providers, moves, held, unknown }. A session
 * whose account nobody read lands in `unknown` WITH THE REASON, rather than
 * being dropped: "the check has not run" and "nothing needs to move" are
 * different answers, and merging them is how a fleet on six spent accounts
 * reads as a fleet with nothing to do.
 */
function handoverReport({ usage = null, sessions = [] } = {}) {
  const live = (Array.isArray(sessions) ? sessions : [])
    .filter(plainObject)
    .map(session => ({
      sessionId: nonEmptyString(session.sessionId) ? session.sessionId : session.id,
      agentId: nonEmptyString(session.agentId) ? session.agentId : null,
      account: session.account,
      provider: nonEmptyString(session.provider) ? session.provider : null,
    }))
    .filter(session => nonEmptyString(session.sessionId) && nonEmptyString(session.account));

  const measured = plainObject(usage) && usage.ok === true && Array.isArray(usage.orders);
  if (!measured) {
    /* NOT A FAILURE AND NOT AN EMPTY PLAN. Every running session is named, each
       one saying the allowance behind it was never read, so a surface can put
       that sentence on the screen instead of an encouraging blank. */
    return Object.freeze({
      ok: false,
      code: HANDOVER.UNKNOWN_NOTHING_READ,
      readAt: null,
      providers: Object.freeze([]),
      moves: Object.freeze([]),
      held: Object.freeze([]),
      unknown: Object.freeze(live.map(session => Object.freeze({
        sessionId: session.sessionId,
        agentId: session.agentId,
        provider: session.provider,
        from: session.account,
        why: HANDOVER.UNKNOWN_NOTHING_READ,
      }))),
    });
  }

  const rows = Array.isArray(usage.accounts) ? usage.accounts.filter(plainObject) : [];
  const inForce = windowLimits(plainObject(usage.policy) ? usage.policy : {});

  const providers = [];
  const moves = [];
  const held = [];
  const unknown = [];
  /* `judged` is "this program's pass reached a verdict about it"; `covered` is
     "some program's pass LOOKED at it". They are different sets and the last
     loop below needs the second: a session on a measured account that is under
     its limits is judged-and-settled, and reporting it as unknown because no
     row was pushed for it would be exactly the merge of "fine" with "nobody
     looked" that this report exists to keep apart. */
  const judged = new Set();
  const covered = new Set();

  for (const entry of usage.orders) {
    if (!plainObject(entry) || !nonEmptyString(entry.provider)) continue;
    const provider = entry.provider;
    /* This program's readings only, keyed by name -- which is safe precisely
       because the table was narrowed to one program first. */
    const readings = new Map();
    for (const row of rows) {
      if (row.provider === provider && nonEmptyString(row.name)) readings.set(row.name, row);
    }
    const order = Array.isArray(entry.names) ? entry.names.filter(nonEmptyString) : [];
    const mine = live.filter(session => session.provider === provider);
    for (const session of mine) covered.add(session.sessionId);

    const plan = handoverPlan({
      readings,
      limits: usage.policy,
      sessions: mine,
      order,
    });

    const agentOf = new Map(mine.map(session => [session.sessionId, session.agentId]));
    for (const move of plan.moves) {
      judged.add(move.sessionId);
      moves.push(Object.freeze({ ...move, provider, agentId: agentOf.get(move.sessionId) ?? null }));
    }
    for (const stay of plan.held) {
      judged.add(stay.sessionId);
      held.push(Object.freeze({ ...stay, provider, agentId: agentOf.get(stay.sessionId) ?? null }));
    }
    /* A session this program's table has a reading for and did not move is
       settled: measured, under its limits, nothing to decide. One it has NO
       reading for was never judged, and says so. */
    for (const session of mine) {
      if (judged.has(session.sessionId)) continue;
      if (plainObject(readings.get(session.account))) continue;
      judged.add(session.sessionId);
      unknown.push(Object.freeze({
        sessionId: session.sessionId,
        agentId: session.agentId,
        provider,
        from: session.account,
        why: HANDOVER.UNKNOWN_ACCOUNT_NOT_READ,
      }));
    }

    providers.push(Object.freeze({
      provider,
      draining: plan.draining,
      ready: plan.ready,
      limits: inForce,
    }));
  }

  /* A session whose program the usage answer never covered at all -- a build
     that read Codex and Claude while a Gemini session was running. Nobody
     looked, so it is unknown rather than settled. */
  for (const session of live) {
    if (covered.has(session.sessionId)) continue;
    unknown.push(Object.freeze({
      sessionId: session.sessionId,
      agentId: session.agentId,
      provider: session.provider,
      from: session.account,
      why: HANDOVER.UNKNOWN_ACCOUNT_NOT_READ,
    }));
  }

  return Object.freeze({
    ok: true,
    code: null,
    readAt: nonEmptyString(usage.readAt) ? usage.readAt : null,
    providers: Object.freeze(providers),
    moves: Object.freeze(moves),
    held: Object.freeze(held),
    unknown: Object.freeze(unknown),
  });
}

module.exports = Object.freeze({
  HANDOVER,
  draining,
  handoverPlan,
  handoverReport,
  ready,
});
