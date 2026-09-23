'use strict';
/* "NOTHING IS CONFIGURED" IS AN ANSWER TO A STATUS QUESTION, NOT A FAILURE.
 *
 * MEASURED 2026-09-03 on the owner's own ledger: research.local_tiers_status
 * was called 21 times over four days and failed 21 times, every one
 * MODEL_NO_GPU_PEER_CONFIGURED at HTTP 409, median 19 ms server-side. This
 * machine has no GPU peer, which is the ordinary single-machine case -- the
 * module that raises it says so itself: "Not an error the user caused."
 *
 * Each of those 21 calls also wrote TWO durable audit records, so a question
 * with a perfectly good answer cost 42 signed ledger entries and read, to
 * anyone looking at the log, as a tool that does not work.
 *
 * The distinction is the one this codebase draws everywhere else: "could not
 * look" and "not there" are different answers, and only one of them is a
 * failure. Asking "are the local tiers ready" is answered by "no, because
 * nothing is configured" -- that IS the status.
 *
 * THE HALF THAT MATTERS MORE is what still throws. Widening the catch would
 * hide a real outage behind a calm sentence, which is the opposite of the fix,
 * so this file spends most of its assertions on the errors that must survive.
 *
 *   node --test tests/local-tiers-absence.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const research = require('../src/lib/providers/research-strong.js');

function failing(code, message, reason) {
  return async () => {
    const error = new Error(message);
    error.code = code;
    if (reason) error.details = { reason };
    throw error;
  };
}

const NO_TEMPERATURE = () => null;
const POLICY = Object.freeze({ hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true });

test('no GPU peer configured answers, and the answer says which tiers are unavailable and why', async () => {
  const answer = await research.status({
    probe: failing('MODEL_NO_GPU_PEER_CONFIGURED',
      'No GPU peer machine is configured, so no local model backend is reachable. Add one in config/machines.profile.json to enable local model inference.',
      'no_gpu_peer_configured'),
    gpuTemperatureC: NO_TEMPERATURE,
    policy: POLICY,
  });

  assert.equal(answer.available, false, 'the answer says plainly that nothing is available');
  assert.equal(answer.reason, 'no_gpu_peer_configured');
  assert.equal(answer.localOnly, true);
  assert.equal(answer.fast.ready, false);
  assert.equal(answer.strong.ready, false);
  assert.equal(answer.fast.reason, 'no_gpu_peer_configured');
  assert.equal(answer.strong.reason, 'no_gpu_peer_configured');

  /* The sentence the module already wrote is carried rather than reworded: it
     names what to add and where, and a second copy would be free to drift. */
  assert.match(answer.detail, /config\/machines\.profile\.json/);

  /* A figure nobody measured is null, never 0 -- a zero would read as "no free
     memory", which is a different and alarming fact. */
  assert.equal(answer.freeRamMiB, null);
  assert.equal(answer.freeVramMiB, null);
  assert.equal(answer.gpuTemperatureC, null);
  /* null, NOT []: nothing was measured, and an empty array would read as
     "we looked and no model is resident" -- a measurement nobody took.
     Same reasoning as the null figures above. */
  assert.equal(answer.residentModels, null);
});

test('a configured peer that is ambiguous is also an answer, with its own reason', async () => {
  const answer = await research.status({
    probe: failing('MODEL_GPU_PEER_AMBIGUOUS',
      'More than one peer machine is configured and no explicit GPU-peer selector exists.',
      'gpu_peer_ambiguous'),
    gpuTemperatureC: NO_TEMPERATURE,
    policy: POLICY,
  });
  assert.equal(answer.available, false);
  assert.equal(answer.reason, 'gpu_peer_ambiguous',
    'the two absences stay distinguishable; collapsing them would lose what to fix');
});

test('an unreadable machine profile still THROWS, because that is "could not look"', async () => {
  await assert.rejects(
    research.status({
      probe: failing('MODEL_MACHINE_PROFILE_CHECK_FAILED', 'The machine profile could not be checked.'),
      gpuTemperatureC: NO_TEMPERATURE,
      policy: POLICY,
    }),
    error => error.code === 'MODEL_MACHINE_PROFILE_CHECK_FAILED',
    'a broken check must never be reported as "nothing is configured"',
  );
});

test('a peer that IS configured but unreachable still THROWS', async () => {
  /* This is the case the narrow catch exists to protect. A real outage on a
     configured backend must not arrive as a calm "not available". */
  for (const code of ['MODEL_OLLAMA_UNREACHABLE', 'ECONNREFUSED', 'MODEL_OLLAMA_TIMEOUT']) {
    await assert.rejects(
      research.status({
        probe: failing(code, 'the peer did not answer'),
        gpuTemperatureC: NO_TEMPERATURE,
        policy: POLICY,
      }),
      error => error.code === code,
      code,
    );
  }
});

test('an error with no code at all still throws', async () => {
  await assert.rejects(
    research.status({
      probe: async () => { throw new Error('something unexpected'); },
      gpuTemperatureC: NO_TEMPERATURE,
      policy: POLICY,
    }),
    /something unexpected/,
    'an unrecognised failure is not an absence',
  );
});

test('a working probe answers available:true, so a caller reads one field either way', async () => {
  const answer = await research.status({
    /* The full shape assertMeasuredResources() requires: a probe missing any of
       these is not a measurement and is refused before readiness is judged. */
    probe: async () => ({
      ollamaReachable: true,
      freeRamBytes: 32 * 1024 ** 3,
      freeVramBytes: 12 * 1024 ** 3,
      onBattery: false,
      installedModels: ['hermes3:8b'],
      residentModels: [],
    }),
    gpuTemperatureC: () => 52,
    policy: POLICY,
  });
  assert.equal(answer.available, true);
  assert.equal(answer.reason, null);
  assert.equal(answer.gpuTemperatureC, 52);
  assert.ok(Number.isFinite(answer.freeRamMiB));
});
