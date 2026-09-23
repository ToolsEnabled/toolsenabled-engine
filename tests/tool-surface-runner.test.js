'use strict';

const assert = require('node:assert/strict');
const runner = require('../tools/lib/tool-surface-runner');
const cli = require('../tools/tool-surface-runner');

function descriptor(name, effect, { destructiveHint = effect.endsWith('-write'), provider = null, required = [] } = {}) {
  return Object.freeze({
    name, description: name, effect, approvalEligible: effect === 'external-write', provider,
    inputSchema: Object.freeze({ type: 'object', properties: {}, required, additionalProperties: false }),
    annotations: Object.freeze({
      readOnlyHint: effect.endsWith('-read'), destructiveHint,
      idempotentHint: true, openWorldHint: effect.startsWith('external-')
    })
  });
}

const tools = [
  descriptor('alpha.read', 'local-read'),
  descriptor('alpha.lookup', 'local-read', { required: ['id'] }),
  descriptor('beta.write', 'local-write', { destructiveHint: false }),
  descriptor('gamma.fetch', 'external-read', { destructiveHint: false, provider: 'fixture' }),
  descriptor('gamma.send', 'external-write', { destructiveHint: false, provider: 'fixture' }),
  descriptor('delta.delete', 'local-write', { destructiveHint: true })
];

