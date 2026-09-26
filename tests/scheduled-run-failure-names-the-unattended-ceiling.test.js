'use strict';

// A FAILED SCHEDULED RUN MUST NOT SEND THE OWNER TO A SETTING THAT CANNOT HELP.
//
// src/lib/confined-tool-surface.js refuses an unconfinable tool with "... so it
// is available only at the Unrestricted level". That is true of an interactive
// caller and false of a scheduled one: src/lib/dispatch-permission-session.js's
// unattendedSession() clamps a local `full` (Unrestricted) owner session down to
// confined/workspace, so the two SUPPORTED_SCHEDULED_ACTIONS that are classified
// unconfinable -- launch.execute and deployment.execute -- refuse on the
// scheduled path at every recorded installation level.
//
// src/job-runner.js persists that refusal message as the reason the owner reads
// for a failed run. Unqualified, it asks someone whose nightly job keeps failing
// to widen their machine's permission level in exchange for nothing, which is a
// worse outcome than the failure it explains.
//
// THIS SUITE DRIVES THE REAL CHOKEPOINT. `executeTool` is NOT injected: the
// refusal comes from tool-registry.js#executeTool consulting the same ceiling a
// real firing would, so the assertions below measure the product's own refusal
// rather than a fabricated error object. Only the durable store, the audit sink,
// the active-policy guard and the machine record are stubbed, and the machine
// record is stubbed precisely because the recorded level is the axis under test.
//
// The negative case is load-bearing. `gmail.send` at `guided` refuses too, with
// PERMISSION_CONFINED_EFFECT_REFUSED -- and there raising the level to Standard
// genuinely IS the answer, which the repro in this suite's sibling measurement
// confirms. So the note must NOT be appended there; a version of this fix that
// always appended it would still be wrong, and the second test is what fails on
// it rather than passing vacuously.

const test = require('node:test');
const assert = require('node:assert/strict');

require('./lib/isolated-environment').activate('scheduled-run-ceiling');

const { runScheduledInvocation } = require('../src/job-runner');

const CEILING_NOTE = /raising the installation level does not make this action schedulable/;
const INSTALL_LEVELS = Object.freeze(['guided', 'standard', 'unrestricted']);

// A store that admits exactly one run and records what the runner concluded
// about it. Nothing here decides the refusal; it only captures the durable
// sentence the owner would read.
function recordingStore(action, args) {
  const outcomes = [];
  return {
    outcomes,
    reapExpiredSchedulerRuns() {},
    startSchedulerRun() {
      return {
        runId: 'scheduler-run-ceiling', fence: 1, action, args,
        job: { jobId: 'scheduler-job-ceiling', name: 'nightly' }
      };
    },
    completeSchedulerRun(handle, outcome) { outcomes.push(outcome); }
  };
}

function dependencies(store, tier) {
  return {
    state: store,
    assertActive() {},
    audit: { record() {}, redact: value => String(value) },
    // The same lever the recorded level itself uses; see unattendedSession's
    // note on why no caller-supplied ceiling override exists.
    machineRecord: {
      readMachineRecord: () => ({ tier }),
      resolveServicesRoot: () => '/nonexistent-for-this-suite'
    }
  };
}

const SELECTOR = Object.freeze({
  installationId: 'a'.repeat(32), jobId: 'scheduler-job-ceiling',
  generation: 1, ownershipMarker: 'b'.repeat(64)
});

test('an unconfinable scheduled action explains the unattended ceiling at every installation level', async () => {
  for (const tier of INSTALL_LEVELS) {
    const store = recordingStore('launch.execute', { cwd: 'C:\\project' });
    await assert.rejects(() => runScheduledInvocation(SELECTOR, dependencies(store, tier)),
      error => error && error.code === 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      `launch.execute must be refused by the confined tool policy at ${tier}`);

    assert.equal(store.outcomes.length, 1, `exactly one outcome must be persisted at ${tier}`);
    const [outcome] = store.outcomes;
    assert.equal(outcome.status, 'failed');
    // The policy's own code is kept: this corrects the explanation, it does not
    // re-decide or rename the refusal.
    assert.equal(outcome.code, 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED');
    assert.match(outcome.message, /launch\.execute/,
      `the persisted reason must still name the action at ${tier}`);
    assert.match(outcome.message, CEILING_NOTE,
      `at ${tier} the owner is told to raise the installation level, which cannot make a scheduled `
      + 'launch.execute run -- unattendedSession clamps every level to the same confined ceiling');
  }
});

test('a refusal a higher installation level really would fix is left to speak for itself', async () => {
  // gmail.send is admitted at standard/unrestricted and refused at guided on
  // effect alone. Moving that installation from Guided to Standard is the real
  // remedy, so the scheduled path must not talk the owner out of it.
  const store = recordingStore('gmail.send', { to: 'owner@example.invalid', subject: 'nightly' });
  await assert.rejects(() => runScheduledInvocation(SELECTOR, dependencies(store, 'guided')),
    error => error && error.code === 'PERMISSION_CONFINED_EFFECT_REFUSED');

  assert.equal(store.outcomes.length, 1);
  const [outcome] = store.outcomes;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.code, 'PERMISSION_CONFINED_EFFECT_REFUSED');
  assert.doesNotMatch(outcome.message, CEILING_NOTE,
    'the note belongs only to a refusal no installation level can lift');
});
