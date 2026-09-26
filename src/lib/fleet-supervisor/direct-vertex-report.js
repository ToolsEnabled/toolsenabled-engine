'use strict';

// Fixed-profile Direct Vertex report transport (Q57/R122).
//
// This is deliberately not a generic provider wrapper.  It calls one fixed,
// tool-less Vertex report operation, writes exactly one report through the
// caller's existing artifact gate, and exposes only the Q57 evidence envelope
// required to bind the producing call.  No caller can choose an account,
// model, endpoint, tools, or a provider implementation in production.

const fs = require('node:fs');
const { types: utilTypes } = require('node:util');
const directReceipt = require('./direct-vertex-receipt.js');
const vertexGemini = require('../providers/vertex-gemini.js');

const MAX_ACCOUNTING = 2_000_000;

function plainData(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function boundedAccounting(value) {
  const input = plainData(value, ['promptTokens', 'outputTokens', 'billableOutputTokens', 'durationMs']);
  if (!input) return null;
  for (const key of Object.keys(input)) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > MAX_ACCOUNTING) return null;
  }
  return Object.freeze({ ...input });
}

function providerResult(value) {
  const input = plainData(value, ['output', 'rawResponse', 'accounting']);
  if (!input || typeof input.output !== 'string') return null;
  const accounting = boundedAccounting(input.accounting);
  if (!accounting) return null;
  // providerCallEvent() is the identity validator as well as the event maker.
  // Run it against a disposable binding here only to reject malformed raw
  // provider identities before an artifact is written; the real event below
  // is generated after the artifact binding is known.
  try {
    directReceipt.providerCallEvent({
      binding: { callId: 'probe:direct-vertex-report', attemptNumber: 1, artifactProduced: true },
      rawResponse: input.rawResponse
    });
  } catch { return null; }
  return { output: input.output, rawResponse: input.rawResponse, accounting };
}

function failure(code) {
  return { ok: false, code, directVertexEvidence: null, report: null, reportBytes: 0, changed: null, accounting: null };
}

function artifactPresent(fsImpl, reportPath) {
  try {
    fsImpl.lstatSync(reportPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function runDirectVertexReport({
  laneId,
  prompt,
  reportPath,
  contract,
  attemptNumber = 1,
  // Test seam only. Production omits it and cannot select another transport.
  provider = vertexGemini.geminiReportComplete,
  materializeReport,
  changedFileCount,
  fsImpl = fs
} = {}) {
  if (typeof laneId !== 'string' || !laneId || typeof prompt !== 'string' || !reportPath
    || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1
    || typeof materializeReport !== 'function' || typeof changedFileCount !== 'function') {
    return failure('DIRECT_VERTEX_REPORT_INPUT_INVALID');
  }
  const binding = {
    callId: `lane:${laneId}:attempt:${attemptNumber}`,
    attemptNumber,
    artifactProduced: true
  };
  // Validate the caller-controlled portion of the eventual receipt before
  // starting the provider or artifact gate. Otherwise an invalid lane or
  // attempt can produce a report which this function must then refuse.
  try {
    directReceipt.providerCallEvent({
      binding,
      rawResponse: { modelVersion: 'identity-probe', responseId: 'identity-probe' }
    });
  } catch { return failure('DIRECT_VERTEX_REPORT_IDENTITY_INVALID'); }
  // A direct report owns exactly one artifact.  It never accepts an artifact
  // silently pre-created by a different process or model call.
  try { if (artifactPresent(fsImpl, reportPath)) return failure('DIRECT_VERTEX_REPORT_PREEXISTING_ARTIFACT'); }
  catch { return failure('DIRECT_VERTEX_REPORT_ARTIFACT_CHECK_FAILED'); }

  let raw;
  try { raw = await provider({ prompt }); }
  catch { return failure('DIRECT_VERTEX_REPORT_PROVIDER_FAILED'); }
  const result = providerResult(raw);
  if (!result) return failure('DIRECT_VERTEX_REPORT_PROVIDER_RESULT_INVALID');

  let report;
  try { report = materializeReport(reportPath, result.output, contract); }
  catch { return failure('DIRECT_VERTEX_REPORT_MATERIALIZE_FAILED'); }
  if (!report || report.ok !== true) {
    return { ...failure((report && report.code) || 'DIRECT_VERTEX_REPORT_REJECTED'), report: report || null };
  }

  let reportBytes;
  let changed;
  try {
    reportBytes = fsImpl.statSync(reportPath).size;
    changed = await changedFileCount();
  } catch { return failure('DIRECT_VERTEX_REPORT_MEASURE_FAILED'); }
  if (!Number.isSafeInteger(reportBytes) || reportBytes < 1 || !Number.isInteger(changed)) {
    return failure('DIRECT_VERTEX_REPORT_MEASURE_INVALID');
  }

  let providerCallEvent;
  try { providerCallEvent = directReceipt.providerCallEvent({ binding, rawResponse: result.rawResponse }); }
  catch { return failure('DIRECT_VERTEX_REPORT_IDENTITY_INVALID'); }
  return {
    ok: true,
    code: null,
    report,
    reportBytes,
    changed,
    accounting: result.accounting,
    // Exact Q57 outer envelope.  Nothing else from the direct provider is
    // carried into acceptance, logs, or a result receipt.
    directVertexEvidence: Object.freeze({
      providerCallEvent,
      rawResponse: Object.freeze({ ...result.rawResponse })
    })
  };
}

module.exports = { MAX_ACCOUNTING, boundedAccounting, providerResult, runDirectVertexReport };
