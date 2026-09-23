'use strict';

// R1162 regression: a provider being disabled must not mask the mechanical
// lane-scope refusal. The registry guard runs before provider dispatch and no
// network/provider handler is reached.

const assert = require('node:assert/strict');
const audit = require('../../src/lib/audit');
const { createAuditStore } = require('../../src/lib/audit-store');
const laneScope = require('../../src/lib/lane-scope');
const actionGuards = require('../../src/lib/action-guards');
const { executeTool, registeredTools } = require('../helpers/dispatch');

let checks = 0;

async function main() {
  // Audit-touching tests never resolve the production default. This in-memory
  // store is injected into the registry's refusal-audit seam for this case.
  const auditStore = createAuditStore({ file: ':memory:' });
  const priorRecord = audit.record;
  const priorScope = process.env[laneScope.ENV_VAR];
  let auditSequence = 0;
  audit.record = (action, target, details) => {
    auditSequence += 1;
    auditStore.setMetadata(`lane-scope-event-${auditSequence}`, JSON.stringify({ action, target, details }));
    return { durable: true, anchored: true };
  };
  process.env[laneScope.ENV_VAR] = laneScope.serialize({
    directiveId: 'R1162',
    territory: ['src/lib/**'],
    machineScope: 'local'
  });

  try {
    const registryNames = registeredTools().map(entry => entry.name);
    const registryNameSet = new Set(registryNames);
    const familyPrefixes = actionGuards.LANE_SCOPE_CROSS_MACHINE_PREFIXES;
    const exactNonFamily = new Set([
      'gmail.send', 'system.ask_remote',
      'host.read_file', 'host.write_file', 'host.list_dir', 'host.list_processes', 'host.exec',
      // host.patch_file (byte-mediated exact-span host edit, 2026-09-11) is a
      // host file writer exactly like host.write_file.
      'host.patch_file',
      // repo.patch_file joined the registry after this mirror was written. The
      // guard already carried it; this list did not, so the guard was reported
      // as over-enumerating when it was in fact correct and this list was the
      // stale half. A repo write that crosses machines belongs in the scoped
      // set exactly as much as repo.write_file does.
      'repo.read_file', 'repo.write_file', 'repo.patch_file', 'repo.list_dir',
      'agent_comms.send', 'agent_comms.read'
    ]);
    const expectedEnumerated = registryNames.filter(name => exactNonFamily.has(name)
      || familyPrefixes.some(prefix => name.startsWith(prefix))).sort();
    const actualEnumerated = [...actionGuards.LANE_SCOPE_CROSS_MACHINE_TOOLS]
      .filter(name => registryNameSet.has(name)).sort();
    assert.deepEqual(actualEnumerated, expectedEnumerated,
      'the guard must explicitly enumerate every current registry name in the scoped families');
    checks += 1;

    await assert.rejects(
      // SUBJECT CHANGED 2026-08-23: this drove telegram.send, which left the
      // registry with the connector. workstation.status is a surviving member of
      // LANE_SCOPE_CROSS_MACHINE_TOOLS, so the refusal path is still exercised
      // against a REAL registry entry rather than an unknown id -- an UNKNOWN_TOOL
      // would refuse for the wrong reason and prove nothing. It also takes no
      // required arguments, so the lane-scope guard is reached instead of argument
      // validation refusing first with INVALID_PARAMS.
      executeTool('workstation.status', {}),
      error => {
        assert.equal(error.code, 'LANE_SCOPE_REFUSED');
        assert.equal(error.directiveId, 'R1162');
        assert.equal(error.requiredMachineScope, 'cross-machine');
        assert.match(error.message, /Directive R1162/);
        assert.match(error.message, /machineScope 'cross-machine'/);
        return true;
      }
    );
    checks += 1;

    const refusal = JSON.parse(auditStore.getMetadata('lane-scope-event-1').value);
    assert.equal(refusal.action, 'mcp.tool.standing_order_refused');
    assert.equal(refusal.target, 'workstation.status');
    assert.equal(refusal.details.code, 'LANE_SCOPE_REFUSED');
    checks += 1;

    // R1162 security research F2 regression: the internal agent-comms fabric
    // relay is an authenticated cross-machine transport and was previously
    // missing from the guard's list entirely, so a local-scoped lane reached
    // it with no LANE_SCOPE_REFUSED check at all.
    await assert.rejects(
      // recipientMachine was 'machine-b'. The schema has since narrowed that
      // field to the single value 'this-machine', so the old payload refused
      // with INVALID_PARAMS during argument validation and never reached the
      // lane-scope guard at all -- the check went on passing its own name while
      // proving nothing about lane scope, which is the exact failure mode the
      // workstation.status comment above was written about. The guard keys on
      // the tool's family, not on the argument value, so the only schema-legal
      // payload still reaches it and still refuses.
      executeTool('agent_comms.send', { recipientActor: 'codex', recipientMachine: 'this-machine', body: 'exfiltrate' }),
      error => {
        assert.equal(error.code, 'LANE_SCOPE_REFUSED');
        assert.equal(error.requiredMachineScope, 'cross-machine');
        return true;
      }
    );
    checks += 1;

    await assert.rejects(
      executeTool('agent_comms.read', { cursor: 0 }),
      error => {
        assert.equal(error.code, 'LANE_SCOPE_REFUSED');
        assert.equal(error.requiredMachineScope, 'cross-machine');
        return true;
      }
    );
    checks += 1;

    process.env[laneScope.ENV_VAR] = laneScope.serialize({
      directiveId: 'R1162',
      territory: ['src/lib/**'],
      machineScope: 'cross-machine'
    });
    await assert.rejects(
      executeTool('workstation.status', {}),
      error => error.code !== 'LANE_SCOPE_REFUSED'
    );
    checks += 1;

    process.stdout.write(`lane-scope registry guard: ${checks} checks passed\n`);
  } finally {
    audit.record = priorRecord;
    if (priorScope === undefined) delete process.env[laneScope.ENV_VAR];
    else process.env[laneScope.ENV_VAR] = priorScope;
    auditStore.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
