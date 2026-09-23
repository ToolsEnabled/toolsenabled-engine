// EXECUTABLE CHANGE
'use strict';

/* TEST-CAN-FAIL REPORT (testcanfail-tests-swarm-presets-test-js)
 *
 * STRENGTHENED: the boundsFor(25, 2) rate assertion below formerly compared
 * boundsFor's result with presetFor's result. Mutation: changed the 25 preset's
 * launchesPerMinute from 21 to 20. Before this strengthening the test stayed
 * green: "swarm-presets tests passed (70 checks: ... bounds refusing rather
 * than clamping)." After pinning the independently known tuned rate to 21, the
 * same mutation went RED with:
 * "AssertionError [ERR_ASSERTION]: bounds preserve the independently measured
 * 25-task launch rate and account count"
 * The product file was restored byte-for-byte (SHA-256
 * b4d36146abe5ad012aa66e7c5fb29efb432eb8496d36eb3a7917625f798660f2),
 * and the restored run was green:
 * "swarm-presets tests passed (71 checks: ... bounds refusing rather than
 * clamping)."
 *
 * NOT-FOUND (1): the preset loop is guarded by the exact, non-empty SIZES
 * assertion; no loop/forEach assertion can disappear behind an empty input.
 * NOT-FOUND (2): no exit-status or truthy process-return assertion exists.
 * NOT-FOUND (3): raises catches subject errors only to assert both presence and
 * exact error code; no try/catch or optional chain swallows a required failure.
 * NOT-FOUND (4): the subject is loaded directly and no mocks exist.
 * NOT-FOUND (5): there are no skips, platform branches, or precondition guards.
 * NOT-FOUND (6), beyond the strengthened bounds assertion: expected values are
 * literals or independently calculated from test inputs, not product outputs.
 * Unmet preconditions: none.
 */

// Swarm sizes as a short tuned list rather than a dial.
//
// THE PROPERTY UNDER TEST IS MOSTLY A REFUSAL. Six sizes are worth having only
// because each has been measured; the moment an unlisted size is served by
// interpolating between two of them, the product is shipping a configuration
// nobody has run and calling it a recommendation. So the interesting assertions
// are what happens for 7, for 75, and for an account whose allowance could not
// be read.

const assert = require('node:assert');

const swarm = require('../src/lib/cloud-agent/swarm-presets');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

