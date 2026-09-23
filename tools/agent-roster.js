#!/usr/bin/env node
'use strict';

// Agent-roster CLI (owner request R103, gate 6: the derived scoreboard is
// SHOWN to the owner -- this is that surface).
//
//   node tools/agent-roster.js --backfill            replay harness history into events (idempotent)
//   node tools/agent-roster.js --scoreboard          per-config table incl. per-class non-attributable counts
//   node tools/agent-roster.js --decisions           what would dispatch now, and why
//   node tools/agent-roster.js --explain <configKey> full evidence trail for one config
//   node tools/agent-roster.js --attribution-table   the deterministic rule table, with observed counts
//   node tools/agent-roster.js --allotment           what the owner's ceiling currently allows
//   node tools/agent-roster.js --rebuild             delegate to roster/scoreboard.js (builder 2) when installed
//
// Honesty rules this CLI enforces on itself:
//  * Counts come from state/agent-roster-events.jsonl only (destination-verified
//    facts). Posterior/CI/decision columns belong to roster/statistics.js +
//    roster/decisions.js (another builder's modules); when their derived
//    artifact state/agent-roster.json is absent, this CLI SAYS SO instead of
//    reimplementing their statistics.
//  * pendingVerification is never a success (gate 1).
//  * infra/environment/unknown are counted and SHOWN, never scored (gate 2/3);
//    an infra-fault rate is a supervisor quality metric, labeled as such.
//  * Unused allotment is never described as waste (gate 8).

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const backfillModule = require('../src/lib/fleet-supervisor/roster/backfill.js');
const allotmentModule = require('../src/lib/fleet-supervisor/roster/allotment.js');
const presenceModule = require('../src/lib/agent-presence.js');

const DEFAULT_SCOREBOARD_FILE = path.join(REPO_ROOT, 'state', 'agent-roster.json');

