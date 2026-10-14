'use strict';

// REMOVING AN ENVIRONMENT VARIABLE ON WINDOWS, WHERE `delete` IS NOT ENOUGH.
//
// Windows environment variables are case-INSENSITIVE. `process.env` honours
// that. But `{ ...process.env }` produces a PLAIN object, and plain-object
// property access is case-SENSITIVE. So the shape this codebase uses
// everywhere:
//
//     const env = { ...process.env };
//     delete env.ANTHROPIC_BASE_URL;
//
// removes only that exact spelling. A variable set as `anthropic_base_url`
// survives -- and the child process, whose OS lookup is case-insensitive,
// reads it anyway.
//
// MEASURED on win32, spawning a real child with the scrubbed environment:
//
//     set as ANTHROPIC_BASE_URL   -> survives delete: false  child sees it: false
//     set as anthropic_base_url   -> survives delete: true   child sees it: TRUE
//     set as Anthropic_Base_Url   -> survives delete: true   child sees it: TRUE
//
// This is not a hypothetical casing. `setx anthropic_api_key ...` is an
// ordinary thing for a user or an installer to do on Windows, because Windows
// does not care -- so nothing looks wrong at any point. The failure is silent
// in both directions: the guard reports success, and the child works.
//
// The consequence is the R1186 outage that the credential scrubs exist to
// prevent -- an ambient API key reaching a child that bills it instead of the
// user's subscription, "for hours while reporting logged in" -- recurring with
// every guard in place and passing.
//
// WHY A MODULE AND NOT A FIX AT EACH CALL SITE. The exact-case `delete` appears
// in at least two independent scrubs (the provider gateway's, which the whole
// provider surface delegates into, and the Claude session's). This codebase has
// already watched one defect class survive six rounds of per-call-site fixes,
// because a mitigation applied where you are looking is one the next caller
// forgets. The NAME LISTS stay where they are -- they are genuinely different
// questions -- but the removal mechanism is one function.
//
// ---------------------------------------------------------------------------
// ROUND 2 (2026-08-11). The paragraph above was written before it was true.
//
// An adversarial review measured the claim and found it false: `deleteEnvNames`
// had ONE importer, `hasEnvName` had ZERO, and cli-provider-gateway.js -- the
// scrub the whole provider surface delegates into -- carried its own second
// copy of both halves. "Removal is now one function" described an intention,
// not the tree. It is true now because the gateway's `deleteEnvironmentNames`
// and `presentEnvironmentNames` are thin delegations to this file, and because
// tools/check-spawn-env-scrub.js FAILS THE BUILD on a new hand-rolled
// credential delete rather than trusting anyone to remember.
//
// Two defects that the Object.keys() implementation could not see are fixed
// here, both measured against a real spawned child:
//
//  1. INHERITED ENUMERABLE KEYS. Node builds a child's environment with
//     `for (const key in options.env)` -- its own source comments that
//     "prototype values are intentionally included". `for...in` walks the
//     prototype chain; `Object.keys()` does not. So an enumerable
//     `anthropic_api_key` on Object.prototype was invisible to every remover
//     AND every detector in this repo, while a real child read it canonically.
//     MEASURED: subscriptionLaunchEnvironment() and createSessionEnvironment()
//     both returned an environment with zero matching OWN keys, both detectors
//     reported clean, assertNoBillingCredentials() accepted -- and both
//     children reported ANTHROPIC_API_KEY PRESENT.
//
//  2. DETECTION FAILED OPEN ON `null`. `hasEnvName(null, ...)` returned false,
//     meaning "not present". But `spawn(cmd, args, { env: null })` makes node
//     INHERIT THE FULL AMBIENT ENVIRONMENT. MEASURED: the detector said clean,
//     the tripwire accepted, and the child read ANTHROPIC_API_KEY. The one
//     input that leaks the most got the most reassuring answer.

/* Node's own child-environment enumeration, which this must agree with exactly.
 * Collected into an array BEFORE any mutation, because deleting during a
 * `for...in` is not safe to reason about. */
function enumerateEnvNames(env) {
  const names = [];
  for (const key in env) names.push(key);
  return names;
}

