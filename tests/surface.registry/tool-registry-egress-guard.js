'use strict';

// The registry is the effect chokepoint. Its own comments require every
// external write to pass artifact provenance and owner-request gates before a
// provider handler or durable intent can run.

const assert = require('node:assert/strict');
const audit = require('../../src/lib/audit');
// egress-preflight intentionally freezes its public API. Give the registry a
// mutable copy at module-load time so this suite can observe the dependency
// boundary without weakening or editing the production export.
const egressPath = require.resolve('../../src/lib/egress-preflight');
const egress = { ...require(egressPath) };
require.cache[egressPath].exports = egress;
const requestContextPath = require.resolve('../../src/lib/request-context');
const requestContext = { ...require(requestContextPath) };
require.cache[requestContextPath].exports = requestContext;
const registry = require('../../src/lib/tool-registry');

let checks = 0;

function checkEqual(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function checkDeepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

function checkOk(value, message) {
  assert.ok(value, message);
  checks += 1;
}

function checkThrows(block, predicate, message) {
  assert.throws(block, predicate, message);
  checks += 1;
}

function main() {
  const executeSource = registry.executeTool.toString();
  const effectGate = executeSource.indexOf("entry.effect === 'external-write'");
  const provenanceGate = executeSource.indexOf('assertEgressPreflight(entry, executionArguments, invocationId)', effectGate);
  const ownerGate = executeSource.indexOf('assertOutwardGate(entry, context, invocationId, executionArguments)', provenanceGate);
  const durableIntent = executeSource.indexOf("requireDurableRecord('mcp.tool.intent'", ownerGate);
  const handler = executeSource.indexOf('entry.handler(executionArguments', durableIntent);
  checkOk(effectGate >= 0 && provenanceGate > effectGate && ownerGate > provenanceGate
      && durableIntent > ownerGate && handler > durableIntent,
    'chokepoint contract: every external write must cross provenance and owner gates before audit intent and handler dispatch');

  checkDeepEqual(registry.findOutwardFileFields({
    filePath: 'release.zip', remoteFileId: 'drive-object-1', url: 'https://example.invalid/file',
    attachments: [{ path: 'invoice.pdf' }, { sourceFileName: 'photo.png' }]
  }), [
    { key: 'filePath', value: 'release.zip' },
    { key: 'attachments[0].path', value: 'invoice.pdf' },
    { key: 'attachments[1].sourceFileName', value: 'photo.png' }
  ], 'artifact contract: top-level and nested local files are found without treating remote IDs or URLs as local artifacts');

  const bounded = Array.from({ length: 40 }, (_, index) => ({ path: `artifact-${index}.txt` }));
  checkEqual(registry.findOutwardFileFields({ attachments: bounded }).length, 32,
    'artifact contract: nested artifact scans must remain bounded');

  const originalPreflight = egress.preflight;
  const originalAssertGatesMet = egress.assertGatesMet;
  const originalReadGates = egress.readGates;
  const originalGetActiveRequest = requestContext.getActiveRequest;
  const originalAuditRecord = audit.record;
  try {
    const unreadableMarker = Object.assign(new Error('active request marker unreadable'), { code: 'EACCES' });
    requestContext.getActiveRequest = () => { throw unreadableMarker; };
    checkThrows(
      () => registry.resolveActiveRequestId({}),
      error => error === unreadableMarker,
      'absence versus unreadable: no active request is null, but a marker read failure remains observable'
    );
    requestContext.getActiveRequest = () => null;
    checkEqual(registry.resolveActiveRequestId({}), null,
      'absence versus unreadable: an established absent active-request marker remains null');

    const unreadableGates = Object.assign(new Error('gate record unreadable'), { code: 'EIO' });
    egress.readGates = () => { throw unreadableGates; };
    checkThrows(
      () => registry.authorizeExactDuoLiveProof(
        { name: 'duo.ucr_login' }, 'owner-request-42', { duoDesktopApproval: 'exact_owner_requested' }, 'invocation-0'
      ),
      error => error === unreadableGates,
      'inapplicable versus unreadable: a failed gate read must not render as a definite denied bypass'
    );

    const blocked = Object.freeze({ allowed: false, severity: 'block', findings: [{ code: 'AI_GENERATED_ARTIFACT' }] });
    egress.preflight = input => {
      checkDeepEqual(input, { filePath: 'agent-output.zip', destination: 'drive.upload' },
        'provenance contract: the registry must send the exact artifact and destination to preflight');
      return blocked;
    };
    checkThrows(
      () => registry.assertEgressPreflight({ name: 'drive.upload' }, { filePath: 'agent-output.zip' }, 'invocation-1'),
      error => error instanceof registry.EgressPreflightBlockedError
        && error.code === 'EGRESS_PREFLIGHT_BLOCKED'
        && error.field === 'filePath'
        && /drive\.upload/.test(error.message),
      'provenance contract: a blocked artifact must stop at the registry with a named typed refusal'
    );

    const auditCalls = [];
    egress.preflight = () => ({ allowed: true, severity: 'warn', findings: [{ code: 'UNVERIFIED_PROVENANCE' }] });
    audit.record = (action, target, details) => { auditCalls.push({ action, target, details }); };
    registry.assertEgressPreflight({ name: 'drive.upload' }, { filePath: 'owner-file.zip' }, 'invocation-2');
    checkEqual(auditCalls.length, 1,
      'provenance contract: an allowed warning must remain visible in audit');
    checkDeepEqual(auditCalls[0], {
      action: 'mcp.tool.egress_warning', target: 'drive.upload',
      details: { invocationId: 'invocation-2', field: 'filePath', findingCodes: ['UNVERIFIED_PROVENANCE'] }
    }, 'provenance contract: the warning audit must retain the exact invocation, field, and finding');

    const gateFailure = Object.assign(new Error('owner gate unmet'), { code: 'EGRESS_GATES_UNMET' });
    let gateRequest = null;
    egress.assertGatesMet = requestId => { gateRequest = requestId; throw gateFailure; };
    checkThrows(
      () => registry.assertOutwardGate(
        { name: 'browser.start' }, { requestId: 'owner-request-42' }, 'invocation-3', {},
        { assertEventAllowed() {} }
      ),
      error => error === gateFailure,
      'owner-gate contract: an unmet durable request gate must stop the outward call'
    );
    checkEqual(gateRequest, 'owner-request-42',
      'owner-gate contract: the exact active request id must be checked');

    let gateReached = false;
    egress.assertGatesMet = () => { gateReached = true; };
    const dependencyFailure = Object.assign(new Error('dependency not accepted'), { code: 'DEPENDENCY_ACCEPTANCE_REQUIRED' });
    checkThrows(
      () => registry.assertOutwardGate(
        { name: 'browser.start' }, { requestId: 'owner-request-43' }, 'invocation-4', {},
        { assertEventAllowed() { throw dependencyFailure; } }
      ),
      error => error === dependencyFailure,
      'dependency contract: third-party acceptance refusal must win before owner-gate evaluation'
    );
    checkEqual(gateReached, false,
      'dependency contract: a refused dependency must not reach the outward request gate');

    checkThrows(
      () => registry.assertOutwardGate(
        { name: 'drive.upload' }, {}, 'invocation-5', { filePath: 'owner-file.zip' },
        { assertEventAllowed() {} }
      ),
      error => error instanceof registry.EgressGatesRequiredError
        && error.code === 'EGRESS_GATES_REQUIRED',
      'owner-gate contract: an artifact-bearing call without an active owner request must fail closed'
    );
  } finally {
    egress.preflight = originalPreflight;
    egress.assertGatesMet = originalAssertGatesMet;
    egress.readGates = originalReadGates;
    requestContext.getActiveRequest = originalGetActiveRequest;
    audit.record = originalAuditRecord;
  }

  process.stdout.write(`tool-registry egress guard: ${checks} checks passed\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