// --- argv ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const name = token.slice(2);
    const valued = ['state', 'log', 'events', 'file', 'scoreboard-file', 'explain', 'presence-file', 'stale-ms'];
    if (valued.includes(name) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[name] = argv[i + 1];
      i += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

// --- events aggregation (counts only; statistics stay with builder 2) --------

function keyOfConfig(config) {
  const part = (value) => (value === null || value === undefined ? 'null' : String(value));
  return [
    part(config && config.role),
    part(config && config.provider),
    part(config && config.model),
    part(config && config.backend),
    config && config.decomposed ? 'decomposed' : 'whole'
  ].join('/');
}

function parseConfigKey(text) {
  if (!text || typeof text !== 'string') return null;
  const named = {};
  if (text.includes('=')) {
    for (const pair of text.split(',')) {
      const [k, v] = pair.split('=').map((s) => s && s.trim());
      if (!k) continue;
      named[k] = v === 'null' || v === undefined ? null : v;
    }
  } else {
    const parts = text.split('/');
    if (parts.length < 4) return null;
    named.role = parts[0];
    named.provider = parts[1];
    named.model = parts[2];
    named.backend = parts[3];
    named.decomposed = parts[4] ?? 'whole';
  }
  const norm = (v) => (v === 'null' || v === null || v === undefined ? null : v);
  const decomposedRaw = named.decomposed;
  return {
    role: norm(named.role) ?? 'builder',
    provider: norm(named.provider),
    model: norm(named.model),
    backend: norm(named.backend),
    decomposed: decomposedRaw === true || decomposedRaw === 'true' || decomposedRaw === 'decomposed'
  };
}

function aggregateEvents(events) {
  const configs = new Map();
  const verdictLanes = new Set();
  for (const event of events) {
    if (event.kind === 'review-verdict' && event.laneId) verdictLanes.add(event.laneId);
  }
  const rowFor = (config) => {
    const key = keyOfConfig(config);
    if (!configs.has(key)) {
      configs.set(key, {
        key,
        config: {
          role: (config && config.role) ?? null,
          provider: (config && config.provider) ?? null,
          model: (config && config.model) ?? null,
          backend: (config && config.backend) ?? null,
          decomposed: Boolean(config && config.decomposed)
        },
        counts: {
          laneOutcomes: 0,
          acceptedByReview: 0,
          rejectedByReview: 0,
          failedBeforeReview: 0,
          pendingVerification: 0,
          infraFault: 0,
          environmentFault: 0,
          unknown: 0,
          parks: 0,
          rosterErrors: 0
        },
        lastEventAt: null
      });
    }
    return configs.get(key);
  };

  const totals = { 'agent-attributable': 0, 'infra-fault': 0, 'environment-fault': 0, unknown: 0, byRule: {} };
  const unseen = new Map();

  for (const event of events) {
    const row = rowFor(event.config || {});
    const cls = event.attribution ? event.attribution.class : 'unknown';
    const rule = event.attribution ? event.attribution.rule : null;
    if (event.at && (!row.lastEventAt || event.at > row.lastEventAt)) row.lastEventAt = event.at;
    if (event.kind !== 'roster-error') {
      totals[cls] = (totals[cls] || 0) + 1;
      if (rule) totals.byRule[rule] = (totals.byRule[rule] || 0) + 1;
    }

    if (event.kind === 'lane-outcome') {
      row.counts.laneOutcomes += 1;
      if (cls === 'infra-fault') row.counts.infraFault += 1;
      else if (cls === 'environment-fault') row.counts.environmentFault += 1;
      else if (cls === 'unknown') row.counts.unknown += 1;
      else if (cls === 'agent-attributable') {
        if (event.outcome && event.outcome.ok === true) {
          if (!verdictLanes.has(event.laneId)) row.counts.pendingVerification += 1;
        } else {
          row.counts.failedBeforeReview += 1;
        }
      }
      if (rule === 'R-UNSEEN' && event.outcome && event.outcome.code) {
        const entry = unseen.get(event.outcome.code)
          || { code: event.outcome.code, count: 0, firstAt: event.at };
        entry.count += 1;
        unseen.set(event.outcome.code, entry);
      }
    } else if (event.kind === 'review-verdict') {
      if (cls === 'agent-attributable') {
        if (event.verdict && event.verdict.verdict === 'accepted') row.counts.acceptedByReview += 1;
        else row.counts.rejectedByReview += 1;
      } else if (cls === 'infra-fault') row.counts.infraFault += 1;
      else if (cls === 'environment-fault') row.counts.environmentFault += 1;
      else row.counts.unknown += 1;
    } else if (event.kind === 'park') {
      row.counts.parks += 1;
    } else if (event.kind === 'roster-error') {
      row.counts.rosterErrors += 1;
    }
  }

  const rows = [...configs.values()];
  for (const row of rows) {
    row.n = row.counts.acceptedByReview + row.counts.rejectedByReview + row.counts.failedBeforeReview;
  }
  rows.sort((a, b) => b.n - a.n || b.counts.laneOutcomes - a.counts.laneOutcomes || a.key.localeCompare(b.key));
  return { rows, totals, unseenCodes: [...unseen.values()] };
}

// --- rendering ----------------------------------------------------------------

function pad(text, width) {
  const s = String(text ?? '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

function loadEventsOrExplain(eventsFile) {
  if (!fs.existsSync(eventsFile)) {
    return {
      events: null,
      message: `No events file at ${eventsFile}. Run \`node tools/agent-roster.js --backfill\` to replay the `
        + 'harness history (state/fleet-supervisor.json + logs/fleet-supervisor.log) into it.'
    };
  }
  const { events, corruptLines } = backfillModule.readEvents(eventsFile);
  return { events, corruptLines, message: null };
}

function refuseIncompleteEvents(loaded, eventsFile) {
  if (!loaded.events) {
    console.log(loaded.message);
    return 2;
  }
  if (loaded.corruptLines > 0) {
    console.log(`REFUSING: ${eventsFile} contains ${loaded.corruptLines} corrupt line(s); `
      + 'counts and decisions would be based on an incomplete event set.');
    return 2;
  }
  return null;
}

// --- commands -----------------------------------------------------------------

function cmdBackfill(args) {
  const summary = backfillModule.backfill({
    stateFile: args.state ? path.resolve(args.state) : undefined,
    logFile: args.log ? path.resolve(args.log) : undefined,
    eventsFile: args.events ? path.resolve(args.events) : undefined
  });
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('Backfill complete (idempotent; rerun emits zero duplicates).');
    console.log(`  events file:   ${summary.eventsFile}`);
    console.log(`  scanned:       ${summary.scanned.lanes} lanes, ${summary.scanned.historyVerifications} history verifications, `
      + `${summary.scanned.laneVerdicts} lane verdicts, ${summary.scanned.logVerdicts} log verdicts, ${summary.scanned.parkedItems} parked items`);
    console.log(`  emitted:       ${summary.emitted.total} total  (lane-outcome ${summary.emitted['lane-outcome'] || 0}, `
      + `review-verdict ${summary.emitted['review-verdict'] || 0}, park ${summary.emitted.park || 0})`);
    console.log(`  skipped:       ${summary.skipped.duplicateEventId} duplicate eventIds, ${summary.skipped.laneAlreadyCovered} lanes already covered`);
    console.log(`  attribution:   ${JSON.stringify(summary.attributionTotals)}`);
    console.log(`  by rule:       ${JSON.stringify(summary.byRule)}`);
    if (summary.unseenCodes.length > 0) {
      console.log(`  UNSEEN CODES:  ${JSON.stringify(summary.unseenCodes)} <- new failure modes; extend the rule table honestly, do not misfile.`);
    }
    const reg = summary.fvpmRegression;
    console.log(`  gate-2 check:  FLEET_VERTEX_PROJECT_MISSING events=${reg.fvpmEvents}, agent-attributable=${reg.agentAttributable} `
      + `-> ${reg.ok ? 'PASS (no agent penalized for supervisor misconfiguration)' : `FAIL: ${reg.offenders.join(', ')}`}`);
  }
  return summary.fvpmRegression.ok ? 0 : 1;
}

function cmdScoreboard(args) {
  const eventsFile = args.events ? path.resolve(args.events) : backfillModule.DEFAULT_EVENTS_FILE;
  const scoreboardFile = args['scoreboard-file'] ? path.resolve(args['scoreboard-file']) : DEFAULT_SCOREBOARD_FILE;
  const loaded = loadEventsOrExplain(eventsFile);
  const eventsError = refuseIncompleteEvents(loaded, eventsFile);
  if (eventsError !== null) return eventsError;
  const aggregate = aggregateEvents(loaded.events);

  let derived = null;
  if (fs.existsSync(scoreboardFile)) {
    try {
      derived = JSON.parse(fs.readFileSync(scoreboardFile, 'utf8'));
    } catch (error) {
      console.log(`NOTE: ${scoreboardFile} exists but is unreadable (${error.message}); showing events-derived counts only.`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      eventsFile,
      eventCount: loaded.events.length,
      corruptLines: loaded.corruptLines,
      configs: aggregate.rows,
      attributionTotals: aggregate.totals,
      unseenCodes: aggregate.unseenCodes,
      derivedScoreboard: derived ? { file: scoreboardFile, generatedAt: derived.generatedAt, eventCount: derived.eventCount } : null
    }, null, 2));
    return 0;
  }

  console.log(`Agent roster scoreboard -- counts derived from ${eventsFile} (${loaded.events.length} events).`);
  console.log('Success = ACCEPTED BY REVIEW only (destination-verified; gate 1). pending = process-succeeded, no verdict yet -- NOT successes.');
  console.log('infra/env/unknown are counted and SHOWN, never scored: an infra-fault rate is a SUPERVISOR quality metric, not an agent one.');
  console.log('');
  const rows = aggregate.rows.map((row) => [
    row.key,
    row.n,
    row.counts.acceptedByReview,
    row.counts.rejectedByReview,
    row.counts.failedBeforeReview,
    row.counts.pendingVerification,
    row.counts.infraFault,
    row.counts.environmentFault,
    row.counts.unknown,
    row.counts.parks
  ]);
  console.log(renderTable(
    ['config (role/provider/model/backend/decomposed)', 'n', 'accepted', 'rejected', 'failed-pre-review', 'pending', 'infra', 'env', 'unknown', 'parks'],
    rows
  ));
  console.log('');
  console.log(`Attribution totals: ${JSON.stringify(aggregate.totals)}`);
  if (aggregate.unseenCodes.length > 0) {
    console.log(`UNSEEN CODES (new failure modes, honestly unclassified): ${JSON.stringify(aggregate.unseenCodes)}`);
  }
  if (derived) {
    const stale = derived.eventCount !== loaded.events.length;
    console.log('');
    console.log(`Derived scoreboard ${scoreboardFile}: generatedAt=${derived.generatedAt}, eventCount=${derived.eventCount}`
      + (stale ? ` -- STALE (events file now has ${loaded.events.length}); rerun --rebuild.` : ' -- up to date.'));
  } else {
    console.log('');
    console.log('Posterior mean / CI95 / decision columns: UNAVAILABLE -- state/agent-roster.json is absent because');
    console.log('roster/scoreboard.js + roster/decisions.js (another builder\'s modules) are not installed yet.');
    console.log('This CLI does not reimplement their statistics; counts above are the honest subset.');
  }
  return 0;
}

function cmdDecisions(args) {
  const eventsFile = args.events ? path.resolve(args.events) : backfillModule.DEFAULT_EVENTS_FILE;
  const allotmentPath = args.file ? path.resolve(args.file) : undefined;
  const allotment = allotmentModule.loadAllotment(allotmentPath ? { allotmentPath, force: true } : { force: true });

  const out = {
    allotment: {
      path: allotment.path, source: allotment.source, enabled: allotment.enabled,
      reason: allotment.reason, sha256: allotment.sha256, warnings: allotment.warnings
    },
    candidates: [],
    advice: null
  };

  if (!allotment.enabled) {
    out.advice = 'ROSTER ADVISES NOTHING: ' + (allotment.reason || 'allotment dormant.')
      + ' Dispatch proceeds exactly as before the roster existed (constructor defaults).';
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`Allotment: ${allotment.source} (${allotment.path})`);
      console.log(out.advice);
    }
    return 0;
  }

  const loaded = loadEventsOrExplain(eventsFile);
  const eventsError = refuseIncompleteEvents(loaded, eventsFile);
  if (eventsError !== null) return eventsError;
  const events = loaded.events;
  const aggregate = aggregateEvents(events);
  const today = new Date().toISOString().slice(0, 10);
  const dispatchesToday = events.filter((e) => e.kind === 'lane-outcome' && typeof e.at === 'string' && e.at.startsWith(today)).length;

  for (const entry of allotment.allowed) {
    if (entry.role !== 'builder') {
      out.candidates.push({
        entry: { role: entry.role, provider: entry.provider, backend: entry.backend, models: entry.models },
        eligible: false,
        reason: `role "${entry.role}" is recorded but not advised in v1 (reviewer/planner scoring is an open question in the contract).`
      });
      continue;
    }
    for (const model of entry.models || []) {
      const selection = { role: 'builder', provider: entry.provider, model, backend: entry.backend };
      const verdict = allotmentModule.checkSelection(selection, { allotment });
      const keyBoth = ['whole', 'decomposed'].map((d) => `builder/${entry.provider}/${model}/${entry.backend}/${d}`);
      const rows = aggregate.rows.filter((row) => keyBoth.includes(row.key));
      const n = rows.reduce((sum, row) => sum + row.n, 0);
      const accepted = rows.reduce((sum, row) => sum + row.counts.acceptedByReview, 0);
      out.candidates.push({
        selection,
        eligible: verdict.eligible,
        stage: verdict.stage,
        reason: verdict.reason,
        availability: verdict.eligible
          ? 'unknown-here: v1 restricts advice to the supervisor\'s constructed backend, and a vertex selection additionally requires its non-null laneProject -- both facts live inside the running supervisor (the FLEET_VERTEX_PROJECT_MISSING history is what that check prevents).'
          : null,
        evidence: { n, acceptedByReview: accepted, minSamples: allotment.parameters.minSamples },
        budget: {
          maxDispatchesPerDay: entry.maxDispatchesPerDay,
          maxTotalDispatchesPerDay: allotment.budgets.maxTotalDispatchesPerDay,
          laneOutcomeEventsToday: dispatchesToday
        }
      });
    }
  }

  const scoreboardFile = args['scoreboard-file'] ? path.resolve(args['scoreboard-file']) : DEFAULT_SCOREBOARD_FILE;
  let board = null;
  if (fs.existsSync(scoreboardFile)) {
    try { board = JSON.parse(fs.readFileSync(scoreboardFile, 'utf8')); } catch (_) { board = null; }
  }
  if (board && Array.isArray(board.configs)) {
    for (const candidate of out.candidates) {
      if (!candidate.selection) continue;
      candidate.decisions = board.configs
        .filter((row) => row.key
          && row.key.role === candidate.selection.role
          && row.key.provider === candidate.selection.provider
          && row.key.model === candidate.selection.model
          && row.key.backend === candidate.selection.backend)
        .map((row) => ({
          decomposed: row.key.decomposed,
          state: row.decision ? row.decision.state : null,
          reason: row.decision ? row.decision.reason : null,
          n: row.stats ? row.stats.n : null,
          mean: row.stats ? row.stats.mean : null,
          ci95: row.stats ? row.stats.ci95 : null
        }));
    }
    out.scoreboard = {
      file: scoreboardFile,
      generatedAt: board.generatedAt,
      eventCount: board.eventCount,
      stale: typeof board.eventCount === 'number' && board.eventCount !== events.length
    };
  }
  const haveDecisionEngine = board !== null;
  out.advice = haveDecisionEngine
    ? `decision states above come from ${scoreboardFile} (roster/decisions.js output, generatedAt ${board.generatedAt}`
      + `${out.scoreboard && out.scoreboard.stale ? '; STALE vs events file, rerun --rebuild' : ''}).`
    : 'DECISION ENGINE OUTPUT UNAVAILABLE: state/agent-roster.json is absent (roster/scoreboard.js + '
      + 'roster/decisions.js are another builder\'s modules and are not installed yet). Shown above is the '
      + 'hard-bound eligibility only (allotment INTERSECT floor; availability is supervisor-side). Until the '
      + 'decision engine lands, the roster advises nothing and dispatch keeps its current behavior. '
      + 'No config reaching minSamples also means: promotion cannot precede evidence.';

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  console.log(`Allotment: ${allotment.path} (sha256 ${String(allotment.sha256).slice(0, 12)}..., enabled=${allotment.enabled})`);
  for (const warning of allotment.warnings) console.log(`  WARNING: ${warning}`);
  console.log('');
  console.log('What would dispatch now, and why (allotment INTERSECT floor INTERSECT availability):');
  for (const candidate of out.candidates) {
    if (candidate.selection) {
      const s = candidate.selection;
      console.log(`  ${s.role} ${s.provider}/${s.model} on ${s.backend}:`);
      console.log(`    allotment+floor: ${candidate.eligible ? 'ELIGIBLE' : `BLOCKED at ${candidate.stage}: ${candidate.reason}`}`);
      if (candidate.eligible) console.log(`    availability:    ${candidate.availability}`);
      console.log(`    evidence:        n=${candidate.evidence.n} agent-attributable outcomes, accepted=${candidate.evidence.acceptedByReview} `
        + `(minSamples=${candidate.evidence.minSamples}${candidate.evidence.n < candidate.evidence.minSamples ? ' -> UNKNOWN: no promote, no suspend' : ''})`);
      console.log(`    budget:          perDay=${candidate.budget.maxDispatchesPerDay ?? 'no cap'}, total=${candidate.budget.maxTotalDispatchesPerDay ?? 'no cap'}, lane-outcome events dated today=${candidate.budget.laneOutcomeEventsToday}`);
      for (const decision of candidate.decisions || []) {
        console.log(`    decision(${decision.decomposed ? 'decomposed' : 'whole'}):  ${decision.state} -- ${decision.reason} `
          + `[n=${decision.n}, mean=${decision.mean}, ci95=${decision.ci95 ? `${decision.ci95.lower}..${decision.ci95.upper}` : 'n/a'}]`);
      }
    } else {
      console.log(`  ${candidate.entry.role} ${candidate.entry.provider ?? 'any'}/${candidate.entry.backend ?? 'any'}: ${candidate.reason}`);
    }
  }
  console.log('');
  console.log(out.advice);
  console.log('Idle allotment is valid: an entry above that never dispatches is a correct state, not waste (gate 8).');
  return 0;
}

