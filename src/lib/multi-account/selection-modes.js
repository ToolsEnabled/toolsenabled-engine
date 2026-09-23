'use strict';
// WHICH OF THE PERSON'S OWN ACCOUNTS GOES FIRST, AND WHY THAT IS A CHOICE.
//
// Until this module there was one answer: registry priority, walked top to
// bottom, moving on only when an account proved it was spent. That is a good
// default and it stays -- it is `priority` below -- but it is the wrong answer
// for at least three ordinary situations, and the person is the only one who
// knows which situation they are in:
//
//   * a long unattended run must not stop halfway, so it wants the account with
//     the MOST room, whatever the registry order says;
//   * somebody who wants one account kept pristine as a reserve wants the
//     nearly-spent one drained FIRST, which is the opposite ordering;
//   * somebody paying for three accounts usually wants all three to land at the
//     same place at the end of the week rather than one at 100% and two at 5%.
//
// So this module is ONE PURE FUNCTION over readings that were already taken. It
// starts nothing, spends nothing, and reads no file. It decides an ORDER; who
// may actually be switched to, and when a switch is allowed at all, stays in
// switcher.js and rotation.js, which already state those rules.
//
// FIVE PROPERTIES, EACH OF WHICH IS A REFUSAL TO GUESS.
//
// 1. AN UNREAD ACCOUNT IS NEVER RANKED AGAINST A READ ONE. Claude's free
//    surface reports no usage at all on a machine whose CLI has not fetched it,
//    and Codex answers nothing at all when its allowance surface is down. Those
//    accounts keep REGISTRY PRIORITY ORDER and sit behind every account whose
//    room is known. Sorting them as though they were at 0% would send every
//    "most room available" start to whichever account the product understood
//    least -- confidently, and wrongly.
// 2. NO MODE INVENTS A REASON TO SWITCH. Ordering is not selection: an account
//    that comes first here is still probed, still refused if it cannot serve,
//    and in `manual` mode still stops rather than moving on.
// 3. THE ORDER IS STABLE. Equal readings fall back to the OTHER window, then to
//    registry priority and then to name, so the same facts produce the same
//    order every time and a person watching the panel does not see accounts
//    shuffle for no reason. The other window matters: two accounts equal on
//    their worst window are still 35 points apart on the other one right after
//    both short windows reset, and registry order would ignore that.
// 4. AN HOUR THAT IS SPENT IS SPENT IN EVERY MODE. An account whose short
//    window is at the exhaustion threshold stops NOW, whatever its weekly
//    position says, so every usage-ranked mode moves it to the back of the
//    ranked group rather than aiming the next start at an account that will
//    refuse within minutes. It is demoted, never dropped: the account is
//    usable again when the window resets, and removing it would make a
//    temporary window look like a missing account. The threshold is the
//    registry's own `exhaustedAtPercent` -- the number health.js already calls
//    spent -- and never the reserve, which is a different question.
// 5. EVERY MODE SAYS WHY, IN ONE SENTENCE, NAMING THE NUMBER IT USED. A switch
//    a person cannot account for is the trust problem this whole lane exists to
//    avoid.
// 6. ROOM THAT IS ABOUT TO EXPIRE IS ROOM. `expiring-first` ranks on the
//    SOONEST reset among an account's windows that still have room, because
//    whatever is left in a window is gone when it turns over. A window already
//    spent has nothing to lose and is not an expiry; an account that named no
//    reset time cannot be placed on this scale and sits behind the timed ones
//    in registry order, said out loud, for the same reason rule 1 keeps an
//    unread account behind a read one.

const { anyWindowMeasured, bindingWindow, headroomPercent, usableThreshold } = require('./usage-windows.js');
const usability = require('./usability.js');

/* WHERE "TIGHT" IS, and it is one number with one meaning: an account with less
   than this much room left is nearly spent. `dynamic` is the only mode that
   reads it, and it is settable because a person running eight-hour jobs and a
   person running two-minute ones do not agree about what nearly-spent means. */
const DEFAULT_RESERVE_PERCENT = 25;

