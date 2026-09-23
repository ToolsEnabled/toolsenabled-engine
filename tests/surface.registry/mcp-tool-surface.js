// EXECUTABLE CHANGE — assertion audit report (testcanfail-tests-surface-registry-mcp-tool-surface-js)
// Strengthened browserProjection assertion: mutating browserProjection to return a fixed, safely
// shaped object left the former key-list/redaction assertions GREEN ("projection probe passed").
// With this value-preservation assertion, that mutation is RED: "Expected values to be strictly
// deep-equal" (actual state "unknown", expected "fresh"). The source mutation was restored
// byte-for-byte; the restored focused run was GREEN: "restored projection assertion passed".
// Final full-file run precondition not met: installed Node 20.20.2 lacks node:sqlite.
// NOT-FOUND: empty loop/forEach assertions; exit-status/truthy-process assertions; swallowed
// try/catch or optional-chain failures; assertions against a mock of their subject; skip/platform
// no-op guards; expected values computed by the same code under test.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../../src/lib/state-store');
const { recordMcpSurface } = require('../../src/mcp-server');
const crypto = require('node:crypto');
const {
  MEMORY_KEY, MEMORY_NAMESPACE, batchedProcessIdentity, browserProjection,
  classifyInstance, defaultProcessIdentity, recordStartup, status
} = require('../../src/lib/mcp-tool-surface');
const { windowsStartTicks } = require('../../src/lib/providers/durable-worker-runtime');

class MemoryState {
  constructor({ conflicts = 0 } = {}) {
    this.value = null;
    this.revision = 0;
    this.conflicts = conflicts;
  }

  getMemory({ namespace, key }) {
    assert.equal(namespace, MEMORY_NAMESPACE);
    assert.equal(key, MEMORY_KEY);
    return this.value === null ? null : { value: structuredClone(this.value), revision: this.revision };
  }

  setMemory({ namespace, key, value, expectedRevision }) {
    assert.equal(namespace, MEMORY_NAMESPACE);
    assert.equal(key, MEMORY_KEY);
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      const error = new Error('simulated concurrent writer');
      error.code = 'MEMORY_REVISION_CONFLICT';
      throw error;
    }
    if (expectedRevision !== this.revision) {
      const error = new Error('revision conflict');
      error.code = 'MEMORY_REVISION_CONFLICT';
      throw error;
    }
    this.value = structuredClone(value);
    this.revision += 1;
    return { entry: { revision: this.revision }, replayed: false };
  }
}