function cmdExplain(args, keyText) {
  const eventsFile = args.events ? path.resolve(args.events) : backfillModule.DEFAULT_EVENTS_FILE;
  const target = parseConfigKey(keyText);
  if (!target) {
    console.log('Cannot parse config key. Use role/provider/model/backend/decomposed '
      + '(e.g. builder/gemini/gemini-2.5-pro/vertex/whole) or role=builder,provider=gemini,model=...,backend=...,decomposed=false');
    return 1;
  }
  const loaded = loadEventsOrExplain(eventsFile);
  const eventsError = refuseIncompleteEvents(loaded, eventsFile);
  if (eventsError !== null) return eventsError;
  const targetKey = keyOfConfig(target);
  const matches = loaded.events
    .filter((event) => keyOfConfig(event.config || {}) === targetKey)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  if (args.json) {
    console.log(JSON.stringify({ configKey: targetKey, events: matches }, null, 2));
    return 0;
  }
  console.log(`Evidence trail for ${targetKey} (${matches.length} events from ${eventsFile}):`);
  console.log('');
  for (const event of matches) {
    const what = event.kind === 'lane-outcome'
      ? `code=${event.outcome ? event.outcome.code ?? (event.outcome.ok ? 'ok' : 'null') : 'null'}${event.outcome && event.outcome.detailPrefix ? ` detail="${event.outcome.detailPrefix}"` : ''}`
      : event.kind === 'review-verdict'
        ? `verdict=${event.verdict.verdict} reviewer=${event.verdict.reviewer}${event.verdict.reasonPrefix ? ` reason="${event.verdict.reasonPrefix}"` : ''}`
        : event.kind === 'park'
          ? `parked: ${event.park.parkedReason} (lastOutcomeCode=${event.park.lastOutcomeCode})`
          : JSON.stringify(event.error ?? {});
    console.log(`  ${event.at ?? 'no-timestamp'}  ${pad(event.kind, 14)} ${pad(event.laneId, 42)} ${pad(`${event.attribution.class} [${event.attribution.rule}]`, 36)} ${what}`);
  }
  const agg = aggregateEvents(matches);
  const row = agg.rows.find((r) => r.key === targetKey);
  console.log('');
  if (row) {
    console.log(`Summary: n=${row.n} (accepted=${row.counts.acceptedByReview}, rejected=${row.counts.rejectedByReview}, `
      + `failed-pre-review=${row.counts.failedBeforeReview}); pending=${row.counts.pendingVerification}; `
      + `infra=${row.counts.infraFault}, env=${row.counts.environmentFault}, unknown=${row.counts.unknown}, parks=${row.counts.parks}.`);
  } else {
    console.log('Summary: no events match this config key.');
  }
  return 0;
}

