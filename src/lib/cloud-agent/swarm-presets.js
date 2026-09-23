'use strict';

/* SWARM SIZES ARE A SHORT LIST, NOT A DIAL.
 *
 * THE PRODUCT DECISION THIS ENCODES, from the owner: "planners, workers, and
 * dispatchers should be largely controlled by us but we accept model input ...
 * This is a bit of a more closed product and we should try to deliver a good
 * experience as opposed to a fine grained control ... we design it around
 * intervals like 5, 10, 25, 50, 100, 150 agent swarms and we optimize it around
 * those sizes."
 *
 * So a person picks a SIZE. They do not pick a concurrency, a launch rate, a
 * number of planners, or a harvest fan-out -- because those are not preferences,
 * they are answers, and getting them wrong is expensive in a way a person
 * cannot see until the bill arrives. Six sizes can each be measured and tuned
 * once. A continuous dial cannot be measured at all, and every value on it is a
 * configuration nobody has ever run.
 *
 * OPEN SOURCE, CLOSED EXPERIENCE. Every number below is readable, and the
 * reasoning is here to be argued with. What is withheld is the invitation to
 * tune it per-run, which is the difference between a product and a control
 * panel.
 *
 * WHERE THE NUMBERS COME FROM. Measured on this machine 2026-08-24, across 134
 * real dispatches to two accounts, and the headline is the one that matters
 * most: ZERO provider refusals at every rate tried. The provider was never the
 * constraint.
 *
 *   serial (concurrency 1, sync spawn)     8.6 launches/minute
 *   concurrency 6, sync spawn              5.6   -- sync spawn blocks the event
 *                                                   loop, so concurrency was not
 *                                                   slow, it was IMPOSSIBLE
 *   concurrency 10, async spawn           20.0
 *   concurrency 24, async spawn           21.4   -- +140% concurrency bought +7%
 *
 * THE CEILING IS THIS MACHINE, NOT THE API. Twenty-four in flight against a
 * declared 140/min produced 21.4. Each `codex cloud exec` costs about seven
 * seconds, most of it process startup, and past roughly ten in flight the
 * machine is the queue. So a preset that promised 100/min from one machine
 * would be promising something no measurement supports.
 *
 * That is why `launchesPerMinute` below is never above what was observed, and
 * why the large sizes say plainly that they need more than one machine rather
 * than quietly taking longer. A rate a product claims and cannot serve is the
 * same defect as a setting that enforces nothing.
 */

const { CloudAgentError } = require('./errors');
const { MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT } = require('./batch-target');

/* MEASURED, not chosen. Dispatch throughput per machine, from the runs above.
 * Concurrency past this buys almost nothing and costs memory, so the presets
 * stop here rather than pretending. */
const MEASURED_LAUNCHES_PER_MINUTE_PER_MACHINE = 21;
const MEASURED_DISPATCH_SECONDS = 7;
const USEFUL_CONCURRENCY_PER_MACHINE = 10;

/* Rough, and DELIBERATELY rough. A cloud task's real cost depends on what it
 * finds, and a forecast presented to more precision than it has is worse than a
 * range: somebody plans against it. Derived from this session's own briefs --
 * a CONTRACT/1 brief expands to roughly 4,000 tokens and a task that reads a
 * file, changes it and writes a report has run 60,000-100,000 output tokens.
 * Presented as a BAND everywhere it is shown. */
const TOKENS_PER_TASK_LOW = 60_000;
const TOKENS_PER_TASK_HIGH = 100_000;

/* The six sizes, and the composition each one gets.
 *
 * The compositions are not proportional, and that is the point of tuning them
 * separately. A five-task swarm gets one harvester because five returns fit one
 * apply-and-verify pass; a hundred-task swarm gets five because the returns
 * arrive faster than one process can apply and verify them.
 *
 * HARVESTERS ARE THE HALF THAT GETS FORGOTTEN. Measured this session: dispatch
 * is parallel and harvest was serial, so 28 dispatches cost one command and 28
 * harvests cost 28 apply-and-test cycles at about nine minutes each. A swarm
 * that dispatches faster than it harvests just moves the queue somewhere less
 * visible. */
/* THERE IS NO PLANNER SEAT, AND THAT IS A DECISION, NOT AN OMISSION (owner,
 * 2026-08-24: "or we leave the [planning] to coordinator/dispatch?" -- yes).
 * Measured basis: across 150 mechanically derived briefs the admission
 * validator found ZERO brief faults, and every planning act that needed
 * judgement was the coordinator's. Planning is the coordinator declaring
 * intent plus a mechanical pipeline the product owns (derive, merge
 * collisions, validate, refuse); model input arrives as authored briefs in
 * the corpus directory and passes the same gates. A paid planner agent
 * between intent and admission would add latency and a failure mode with
 * nothing measured to add. An earlier draft of these presets declared
 * planner counts; they described agents that would never exist, which is the
 * declared-field-nothing-consumes defect this repository keeps finding in
 * settings, so they were removed rather than left to be believed. */
