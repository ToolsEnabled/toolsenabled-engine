'use strict';

// roster/decisions.js — promote / suspend / trial / unknown rules for the
// agent roster (R103), plus the pure dispatch-advice function.
//
// EVERYTHING here is pure: (scoreboard, allotment, floorApi, queueDepth,
// context) -> a decision object. No I/O, no clock reads, no requires beyond
// ./statistics.js. "Now" and the current HEAD commit are inputs, never
// ambient reads, so the same inputs always produce the same outputs.
//
// THE RULES (contract decisionRules, honored verbatim):
//   success  = review-verdict event, class agent-attributable, 'accepted'.
//   failure  = agent-attributable 'rejected' verdict OR agent-attributable
//              lane failure (R-EXIT-AGENT). n = successes + failures.
//   pendingVerification / infra-fault / environment-fault / unknown / park /
//   roster-error events NEVER enter n (gates 1-3).
//   1. UNKNOWN: n < minN -> state 'unknown'. No promote, no suspend, no fire.
//   2. CANDIDATE-BEST: among non-suspended, non-trial configs with n >= minN,
//      the highest posterior mean. If NO config reaches minN the roster
//      advises nothing at all — the contract's "promotion cannot precede
//      evidence" sentence is read literally here: with no evidence-qualified
//      config there is no exploit pick AND no exploration pick; dispatch
//      keeps current behavior and the defaults accrue the first evidence.
//   3. SUSPEND: C.ci95.upper < best.ci95.lower AND C.n >= minN AND
//      best.n >= minN AND C !== best. Suspension is ADVICE — it only stops
//      the roster proposing C.
//   4. EXPIRY -> TRIAL: earliest of (since + suspendDays) or environment
//      fingerprint change (headCommit differs from suspendedAtCommit, or the
//      allotment content hash changed since the scoreboard snapshot). Trial
//      budget: ONE agent-attributable dispatch; non-attributable outcomes do
//      not consume it, but after 3 non-attributable outcomes the config
//      returns to 'suspended' with reason 'trial-blocked-by-infra' and a
//      fresh clock. Trial outcome: accepted -> 'active'; agent-attributable
//      failure -> 'suspended' (new clock, new anchor commit).
//   5. EXPLORATION: an eligible under-sampled config (n < minN) gets the
//      dispatch iff fewer than 1 of the last K roster-advised dispatches were
//      exploration picks. queueDepth 0 -> NO advice of any kind (gate 8).
//   6. HARD BOUNDS on every advised selection (gate 4): allotment membership
//      + enabled, floor via the injected floorApi (assertLaneModelFor — the
//      roster never restates model lists), availability (same backend as the
//      supervisor; vertex requires a project), Sol exclusion (defensive here,
//      primary refusal lives in the allotment loader).
//   7. IDLE IS VALID (gate 8): no timer, no daemon; this module only answers
//      when called.
//
// CONTRACT-AMBIGUITY RESOLUTION (recorded per the builder brief): the config
// identity key includes `decomposed`, but the dispatch hook can only override
// {model, project, backend} — decomposed is the supervisor's planning choice,
// not advisable. decide() therefore aggregates the decomposed variants of
// each {role, provider, model, backend} triple (summing successes/failures
// and recomputing the posterior) when ranking advice, while the per-key rows
// keep their own decision states. A triple is suspended-for-advice only when
// every variant that has evidence is suspended (unexpired); a triple with a
// variant in 'trial' becomes the bounded re-trial candidate.

const statistics = require('./statistics.js');

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PARAMETERS = Object.freeze({
  minSamples: 5,
  explorationEveryK: 5,
  suspendDays: 14
});

const FREE_STATES = new Set(['unknown', 'active', 'candidate-best']);

/** Parameters from an allotment object, with contract defaults. */
function parametersFrom(allotment) {
  const p = (allotment && allotment.parameters) || {};
  const pick = (name) =>
    Number.isInteger(p[name]) && p[name] > 0 ? p[name] : DEFAULT_PARAMETERS[name];
  return {
    minSamples: pick('minSamples'),
    explorationEveryK: pick('explorationEveryK'),
    suspendDays: pick('suspendDays')
  };
}