/* WHERE "SPENT" IS for the short window. Mirrors registry.js
   DEFAULT_EXHAUSTED_AT_PERCENT so an account the health check calls spent and
   an account this module moves to the back are the same account. */
const DEFAULT_EXHAUSTED_AT_PERCENT = 99;

const MODE = Object.freeze({
  MANUAL: 'manual',
  PRIORITY: 'priority',
  ROTATE: 'rotate',
  MOST_AVAILABLE: 'most-available',
  LEAST_AVAILABLE: 'least-available',
  EVEN: 'even',
  DYNAMIC: 'dynamic',
  RESETS_SOONEST: 'resets-soonest'
});

/* The id this mode shipped under for a few hours on 2026-09-02, before the
   owner said what they meant: "when I said expiring soonest I really meant
   resetting soonest". A registry that recorded the old id keeps working. */
const LEGACY_SELECTION_MODES = Object.freeze({ 'expiring-first': MODE.RESETS_SOONEST });

/* WHICH WINDOW A RANKED MODE LOOKS AT (owner, 2026-09-02: "maybe a
   weekly/hourly choice"). `either` is the whole-account view every mode had
   until now: room is the worst measured window, a reset is the soonest one
   with room. `hourly` and `weekly` look at that window alone, and an account
   that did not report it is unread for the purpose of the order. */
const RANK_WINDOW = Object.freeze({ EITHER: 'either', HOURLY: 'hourly', WEEKLY: 'weekly' });
const RANK_WINDOW_IDS = Object.freeze([RANK_WINDOW.EITHER, RANK_WINDOW.HOURLY, RANK_WINDOW.WEEKLY]);
const DEFAULT_RANK_WINDOW = RANK_WINDOW.EITHER;

function normalizeRankWindow(value) {
  return RANK_WINDOW_IDS.includes(value) ? value : DEFAULT_RANK_WINDOW;
}

/* THE TABLE OF MODES, AND WHAT IS DELIBERATELY NOT IN IT.
 *
 * Each row is an id and whether that mode may move between accounts without
 * being asked. There is no label and no help sentence here. The words a person
 * reads belong to the accounts menu (app src/account-switcher-state.js,
 * SELECTION_MODE_CHOICES): that is the one place they are written and the one
 * place they are tested. This file used to carry a copy that claimed to be
 * verbatim, and the copy drifted from the menu within a day while a test
 * asserting equality stayed green, because the test held a second copy. So
 * the engine keeps only what it acts on, and the app owns the words.
 *
 * `automatic: false` on `manual` is the whole of that mode. It is first in the
 * list and it is what every UNREADABLE answer falls back to -- switching
 * accounts because a file would not parse is not a decision anybody made.
 *
 * THE DEFAULT WHEN NOBODY HAS CHOSEN IS `priority`, not `manual`. Owner,
 * 2026-09-02, after adding two accounts and signing them in: "they should stay
 * signed in once i sign in - and then auto rotate". An account a person went
 * to the trouble of adding and signing in is an account they mean to use, so
 * the list is walked in the order they gave it until one runs out; "stop and
 * let me switch" stays one choice away on the menu. */
const SELECTION_MODES = Object.freeze([
  Object.freeze({ id: MODE.MANUAL, automatic: false }),
  Object.freeze({ id: MODE.PRIORITY, automatic: true }),
  Object.freeze({ id: MODE.ROTATE, automatic: true }),
  Object.freeze({ id: MODE.MOST_AVAILABLE, automatic: true }),
  Object.freeze({ id: MODE.LEAST_AVAILABLE, automatic: true }),
  Object.freeze({ id: MODE.EVEN, automatic: true }),
  Object.freeze({ id: MODE.DYNAMIC, automatic: true }),
  Object.freeze({ id: MODE.RESETS_SOONEST, automatic: true })
]);

const SELECTION_MODE_IDS = Object.freeze(SELECTION_MODES.map(mode => mode.id));
const DEFAULT_SELECTION_MODE = MODE.PRIORITY;
/* What an id this build does not know normalises to. Distinct from the
   default on purpose: "nobody chose" walks the list, "chose something this
   build cannot read" stops, because the unreadable choice might have been the
   stop. */
