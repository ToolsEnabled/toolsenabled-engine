'use strict';
// HOW MUCH OF A CLAUDE ACCOUNT IS LEFT, READ WITHOUT SPENDING ANY OF IT.
//
// WHY THIS IS ITS OWN FILE AND NOT THREE FUNCTIONS IN rotation.js.
// tests/multi-account-rotation.test.js asserts against rotation.js's SOURCE
// that the string `readFileSync` does not appear in it -- an absence of code,
// which no behavioural test can observe. That guard is right and it is not
// something to route around: rotation.js resolves directory names and must go
// on being provably unable to open anything. So the one read this feature needs
// lives here, alone, where it can be fenced on its own terms.
//
// WHAT IT MAY OPEN, AND IT IS EXACTLY ONE FILENAME.
// `<configDir>/.claude.json`, and the check below is on the resolved basename
// rather than on the caller's good intentions. That file is Claude Code's own
// settings-and-state cache; the SIGN-IN is `.credentials.json`, a different
// file in the same directory, and nothing here can name it. The distinction is
// the whole safety argument, so it is enforced rather than promised:
// tests/multi-account-rotation.test.js holds this file to a forbidden-token
// list of its own.
//
// WHY A FILE AT ALL, when the sibling probe asks the provider directly.
// Claude's free auth surface reports identity and the billing route and NO
// usage figure -- rotation.js said so in its own comments for as long as that
// was the whole story. A real `--print` turn does report one, and spends the
// very allowance this feature exists to conserve. Claude Code meanwhile caches
// the same payload its `/usage` panel renders into `.claude.json` under
// `cachedUsageUtilization`. Reading a file already on disk spends nothing, so
// the objection to the paid probe does not reach it. (There is now also a
// live, zero-token read -- ../providers/claude-usage-probe.js asks the CLI's
// control protocol for the same figures -- and it refreshes this very cache,
// so a caller that has just probed reads the same numbers here.)
//
// IT IS THE ACCOUNT'S OWN CACHE OR NOTHING. There is deliberately no fallback
// to `~/.claude.json`. The ambient cache belongs to whichever account the
// person last used in their own terminal, and attributing it to a registry
// entry would rank the account list on somebody else's numbers -- the
// wrong-identity failure health.js's e-mail gate exists to prevent.
//
// AND AN UNREAD CACHE CHANGES NOTHING. Absent, malformed, drifted or STALE all
// answer "not measured" (../usage/adapters/claude-cached-utilization.js refuses
// each of those by name rather than guessing), the account keeps exactly the
// status its auth probe gave it, and ./selection-modes.js leaves it in registry
// order behind the accounts that did report.
//
// HOW OLD IS TOO OLD IS THE CALLER'S QUESTION. The adapter's default budget is
// fifteen minutes, which suits "what is this account at right now". A caller
// ranking idle accounts against each other may pass `freshnessBudgetMs` in
// hours: the weekly window moves slowly, and a fifteen-minute budget would
// leave every idle account "unread" and ranked behind whichever one just ran,
// which is the opposite of levelling. Beyond whatever budget was given, the
// answer is still NOT_MEASURED -- never a number with its age hidden.

const fs = require('node:fs');
const path = require('node:path');

const { createClaudeCachedUtilizationAdapter } = require('../usage/adapters/claude-cached-utilization.js');
const { NO_WINDOWS, claudeWindows, headroomPercent, spentWindow, windowLimits } = require('./usage-windows.js');

// The one leaf this module is allowed to open. Compared against the resolved
// basename, so no amount of `..` in a configDir can walk the read onto another
// file -- and in particular not onto the sign-in beside it.
const CACHE_LEAF = '.claude.json';

const NOT_MEASURED = Object.freeze({
  windows: NO_WINDOWS,
  usedPercent: null,
  resetsAt: null,
  exhausted: false,
  // Nothing was compared, so the threshold was neither used nor found wanting.
  thresholdInvalid: false,
  note: null
});