const fmt = (v) => String(statistics.round6(v));

/**
 * Has a suspension expired? (Rule 4 expiry conditions.)
 * All inputs explicit; never reads a clock or git.
 */
function suspensionExpired(decision, { now, headCommit, allotmentChanged } = {}) {
  if (!decision || decision.state !== 'suspended') return false;
  if (allotmentChanged === true) return true;
  if (decision.suspendExpiresAt && now &&
      Date.parse(now) >= Date.parse(decision.suspendExpiresAt)) {
    return true;
  }
  if (headCommit && decision.suspendedAtCommit &&
      headCommit !== decision.suspendedAtCommit) {
    return true;
  }
  return false;
}

/**
 * One decision step, run by the scoreboard replay after every statistic-
 * changing event. Mutates row.decision objects in place and returns the
 * transitions it caused. Deterministic: rows are processed in key order and
 * "now" is the triggering event's timestamp, never the wall clock.
 *
 * rows: [{ keyStr, stats: {n, successes, mean, ci95}, decision }]
 * context: { at, headCommit, parameters, touched }
 *   touched: { keyString, kind: 'lane-outcome'|'review-verdict',
 *              disposition: 'pending'|'failed'|'accepted'|'rejected'|
 *                           'infra'|'env'|'unknown' } | null
 */
function stepDecisions(rows, { at, headCommit, parameters, touched } = {}) {
  const params = parameters || DEFAULT_PARAMETERS;
  const transitions = [];
  const sorted = rows.slice().sort((a, b) => (a.keyStr < b.keyStr ? -1 : a.keyStr > b.keyStr ? 1 : 0));

  const move = (row, to, reason) => {
    const from = row.decision.state;
    row.decision.reason = reason;
    if (from === to) return;
    row.decision.state = to;
    row.decision.since = at;
    transitions.push({ at, key: row.keyStr, from, to, reason });
  };

  const suspend = (row, reason) => {
    row.decision.suspendExpiresAt = new Date(Date.parse(at) + params.suspendDays * DAY_MS).toISOString();
    row.decision.suspendedAtCommit = headCommit || null;
    row.decision.trialDispatchesUsed = 0;
    row.decision.trialNonAttributableUsed = 0;
    move(row, 'suspended', reason);
  };

  // --- Rule 4a: suspension expiry -> one bounded re-trial -------------------
  for (const row of sorted) {
    if (row.decision.state !== 'suspended') continue;
    const timeExpired = row.decision.suspendExpiresAt &&
      Date.parse(at) >= Date.parse(row.decision.suspendExpiresAt);
    const commitChanged = headCommit && row.decision.suspendedAtCommit &&
      headCommit !== row.decision.suspendedAtCommit;
    if (!timeExpired && !commitChanged) continue;
    row.decision.trialDispatchesUsed = 0;
    row.decision.trialNonAttributableUsed = 0;
    row.decision.suspendExpiresAt = null;
    move(row, 'trial', timeExpired
      ? `suspension expired after ${params.suspendDays} days; one bounded re-trial`
      : `environment fingerprint changed (${row.decision.suspendedAtCommit} -> ${headCommit}); one bounded re-trial`);
  }

  // --- Rule 4b: trial accounting for the touched config ---------------------
  if (touched) {
    const row = sorted.find((r) => r.keyStr === touched.keyString);
    if (row && row.decision.state === 'trial') {
      const nonAttributable = touched.disposition === 'infra' ||
        touched.disposition === 'env' || touched.disposition === 'unknown';
      if (touched.kind === 'lane-outcome') {
        row.decision.trialDispatchesUsed += 1;
        if (nonAttributable) {
          row.decision.trialNonAttributableUsed += 1;
          if (row.decision.trialNonAttributableUsed >= 3) {
            suspend(row, 'trial-blocked-by-infra: 3 non-attributable outcomes consumed the trial window; fresh clock, nothing learned about the agent');
          }
        } else if (touched.disposition === 'failed') {
          suspend(row, 'trial failed: agent-attributable lane failure during re-trial');
        }
        // disposition 'pending': the one attributable trial dispatch is in
        // flight; resolution arrives with its review verdict.
      } else if (touched.kind === 'review-verdict') {
        if (touched.disposition === 'accepted') {
          move(row, 'active', 'trial passed: destination-verified acceptance during re-trial');
        } else if (touched.disposition === 'rejected') {
          suspend(row, 'trial failed: rejected by review during re-trial');
        } else if (nonAttributable) {
          row.decision.trialNonAttributableUsed += 1;
          if (row.decision.trialNonAttributableUsed >= 3) {
            suspend(row, 'trial-blocked-by-infra: 3 non-attributable outcomes consumed the trial window; fresh clock, nothing learned about the agent');
          }
        }
      }
    }
  }

  // --- Rules 1-3: free-state recompute --------------------------------------
  // Suspended and trial states are sticky: only their own expiry/trial events
  // move them. Best is chosen among free-state configs with n >= minN; ties
  // break to the lexicographically-first key (strict > comparison over a
  // key-sorted list), which is deterministic.
  const qualified = sorted.filter((r) => FREE_STATES.has(r.decision.state) && r.stats.n >= params.minSamples);
  let best = null;
  for (const row of qualified) {
    if (!best || row.stats.mean > best.stats.mean) best = row;
  }
  for (const row of sorted) {
    if (!FREE_STATES.has(row.decision.state)) continue;
    if (row.stats.n < params.minSamples) {
      move(row, 'unknown', `insufficient evidence (n=${row.stats.n} < ${params.minSamples})`);
      continue;
    }
    if (row === best) {
      move(row, 'candidate-best', `highest posterior mean ${fmt(row.stats.mean)} among ${qualified.length} config(s) with n >= ${params.minSamples}`);
      continue;
    }
    if (best && row.stats.ci95.upper < best.stats.ci95.lower) {
      suspend(row, `ci95.upper ${fmt(row.stats.ci95.upper)} < best(${best.keyStr}) ci95.lower ${fmt(best.stats.ci95.lower)} with n=${row.stats.n} vs best n=${best.stats.n}`);
      continue;
    }
    move(row, 'active', best
      ? `mean ${fmt(row.stats.mean)} within uncertainty of best(${best.keyStr}) mean ${fmt(best.stats.mean)}`
      : `n=${row.stats.n} >= ${params.minSamples}; no dominant config`);
  }

  return { transitions, bestKey: best ? best.keyStr : null };
}