async function main() {
  const measured = runner.census(tools);
  assert.equal(measured.toolCount, 6);
  assert.equal(measured.namespaceCount, 4);
  assert.deepEqual(measured.classes, {
    'HARMLESS READ': 2,
    'REVERSIBLE WRITE': 1,
    'REQUIRES-STAND-IN': 2,
    'OWNER-PREREQUISITE': 1
  });

  const invoked = [];
  const adapter = {
    discover: async () => tools,
    invoke: async (name) => {
      invoked.push(name);
      return name === 'alpha.lookup'
        ? { origin: 'product', kind: 'refusal', code: 'INVALID_PARAMS', message: 'id is required' }
        : { origin: 'product', kind: 'answer', value: { ok: true } };
    },
    exerciseReversible: async tool => ({
      origin: 'product', kind: 'reversible', writeAsserted: true, restoreAsserted: true,
      writeEvidence: `${tool.name} changed`, restoreEvidence: `${tool.name} restored`
    })
  };
  const result = await runner.run({ registeredTools: () => tools, adapters: { 'desktop-here': adapter } });
  assert.deepEqual(invoked.sort(), ['alpha.lookup', 'alpha.read']);
  assert.equal(result.surfaces['desktop-here'].cells['alpha.read'].status, 'VERIFIED');
  assert.equal(result.surfaces['desktop-here'].cells['alpha.lookup'].evidence.refusalCode, 'INVALID_PARAMS');
  assert.equal(result.surfaces['desktop-here'].cells['beta.write'].status, 'VERIFIED');
  assert.equal(result.surfaces['desktop-here'].cells['gamma.fetch'].status, 'OWNER-PREREQUISITE');
  assert.match(result.surfaces['desktop-here'].cells['gamma.fetch'].reason, /fixture test account/);
  assert.equal(result.surfaces['desktop-here'].cells['gamma.send'].status, 'NOT APPLICABLE');
  assert.equal(result.surfaces['desktop-here'].cells['delta.delete'].status, 'NOT APPLICABLE');
  assert.equal(result.surfaces.docker.counts['NOT YET TESTED'], tools.length);

  const noLifecycle = await runner.run({ registeredTools: () => [tools[2]], adapters: {
    'desktop-here': { discover: async () => [tools[2]], invoke: async () => ({ origin: 'product', kind: 'answer', value: {} }) }
  }});
  assert.equal(noLifecycle.surfaces['desktop-here'].cells['beta.write'].status, 'NOT YET TESTED');
  assert.match(noLifecycle.surfaces['desktop-here'].cells['beta.write'].reason, /write\/assert\/restore\/re-read\/assert/);

  const codedRefusal = new Error('bounded runner refusal');
  codedRefusal.code = 'INVALID_PARAMS';
  const codedThrow = await runner.run({ registeredTools: () => [tools[0]], adapters: {
    'desktop-here': {
      discover: async () => [tools[0]],
      invoke: async () => { throw codedRefusal; }
    }
  }});
  assert.equal(codedThrow.surfaces['desktop-here'].cells['alpha.read'].status, 'NOT MEASURED');
  assert.equal(codedThrow.surfaces['desktop-here'].cells['alpha.read'].evidence.origin, 'runner');
  assert.equal(codedThrow.surfaces['desktop-here'].cells['alpha.read'].evidence.runnerCode, 'INVALID_PARAMS');
  assert.equal(codedThrow.surfaces['desktop-here'].cells['alpha.read'].evidence.delivery, 'throw');

  const codedWriteRefusal = await runner.run({ registeredTools: () => [tools[2]], adapters: {
    'desktop-here': {
      discover: async () => [tools[2]],
      exerciseReversible: async () => { throw codedRefusal; }
    }
  }});
  assert.equal(codedWriteRefusal.surfaces['desktop-here'].cells['beta.write'].status, 'NOT MEASURED');
  assert.equal(codedWriteRefusal.surfaces['desktop-here'].cells['beta.write'].evidence.origin, 'runner');
  assert.equal(codedWriteRefusal.surfaces['desktop-here'].cells['beta.write'].evidence.runnerCode, 'INVALID_PARAMS');

  const productCodeWithRunnerLikeName = await runner.run({ registeredTools: () => [tools[0]], adapters: {
    'desktop-here': {
      discover: async () => [tools[0]],
      invoke: async () => ({
        origin: 'product', kind: 'refusal', code: 'RUNNER_ADAPTER_TIMEOUT', message: 'product sentinel'
      })
    }
  }});
  assert.equal(productCodeWithRunnerLikeName.surfaces['desktop-here'].cells['alpha.read'].status, 'FAILS');
  assert.equal(productCodeWithRunnerLikeName.surfaces['desktop-here'].cells['alpha.read'].evidence.origin, 'product');

  const refusedValidRead = await runner.run({ registeredTools: () => [tools[0]], adapters: {
    'desktop-here': {
      discover: async () => [tools[0]],
      invoke: async () => ({
        origin: 'product', kind: 'refusal', code: 'TEMPORARILY_UNAVAILABLE', message: 'could not read'
      })
    }
  }});
  assert.equal(refusedValidRead.surfaces['desktop-here'].cells['alpha.read'].status, 'FAILS');
  assert.match(refusedValidRead.surfaces['desktop-here'].cells['alpha.read'].reason, /refused a valid empty-argument read/);

  const uncodedProductFailure = await runner.run({ registeredTools: () => [tools[0]], adapters: {
    'desktop-here': {
      discover: async () => [tools[0]],
      invoke: async () => ({ origin: 'product', kind: 'failure', message: 'broken product handler' })
    }
  }});
  assert.equal(uncodedProductFailure.surfaces['desktop-here'].cells['alpha.read'].status, 'FAILS');
  assert.equal(uncodedProductFailure.surfaces['desktop-here'].cells['alpha.read'].evidence.origin, 'product');

  const unmarkedEnvelope = await runner.run({ registeredTools: () => [tools[0]], adapters: {
    'desktop-here': {
      discover: async () => [tools[0]],
      invoke: async () => ({ kind: 'refusal', code: 'LOOKS_PRODUCT_BUT_ORIGIN_UNKNOWN' })
    }
  }});
  assert.equal(unmarkedEnvelope.surfaces['desktop-here'].cells['alpha.read'].status, 'NOT MEASURED');
  assert.equal(unmarkedEnvelope.surfaces['desktop-here'].cells['alpha.read'].evidence.origin, 'runner');

  const expectedSession = Object.freeze({ origin: 'local', tier: 'confined', profile: 'read-only' });
  const expectedMaximum = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
  let workerPayload = null;
  const localAdapter = cli.desktopAdapter(1_000, {
    dispatchSession: {
      UNATTENDED_CEILING: expectedMaximum,
      unattendedSession: () => expectedSession
    },
    spawnRequest: async command => {
      workerPayload = JSON.parse(Buffer.from(command[2], 'base64url').toString('utf8'));
      return { ok: true, result: { origin: 'product', kind: 'answer', value: { ok: true } } };
    }
  });
  await localAdapter.invoke(tools[0].name, {});
  assert.deepEqual(workerPayload.permissionSession, expectedSession);
  assert.deepEqual(localAdapter.permissionCeiling, {
    state: 'STATED',
    source: 'src/lib/dispatch-permission-session.js#unattendedSession()',
    maximum: expectedMaximum,
    resolved: expectedSession
  });

  const missing = await runner.run({ registeredTools: () => [tools[0]], adapters: {
    'desktop-here': { discover: async () => [], invoke: async () => ({ origin: 'product', kind: 'answer', value: {} }) }
  }});
  assert.equal(missing.surfaces['desktop-here'].cells['alpha.read'].status, 'FAILS');

  const unreachable = await runner.run({ registeredTools: () => [tools[0]], adapters: {
    'desktop-here': { discover: async () => { throw new Error('offline'); } }
  }});
  assert.equal(unreachable.surfaces['desktop-here'].cells['alpha.read'].status, 'NOT MEASURED');
  assert.equal(unreachable.surfaces['desktop-here'].cells['alpha.read'].evidence.origin, 'runner');
  assert.equal(unreachable.surfaces['desktop-here'].permissionCeiling.state, 'UNKNOWN');

  assert.equal(cli.resultExitCode(result), 3,
    'unconfigured surfaces, forbidden real invocations, and owner prerequisites must not exit green');
  assert.equal(cli.resultExitCode(unreachable), 3, 'unmeasured discovery must not exit green');
  assert.equal(cli.resultExitCode(missing), 1, 'a definite failed check retains the failure exit code');
  const verifiedOnly = await runner.run({
    registeredTools: () => [tools[0]],
    surfaces: runner.SURFACES,
    adapters: Object.fromEntries(runner.SURFACES.map(surface => [surface, {
      discover: async () => [tools[0]],
      invoke: async () => ({ origin: 'product', kind: 'answer', value: { ok: true } })
    }]))
  });
  assert.equal(cli.resultExitCode(verifiedOnly), 0, 'only fully verified coverage exits green');

  const proof = await runner.failureProof(() => tools);
  assert.equal(tools.some(tool => tool.name === proof.tool), true);
  assert.equal(proof.broken.status, 'FAILS');
  assert.equal(proof.restored.status, 'VERIFIED');

  assert.throws(() => runner.census([...tools, tools[0]]), /duplicate/);
  process.stdout.write('Tool surface runner tests passed.\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