function cmdAttributionTable(args) {
  const eventsFile = args.events ? path.resolve(args.events) : backfillModule.DEFAULT_EVENTS_FILE;
  const loaded = loadEventsOrExplain(eventsFile);
  const eventsError = refuseIncompleteEvents(loaded, eventsFile);
  if (eventsError !== null) return eventsError;
  const byRule = {};
  for (const event of loaded.events) {
    if (event.attribution && event.attribution.rule) {
      byRule[event.attribution.rule] = (byRule[event.attribution.rule] || 0) + 1;
    }
  }
  if (args.json) {
    console.log(JSON.stringify({
      laneRules: backfillModule.LANE_RULES,
      verdictRules: backfillModule.VERDICT_RULES,
      parkRule: backfillModule.PARK_RULE,
      observedCounts: byRule,
      eventsFile
    }, null, 2));
    return 0;
  }
  console.log('Attribution rule table (deterministic, ordered, first match wins; exactly one class per event).');
  console.log('Prose matching is limited to the three enumerated exact historical strings -- never a general heuristic.');
  console.log('');
  console.log('LANE-OUTCOME RULES (in order):');
  for (const rule of backfillModule.LANE_RULES) {
    console.log(`  ${pad(rule.id, 20)} -> ${pad(rule.class ?? 'NO EVENT', 18)} observed=${byRule[rule.id] || 0}`);
    console.log(`  ${' '.repeat(20)}    ${rule.when}`);
  }
  console.log('');
  console.log('REVIEW-VERDICT RULES (in order):');
  for (const rule of backfillModule.VERDICT_RULES) {
    console.log(`  ${pad(rule.id, 20)} -> ${pad(rule.class, 18)} observed=${byRule[rule.id] || 0}`);
    console.log(`  ${' '.repeat(20)}    ${rule.when}`);
  }
  console.log('');
  console.log(`PARKS: ${backfillModule.PARK_RULE.when}`);
  console.log('');
  console.log('Only agent-attributable events enter promote/fire statistics; infra-fault, environment-fault,');
  console.log('unknown, park, and roster-error events are counted and shown, never scored (gates 1-3).');
  return 0;
}