/**
 * The hourly and weekly position of one Claude account, or a stated nothing.
 *
 * `freshnessBudgetMs`, when given, is handed straight to the cache adapter; an
 * unusable value makes the adapter refuse, and that refusal is answered here
 * as NOT_MEASURED rather than as a number read against no budget at all.
 *
 * Never throws: this sits in front of starting an agent, and a fault in an
 * optional cache may not be the reason somebody cannot work.
 */
function claudeAllowance(configDir, {
  fsImpl = fs,
  model = null,
  exhaustedAtPercent,
  exhaustedAtPercentHourly = null,
  exhaustedAtPercentWeekly = null,
  freshnessBudgetMs
} = {}) {
  if (typeof configDir !== 'string' || configDir.length === 0) return NOT_MEASURED;
  const cacheFile = path.resolve(configDir, CACHE_LEAF);
  // Belt and braces on the fence stated in the header. path.resolve already
  // collapses any traversal the caller handed in; this proves the result is
  // still the one filename this module may open.
  if (path.basename(cacheFile) !== CACHE_LEAF) return NOT_MEASURED;

  let observed;
  try {
    const read = createClaudeCachedUtilizationAdapter({
      readCache: () => fsImpl.readFileSync(cacheFile, 'utf8'),
      ...(freshnessBudgetMs === undefined ? {} : { freshnessBudgetMs })
    });
    observed = read();
  } catch {
    // The adapter refusing is the same fact as an absent cache: nothing was
    // measured. It must never take a start down with it.
    return NOT_MEASURED;
  }
  if (!observed || observed.status !== 'MEASURED') return NOT_MEASURED;

  const windows = claudeWindows(observed, { model });
  const room = headroomPercent(windows);
  if (room === null) return NOT_MEASURED;

  const binding = windows.weekly && windows.hourly
    ? (windows.weekly.usedPercent > windows.hourly.usedPercent ? windows.weekly : windows.hourly)
    : (windows.weekly || windows.hourly);
  const usedPercent = 100 - room;

  /* The SAME threshold Codex is held to, read off the same registry field, so
     "spent" means one thing across both providers. Without a valid threshold
     there is no comparison to make, and the answer SAYS SO: `thresholdInvalid`
     is what rotation.js's claudeProbeFactory reads to answer TRANSIENT for a
     measured account -- the way health.js refuses a Codex account -- instead
     of a 99%-spent account passing as healthy because NaN compared as
     nothing. health.js records that exact mistake. */
  const thresholdValid = Number.isFinite(exhaustedAtPercent)
    && exhaustedAtPercent >= 0 && exhaustedAtPercent <= 100;
  /* AND EACH WINDOW IS JUDGED AGAINST ITS OWN LIMIT. `usedPercent` above is
     still the worst window, because every surface that shows a figure shows
     that one; what changed is that the DECISION no longer holds the weekly
     window to a number chosen for the hour. With only the single field set
     both limits are that number and this is the comparison it always was. */
  const exhausted = thresholdValid && spentWindow(windows, windowLimits({
    exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly
  })) !== null;

  return Object.freeze({
    windows,
    usedPercent,
    // Keep the provider cache's observation time. Checking a cached value
    // again does not make the allowance itself newly measured.
    readAt: Number.isFinite(observed.fetchedAtMs) ? new Date(observed.fetchedAtMs).toISOString() : null,
    resetsAt: binding ? binding.resetsAt : null,
    exhausted,
    thresholdInvalid: !thresholdValid,
    /* NO RESET TIMESTAMP IN THE NOTE. This sentence reaches the accounts menu
       as a row's tooltip, beside a row that already says "resets in 6 days" in
       words; a raw ISO string mid-sentence was the one machine value left on
       that screen. The reset time is on the window and on `resetsAt` above for
       any surface that wants to say it in its own words. */
    note: `${Math.round(usedPercent)}% of its ${binding && binding.kind === 'weekly' ? 'weekly' : 'hourly'} allowance is used.`
  });
}

module.exports = Object.freeze({ CACHE_LEAF, NOT_MEASURED, claudeAllowance });
