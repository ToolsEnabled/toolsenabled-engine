'use strict';

// roster/statistics.js — pure Beta-Bernoulli statistics for the agent roster (R103).
//
// DESIGN CHOICE (from the roster contract): the Jeffreys posterior is used
// instead of a Wilson score interval so the credible interval and the
// posterior are the same object — the interval bounds ARE quantiles of the
// posterior the promote/suspend rules reason about, not a separate
// approximation with its own failure modes.
//
// Model: each agent-attributable outcome is a Bernoulli trial
// (success = destination-verified acceptance by review; gate 1).
// Prior: Jeffreys prior Beta(1/2, 1/2) — the reference prior for the
// Bernoulli parameter (Jeffreys 1946; invariant under reparameterization).
// Posterior after s successes and f failures:
//     p | data ~ Beta(alpha, beta),  alpha = 1/2 + s,  beta = 1/2 + f
// Posterior mean: alpha / (alpha + beta).
// Interval: equal-tailed 95% credible interval = [Q(0.025), Q(0.975)] where
// Q is the Beta quantile function, computed by bisection on the regularized
// incomplete beta function I_x(a, b).
//
// I_x(a, b) is evaluated with the standard continued-fraction expansion
// (Abramowitz & Stegun, Handbook of Mathematical Functions, eq. 26.5.8;
// modified Lentz's method as in Numerical Recipes sec. 6.4, `betacf`):
//     I_x(a,b) = [x^a (1-x)^b / (a B(a,b))] * 1/(1+ d1/(1+ d2/(1+ ...)))
// with the symmetry transform I_x(a,b) = 1 - I_{1-x}(b,a) applied when
// x >= (a+1)/(a+b+2) so the continued fraction converges fast.
// log Gamma uses the Lanczos approximation (g = 7, n = 9 coefficients;
// Lanczos 1964, "A precision approximation of the gamma function").
//
// Everything here is a pure function of its arguments: no I/O, no clock,
// no requires beyond this file. Same inputs => bit-identical outputs, which
// is what makes the scoreboard rebuild byte-identical (contract requirement).

// Lanczos coefficients, g = 7, n = 9 (double precision).
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7
];

/** Natural log of the Gamma function, Lanczos approximation. */
function logGamma(x) {
  if (!Number.isFinite(x) || x <= 0) {
    if (x > 0) return Infinity; // 0+ limit
    throw new RangeError(`logGamma requires x > 0, got ${x}`);
  }
  if (x < 0.5) {
    // Reflection formula: Gamma(x) Gamma(1-x) = pi / sin(pi x)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let acc = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i++) {
    acc += LANCZOS_COEFFICIENTS[i] / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
}

/** log B(a, b) = log Gamma(a) + log Gamma(b) - log Gamma(a + b). */
function logBeta(a, b) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

// Continued fraction for the incomplete beta function (Numerical Recipes
// `betacf`, modified Lentz's method). Converges for x < (a+1)/(a+b+2).
function betaContinuedFraction(x, a, b) {
  const FPMIN = 1e-300;
  const EPS = 1e-15;
  const MAX_ITERATIONS = 300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  let converged = false;
  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new RangeError(`Incomplete beta continued fraction did not converge for x=${x} a=${a} b=${b}`);
  }
  return h;
}

/**
 * Regularized incomplete beta function I_x(a, b) = P(X <= x) for
 * X ~ Beta(a, b). Pure; deterministic.
 */
function regularizedIncompleteBeta(x, a, b) {
  if (!(a > 0) || !(b > 0)) throw new RangeError(`Beta parameters must be > 0, got a=${a} b=${b}`);
  if (!(x >= 0 && x <= 1)) throw new RangeError(`x must be in [0,1], got ${x}`);
  if (x === 0) return 0;
  if (x === 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  // Symmetry: I_x(a,b) = 1 - I_{1-x}(b,a)
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Quantile function of Beta(a, b): smallest x with I_x(a, b) >= p.
 * Fixed-iteration bisection (deterministic; 200 halvings drive the bracket
 * far below double-precision resolution, so the result is the converged
 * double regardless of inputs).
 */
function betaQuantile(p, a, b) {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`p must be in [0,1], got ${p}`);
  if (p === 0) return 0;
  if (p === 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break; // bracket exhausted at double precision
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Jeffreys posterior parameters after s successes, f failures. */
function jeffreysPosterior(successes, failures) {
  const s = assertCount(successes, 'successes');
  const f = assertCount(failures, 'failures');
  return { alpha: 0.5 + s, beta: 0.5 + f };
}

/** Posterior mean of Beta(alpha, beta). */
function posteriorMean(alpha, beta) {
  return alpha / (alpha + beta);
}

/**
 * Equal-tailed credible interval of Beta(alpha, beta) at the given level
 * (default 0.95): [Q((1-level)/2), Q(1-(1-level)/2)].
 */
function credibleInterval(alpha, beta, level) {
  const lvl = level === undefined ? 0.95 : level;
  if (!(lvl > 0 && lvl < 1)) throw new RangeError(`level must be in (0,1), got ${lvl}`);
  const tail = (1 - lvl) / 2;
  return {
    lower: betaQuantile(tail, alpha, beta),
    upper: betaQuantile(1 - tail, alpha, beta)
  };
}

/**
 * One-call summary for a config's agent-attributable record:
 * s successes (accepted-by-review), f failures (rejected-by-review or
 * failed-before-review). Everything downstream (scoreboard rows, decision
 * rules) consumes exactly this shape.
 */
function summarize(successes, failures) {
  const posterior = jeffreysPosterior(successes, failures);
  return {
    n: successes + failures,
    successes,
    failures,
    posterior,
    mean: posteriorMean(posterior.alpha, posterior.beta),
    ci95: credibleInterval(posterior.alpha, posterior.beta, 0.95)
  };
}

function assertCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
  return value;
}

/** Deterministic 6-decimal rounding for display fields. */
function round6(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(6));
}

module.exports = {
  logGamma,
  logBeta,
  regularizedIncompleteBeta,
  betaQuantile,
  jeffreysPosterior,
  posteriorMean,
  credibleInterval,
  summarize,
  round6
};