// ---------------------------------------------------------------------------
// decide(): the dispatch-advice function (hook (a) consumer).
// ---------------------------------------------------------------------------

const tripleKeyOf = (k) => [k.role, k.provider, k.model, k.backend]
  .map((v) => (v === null || v === undefined ? 'null' : String(v))).join('|');

/**
 * Pure dispatch advice.
 *
 * decide({ scoreboard, allotment, floorApi, queueDepth, context })
 *   scoreboard: the object built by scoreboard.buildScoreboard()
 *   allotment:  parsed config/agent-allotment.json (owner ceiling, gate 7)
 *   floorApi:   an object with assertLaneModelFor(backend, model) that THROWS
 *               for an off-floor model. Production passes
 *               src/lib/fleet-supervisor/lane-models.js; tests may pass a fake.
 *               The roster never restates model lists (gate 4).
 *   queueDepth: number of REAL queued work items. <= 0 -> no advice at all
 *               (gate 8: idle allotment is valid; no work is invented).
 *   context (all optional, all explicit — purity):
 *     now, headCommit           — for suspension-expiry evaluation
 *     backend                   — the supervisor's constructed backend;
 *                                 v1 advice never crosses backends
 *     laneProjectPresent        — false blocks vertex advice
 *                                 (the FLEET_VERTEX_PROJECT_MISSING lesson)
 *     allotmentSha256           — current allotment content hash, compared to
 *                                 scoreboard.allotmentSnapshot.sha256 for the
 *                                 fingerprint-change expiry condition
 *     recentAdvisedDispatches   — [{ keyStr, exploration: bool }], most recent
 *                                 LAST; used for the 1-in-K exploration cap
 *     dispatchCounts            — { total, byTriple: {tripleKey: n} } counted
 *                                 from today's roster events (owner
 *                                 conserve-usage caps)
 *
 * Returns { advice, best, ranked, exploration, ineligible, notes }.
 * advice: null | { role, provider, model, backend, kind:
 *   'exploit'|'exploration'|'trial', reason } — null always means "dispatch
 * proceeds exactly as today" (fail-open is the caller's contract).
 */