function cmdAllotment(args) {
  const allotmentPath = args.file ? path.resolve(args.file) : undefined;
  const allotment = allotmentModule.loadAllotment(allotmentPath ? { allotmentPath, force: true } : { force: true });
  if (args.json) {
    console.log(JSON.stringify(allotment, null, 2));
    return 0;
  }
  console.log(`Allotment file: ${allotment.path}`);
  console.log(`  source:  ${allotment.source}   enabled: ${allotment.enabled}   sha256: ${allotment.sha256 ? allotment.sha256.slice(0, 16) + '...' : 'n/a'}`);
  if (allotment.reason) console.log(`  reason:  ${allotment.reason}`);
  if (allotment.allowed.length > 0) {
    console.log('  allowed (a ceiling, never a target; idle allotment is valid):');
    for (const entry of allotment.allowed) {
      console.log(`    - ${entry.role} ${entry.provider ?? 'any-provider'} on ${entry.backend ?? 'any-backend'}: `
        + `models=${entry.models ? JSON.stringify([...entry.models]) : 'not pinned by allotment (floor still applies)'}, `
        + `maxDispatchesPerDay=${entry.maxDispatchesPerDay ?? 'no cap'}`);
    }
  }
  for (const drop of allotment.droppedModels) {
    console.log(`  DROPPED: allowed[${drop.entry}] model "${drop.model}" -- ${drop.reason}`);
  }
  for (const warning of allotment.warnings) console.log(`  WARNING: ${warning}`);
  console.log(`  budgets: maxTotalDispatchesPerDay=${allotment.budgets.maxTotalDispatchesPerDay ?? 'no cap'}`);
  console.log(`  parameters: ${JSON.stringify(allotment.parameters)}`);
  return 0;
}