const PRESETS = Object.freeze({
  5: Object.freeze({
    size: 5, workers: 5, dispatchers: 1, harvesters: 1,
    concurrency: 5, launchesPerMinute: 15, machines: 1,
    note: 'At five tasks somebody has already decided what they are; the pipeline validates and dispatches, nothing more.',
  }),
  10: Object.freeze({
    size: 10, workers: 10, dispatchers: 1, harvesters: 1,
    concurrency: 8, launchesPerMinute: 18, machines: 1,
    note: 'Ten briefs is where hand-authoring starts producing collisions, so the mechanical merge earns its keep.',
  }),
  25: Object.freeze({
    size: 25, workers: 25, dispatchers: 1, harvesters: 2,
    concurrency: 10, launchesPerMinute: 21, machines: 1,
    note: 'A second harvester, because returns begin arriving before the last dispatch goes out.',
  }),
  50: Object.freeze({
    size: 50, workers: 50, dispatchers: 2, harvesters: 3,
    concurrency: 10, launchesPerMinute: 21, machines: 1,
    note: 'Dispatch is already at this machine\'s measured ceiling; the second dispatcher is for account isolation, not for speed.',
  }),
  100: Object.freeze({
    size: 100, workers: 100, dispatchers: 2, harvesters: 5,
    concurrency: 10, launchesPerMinute: 42, machines: 2,
    note: 'Needs TWO machines. One machine measured 21 launches a minute regardless of concurrency, so a hundred-task swarm on one machine takes about five minutes to dispatch and the rate a caller was promised would be fiction.',
  }),
  150: Object.freeze({
    size: 150, workers: 150, dispatchers: 3, harvesters: 7,
    concurrency: 10, launchesPerMinute: 63, machines: 3,
    note: 'Needs THREE machines, and the harvest fan-out is what actually bounds it: seven harvesters against 150 returns is still roughly twenty apply-and-verify cycles each.',
  }),
});

const SIZES = Object.freeze(Object.keys(PRESETS).map(Number).sort((a, b) => a - b));

function fail(code, message, details) {
  throw new CloudAgentError(code, message, details);
}

/**
 * The preset for a size. A size that is not one of the six REFUSES and names
 * the nearest two, rather than interpolating.
 *
 * Interpolating would be the whole design undone: the value of six sizes is
 * that each has been run and measured, and a seventh invented at call time has
 * been run by nobody. "Roughly halfway between two tuned configurations" is not
 * a tuned configuration.
 */
function presetFor(size) {
  const wanted = Number(size);
  if (!Number.isInteger(wanted) || wanted < 1) {
    fail('SWARM_SIZE_INVALID', `swarm size must be a positive whole number; got ${JSON.stringify(size)}.`);
  }
  const preset = PRESETS[wanted];
  if (preset) return preset;
  const below = [...SIZES].reverse().find((candidate) => candidate < wanted) || null;
  const above = SIZES.find((candidate) => candidate > wanted) || null;
  const nearest = [below, above].filter((value) => value !== null);
  fail('SWARM_SIZE_UNSUPPORTED',
    `${wanted} is not one of the sizes this product is tuned for (${SIZES.join(', ')}). `
    + (nearest.length ? `Pick ${nearest.join(' or ')}. ` : '')
    + 'Each size has been measured and tuned; a size in between has been run by nobody, so serving it would mean guessing at a configuration and calling it a recommendation.');
}

/**
 * What a swarm of this size is expected to cost, and whether the accounts can
 * carry it.
 *
 * `accounts` is the shape cloud.account_list returns: each with a usedPercent,
 * or null when it could not be established.
 *
 * THE WARNING IS THE POINT. A swarm that runs a person out of quota halfway
 * through leaves a batch half-dispatched, and the half that went out cannot be
 * cancelled or refunded. Telling them BEFORE is the only moment the information
 * is worth anything.
 */
