'use strict';

// Drive the generic throwing-form refusal through the public API. The injected
// entitlement dependency models a gate that refuses correctly but supplies no
// provider-specific code; this is the reachable condition for which
// assertTransportAllowed() promises ANYWHERE_TRANSPORT_REFUSED.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const transport = require('../src/lib/anywhere-transport');

function main() {
  const sideEffects = [];
  const originals = {
    appendFileSync: fs.appendFileSync,
    createWriteStream: fs.createWriteStream,
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    writeFileSync: fs.writeFileSync
  };

  fs.appendFileSync = (...args) => { sideEffects.push(['appendFileSync', ...args]); };
  fs.createWriteStream = (...args) => { sideEffects.push(['createWriteStream', ...args]); };
  fs.writeFileSync = (...args) => { sideEffects.push(['writeFileSync', ...args]); };
  childProcess.spawn = (...args) => { sideEffects.push(['spawn', ...args]); };
  childProcess.spawnSync = (...args) => { sideEffects.push(['spawnSync', ...args]); };

  const calls = [];
  const entitlement = Object.freeze({
    GATED_CAPABILITIES: Object.freeze({
      'hosted-relay': Object.freeze({ freeAlternatives: Object.freeze(['direct', 'self-hosted-relay']) })
    }),
    decide(capability, suppliedEntitlement) {
      calls.push({ capability, suppliedEntitlement });
      return {
        allowed: false,
        code: null,
        reason: 'The injected entitlement gate refused this installation.',
        remedy: 'Choose a free transport.'
      };
    },
    resolveEntitlement() {
      throw new Error('an explicit entitlement must not be resolved again');
    }
  });
  const suppliedEntitlement = Object.freeze({ source: 'test refusal fixture' });

  try {
    assert.throws(
      () => transport.assertTransportAllowed(
        transport.HOSTED_RELAY,
        { entitlement: suppliedEntitlement },
        { entitlement }
      ),
      error => {
        assert.ok(error instanceof transport.AnywhereTransportError);
        assert.equal(error.name, 'AnywhereTransportError');
        assert.equal(error.code, 'ANYWHERE_TRANSPORT_REFUSED');
        assert.equal(
          error.message,
          'The injected entitlement gate refused this installation. Choose a free transport.'
        );
        assert.strictEqual(error.decision, error.details.decision);
        assert.deepEqual(error.decision, {
          transport: 'hosted-relay',
          allowed: false,
          code: null,
          reason: 'The injected entitlement gate refused this installation.',
          remedy: 'Choose a free transport.',
          freeAlternatives: ['direct', 'self-hosted-relay'],
          entitlementChecked: true
        });
        assert.equal(Object.isFrozen(error.decision), true);
        assert.equal(Object.isFrozen(error.decision.freeAlternatives), true);
        return true;
      }
    );

    assert.deepEqual(calls, [{
      capability: 'hosted-relay',
      suppliedEntitlement
    }], 'the real module must drive the injected gate exactly once');
    assert.deepEqual(sideEffects, [], 'refusal must neither write nor spawn a process');
  } finally {
    fs.appendFileSync = originals.appendFileSync;
    fs.createWriteStream = originals.createWriteStream;
    fs.writeFileSync = originals.writeFileSync;
    childProcess.spawn = originals.spawn;
    childProcess.spawnSync = originals.spawnSync;
  }

  process.stdout.write('Anywhere transport generic refusal test passed.\n');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