function raises(code, action, message) {
  let error = null;
  try { action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

// -------------------------------------------------------------------
// The six sizes exist and each is internally coherent.
// -------------------------------------------------------------------
check(swarm.SIZES.join(',') === '5,10,25,50,100,150',
  'the tuned sizes are the six the product offers, in order');

for (const size of swarm.SIZES) {
  const preset = swarm.presetFor(size);
  check(preset.size === size, `${size}: the preset knows its own size`);
  check(preset.workers === size, `${size}: one worker per task`);
  check(preset.harvesters >= 1, `${size}: every size harvests -- dispatching faster than you harvest just moves the queue somewhere less visible`);
  check(preset.concurrency <= swarm.USEFUL_CONCURRENCY_PER_MACHINE,
    `${size}: concurrency stays at or under the measured useful ceiling; past ten in flight the machine is the queue and more only costs memory`);
  check(preset.launchesPerMinute <= preset.machines * swarm.MEASURED_LAUNCHES_PER_MINUTE_PER_MACHINE,
    `${size}: the declared rate never exceeds what the declared machines were MEASURED to serve -- a rate a product claims and cannot serve is the same defect as a setting that enforces nothing`);
  check(typeof preset.note === 'string' && preset.note.length > 20,
    `${size}: carries the reason it is shaped this way, so the tuning can be argued with rather than only obeyed`);
}

// Composition is tuned per size, not scaled proportionally. If every field were
// a fixed ratio of size, the six presets would be a dial wearing a costume.
{
  const five = swarm.presetFor(5);
  const hundred = swarm.presetFor(100);
  /* THE PLANNER SEAT WAS REMOVED ON PURPOSE (owner, 2026-08-24: planning is
     the coordinator plus the mechanical pipeline). A field describing an agent
     that will never exist is the declared-but-unconsumed defect, so its ABSENCE
     is pinned: a preset that grows one back is reintroducing a seat the
     product decided against, and should have to say why out loud. */
  check(swarm.SIZES.every((size) => !('planners' in swarm.presetFor(size))),
    'no preset declares a planner seat -- planning is the coordinator plus the mechanical pipeline, decided and recorded, not omitted');
  check(hundred.harvesters > five.harvesters * 2,
    'the large size adds harvesters out of proportion to its size, which is what tuning each one separately means');
}

// -------------------------------------------------------------------
// AN UNLISTED SIZE REFUSES AND NAMES THE NEAREST TUNED ONES.
//
// This is the whole design. Interpolating would serve a configuration nobody
// has ever run, dressed as a recommendation.
// -------------------------------------------------------------------
{
  const error = raises('SWARM_SIZE_UNSUPPORTED', () => swarm.presetFor(75),
    'a size between two tuned ones refuses rather than interpolating');
  check(/50/.test(error.message) && /100/.test(error.message),
    'the refusal names BOTH neighbours, so the person has a choice rather than a correction');
  check(/run by nobody|has been run by nobody/.test(error.message),
    'and says WHY: an in-between size has been measured by nobody');

  const below = raises('SWARM_SIZE_UNSUPPORTED', () => swarm.presetFor(3),
    'a size below the smallest refuses');
  check(/5/.test(below.message), 'and names the smallest tuned size');

  const above = raises('SWARM_SIZE_UNSUPPORTED', () => swarm.presetFor(500),
    'a size above the largest refuses rather than being quietly served as 150');
  check(/150/.test(above.message), 'and names the largest tuned size');

  raises('SWARM_SIZE_INVALID', () => swarm.presetFor('lots'),
    'a size that is not a number refuses distinctly from one that is merely untuned');
  raises('SWARM_SIZE_INVALID', () => swarm.presetFor(12.5),
    'a fractional size refuses -- there is no half an agent');
}

// -------------------------------------------------------------------
// THE FORECAST WARNS BEFORE, WHICH IS THE ONLY MOMENT IT IS WORTH ANYTHING.
// -------------------------------------------------------------------
{
  const healthy = swarm.forecast(25, { accounts: [{ name: 'a', usedPercent: 40 }, { name: 'b', usedPercent: 30 }] });
  check(healthy.tokens.low < healthy.tokens.high,
    'the token estimate is a BAND -- a single number would be planned against, and this cost depends on what each task finds');
  check(/rough bands, not a quote/.test(healthy.summary),
    'and it says so in the sentence a person actually reads');
  check(healthy.warnings.length === 0, 'two healthy accounts against a 25 swarm warns about nothing');
  check(healthy.dispatchSeconds > 0, 'the forecast says how long dispatch will take, not only what it costs');
}

{
  // The case that matters: nearly out of quota.
  const thin = swarm.forecast(150, { accounts: [{ name: 'a', usedPercent: 95 }, { name: 'b', usedPercent: 92 }] });
  check(thin.warnings.some((w) => /allowance remains/.test(w)),
    'a swarm that may not finish warns BEFORE it starts');
  check(thin.warnings.some((w) => /cannot be cancelled or refunded/.test(w)),
    'and says what running out actually costs -- the dispatched half cannot be taken back');
}

{
  // UNKNOWN ALLOWANCE IS NOT A FULL ONE.
  const unknown = swarm.forecast(50, { accounts: [{ name: 'a', usedPercent: null }, { name: 'b', usedPercent: 10 }] });
  check(unknown.unknownAllowanceFor.includes('a'),
    'an account whose allowance could not be read is named');
  check(unknown.warnings.some((w) => /could not be read/.test(w)),
    'and warned about, rather than counted as headroom -- treating "we could not ask" as "there is plenty" is how a batch runs a person dry');
  check(unknown.headroomPercent === Math.max(0, 99 - 10),
    'the unknown account contributes NOTHING to the headroom sum');
}

{
  // NON-FINITE ALLOWANCE IS ALSO NOT A MEASUREMENT.
  for (const usedPercent of [NaN, Infinity, -Infinity]) {
    const unknown = swarm.forecast(5, { accounts: [{ name: 'a', usedPercent }] });
    check(unknown.unknownAllowanceFor.includes('a'),
      `${usedPercent} is carried as an unknown allowance rather than a definite measurement`);
    check(unknown.headroomPercent === 0,
      `${usedPercent} contributes NOTHING to the headroom sum`);
  }
}

{
  // A size tuned for more machines than are present says so, with the real number.
  const short = swarm.forecast(100, { accounts: [{ name: 'a', usedPercent: 10 }] });
  check(short.warnings.some((w) => /tuned for 2 machine/.test(w)),
    'a size needing two machines run on one warns');
  check(short.warnings.some((w) => /21 launches a minute/.test(w)),
    'and gives the MEASURED rate it will really get, not the one the preset declares');
}

// -------------------------------------------------------------------
// Bounds refuse rather than clamp, exactly as admission does.
// -------------------------------------------------------------------
{
  const bounds = swarm.boundsFor(25, 2);
  check(bounds.launchesPerMinute === swarm.presetFor(25).launchesPerMinute && bounds.accounts === 2,
    'bounds come straight from the preset');
  check(bounds.launchesPerMinute === 21 && bounds.accounts === 2,
    'bounds preserve the independently measured 25-task launch rate and account count');
  const error = raises('SWARM_ACCOUNTS_INSUFFICIENT', () => swarm.boundsFor(150, 1),
    'a preset tuned for three accounts offered one refuses -- its rate has never been measured on fewer, so serving it would promise a configuration nobody has run');
  check(/Add an account or pick a smaller size/.test(error.message),
    'and offers the two things that would actually fix it');
  raises('SWARM_ACCOUNTS_INVALID', () => swarm.boundsFor(25, 0),
    'zero accounts refuses -- a batch with nowhere to launch has nowhere to go');
}

console.log(`swarm-presets tests passed (${checks} checks: six tuned sizes each internally coherent and each carrying its reasoning, composition tuned per size rather than scaled, an unlisted size REFUSING and naming both neighbours instead of interpolating a configuration nobody has run, a fractional and a non-numeric size refused distinctly, the forecast given as a band and labelled rough, a thin allowance warned about BEFORE dispatch with what it costs, an unreadable allowance contributing nothing to headroom rather than being read as plenty, a size run on too few machines told the MEASURED rate it will really get, and bounds refusing rather than clamping).`);