/* THE CASE FOLD, AND THE OVER-REMOVAL IT DELIBERATELY ACCEPTS.
 *
 * JavaScript's toLowerCase() is a UNICODE fold; Windows' environment-name
 * comparison is not the same function. The measured divergence: U+212A KELVIN
 * SIGN folds to ASCII `k` in JavaScript, so `ANTHROPIC_API_<KELVIN>EY` compares
 * equal to `ANTHROPIC_API_KEY` here -- while Windows treats them as two
 * different variables. MEASURED with a real child: before any scrub, a child
 * given the Kelvin spelling reported the CANONICAL name ABSENT and the Kelvin
 * name PRESENT. This function removes it anyway.
 *
 * THE DECISION, MADE DELIBERATELY: keep the Unicode fold and accept the
 * over-removal. Not because it is harmless -- it deletes a variable the OS
 * would have kept -- but because the two errors are not symmetric:
 *
 *   over-removal   a subscription launch loses a variable nothing in this
 *                  product sets, and the caller can re-set it explicitly.
 *   under-removal  the owner's API key reaches a child and bills him, silently,
 *                  while every guard reports success. That is R1186.
 *
 * An ASCII-only fold would match Windows more closely for these lookalikes, and
 * was rejected: Windows' real comparison is a locale-invariant UPPERCASE map
 * that folds some non-ASCII pairs too, so an ASCII-only fold would UNDER-remove
 * for those -- trading a safe error for an unsafe one to fix a name
 * (`ANTHROPIC_API_<KELVIN>EY`) that nothing legitimate sets. The cost is
 * bounded and re-settable; the benefit is that no lookalike spelling of a
 * credential can survive. tests/providers/credential-scrub-round2.test.js pins
 * this against a real child ("the Unicode fold DELIBERATELY over-removes...")
 * so it stays a decision rather than drifting back into an accident. */
function fold(name) {
  return String(name).toLowerCase();
}

function foldedSet(names) {
  const list = Array.isArray(names) ? names : [names];
  return new Set(list.map((name) => {
    if (typeof name !== 'string' || !name) throw new TypeError('every name must be a non-empty string');
    return fold(name);
  }));
}

/* `env: null`, `env: undefined`, and an omitted `env` all mean the same thing to
 * node: give the child the FULL process.env. A detector that answers "nothing is
 * present" for those is not being lenient, it is being wrong -- so they resolve
 * to the environment the child would actually receive. Any other non-object is a
 * caller bug and throws rather than returning a reassuring answer. */
function resolveEnvironmentForReading(env) {
  if (env === null || env === undefined) return process.env;
  if (typeof env !== 'object') {
    throw new TypeError('env must be an object, or null/undefined meaning "inherit process.env"');
  }
  return env;
}

/* Remove one exact key, whether it is own or inherited.
 *
 * `delete env[key]` cannot remove an INHERITED property -- it silently succeeds
 * and changes nothing, which is the shape that made this class invisible. It can
 * also UNMASK an inherited property of the same name that an own property was
 * hiding. So after deleting, re-check reachability and TOMBSTONE what remains:
 * an own, ENUMERABLE property whose value is `undefined`.
 *
 * WHY ENUMERABLE, WHICH LOOKS BACKWARDS. A non-enumerable shadow removes the
 * key from this object correctly and is then SILENTLY LOST by the next
 * `{ ...env }` -- spread copies own ENUMERABLE properties only -- at which point
 * the fresh object inherits the polluted prototype again and the leak is back.
 * That is not hypothetical: subscriptionLaunchEnvironment() folds
 * providerEnvironment() over three providers and each one re-spreads, so a
 * non-enumerable shadow was undone twice per launch. MEASURED with a real child:
 * non-enumerable shadow -> ANTHROPIC_API_KEY PRESENT; tombstone -> ABSENT.
 *
 * An enumerable `undefined` survives every spread (the copy is itself an own
 * property that shadows the prototype) and node drops it when building the
 * child: its env builder skips keys whose value is `undefined`. So the
 * tombstone is what both of node's own rules already ignore. */
function removeReachableName(env, key) {
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    delete env[key];
    if (!(key in env)) return;
  }
  // Reachable but not own (inherited, or just unmasked). Fails LOUDLY on a
  // frozen or sealed environment rather than returning a scrub that did not
  // happen -- a silent no-op here is exactly the R1186 failure shape.
  Object.defineProperty(env, key, {
    value: undefined,
    writable: true,
    enumerable: true,
    configurable: true
  });
}

/**
 * Delete every variable whose name case-insensitively matches one of `names`,
 * including variables reachable only through the prototype chain.
 *
 * Mutates and returns `env`, matching the `delete env.X` shape it replaces so
 * adopting it is a one-line change at each site.
 *
 * Removes EVERY matching casing, not the first: an environment can legitimately
 * carry both `Path` and `PATH` after enough processes have edited it, and
 * removing one while leaving the other is the same bug in a smaller form.
 */
function deleteEnvNames(env, names) {
  if (!env || typeof env !== 'object') throw new TypeError('env must be an object');
  if (!Array.isArray(names)) throw new TypeError('names must be an array');
  const unwanted = foldedSet(names);
  for (const key of enumerateEnvNames(env)) {
    if (unwanted.has(fold(key))) removeReachableName(env, key);
  }
  return env;
}