function decide({ scoreboard, allotment, floorApi, queueDepth, context = {} } = {}) {
  const out = { advice: null, best: null, ranked: [], exploration: null, ineligible: [], notes: [] };
  const params = parametersFrom(allotment);

  // --- assemble triples from scoreboard rows (never the unknownConfig bucket)
  const triples = new Map();
  const rowsIn = (scoreboard && Array.isArray(scoreboard.configs)) ? scoreboard.configs : [];
  for (const row of rowsIn) {
    const key = row.key || {};
    if (key.provider === null || key.model === null || key.backend === null) continue; // never decided on
    const tk = tripleKeyOf(key);
    let t = triples.get(tk);
    if (!t) {
      t = {
        tripleKey: tk,
        key: { role: key.role, provider: key.provider, model: key.model, backend: key.backend },
        successes: 0,
        failures: 0,
        lastDispatchAt: null,
        rows: []
      };
      triples.set(tk, t);
    }
    t.successes += row.stats.successes;
    t.failures += (row.stats.n - row.stats.successes);
    if (row.lastDispatchAt && (!t.lastDispatchAt || row.lastDispatchAt > t.lastDispatchAt)) {
      t.lastDispatchAt = row.lastDispatchAt;
    }
    t.rows.push(row);
  }

  // --- allotment gate (gate 7): disabled/absent -> fully dormant ------------
  if (!allotment || allotment.enabled !== true) {
    out.notes.push('allotment disabled or absent: roster advises nothing (fail-dormant, dispatch keeps current behavior)');
    for (const t of [...triples.values()].sort((a, b) => (a.tripleKey < b.tripleKey ? -1 : 1))) {
      out.ineligible.push({ key: t.key, keyStr: t.tripleKey, reason: 'allotment-disabled' });
    }
    return out;
  }

  const allowedEntries = Array.isArray(allotment.allowed) ? allotment.allowed : [];

  // Synthesize never-dispatched allotted triples so exploration can propose a
  // config that has no events yet (n = 0).
  for (const entry of allowedEntries) {
    if (!entry || !Array.isArray(entry.models)) continue;
    for (const model of entry.models) {
      const key = {
        role: entry.role || 'builder',
        provider: entry.provider || null,
        model,
        backend: entry.backend || null
      };
      const tk = tripleKeyOf(key);
      if (!triples.has(tk)) {
        triples.set(tk, { tripleKey: tk, key, successes: 0, failures: 0, lastDispatchAt: null, rows: [] });
      }
    }
  }

  // --- global day budget (owner conserve-usage lever) -----------------------
  const budgets = allotment.budgets || {};
  const counts = context.dispatchCounts || null;
  if (Number.isInteger(budgets.maxTotalDispatchesPerDay) &&
      (!counts || !Number.isInteger(counts.total) || counts.total < 0)) {
    out.notes.push('global-day-cap-unmeasured: maxTotalDispatchesPerDay is configured but dispatchCounts.total is unavailable; roster refuses to advise');
    for (const t of [...triples.values()].sort((a, b) => (a.tripleKey < b.tripleKey ? -1 : 1))) {
      out.ineligible.push({ key: t.key, keyStr: t.tripleKey, reason: 'dispatch-count-unavailable' });
    }
    return out;
  }
  if (Number.isInteger(budgets.maxTotalDispatchesPerDay) &&
      counts.total >= budgets.maxTotalDispatchesPerDay) {
    out.notes.push(`global-day-cap: ${counts.total} roster-advised dispatches today >= maxTotalDispatchesPerDay ${budgets.maxTotalDispatchesPerDay}; roster advises nothing further today`);
    for (const t of [...triples.values()].sort((a, b) => (a.tripleKey < b.tripleKey ? -1 : 1))) {
      out.ineligible.push({ key: t.key, keyStr: t.tripleKey, reason: 'global-day-cap' });
    }
    return out;
  }

  const allotmentChanged = Boolean(
    context.allotmentSha256 && scoreboard && scoreboard.allotmentSnapshot &&
    scoreboard.allotmentSnapshot.sha256 &&
    context.allotmentSha256 !== scoreboard.allotmentSnapshot.sha256
  );

  // --- per-triple eligibility (gate 4 hard bounds, in contract order) -------
  const eligible = [];
  const trialCandidates = [];
  for (const t of [...triples.values()].sort((a, b) => (a.tripleKey < b.tripleKey ? -1 : 1))) {
    const k = t.key;
    // (a) allotment membership
    const entry = allowedEntries.find((e) => e &&
      (e.role || 'builder') === k.role &&
      (e.provider || null) === k.provider &&
      (e.backend || null) === k.backend &&
      Array.isArray(e.models) && e.models.includes(k.model));
    if (!entry) {
      out.ineligible.push({ key: k, keyStr: t.tripleKey, reason: 'not-allotted' });
      continue;
    }
    // (d, defensive) Sol exclusion — the loader is the primary refusal; this
    // is belt-and-suspenders so a loader bypass still cannot select Sol.
    if (String(entry.tier || '').toLowerCase() === 'sol' || String(k.model).toLowerCase() === 'sol') {
      out.ineligible.push({ key: k, keyStr: t.tripleKey, reason: 'sol-excluded' });
      continue;
    }
    // (b) model floor — the injected API is the authority, never a local list
    try {
      if (!floorApi || typeof floorApi.assertLaneModelFor !== 'function') {
        throw new Error('floorApi.assertLaneModelFor missing');
      }
      floorApi.assertLaneModelFor(k.backend, k.model);
    } catch (error) {
      out.ineligible.push({
        key: k, keyStr: t.tripleKey, reason: 'below-floor',
        detail: String((error && (error.code || error.message)) || error).slice(0, 160)
      });
      continue;
    }
    // (c) availability: same backend as the supervisor; vertex needs a project
    if (context.backend && k.backend !== context.backend) {
      out.ineligible.push({ key: k, keyStr: t.tripleKey, reason: 'backend-unavailable' });
      continue;
    }
    if (k.backend === 'vertex' && context.laneProjectPresent === false) {
      out.ineligible.push({ key: k, keyStr: t.tripleKey, reason: 'vertex-project-missing' });
      continue;
    }
    // per-entry day cap
    if (Number.isInteger(entry.maxDispatchesPerDay)) {
      const hasMeasuredCount = counts && counts.byTriple &&
        Object.prototype.hasOwnProperty.call(counts.byTriple, t.tripleKey) &&
        Number.isInteger(counts.byTriple[t.tripleKey]) && counts.byTriple[t.tripleKey] >= 0;
      if (!hasMeasuredCount) {
        out.ineligible.push({ key: k, keyStr: t.tripleKey, reason: 'dispatch-count-unavailable' });
        continue;
      }
      if (counts.byTriple[t.tripleKey] >= entry.maxDispatchesPerDay) {
        out.ineligible.push({ key: k, keyStr: t.tripleKey, reason: 'allotment-day-cap' });
        continue;
      }
    }
    // suspension / trial (sticky states live on the per-key rows)
    const evidenceRows = t.rows.filter((r) => r.stats.n > 0 || r.decision.state !== 'unknown');
    const expiryCtx = { now: context.now, headCommit: context.headCommit, allotmentChanged };
    const trialRow = t.rows.find((r) => r.decision.state === 'trial') ||
      t.rows.find((r) => suspensionExpired(r.decision, expiryCtx));
    const allSuspended = evidenceRows.length > 0 &&
      evidenceRows.every((r) => r.decision.state === 'suspended' && !suspensionExpired(r.decision, expiryCtx));
    if (allSuspended) {
      out.ineligible.push({
        key: k, keyStr: t.tripleKey, reason: 'suspended',
        detail: evidenceRows[0].decision.reason
      });
      continue;
    }
    const stats = statistics.summarize(t.successes, t.failures);
    const record = {
      key: k,
      keyStr: t.tripleKey,
      n: stats.n,
      successes: stats.successes,
      mean: statistics.round6(stats.mean),
      ci95: { lower: statistics.round6(stats.ci95.lower), upper: statistics.round6(stats.ci95.upper) },
      lastDispatchAt: t.lastDispatchAt
    };
    if (trialRow && trialRow.decision.trialDispatchesUsed < 3) {
      trialCandidates.push({ ...record, trialReason: trialRow.decision.reason });
      continue; // a trialing triple competes only for the bounded re-trial slot
    }
    eligible.push(record);
  }

  // --- ranking (rule 2) -----------------------------------------------------
  const ranked = eligible
    .filter((r) => r.n >= params.minSamples)
    .sort((a, b) =>
      b.mean - a.mean ||
      b.ci95.lower - a.ci95.lower ||
      (a.keyStr < b.keyStr ? -1 : a.keyStr > b.keyStr ? 1 : 0));
  out.ranked = ranked;
  out.best = ranked.length ? ranked[0].keyStr : null;

  // --- gate 8: no queued work -> no advice of any kind ----------------------
  if (!(Number(queueDepth) >= 1)) {
    out.notes.push('queue empty: no advice, no exploration (gate 8: allotted is never a utilization target; no work is invented)');
    return out;
  }

  // --- rule 2 literal: promotion (and any advice) cannot precede evidence ---
  if (!ranked.length) {
    out.notes.push(`no config reaches minN=${params.minSamples}: roster advises nothing (promotion cannot precede evidence; dispatch keeps current behavior)`);
    return out;
  }

  // --- bounded re-trial slot (rule 4) — has its own budget, no 1-in-K cap ---
  if (trialCandidates.length) {
    const pick = trialCandidates[0]; // key-sorted upstream: deterministic
    out.exploration = { key: pick.key, keyStr: pick.keyStr, kind: 'trial', reason: `bounded re-trial after suspension expiry (${pick.trialReason})` };
    out.advice = { ...pick.key, kind: 'trial', reason: out.exploration.reason };
    return out;
  }

  // --- exploration slot (rule 5): at most 1 of the last K advised dispatches
  const underSampled = eligible
    .filter((r) => r.n < params.minSamples)
    .sort((a, b) => {
      const al = a.lastDispatchAt, bl = b.lastDispatchAt;
      if (al === null && bl !== null) return -1; // never-dispatched first
      if (al !== null && bl === null) return 1;
      if (al !== null && bl !== null && al !== bl) return al < bl ? -1 : 1;
      return a.keyStr < b.keyStr ? -1 : a.keyStr > b.keyStr ? 1 : 0;
    });
  if (underSampled.length) {
    if (!Array.isArray(context.recentAdvisedDispatches)) {
      out.notes.push('exploration-history-unmeasured: recentAdvisedDispatches is unavailable; roster refuses to infer that the exploration slot is open');
    } else {
      const recent = context.recentAdvisedDispatches;
      const lastK = recent.slice(-params.explorationEveryK);
      const recentExplorations = lastK.filter((d) => d && d.exploration === true).length;
      if (recentExplorations < 1) {
        const pick = underSampled[0];
        out.exploration = {
          key: pick.key, keyStr: pick.keyStr, kind: 'exploration',
          reason: `under-sampled (n=${pick.n} < ${params.minSamples}); 0 exploration picks in last ${lastK.length} advised dispatches (cap: 1 in ${params.explorationEveryK})`
        };
        out.advice = { ...pick.key, kind: 'exploration', reason: out.exploration.reason };
        return out;
      }
      out.notes.push(`exploration throttled: ${recentExplorations} of last ${lastK.length} advised dispatches were exploration (cap: 1 in ${params.explorationEveryK})`);
    }
  }

  // --- exploit: candidate-best ---------------------------------------------
  const top = ranked[0];
  out.advice = {
    ...top.key,
    kind: 'exploit',
    reason: `candidate-best: highest posterior mean ${fmt(top.mean)} (ci95 [${fmt(top.ci95.lower)}, ${fmt(top.ci95.upper)}], n=${top.n}) among ${ranked.length} config(s) with n >= ${params.minSamples}`
  };
  return out;
}

module.exports = {
  DEFAULT_PARAMETERS,
  parametersFrom,
  suspensionExpired,
  stepDecisions,
  decide,
  tripleKeyOf
};