const tools = [{
  name: 'code.status', description: 'Read code intelligence status.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}];
const tickA = '638890000000000001';
const tickB = '638890000000000002';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-mcp-surface-'));
const registry = path.join(root, 'tool-registry.js');
fs.writeFileSync(registry, 'const original = true;\n', 'utf8');

function identity(values) {
  return pid => values.get(pid) || { state: 'dead', startTicks: null };
}

try {
  {
    const state = new MemoryState();
    const identities = new Map([[4101, { state: 'alive', startTicks: tickA }]]);
    recordStartup({
      state, transport: 'owner-host', pid: 4101, startTicks: tickA,
      bootedAtMs: 1_784_000_000_000, instanceId: '00000000-0000-4000-8000-000000000001',
      tools, registryFile: registry, processIdentity: identity(identities)
    });
    const report = status({ state, tools, registryFile: registry, processIdentity: identity(identities) });
    assert.equal(report.state, 'fresh');
    assert.equal(report.reason, 'MCP_TOOL_SURFACE_MATCHED_OWNER_HOST');
    assert.equal(report.counts.fresh, 1);
    const projected = browserProjection(report);
    assert.deepEqual(Object.keys(projected).sort(), [
      'counts', 'directSessionScopeUnverified', 'nextAction', 'reason', 'schemaVersion', 'state'
    ]);
    assert.deepEqual(projected, {
      schemaVersion: 1,
      state: 'fresh',
      reason: 'MCP_TOOL_SURFACE_MATCHED_OWNER_HOST',
      nextAction: 'none',
      counts: { observed: 1, fresh: 1, stale: 0, unknown: 0, deadIgnored: 0 },
      directSessionScopeUnverified: false
    }, 'browser projection must preserve every public status value');
    assert.doesNotMatch(JSON.stringify(projected), /4101|6388900|[a-f0-9]{64}/i,
      'browser projection must not expose pid, process identity, or hashes');
  }

  {
    const state = createStateStore({ file: ':memory:' });
    const identities = new Map([[4106, { state: 'alive', startTicks: tickA }]]);
    try {
      recordMcpSurface({
        tools,
        recordStartup: input => recordStartup({
          ...input, state, pid: 4106, startTicks: tickA,
          bootedAtMs: 1_784_000_000_005, instanceId: '00000000-0000-4000-8000-000000000006',
          registryFile: registry, processIdentity: identity(identities)
        })
      });
      const saved = state.getMemory({ namespace: MEMORY_NAMESPACE, key: MEMORY_KEY });
      assert.equal(saved.value.instances.length, 1, 'the MCP bootstrap must use the real transactional state store');
      assert.equal(saved.value.instances[0].transport, 'stdio-direct');
    } finally {
      state.close();
    }
  }

  {
    const state = new MemoryState();
    const identities = new Map([[4102, { state: 'alive', startTicks: tickA }]]);
    recordStartup({
      state, transport: 'owner-host', pid: 4102, startTicks: tickA,
      bootedAtMs: 1_784_000_000_001, instanceId: '00000000-0000-4000-8000-000000000002',
      tools, registryFile: registry, processIdentity: identity(identities)
    });
    fs.writeFileSync(registry, 'const original = false;\n', 'utf8');
    const report = status({ state, tools, registryFile: registry, processIdentity: identity(identities) });
    assert.equal(report.state, 'stale');
    assert.equal(report.reason, 'MCP_TOOL_SURFACE_STALE_INSTANCE');
    assert.match(report.nextAction, /restart.*next session boundary/i);
    fs.writeFileSync(registry, 'const original = true;\n', 'utf8');
  }

  {
    const state = new MemoryState();
    const identities = new Map([[4107, { state: 'alive', startTicks: tickA }]]);
    recordStartup({
      state, transport: 'owner-host', pid: 4107, startTicks: tickA,
      bootedAtMs: 1_784_000_000_006, instanceId: '00000000-0000-4000-8000-000000000007',
      tools, registryFile: registry, processIdentity: identity(identities)
    });
    const changedSurface = [...tools, {
      name: 'code.definition', description: 'Read a definition.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }];
    const report = status({
      state, tools: changedSurface, registryFile: registry, processIdentity: identity(identities)
    });
    assert.equal(report.state, 'stale', 'a changed advertised tool surface must not appear fresh');
    assert.equal(report.reason, 'MCP_TOOL_SURFACE_STALE_INSTANCE');
  }

  {
    const state = new MemoryState();
    const identities = new Map([[4108, { state: 'alive', startTicks: tickA }]]);
    recordStartup({
      state, transport: 'stdio-direct', pid: 4108, startTicks: tickA,
      bootedAtMs: 1_784_000_000_007, instanceId: '00000000-0000-4000-8000-000000000008',
      tools, registryFile: registry, profileSelector: 'system.status,code.status', processIdentity: identity(identities)
    });
    const narrowedProfile = status({
      state, tools: [...tools, {
        name: 'memory.get', description: 'Read durable memory.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      }], registryFile: registry, profileSelector: '', processIdentity: identity(identities)
    });
    assert.equal(narrowedProfile.state, 'unknown',
      'a different allowlist profile is not evidence that a current direct process is stale');
    assert.equal(narrowedProfile.counts.stale, 0);
    assert.equal(narrowedProfile.counts.unknown, 1);
    assert.doesNotMatch(JSON.stringify(state.value), /system\.status|code\.status/,
      'only the profile digest, never allowlist contents, may persist in the MCP surface record');
  }

  {
    const state = new MemoryState({ conflicts: 1 });
    const identities = new Map([[4103, { state: 'alive', startTicks: tickA }]]);
    recordStartup({
      state, transport: 'stdio-direct', pid: 4103, startTicks: tickA,
      bootedAtMs: 1_784_000_000_002, instanceId: '00000000-0000-4000-8000-000000000003',
      tools, registryFile: registry, processIdentity: identity(identities)
    });
    assert.equal(state.value.instances.length, 1, 'CAS retry must retain the direct record after a concurrent write conflict');
    const report = status({ state, tools, registryFile: registry, processIdentity: identity(identities) });
    assert.equal(report.state, 'unknown', 'a matching direct one-shot cannot green-light an arbitrary direct session');
    assert.equal(report.reason, 'MCP_TOOL_SURFACE_DIRECT_SESSION_UNBOUND');
    assert.equal(report.directSessionScopeUnverified, true);
  }

  {
    const state = new MemoryState();
    const identities = new Map([[4109, { state: 'alive', startTicks: tickA }]]);
    let reads = 0;
    const unstableRead = () => {
      reads += 1;
      return Buffer.from(reads === 1 ? 'const before = true;\n' : 'const after = true;\n');
    };
    assert.throws(() => recordStartup({
      state, transport: 'stdio-direct', pid: 4109, startTicks: tickA,
      bootedAtMs: 1_784_000_000_009, instanceId: '00000000-0000-4000-8000-000000000009',
      tools, registryFile: registry, readFile: unstableRead, processIdentity: identity(identities)
    }), error => error && error.code === 'MCP_TOOL_SURFACE_REGISTRY_CHANGED');
    assert.equal(state.value, null, 'a changed hot registry must fail closed before overwriting durable surface evidence');
  }

  {
    const state = new MemoryState();
    const identities = new Map([[4104, { state: 'alive', startTicks: tickB }]]);
    recordStartup({
      state, transport: 'owner-host', pid: 4104, startTicks: null,
      bootedAtMs: 1_784_000_000_003, instanceId: '00000000-0000-4000-8000-000000000004',
      tools, registryFile: registry, processIdentity: identity(identities)
    });
    const report = status({ state, tools, registryFile: registry, processIdentity: identity(identities) });
    assert.equal(report.state, 'unknown');
    assert.equal(report.reason, 'MCP_TOOL_SURFACE_INSTANCE_UNVERIFIABLE');
  }

  {
    const state = new MemoryState();
    const identities = new Map([[4105, { state: 'alive', startTicks: tickA }]]);
    recordStartup({
      state, transport: 'owner-host', pid: 4105, startTicks: tickA,
      bootedAtMs: 1_784_000_000_004, instanceId: '00000000-0000-4000-8000-000000000005',
      tools, registryFile: registry, processIdentity: identity(identities)
    });
    identities.set(4105, { state: 'alive', startTicks: tickB });
    const report = status({ state, tools, registryFile: registry, processIdentity: identity(identities) });
    assert.equal(report.state, 'unknown', 'a recycled PID must be ignored rather than accepted as its old broker');
    assert.equal(report.counts.deadIgnored, 1);
  }

  {
    const unavailable = status({ state: new MemoryState(), tools, registryFile: path.join(root, 'missing-registry.js') });
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(unavailable.reason, 'MCP_TOOL_SURFACE_REGISTRY_UNAVAILABLE');
  }

  // A FAILED BATCH LOOKUP MUST NOT CONVICT EVERY RECORDED INSTANCE.
  //
  // A null lookup against a record that carries real ticks is not proof of
  // death: timeout, permission, and incomplete output all reach that path.
  // classifyInstance() must preserve that uncertainty rather than letting a
  // start-ticks mismatch turn it into a definite dead verdict.
  //
  // These pin the distinction the batching has to preserve: a batch that FAILED
  // answers for nothing, and a successful but incomplete batch still cannot
  // answer for the PID whose ticks were not measured.
  {
    const realTicks = windowsStartTicks(process.pid);
    assert.ok(/^\d{12,20}$/.test(String(realTicks || '')),
      'this test needs a real start-tick value for the current process');

    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const surface = {
      registryContentSha256: digest('registry'),
      surfaceSha256: digest('surface'),
      profileSha256: digest('profile')
    };
    const liveInstance = {
      schemaVersion: 1,
      instanceId: crypto.randomUUID(),
      transport: 'stdio-direct',
      pid: process.pid,
      startTicks: realTicks,
      bootedAtMs: Date.now(),
      toolCount: 1,
      ...surface
    };
    const verdict = processIdentity =>
      classifyInstance(liveInstance, { ...surface, processIdentity }).state;

    // Baseline: the unbatched path calls this instance alive-and-current.
    assert.equal(verdict(defaultProcessIdentity), 'fresh',
      'the per-PID path must report a genuinely live instance as fresh');

    // A working batch must agree with it exactly.
    assert.equal(verdict(batchedProcessIdentity([liveInstance])), 'fresh',
      'a working batch must agree with the per-PID path');

    // THE REGRESSION: a batch that throws must fall back, not convict.
    assert.equal(
      verdict(batchedProcessIdentity([liveInstance], {
        startTicksMany: () => { throw new Error('simulated spawn failure'); }
      })),
      'fresh',
      'a FAILED batch must fall back to per-PID lookup, never mark a live instance dead'
    );

    // A batch can succeed while returning incomplete output. Missing ticks for
    // a PID whose liveness probe succeeded remain unmeasured, not dead.
    assert.equal(
      verdict(batchedProcessIdentity([liveInstance], {
        startTicksMany: () => new Map([[process.pid, null]])
      })),
      'unknown',
      'a SUCCESSFUL but incomplete batch must not turn missing ticks into death'
    );
  }

  /* T159: A LIVE BROKER SERVING AN APP INSTANCE THAT NO LONGER EXISTS.
     Measured 2026-09-16 and 2026-09-18: a runtime-generation activation is
     followed by an app restart, every session bound to the previous instance
     loses its tools, and the previous main process can still be alive. Its
     record's PID is alive and -- when the two generations carry the same tool
     registry, which is every app-only change -- its digests match too. So the
     owner's own health report called a surface no current client can reach
     FRESH, next action NONE. Nothing about that is visible to anybody.

     Everything below is the SAME state store, registry and advertised tools;
     the only thing that differs between the two reports is which app instance
     is currently published. */
  {
    const previousInstance = '99999999-9999-4999-8999-999999999991';
    const currentInstance = '99999999-9999-4999-8999-999999999992';
    const state = new MemoryState();
    const identities = new Map([[4201, { state: 'alive', startTicks: tickA }]]);
    recordStartup({
      state, transport: 'owner-host', pid: 4201, startTicks: tickA,
      bootedAtMs: 1_784_000_000_010, instanceId: '00000000-0000-4000-8000-000000000021',
      tools, registryFile: registry, processIdentity: identity(identities),
      ownerHostGeneration: previousInstance
    });

    const stillPublished = status({
      state, tools, registryFile: registry, processIdentity: identity(identities),
      publishedGeneration: previousInstance
    });
    assert.equal(stillPublished.state, 'fresh',
      'the instance that IS published must still read as fresh; only a replaced one is superseded');

    const afterRestart = status({
      state, tools, registryFile: registry, processIdentity: identity(identities),
      publishedGeneration: currentInstance
    });
    assert.equal(afterRestart.state, 'stale',
      'a live broker belonging to a replaced app instance must not read as a working tool surface');
    assert.equal(afterRestart.reason, 'MCP_TOOL_SURFACE_GENERATION_SUPERSEDED',
      'the owner must be told WHY the surface is unreachable, not just that something is stale');
    assert.match(afterRestart.nextAction, /resume/i,
      'a named state must carry the recovery, and for a replaced instance that is resuming its sessions');
    assert.equal(afterRestart.counts.fresh, 0);
    assert.equal(afterRestart.counts.stale, 1);

    /* "COULD NOT LOOK" IS NOT "REPLACED". With no published generation known,
       the verdict must fall back to what the digests say, never invent a
       supersession from an absence. */
    const unknownPublication = status({
      state, tools, registryFile: registry, processIdentity: identity(identities),
      publishedGeneration: null
    });
    assert.equal(unknownPublication.state, 'fresh',
      'an unreadable publication record must not be turned into a supersession verdict');

    // A record written before this existed carries no generation, and must
    // stay exactly as classifiable as it was.
    const legacy = new MemoryState();
    const legacyIdentities = new Map([[4202, { state: 'alive', startTicks: tickB }]]);
    recordStartup({
      state: legacy, transport: 'owner-host', pid: 4202, startTicks: tickB,
      bootedAtMs: 1_784_000_000_011, instanceId: '00000000-0000-4000-8000-000000000022',
      tools, registryFile: registry, processIdentity: identity(legacyIdentities)
    });
    assert.equal(status({
      state: legacy, tools, registryFile: registry, processIdentity: identity(legacyIdentities),
      publishedGeneration: currentInstance
    }).state, 'fresh', 'a record that never claimed an app instance must not be convicted of being on an old one');

    // A present-but-malformed generation is refused rather than dropped: a
    // record silently written without one would read fresh forever.
    assert.throws(() => recordStartup({
      state: new MemoryState(), transport: 'owner-host', pid: 4203, startTicks: tickA,
      bootedAtMs: 1_784_000_000_012, instanceId: '00000000-0000-4000-8000-000000000023',
      tools, registryFile: registry, processIdentity: identity(identities),
      ownerHostGeneration: 'not-a-generation'
    }), TypeError, 'a malformed owner-host generation must be refused, not quietly omitted');

    // The browser projection is unchanged in shape by any of this.
    const projected = browserProjection(afterRestart);
    assert.equal(projected.reason, 'MCP_TOOL_SURFACE_GENERATION_SUPERSEDED');
    assert.deepEqual(Object.keys(projected.counts).sort(),
      ['deadIgnored', 'fresh', 'observed', 'stale', 'unknown']);
  }

  /* The owner host stamps the instance it published. Asserted by calling the
     recorder the host calls, with the value the host passes, and reading the
     record back -- not by matching the spelling of a call site. */
  {
    const hostGeneration = '99999999-9999-4999-8999-999999999993';
    const state = new MemoryState();
    const identities = new Map([[4204, { state: 'alive', startTicks: tickA }]]);
    recordMcpSurface({
      tools,
      transport: 'owner-host',
      ownerHostGeneration: hostGeneration,
      recordStartup: input => recordStartup({
        ...input, state, pid: 4204, startTicks: tickA,
        bootedAtMs: 1_784_000_000_013, instanceId: '00000000-0000-4000-8000-000000000024',
        registryFile: registry, processIdentity: identity(identities)
      })
    });
    const saved = state.getMemory({ namespace: MEMORY_NAMESPACE, key: MEMORY_KEY });
    assert.equal(saved.value.instances[0].ownerHostGeneration, hostGeneration,
      'the broker recorder dropped the app instance the owner host handed it');
  }


  process.stdout.write('MCP tool-surface tests passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
