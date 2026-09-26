/* Mutation check:
 * Changed `alpha: 0.5 + s` to `alpha: 1 + s` in statistics.js.
 * The mutation landed (confirmed by matching the changed source line).
 * This isolated test went red with exit code 1 on the mutated module.
 */
'use strict';

const assert = require('node:assert/strict');
const statistics = require('../src/lib/fleet-supervisor/roster/statistics.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function approximately(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`);
}

process.stdout.write('fleet-supervisor-roster-statistics\n');

check('log-gamma and log-beta match independently known identities', () => {
  approximately(statistics.logGamma(1), 0);
  approximately(statistics.logGamma(0.5), Math.log(Math.sqrt(Math.PI)));
  approximately(statistics.logBeta(1, 1), 0);
  approximately(statistics.logBeta(2, 3), Math.log(1 / 12));
  assert.throws(() => statistics.logGamma(0), /requires x > 0/);
});

check('regularized incomplete beta evaluates boundaries and a closed form', () => {
  assert.equal(statistics.regularizedIncompleteBeta(0, 2, 3), 0);
  assert.equal(statistics.regularizedIncompleteBeta(1, 2, 3), 1);
  approximately(statistics.regularizedIncompleteBeta(0.5, 2, 3), 0.6875);
  assert.throws(() => statistics.regularizedIncompleteBeta(-0.1, 1, 1), /x must be in \[0,1\]/);
  assert.throws(() => statistics.regularizedIncompleteBeta(0.5, 0, 1), /parameters must be > 0/);
});

check('beta quantiles invert the uniform CDF and reject invalid probabilities', () => {
  approximately(statistics.betaQuantile(0.25, 1, 1), 0.25);
  assert.equal(statistics.betaQuantile(0, 1, 1), 0);
  assert.equal(statistics.betaQuantile(1, 1, 1), 1);
  assert.throws(() => statistics.betaQuantile(1.1, 1, 1), /p must be in \[0,1\]/);
});

check('Jeffreys posterior and posterior mean reflect observed counts', () => {
  assert.deepEqual(statistics.jeffreysPosterior(3, 1), { alpha: 3.5, beta: 1.5 });
  assert.equal(statistics.posteriorMean(3.5, 1.5), 0.7);
  assert.throws(() => statistics.jeffreysPosterior(-1, 0), /successes must be a non-negative integer/);
  assert.throws(() => statistics.jeffreysPosterior(0, 1.5), /failures must be a non-negative integer/);
});

check('credible intervals are equal-tailed and honor their level', () => {
  const interval = statistics.credibleInterval(1, 1, 0.8);
  approximately(interval.lower, 0.1);
  approximately(interval.upper, 0.9);
  assert.throws(() => statistics.credibleInterval(1, 1, 1), /level must be in \(0,1\)/);
});

check('summary combines counts, posterior, mean, and a bounded 95% interval', () => {
  const summary = statistics.summarize(3, 1);
  assert.equal(summary.n, 4);
  assert.equal(summary.successes, 3);
  assert.equal(summary.failures, 1);
  assert.deepEqual(summary.posterior, { alpha: 3.5, beta: 1.5 });
  assert.equal(summary.mean, 0.7);
  approximately(summary.ci95.lower, 0.2837516795634127);
  approximately(summary.ci95.upper, 0.9715291049128532);
});

check('six-decimal display rounding handles finite and absent values', () => {
  assert.equal(statistics.round6(1.23456789), 1.234568);
  assert.equal(statistics.round6(-0.0000006), -0.000001);
  assert.equal(statistics.round6(null), null);
  assert.equal(statistics.round6(Infinity), null);
});

process.stdout.write(`fleet-supervisor-roster-statistics: ${passed} checks passed\n`);