function cmdRebuild(args) {
  const scoreboardModulePath = path.join(REPO_ROOT, 'src', 'lib', 'fleet-supervisor', 'roster', 'scoreboard.js');
  if (!fs.existsSync(scoreboardModulePath)) {
    console.log(`--rebuild UNAVAILABLE: ${scoreboardModulePath} is not installed yet (it belongs to the `
      + 'scoreboard-and-decisions builder). The events file is the source of truth; the scoreboard is always '
      + 'recomputable from it once that module lands. Nothing was written.');
    return 2;
  }
  let scoreboard;
  try {
    scoreboard = require(scoreboardModulePath);
  } catch (error) {
    console.log(`--rebuild UNAVAILABLE: roster/scoreboard.js failed to load (${error.message}). Nothing was written.`);
    return 2;
  }
  if (typeof scoreboard.rebuild !== 'function') {
    console.log(`--rebuild UNAVAILABLE: roster/scoreboard.js exports no rebuild() `
      + `(found: ${Object.keys(scoreboard).join(', ') || 'no exports'}). Refusing to guess its API. Nothing was written.`);
    return 2;
  }
  let result;
  try {
    result = scoreboard.rebuild({
      eventsPath: args.events ? path.resolve(args.events) : undefined,
      outPath: args['scoreboard-file'] ? path.resolve(args['scoreboard-file']) : undefined
    });
  } catch (error) {
    console.log(`--rebuild FAILED inside roster/scoreboard.js#rebuild: ${error.message}`);
    return 1;
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`Scoreboard rebuilt via roster/scoreboard.js#rebuild -> ${result.path}`);
  console.log(`  events=${result.eventCount} configs=${result.configs} generatedAt=${result.generatedAt} `
    + `changed=${result.changed} written=${result.written}`
    + (result.corruptLines ? ` corruptLines=${result.corruptLines}` : '')
    + (result.duplicateLines ? ` duplicateLines=${result.duplicateLines}` : ''));
  for (const note of result.notes || []) console.log(`  note: ${note}`);
  return 0;
}