/**
 * Delete every variable whose NAME satisfies `predicate`, including variables
 * reachable only through the prototype chain.
 *
 * For the heuristic scrubs -- "anything that looks like a token or a secret" --
 * which cannot be expressed as a name list. They have the same two blind spots
 * as a hand-rolled delete (`Object.keys()` misses inherited keys, and `delete`
 * is a silent no-op on them), so they get the same primitive rather than their
 * own loop. A name-list scrub should use deleteEnvNames(); this is the escape
 * hatch, not the default.
 */
function deleteEnvMatching(env, predicate) {
  if (!env || typeof env !== 'object') throw new TypeError('env must be an object');
  if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
  for (const key of enumerateEnvNames(env)) {
    if (predicate(key)) removeReachableName(env, key);
  }
  return env;
}

/**
 * Which of `names` are present in `env` in ANY casing, reported under the
 * CANONICAL name asked for.
 *
 * Returns names, never values -- the values are what must never be printed.
 *
 * The detection half of the same defect, and it has to walk the same properties
 * the removal half does: a tripwire that looks at a narrower set than the child
 * receives reports all-clear on precisely the environment that leaks.
 */
function presentEnvNames(env, names) {
  const resolved = resolveEnvironmentForReading(env);
  const wanted = foldedSet(names);
  const present = new Set();
  for (const key of enumerateEnvNames(resolved)) {
    const folded = fold(key);
    if (!wanted.has(folded)) continue;
    if (resolved[key] === undefined) continue; // node drops undefined-valued keys
    present.add(folded);
  }
  const canonical = Array.isArray(names) ? names : [names];
  return canonical.filter((name) => present.has(fold(name)));
}

/**
 * True if `env` still carries any of `names` in any casing.
 *
 * For assertions and tripwires: a check written as `env.NAME === undefined` has
 * the same blind spot as the delete it is checking, so it would confirm a scrub
 * that did not happen.
 */
function hasEnvName(env, names) {
  return presentEnvNames(env, names).length > 0;
}

/**
 * The VALUES of every variable matching `names` in any casing.
 *
 * Exists for one purpose: redaction. A redactor that reads only
 * `env.ANTHROPIC_API_KEY` repeats the exact-case bug on the output path --
 * MEASURED, a child given a lowercase spelling printed the raw secret to a
 * stderr observer with no redaction marker, because the redactor looked up a
 * spelling that was not there. Callers must not log the return value; it exists
 * to be searched FOR, not printed.
 */
function envValues(env, names) {
  const resolved = resolveEnvironmentForReading(env);
  const wanted = foldedSet(names);
  const values = [];
  for (const key of enumerateEnvNames(resolved)) {
    if (!wanted.has(fold(key))) continue;
    const value = resolved[key];
    if (typeof value === 'string' && value.length > 0) values.push(value);
  }
  return values;
}

/**
 * Rewrite the DELIMITED-LIST VALUE of the variable named `name` (any casing,
 * including variables reachable only through the prototype chain), keeping
 * only the segments for which `keep(segment)` is true.
 *
 * For scrubs that must remove specific entries from a value -- PSModulePath
 * being the motivating case -- without deleting the variable outright, the
 * way `deleteEnvNames`/`deleteEnvMatching` would. Deleting the whole variable
 * is the wrong shape here: it silently disables every OTHER entry a user's
 * own install put there, which is a bigger, unannounced behavior change than
 * removing the specific entries that are actually unsafe.
 *
 * A no-op (env returned unchanged) when `name` is absent, or already has no
 * segment the predicate rejects.
 */
function filterEnvValue(env, name, delimiter, keep) {
  if (!env || typeof env !== 'object') throw new TypeError('env must be an object');
  if (typeof name !== 'string' || !name) throw new TypeError('name must be a non-empty string');
  if (typeof delimiter !== 'string' || !delimiter) throw new TypeError('delimiter must be a non-empty string');
  if (typeof keep !== 'function') throw new TypeError('keep must be a function');
  const folded = fold(name);
  for (const key of enumerateEnvNames(env)) {
    if (fold(key) !== folded) continue;
    const value = env[key];
    if (typeof value !== 'string' || value === '') continue;
    const filtered = value.split(delimiter).filter(keep).join(delimiter);
    if (filtered === value) continue;
    // Same tombstone-safe write removeReachableName uses: an own, enumerable
    // property always wins over whatever the prototype chain holds, and
    // survives the next `{ ...env }` spread this codebase does at every fold.
    Object.defineProperty(env, key, {
      value: filtered,
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return env;
}

module.exports = Object.freeze({
  deleteEnvMatching,
  deleteEnvNames,
  envValues,
  filterEnvValue,
  hasEnvName,
  presentEnvNames
});