const UNRECOGNISED_SELECTION_MODE = MODE.MANUAL;

function selectionMode(id) {
  const known = Object.hasOwn(LEGACY_SELECTION_MODES, id) ? LEGACY_SELECTION_MODES[id] : id;
  return SELECTION_MODES.find(mode => mode.id === known) || null;
}

/** Anything this build does not recognise means `manual`. Fail to the safe half. */
function normalizeSelectionMode(value) {
  const known = Object.hasOwn(LEGACY_SELECTION_MODES, value) ? LEGACY_SELECTION_MODES[value] : value;
  return SELECTION_MODE_IDS.includes(known) ? known : UNRECOGNISED_SELECTION_MODE;
}

/** True when the chosen mode may move between accounts without being asked. */
function isAutomatic(mode) {
  const found = selectionMode(normalizeSelectionMode(mode));
  return Boolean(found && found.automatic);
}

function normalizeReservePercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : DEFAULT_RESERVE_PERCENT;
}

/* Same bounds registry.js applies to the recorded field: a threshold of 0 would
   call every account spent before it started, so 0 is refused like NaN. */
function normalizeExhaustedAtPercent(value) {
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : DEFAULT_EXHAUSTED_AT_PERCENT;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* One account paired with what was measured about it, in the shape the sorters
   below use. A reading that is absent, malformed, or carries no measured window
   produces `known: false` -- which is what keeps rule 1 above true. */
function rankable(account, reading, rankWindow = DEFAULT_RANK_WINDOW) {
  const windows = plainObject(reading) ? reading.windows : null;
  const measured = anyWindowMeasured(windows);
  const weekly = measured && plainObject(windows.weekly) ? windows.weekly : null;
  const hourly = measured && plainObject(windows.hourly) ? windows.hourly : null;
  /* Under `hourly` or `weekly` the account is placed on that window alone;
     one it did not report leaves it unread for this order, behind the rest. */
  const only = rankWindow === RANK_WINDOW.HOURLY ? hourly : (rankWindow === RANK_WINDOW.WEEKLY ? weekly : null);
  const known = rankWindow === RANK_WINDOW.EITHER ? measured : Boolean(only);
  return {
    account,
    priority: Number.isSafeInteger(account.priority) && account.priority > 0 ? account.priority : Number.MAX_SAFE_INTEGER,
    name: typeof account.name === 'string' ? account.name : '',
    /* WHETHER IT CAN SERVE A TURN AT ALL, which is a different question from how
       much allowance it has left. `known` below is about a measurement being
       present; this is about the account being usable. An account can be read
       perfectly and still be signed out. */
    status: usability.statusOf(reading),
    known,
    rankWindow,
    headroom: known ? (only ? only.remainingPercent : headroomPercent(windows)) : null,
    binding: known ? (only || bindingWindow(windows)) : null,
    weekly,
    hourly
  };
}

/* Registry order, which is what every tie and every unread account falls back
   to. Stable by construction: priority, then name. */
function byRegistry(a, b) {
  /* AN ACCOUNT THAT CANNOT SERVE A TURN GOES BEHIND ONE THAT CAN, and only
     then does the listed order decide.
     *
     * This is the one place `manual` and `priority` consult anything about an
     * account, and the distinction that makes it right is USABILITY, NOT USAGE.
     * The note above those two modes rules out consulting how much allowance is
     * left, because that would make the panel's own list disagree with the order
     * it produced -- and that still holds; headroom is not read here. Whether an
     * account is signed out or spent is a different fact, and `rotate` already
     * says out loud that it skips exactly those ("Signed-out or limited accounts
     * are skipped"). Before this, the two modes that ignored it included the
     * DEFAULT one, so the common case was a new agent landing on the first
     * listed account no matter what state it was in: all six Codex accounts
     * exhausted, Codex the default, every turn failing until the owner switched
     * by hand.
     *
     * The order among usable accounts is untouched, and so is the order among
     * unusable ones, so a person who listed their accounts in a deliberate order
     * still gets it -- they just do not get sent to a dead one first. Nothing is
     * demoted permanently: the tier is computed from the reading taken for THIS
     * selection, so an account whose five-hour window has refilled is first
     * again the moment it reports healthy. */
  return (usability.selectionTier(a.status) - usability.selectionTier(b.status))
    || (a.priority - b.priority)
    || a.name.localeCompare(b.name);
}

/* THE OTHER WINDOW: the room in the window that is NOT the binding one, or null
   when only one window was read. Used as the tie-break in rule 3, and only
   when both accounts have one -- comparing a second window against a missing
   one would rank a reading against an absence. */
function otherRoom(entry) {
  if (!entry.binding) return null;
  const other = entry.binding.kind === 'weekly' ? entry.hourly : entry.weekly;
  return other ? other.remainingPercent : null;
}

function byOtherRoomDescending(a, b) {
  const left = otherRoom(a);
  const right = otherRoom(b);
  if (left === null || right === null) return 0;
  return right - left;
}

function byHeadroomDescending(a, b) {
  return (b.headroom - a.headroom) || byOtherRoomDescending(a, b) || byRegistry(a, b);
}

function byHeadroomAscending(a, b) {
  return (a.headroom - b.headroom) || byOtherRoomDescending(b, a) || byRegistry(a, b);
}

/* KEEP THEM EVEN ranks on the WEEKLY window and nothing else, because the
   weekly window is the one that describes a whole week's spending. Ranking on
   the binding window instead would reshuffle the order every few hours as
   short windows filled and drained, which levels nothing and just moves work
   about. An account with no weekly reading falls back to its binding window --
   a real answer about a real account is still better than registry order --
   and an account with nothing read at all stays unknown. Equal weeks are
   split by the hourly window, the other window for this mode. */
function weeklySpent(entry) {
  /* Under `hourly` the even mode levels the short window instead. */
  if (entry.rankWindow === RANK_WINDOW.HOURLY) return entry.hourly ? entry.hourly.usedPercent : null;
  if (entry.weekly) return entry.weekly.usedPercent;
  return entry.headroom === null ? null : 100 - entry.headroom;
}

function byHourlySpentAscending(a, b) {
  const left = a.hourly ? a.hourly.usedPercent : null;
  const right = b.hourly ? b.hourly.usedPercent : null;
  if (left === null || right === null) return 0;
  return left - right;
}

function byWeeklyAscending(a, b) {
  const left = weeklySpent(a);
  const right = weeklySpent(b);
  if (left === null || right === null) return byRegistry(a, b);
  return (left - right) || byHourlySpentAscending(a, b) || byRegistry(a, b);
}

/* Rule 6. The window whose room expires soonest: measured, with room left,
   and with a reset time the provider actually stated. Null when the account
   has no such window, which is the "cannot be placed on this scale" case. */
function expiringWindow(entry) {
  let soonest = null;
  let soonestAt = null;
  const candidates = entry.rankWindow === RANK_WINDOW.HOURLY ? [entry.hourly]
    : (entry.rankWindow === RANK_WINDOW.WEEKLY ? [entry.weekly] : [entry.hourly, entry.weekly]);
  for (const window of candidates) {
    if (!window || !(window.remainingPercent > 0) || typeof window.resetsAt !== 'string') continue;
    const at = Date.parse(window.resetsAt);
    if (!Number.isFinite(at)) continue;
    if (soonestAt === null || at < soonestAt) { soonest = window; soonestAt = at; }
  }
  return soonest;
}

function expiryOf(entry) {
  const window = expiringWindow(entry);
  return window ? Date.parse(window.resetsAt) : null;
}

/* Soonest expiry first. Two windows turning over at the same moment are split
   by how much would be lost, which is the room left, then by registry order. */
function byExpiryAscending(a, b) {
  const left = expiryOf(a);
  const right = expiryOf(b);
  if (left === null || right === null) return 0;
  return (left - right) || byHeadroomDescending(a, b);
}

/* "in 40 min" against the clock the caller gave, or nothing when it gave none.
   Never an ISO timestamp: this sentence is rendered on the menu verbatim. */
function resetPhrase(expiry, clock) {
  if (!Number.isFinite(clock) || !Number.isFinite(expiry)) return '';
  const ms = expiry - clock;
  if (ms <= 0) return ' (due to reset)';
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return ` (in ${minutes} min)`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return ` (in ${hours}h)`;
  return ` (in ${Math.round(hours / 24)} days)`;
}

function untimedClause(untimed) {
  const names = untimed.map(entry => `"${entry.name}"`);
  if (names.length === 1) return `${names[0]} did not say when it resets and stays behind in the listed order.`;
  const listed = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${listed} did not say when they reset and stay behind in the listed order.`;
}

/* Rule 4. The test is on the hourly window's USED figure against the same
   threshold health.js calls spent, so "spent this hour" means one thing across
   the health check and the order. An account with no hourly reading cannot be
   spent this hour: nothing was read, and nothing read is never a verdict. */
function hourlySpent(entry, exhaustedAtPercent) {
  return Boolean(entry.hourly) && entry.hourly.usedPercent >= exhaustedAtPercent;
}

/* Every usage-ranked mode goes through here: the accounts still able to serve
   this hour are ranked first, then the ones waiting for their window, ranked
   by the same rule so that the order among them is as explicable as the order
   among the rest. */
function rankWithHourlyDemotion(entries, comparator, exhaustedAtPercent) {
  const ready = entries.filter(entry => !hourlySpent(entry, exhaustedAtPercent)).sort(comparator);
  const waiting = entries.filter(entry => hourlySpent(entry, exhaustedAtPercent)).sort(comparator);
  return { ordered: [...ready, ...waiting], ready, waiting };
}

/**
 * Order this provider's accounts for a start, under the person's chosen mode.
 *
 * `accounts` are registry entries; `readings` is a map from account name to
 * whatever the probe measured, each carrying a `windows` record from
 * ./usage-windows.js. Nothing here calls a probe: the caller has already paid
 * for those readings and this decides what to do with them.
 *
 * `exhaustedAtPercent` is the registry's own threshold and is what rule 4
 * demotes on; `reservePercent` is read by `dynamic` alone. `now` (epoch
 * milliseconds or an ISO string) is read by `expiring-first` alone, and only
 * to say "in 40 min" in its sentence: the ORDER is on absolute reset times and
 * needs no clock, so a caller without one still gets the same order.
 *
 * Returns the order plus ONE SENTENCE naming the number it used, because a
 * surface that shows a switch has to be able to say why it happened.
 */
function orderAccounts({
  mode = DEFAULT_SELECTION_MODE,
  accounts = [],
  readings = null,
  previousAccount = undefined,
  reservePercent = DEFAULT_RESERVE_PERCENT,
  exhaustedAtPercent = DEFAULT_EXHAUSTED_AT_PERCENT,
  exhaustedAtPercentHourly = null,
  now = null,
  rankWindow = DEFAULT_RANK_WINDOW
} = {}) {
  const chosen = normalizeSelectionMode(mode);
  const window = normalizeRankWindow(rankWindow);
  const clock = typeof now === 'number' ? now : (typeof now === 'string' ? Date.parse(now) : Number.NaN);
  const reserve = normalizeReservePercent(reservePercent);
  /* Rule 4 asks whether an account is spent THIS HOUR, so it is judged by the
     hourly limit rather than by whichever single number the registry carries.
     Without a per-window hourly field this is the same number it always was. */
  const threshold = normalizeExhaustedAtPercent(
    usableThreshold(exhaustedAtPercentHourly, exhaustedAtPercent)
  );
  const list = Array.isArray(accounts) ? accounts.filter(plainObject) : [];
  const lookup = readings instanceof Map
    ? name => readings.get(name)
    : (plainObject(readings) ? name => readings[name] : () => null);

  const entries = list.map(account => rankable(account, lookup(account.name), window));
  const known = entries.filter(entry => entry.known);
  const unknown = entries.filter(entry => !entry.known).sort(byRegistry);

  // The cursor is the last selected account for this provider. Walk once
  // around the listed order; the launch health checks still decide eligibility.
  if (chosen === MODE.ROTATE) {
    const listed = [...entries].sort(byRegistry);
    const previous = listed.findIndex(entry => entry.name === previousAccount);
    const start = previous < 0 ? 0 : (previous + 1) % (listed.length || 1);
    const rotated = [...listed.slice(start), ...listed.slice(0, start)];
    const why = rotated.length === 0 ? 'No accounts are listed to rotate through.'
      : previousAccount === undefined
        ? 'Accounts take turns in the listed order. Signed-out or limited accounts are skipped.'
        : `"${rotated[0].name}" is next in the listed rotation. Signed-out or limited accounts are skipped.`;
    return finish(chosen, rotated, null, listed.length, why);
  }

  /* MANUAL AND PRIORITY DO NOT LOOK AT A READING AT ALL, and that is not an
     oversight. Both are defined as "the order I gave you"; consulting usage
     would make the panel's own list disagree with the order it produced. */
  if (chosen === MODE.MANUAL || chosen === MODE.PRIORITY) {
    /* The unmeasured count is reported as ZERO here, and that is a statement
       about this mode rather than about the accounts. These two orders are not
       based on a measurement at all, so "3 of 5 accounts did not report their
       allowance" would be a caveat about a reading nothing consulted -- true,
       irrelevant, and read by a person as a fault in their setup. `null` rather
       than 0 for the same reason it is null everywhere else in this codebase:
       nothing was counted, which is not the same fact as counting none. */
    /* AND IT SAYS SO WHEN THE LISTED ORDER WAS NOT THE WHOLE ANSWER. byRegistry
       now puts an account that cannot serve a turn behind one that can, so
       "In the order the accounts are listed." is only the truth when nothing was
       moved. Leaving that sentence up while the head of the order is not the
       head of the list is the same defect rule 5 exists to prevent: a person
       reading the panel cannot account for the account they got. */
    const listed = [...entries].sort(byRegistry);
    /* ONLY ACCOUNTS KNOWN TO BE UNUSABLE ARE COUNTED HERE. An account whose
       status was never read is not one that cannot serve -- it is one nothing
       has asked yet -- and counting it would put "1 account cannot serve a turn"
       in front of a person whose account is perfectly fine and merely unprobed.
       That is the same "could not look" versus "not there" line this module
       keeps everywhere else, and the existing suite is what caught it: readings
       in those tests carry usage windows and no status at all. */
    const unusable = listed.filter(entry =>
      usability.recoversWithoutPerson(entry.status) || usability.needsPerson(entry.status)).length;
    return finish(chosen, listed, null, entries.length,
      unusable === 0
        ? 'In the order the accounts are listed.'
        : (unusable === 1
          ? 'In the order the accounts are listed, except one account that cannot serve a turn right now, which was moved behind the rest.'
          : `In the order the accounts are listed, except ${unusable} accounts that cannot serve a turn right now, which were moved behind the rest.`));
  }

  /* NOTHING WAS READ ABOUT ANY ACCOUNT. Every usage-ranking mode degrades to
     registry order and SAYS SO. Silently behaving like `priority` while the
     panel shows "Most room left first" is a setting whose off position is
     indistinguishable from its on position -- the defect this lane has already
     been corrected for once. */
  if (known.length === 0) {
    return finish(chosen, unknown, unknown.length, entries.length,
      window === RANK_WINDOW.EITHER
        ? 'No account reported how much of its allowance is left, so the listed order was used.'
        : (window === RANK_WINDOW.HOURLY
          ? 'No account reported its 5-hour window, so the listed order was used.'
          : 'No account reported its weekly window, so the listed order was used.'));
  }

  let ranked;
  let why;
  if (chosen === MODE.MOST_AVAILABLE) {
    ranked = rankWithHourlyDemotion(known, byHeadroomDescending, threshold);
    why = ranked.ready.length > 0
      ? `"${ranked.ordered[0].name}" has the most left: ${describeRoom(ranked.ordered[0])}.`
      : allWaiting(ranked.ordered[0]);
  } else if (chosen === MODE.LEAST_AVAILABLE) {
    ranked = rankWithHourlyDemotion(known, byHeadroomAscending, threshold);
    why = ranked.ready.length > 0
      ? `"${ranked.ordered[0].name}" is closest to its limit and is being finished first: ${describeRoom(ranked.ordered[0])}.`
      : allWaiting(ranked.ordered[0]);
  } else if (chosen === MODE.RESETS_SOONEST) {
    /* EXPIRING FIRST. Only the accounts that stated a reset time for a window
       with room can be placed; the rest keep registry order behind them and
       are named. When nobody stated one the mode degrades to the listed order
       and says so in its own words, for the same reason the nothing-read case
       above does. */
    const timed = known.filter(entry => expiryOf(entry) !== null);
    const untimed = known.filter(entry => expiryOf(entry) === null).sort(byRegistry);
    if (timed.length === 0) {
      return finish(chosen, [...untimed, ...unknown], unknown.length, entries.length,
        'No account reported when its allowance resets, so the listed order was used.');
    }
    const placed = rankWithHourlyDemotion(timed, byExpiryAscending, threshold);
    const head = placed.ordered[0];
    ranked = { ordered: [...placed.ordered, ...untimed], ready: placed.ready, waiting: placed.waiting };
    why = placed.ready.length > 0
      ? `"${head.name}" resets soonest${resetPhrase(expiryOf(head), clock)}: ${describeRoom(head, expiringWindow(head))}.`
      : allWaiting(head);
    if (placed.ready.length > 0 && placed.waiting.length > 0) why = `${why} ${waitingClause(placed.waiting)}`;
    if (untimed.length > 0) why = `${why} ${untimedClause(untimed)}`;
    return finish(chosen, [...ranked.ordered, ...unknown], unknown.length, entries.length, why, window);
  } else if (chosen === MODE.EVEN) {
    ranked = rankWithHourlyDemotion(known, byWeeklyAscending, threshold);
    /* Named on the WEEKLY window, which is the one this mode ranked on. Quoting
       the binding window instead would report an hourly number under a sentence
       about the week, and the two can be far apart on the same account. When
       the head has no weekly reading the sentence says so and quotes the
       window it does have, in that window's own words. */
    const head = ranked.ordered[0];
    why = ranked.ready.length === 0
      ? allWaiting(head)
      : (head.weekly
        ? `"${head.name}" is the least spent this week: ${describeRoom(head, head.weekly)}.`
        : `"${head.name}" has no weekly reading; ${describeRoom(head)}.`);
  } else {
    /* DYNAMIC. While ANY account still has real room, concentrate: drain the
       one closest to its limit and leave the rest whole. Once the freest
       account has dropped below the reserve, every account is getting tight and
       concentrating would just spend the last one first -- so it flips to
       spreading the load across whatever is left. The flip is stated in the
       sentence, because a mode that changes its mind silently is a mode nobody
       can predict. */
    // An account waiting for its hour cannot provide the reserve that makes
    // concentrating safe. Choose the strategy from accounts this order can
    // use now; waiting accounts still retain their place behind them.
    const available = known.filter(entry => !hourlySpent(entry, threshold));
    const freest = Math.max(...(available.length ? available : known).map(entry => entry.headroom));
    if (freest >= reserve) {
      ranked = rankWithHourlyDemotion(known, byHeadroomAscending, threshold);
      why = ranked.ready.length > 0
        ? `Plenty spare (${Math.round(freest)}% free on the freest account), so "${ranked.ordered[0].name}" is being finished first: ${describeRoom(ranked.ordered[0])}.`
        : allWaiting(ranked.ordered[0]);
    } else {
      ranked = rankWithHourlyDemotion(known, byHeadroomDescending, threshold);
      why = ranked.ready.length > 0
        ? `Every ${available.length < known.length ? 'available account' : 'account'} is under ${Math.round(reserve)}% free, so the load is being spread: "${ranked.ordered[0].name}" has the most left at ${describeRoom(ranked.ordered[0])}.`
        : allWaiting(ranked.ordered[0]);
    }
  }

  if (ranked.ready.length > 0 && ranked.waiting.length > 0) {
    why = `${why} ${waitingClause(ranked.waiting)}`;
  }

  return finish(chosen, [...ranked.ordered, ...unknown], unknown.length, entries.length, why, window);
}

/* The room an account has, said with the window it belongs to. "62% left" on
   its own does not tell a person whether they are minutes or days from it. */
function describeRoom(entry, window = undefined) {
  if (!entry) return 'how much is left is not known';
  const chosen = window === undefined ? entry.binding : window;
  const room = chosen ? chosen.remainingPercent : entry.headroom;
  if (!Number.isFinite(room)) return 'how much is left is not known';
  const where = chosen ? (chosen.kind === 'weekly' ? 'this week' : 'this hour') : '';
  /* NO RESET TIMESTAMP IN THIS SENTENCE, and its removal is deliberate. This
     used to end ", resets 2026-09-08T15:03:42.000Z" -- and this sentence is
     rendered verbatim on the accounts menu, so a person comparing two accounts
     read a machine timestamp mid-clause while the row directly above already
     said "resets in 6 days" in words. The reset time is carried on the window
     itself for any surface that wants it. What THIS sentence answers is why
     this order, which is a question about room. */
  return `${Math.round(room)}% free${where ? ` ${where}` : ''}`;
}

/* Rule 4's sentences. One names the accounts moved to the back and says what
   they are waiting for; the other is for the case where every account that
   reported is waiting, so the head itself is one of them. */
function waitingClause(waiting) {
  const names = waiting.map(entry => `"${entry.name}"`);
  if (names.length === 1) return `${names[0]} has spent its hour and waits at the back until it resets.`;
  const listed = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${listed} have spent their hour and wait at the back until it resets.`;
}

function allWaiting(head) {
  return `Every account that reported has spent its hour, so "${head.name}" is first and waits for its hour to reset.`;
}

function finish(mode, entries, unknownCount, total, why, window = RANK_WINDOW.EITHER) {
  /* `null` means this order consulted no reading at all (manual, priority).
     Zero would mean it consulted every account and found nothing missing,
     which is a different and much more reassuring claim. */
  const counted = Number.isSafeInteger(unknownCount);
  return Object.freeze({
    mode,
    accounts: Object.freeze(entries.map(entry => entry.account)),
    names: Object.freeze(entries.map(entry => entry.name)),
    /* HOW MUCH OF THIS ORDER IS BASED ON A MEASUREMENT. A surface that shows a
       usage-ranked order while three of five accounts were never read owes the
       person that sentence, and it cannot write it without these two numbers. */
    measuredCount: counted ? total - unknownCount : null,
    unmeasuredCount: counted ? unknownCount : null,
    why: counted && unknownCount > 0 && unknownCount < total
      ? `${why} ${unknownCount} of ${total} accounts did not report ${window === RANK_WINDOW.HOURLY ? 'their 5-hour window' : (window === RANK_WINDOW.WEEKLY ? 'their weekly window' : 'their allowance')} and were left in the listed order behind the rest.`
      : why
  });
}

module.exports = Object.freeze({
  DEFAULT_EXHAUSTED_AT_PERCENT,
  DEFAULT_RANK_WINDOW,
  DEFAULT_RESERVE_PERCENT,
  DEFAULT_SELECTION_MODE,
  LEGACY_SELECTION_MODES,
  MODE,
  RANK_WINDOW,
  RANK_WINDOW_IDS,
  SELECTION_MODES,
  UNRECOGNISED_SELECTION_MODE,
  SELECTION_MODE_IDS,
  isAutomatic,
  normalizeExhaustedAtPercent,
  normalizeRankWindow,
  normalizeReservePercent,
  normalizeSelectionMode,
  orderAccounts,
  selectionMode
});