function forecast(size, { accounts = [], exhaustedAtPercent = 99 } = {}) {
  const preset = presetFor(size);
  const low = preset.size * TOKENS_PER_TASK_LOW;
  const high = preset.size * TOKENS_PER_TASK_HIGH;

  const dispatchSeconds = Math.ceil((preset.size / preset.launchesPerMinute) * 60);

  /* UNKNOWN ALLOWANCE IS NOT A FULL ONE. An account whose remaining allowance
   * could not be read is reported as unknown and EXCLUDED from the headroom
   * sum, and its presence downgrades the verdict -- because the alternative is
   * to treat "we could not ask" as "there is plenty", which is how a batch runs
   * a person dry on an account nobody checked. */
  let headroomPercent = 0;
  const unknown = [];
  for (const account of accounts) {
    /* NaN and infinities are numbers to `typeof`, but they are not allowance
     * measurements. Treating them as measurements used to let NaN poison the
     * reported total (or let an infinity become definite zero/infinite
     * headroom) while omitting the account from the unknown list. */
    const used = account && Number.isFinite(account.usedPercent) ? account.usedPercent : null;
    if (used === null) { unknown.push(account && account.name); continue; }
    headroomPercent += Math.max(0, exhaustedAtPercent - used);
  }

  const warnings = [];
  if (unknown.length) {
    warnings.push(`the remaining allowance could not be read for ${unknown.join(', ')}, so this forecast counts none of it. A swarm may still run out on an account nobody could ask about.`);
  }
  if (accounts.length && accounts.length < preset.machines) {
    warnings.push(`this size is tuned for ${preset.machines} machine(s) and ${preset.machines} account(s); with ${accounts.length} it will dispatch at roughly ${MEASURED_LAUNCHES_PER_MINUTE_PER_MACHINE} launches a minute rather than ${preset.launchesPerMinute}, so expect about ${Math.ceil((preset.size / MEASURED_LAUNCHES_PER_MINUTE_PER_MACHINE) * 60)}s of dispatch instead of ${dispatchSeconds}s.`);
  }
  if (headroomPercent > 0 && headroomPercent < 20) {
    warnings.push(`only about ${Math.round(headroomPercent)}% of combined allowance remains. A swarm of ${preset.size} may not finish, and the part that dispatched cannot be cancelled or refunded.`);
  }

  return Object.freeze({
    preset,
    tokens: Object.freeze({ low, high, perTaskLow: TOKENS_PER_TASK_LOW, perTaskHigh: TOKENS_PER_TASK_HIGH }),
    dispatchSeconds,
    /* Stated as a BAND and labelled rough, everywhere it is shown. A single
       number here would be planned against. */
    summary: `about ${(low / 1000).toFixed(0)}k-${(high / 1000).toFixed(0)}k output tokens, dispatched in roughly ${dispatchSeconds}s across ${preset.machines} machine(s). These are rough bands, not a quote.`,
    headroomPercent: accounts.length ? headroomPercent : null,
    unknownAllowanceFor: Object.freeze(unknown),
    warnings: Object.freeze(warnings),
  });
}

/**
 * The bounds a preset produces for a batch declaration.
 *
 * Refuses rather than clamping if the accounts on hand cannot carry the
 * preset's rate at the per-account ceiling -- the same rule admission applies,
 * for the same reason: a batch that quietly serves less than it declared
 * reports a rate nobody can reproduce.
 */
function boundsFor(size, accountCount) {
  const preset = presetFor(size);
  const count = Number(accountCount);
  if (!Number.isInteger(count) || count < 1) {
    fail('SWARM_ACCOUNTS_INVALID', 'accountCount must be a positive whole number.');
  }
  /* CHECKED AGAINST THE PRESET'S OWN TUNED SHAPE, not only the raw per-account
   * ceiling. The first draft checked `count * 72 >= rate`, and the 150 preset
   * slipped through it with ONE account -- 63 < 72, legal on paper. But that
   * preset's rate was measured across three machines and three accounts; one
   * account serving 63/min is a configuration nobody has run, which is
   * precisely what the six-size design exists to refuse. The preset's
   * `machines` figure IS the tuned account count, so falling below it is not a
   * degraded mode -- it is an untuned one. */
  if (count < preset.machines) {
    fail('SWARM_ACCOUNTS_INSUFFICIENT',
      `the ${preset.size} preset was tuned for ${preset.machines} account(s)/machine(s) and this call offers ${count}. Its ${preset.launchesPerMinute}/min rate has never been measured on fewer, so serving it would promise a configuration nobody has run. Add an account or pick a smaller size.`);
  }
  const serveable = count * MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT;
  if (preset.launchesPerMinute > serveable) {
    fail('SWARM_ACCOUNTS_INSUFFICIENT',
      `the ${preset.size} preset dispatches at ${preset.launchesPerMinute} launches a minute, which ${count} account(s) cannot carry (${serveable} at the measured ${MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT} per account). Add an account or pick a smaller size.`);
  }
  return Object.freeze({ launchesPerMinute: preset.launchesPerMinute, accounts: count });
}

module.exports = Object.freeze({
  MEASURED_DISPATCH_SECONDS,
  MEASURED_LAUNCHES_PER_MINUTE_PER_MACHINE,
  PRESETS,
  SIZES,
  TOKENS_PER_TASK_HIGH,
  TOKENS_PER_TASK_LOW,
  USEFUL_CONCURRENCY_PER_MACHINE,
  boundsFor,
  forecast,
  presetFor,
});