function cmdPresence(args) {
  const stateFile = args['presence-file'] ? path.resolve(args['presence-file']) : presenceModule.DEFAULT_STATE_FILE;
  const staleMs = args['stale-ms'] === undefined ? presenceModule.DEFAULT_STALE_MS : Number.parseInt(args['stale-ms'], 10);
  if (!Number.isSafeInteger(staleMs) || staleMs < 1000 || staleMs > 3_600_000) {
    throw new TypeError('--stale-ms must be an integer from 1000 through 3600000.');
  }
  const registry = presenceModule.readRegistry(stateFile);
  const rows = presenceModule.rosterRows(registry, { staleMs });
  // The registry's own age is part of the observation. On 2026-08-12 the file
  // was 40h stale while two live sessions worked the tree, and every consumer
  // read "zero live agents" as a current fact -- a correct local reading
  // presented without its when. Surface the when, always.
  const registryAgeMs = registry.updatedAt === null || registry.updatedAt === undefined
    ? null : Math.max(0, Date.now() - Number(registry.updatedAt));
  const nonTerminal = rows.filter(row => row.liveness !== 'finished' && row.liveness !== 'failed').length;
  if (args.json) {
    console.log(JSON.stringify({
      schemaVersion: presenceModule.SCHEMA_VERSION,
      stateKind: 'observed',
      grantsAuthority: false,
      revision: registry.revision,
      updatedAt: registry.updatedAt,
      registryAgeMs,
      nonTerminalCount: nonTerminal,
      agents: rows
    }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log('No agent presence records. Missing means unknown, not absent.');
    return 0;
  }
  console.log('Live agent presence -- observed runtime state, never authority:');
  if (registryAgeMs !== null) {
    const hours = Math.floor(registryAgeMs / 3_600_000);
    const minutes = Math.floor((registryAgeMs % 3_600_000) / 60_000);
    console.log(`registry last written ${hours}h ${minutes}m ago; ${rows.length} rows, ${nonTerminal} non-terminal.`);
    if (registryAgeMs > 6 * 3_600_000) {
      console.log('WARNING: no presence write in over 6h. Live sessions may simply be unregistered'
        + ' (interactive sessions register via the SessionStart autoregister hook; see tools/claude-session-autoregister.js).'
        + ' Absence of rows is not absence of activity.');
    }
  }
  console.log(renderTable(
    ['agent', 'kind', 'role', 'tier', 'reports-to', 'lane', 'pid', 'liveness', 'useful-progress'],
    rows.map(row => [
      row.agentId, row.kind, row.role, row.tier, row.reportsTo ?? '-', row.lane, row.pid ?? '-', row.liveness,
      `${row.usefulProgressSeq}:${row.lastUsefulProgressKind || 'none'}`
    ])
  ));
  return 0;
}

function usage() {
  console.log(`agent-roster -- mechanical agent-configuration metrics (owner request R103)

Usage: node tools/agent-roster.js <command> [options]

Commands:
  --backfill            Replay state/fleet-supervisor.json + logs/fleet-supervisor.log into
                        state/agent-roster-events.jsonl. Idempotent: rerun emits zero duplicates.
                        Prints the gate-2 FLEET_VERTEX_PROJECT_MISSING regression check.
  --scoreboard          Per-config counts table, including per-class NON-attributable counts
                        (infra / environment / unknown / parks -- shown, never scored).
  --decisions           What would dispatch now and WHY: allotment gate, floor gate, availability,
                        evidence n vs minSamples, budgets. Honest about the missing decision engine.
  --explain <key>       Full evidence trail for one config. Key: role/provider/model/backend/decomposed
                        (e.g. builder/gemini/gemini-2.5-pro/vertex/whole) or k=v,k=v form.
  --attribution-table   The deterministic attribution rule table with observed per-rule counts.
  --allotment           What config/agent-allotment.json currently allows (and why not, when dormant).
  --rebuild             Delegate to roster/scoreboard.js when installed (exit 2 until then).
  --presence            R1146 live registry: kind, role, reporting line, lane, PID, and liveness.

Options:
  --events <file>       Events JSONL (default state/agent-roster-events.jsonl)
  --state <file>        Fleet state (default state/fleet-supervisor.json)   [--backfill]
  --log <file>          Fleet log (default logs/fleet-supervisor.log)       [--backfill]
  --file <file>         Allotment file override                             [--allotment, --decisions]
  --presence-file <f>   Presence registry (default state/agent-presence.json) [--presence]
  --stale-ms <ms>       Presence heartbeat threshold, 1000..3600000          [--presence]
  --json                Machine-readable output`);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.backfill) return cmdBackfill(args);
    if (args.scoreboard) return cmdScoreboard(args);
    if (args.decisions) return cmdDecisions(args);
    if (args.explain !== undefined) {
      return cmdExplain(args, typeof args.explain === 'string' ? args.explain : args._[0]);
    }
    if (args['attribution-table']) return cmdAttributionTable(args);
    if (args.allotment) return cmdAllotment(args);
    if (args.rebuild) return cmdRebuild(args);
    if (args.presence) return cmdPresence(args);
    return usage();
  } catch (error) {
    console.error(`agent-roster error: ${error.message}`);
    return 1;
  }
}

process.exitCode = main();
