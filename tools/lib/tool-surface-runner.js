'use strict';

const crypto = require('node:crypto');
const { captureProductExecution } = require('./tool-surface-product-outcome');

const SURFACES = Object.freeze(['desktop-here', 'docker', 'web', 'mobile']);
const STATUSES = Object.freeze([
  'VERIFIED', 'FAILS', 'NOT MEASURED', 'NOT APPLICABLE', 'NOT YET TESTED', 'OWNER-PREREQUISITE'
]);
const CLASSES = Object.freeze([
  'HARMLESS READ', 'REVERSIBLE WRITE', 'REQUIRES-STAND-IN', 'OWNER-PREREQUISITE'
]);
const EFFECTS = new Set(['local-read', 'local-write', 'external-read', 'external-write']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function namespaceOf(name) {
  return name.slice(0, name.indexOf('.'));
}

function descriptorDigest(tool) {
  return crypto.createHash('sha256').update(JSON.stringify({
    name: tool.name,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations
  })).digest('hex');
}

function validateInventory(tools) {
  if (!Array.isArray(tools)) throw new TypeError('registeredTools() did not return an array.');
  const names = new Set();
  return tools.map((tool, index) => {
    if (!plainObject(tool)) throw new TypeError(`registeredTools()[${index}] is not an object.`);
    if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new TypeError(`registeredTools()[${index}] has an invalid name.`);
    }
    if (names.has(tool.name)) throw new TypeError(`registeredTools() returned duplicate '${tool.name}'.`);
    names.add(tool.name);
    if (!EFFECTS.has(tool.effect)) throw new TypeError(`Tool '${tool.name}' has invalid effect '${tool.effect}'.`);
    if (typeof tool.approvalEligible !== 'boolean') {
      throw new TypeError(`Tool '${tool.name}' has no boolean approvalEligible descriptor.`);
    }
    if (!plainObject(tool.inputSchema) || !plainObject(tool.annotations)
        || typeof tool.annotations.destructiveHint !== 'boolean') {
      throw new TypeError(`Tool '${tool.name}' has incomplete schema or safety annotations.`);
    }
    return tool;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function exactPrerequisite(tool) {
  const provider = typeof tool.provider === 'string' && tool.provider.trim()
    ? tool.provider.trim()
    : 'the descriptor\'s external provider';
  return `a configured non-production ${provider} test account, its test credential, and a reachable sandbox/fixture endpoint`;
}

function standInFor(tool) {
  const provider = typeof tool.provider === 'string' && tool.provider.trim()
    ? tool.provider.trim()
    : 'provider';
  if (tool.annotations.destructiveHint) {
    return `an isolated disposable ${provider} sandbox with resettable state and no real owner data`;
  }
  return `a non-production ${provider} stand-in that cannot spend money, send outbound messages, create real accounts, or claim machines`;
}

function classify(tool) {
  if (tool.annotations.destructiveHint === true || tool.effect === 'external-write') {
    return Object.freeze({
      class: 'REQUIRES-STAND-IN',
      reason: `descriptor says effect=${tool.effect}, destructiveHint=${tool.annotations.destructiveHint}, approvalEligible=${tool.approvalEligible}`,
      prerequisite: null,
      standIn: standInFor(tool)
    });
  }
  if (tool.effect === 'external-read') {
    return Object.freeze({
      class: 'OWNER-PREREQUISITE',
      reason: `descriptor says effect=external-read and provider=${tool.provider || 'unspecified'}`,
      prerequisite: exactPrerequisite(tool),
      standIn: null
    });
  }
  if (tool.effect === 'local-write') {
    return Object.freeze({
      class: 'REVERSIBLE WRITE',
      reason: `descriptor says effect=local-write and destructiveHint=false`,
      prerequisite: null,
      standIn: null
    });
  }
  return Object.freeze({
    class: 'HARMLESS READ',
    reason: `descriptor says effect=local-read and destructiveHint=false`,
    prerequisite: null,
    standIn: null
  });
}

function census(registered) {
  const tools = validateInventory(registered);
  const namespaces = {};
  const classes = Object.fromEntries(CLASSES.map(name => [name, 0]));
  for (const tool of tools) {
    const namespace = namespaceOf(tool.name);
    namespaces[namespace] = (namespaces[namespace] || 0) + 1;
    classes[classify(tool).class] += 1;
  }
  return Object.freeze({
    toolCount: tools.length,
    namespaceCount: Object.keys(namespaces).length,
    namespaces: Object.freeze(Object.fromEntries(Object.entries(namespaces).sort())),
    classes: Object.freeze(classes),
    tools
  });
}

function cell(status, reason, evidence = null) {
  if (!STATUSES.includes(status)) throw new TypeError(`Unknown cell status '${status}'.`);
  if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('Every cell must name its reason.');
  return Object.freeze({ status, reason, evidence });
}

function serializableAnswer(value) {
  if (value === undefined) return false;
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string';
  } catch {
    return false;
  }
}

function surfaceInventoryMap(discovered) {
  if (!Array.isArray(discovered)) throw new TypeError('Surface discovery did not return a tools array.');
  const result = new Map();
  for (const entry of discovered) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    if (typeof name !== 'string' || !name) throw new TypeError('Surface discovery returned an unnamed tool.');
    if (result.has(name)) throw new TypeError(`Surface discovery returned duplicate '${name}'.`);
    result.set(name, entry);
  }
  return result;
}

function selectionReason(selectedTools, tool) {
  return selectedTools && !selectedTools.has(tool.name)
    ? `excluded by the explicit tool selection; selector did not include ${tool.name}`
    : null;
}

function runnerOriginCell(operation, error) {
  const runnerCode = error && typeof error.code === 'string' && error.code.trim()
    ? error.code.trim()
    : null;
  const message = error && error.message ? error.message : String(error);
  const named = runnerCode ? ` ${runnerCode}` : ' an uncoded harness error';
  return cell('NOT MEASURED', `${operation} produced no product result because the runner adapter raised${named}: ${message}`, {
    origin: 'runner',
    runnerCode,
    message,
    delivery: 'throw'
  });
}

function productEnvelope(result, operation) {
  if (!plainObject(result) || result.origin !== 'product') {
    return runnerOriginCell(operation, Object.assign(
      new Error('adapter did not return an envelope explicitly marked origin=product'),
      { code: 'RUNNER_ADAPTER_PROTOCOL_INVALID' }
    ));
  }
  return null;
}

async function harmlessReadCell(adapter, tool) {
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
  const args = {};
  let result;
  try {
    result = await adapter.invoke(tool.name, args, { expectedInvalidParams: required.length > 0 });
  } catch (error) {
    return runnerOriginCell('surface invocation', error);
  }
  const envelopeError = productEnvelope(result, 'surface invocation');
  if (envelopeError) return envelopeError;
  if (result.kind === 'refusal') {
    if (typeof result.code !== 'string' || !result.code.trim()) {
      return cell('FAILS', 'product refused without a named refusal code', { ...result, origin: 'product' });
    }
    if (required.length === 0) {
      return cell('FAILS', `product refused a valid empty-argument read with ${result.code}`, {
        origin: 'product',
        refusalCode: result.code,
        message: result.message || null,
        probe: 'empty safe read'
      });
    }
    return cell('VERIFIED', `product returned the named refusal ${result.code}`, {
      origin: 'product',
      refusalCode: result.code,
      message: result.message || null,
      probe: required.length > 0 ? 'empty arguments against required schema' : 'empty safe read'
    });
  }
  if (result.kind === 'failure') {
    return cell('FAILS', 'product execution raised an uncoded failure', {
      origin: 'product',
      error: result.message || 'product failure had no message',
      code: null
    });
  }
  if (result.kind !== 'answer') {
    return runnerOriginCell('surface invocation', Object.assign(
      new Error(`adapter returned unknown product envelope kind '${String(result.kind)}'`),
      { code: 'RUNNER_ADAPTER_PROTOCOL_INVALID' }
    ));
  }
  if (!serializableAnswer(result.value)) {
    return cell('FAILS', 'product returned an answer that is not serializable JSON', {
      origin: 'product', kind: result.kind
    });
  }
  return cell('VERIFIED', 'tool returned a well-formed JSON answer', {
    origin: 'product',
    probe: required.length > 0 ? 'empty arguments against required schema' : 'empty safe read',
    resultDigest: crypto.createHash('sha256').update(JSON.stringify(result.value)).digest('hex')
  });
}

function validReversibleEvidence(result) {
  if (!plainObject(result) || result.origin !== 'product' || result.kind !== 'reversible') return false;
  return result.writeAsserted === true && result.restoreAsserted === true
    && typeof result.writeEvidence === 'string' && result.writeEvidence.length > 0
    && typeof result.restoreEvidence === 'string' && result.restoreEvidence.length > 0;
}

async function reversibleWriteCell(adapter, tool) {
  if (typeof adapter.exerciseReversible !== 'function') {
    return cell('NOT YET TESTED', 'runner adapter has no write/assert/restore/re-read/assert lifecycle; restoration cannot be assumed and this tool has not yet been tested');
  }
  try {
    const result = await adapter.exerciseReversible(tool);
    const envelopeError = productEnvelope(result, 'reversible lifecycle');
    if (envelopeError) return envelopeError;
    if (plainObject(result) && result.kind === 'refusal') {
      if (typeof result.code !== 'string' || !result.code.trim()) {
        return cell('FAILS', 'product reversible lifecycle refused without a named refusal code', result);
      }
      return cell('VERIFIED', `product reversible lifecycle returned the named refusal ${result.code}`, {
        origin: 'product',
        refusalCode: result.code,
        message: result.message || null,
        delivery: 'return'
      });
    }
    if (result.kind === 'failure') {
      return cell('FAILS', 'product execution raised an uncoded failure during the reversible lifecycle', {
        origin: 'product', error: result.message || 'product failure had no message', code: null
      });
    }
    if (!validReversibleEvidence(result)) {
      return cell('FAILS', 'product lifecycle did not prove both the write assertion and restoration assertion', result);
    }
    return cell('VERIFIED', 'write was asserted, restored, and restoration was asserted', result);
  } catch (error) {
    return runnerOriginCell('reversible lifecycle', error);
  }
}

function permissionCeilingFor(surface, adapter) {
  if (!adapter) {
    return Object.freeze({
      state: 'NOT USED',
      reason: `${surface} has no configured runner adapter, so no invocation ran under a permission ceiling`
    });
  }
  if (plainObject(adapter.permissionCeiling)) return adapter.permissionCeiling;
  return Object.freeze({
    state: 'UNKNOWN',
    reason: `${surface} adapter did not declare the permission ceiling used by its invocations; unknown is not absent`
  });
}

async function runBounded(items, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await operation(items[index]);
    }
  });
  await Promise.all(workers);
}

async function runSurface({ surface, tools, adapter, selectedTools, readConcurrency }) {
  const cells = {};
  const permissionCeiling = permissionCeilingFor(surface, adapter);
  if (!adapter) {
    for (const tool of tools) cells[tool.name] = cell(
      'NOT YET TESTED', `${surface} has no configured runner adapter; reachability is unknown, not absent`
    );
    return { surface, discovery: { state: 'UNREACHABLE', reason: 'adapter not configured' }, permissionCeiling, cells };
  }

  let discovered;
  try {
    discovered = surfaceInventoryMap(await adapter.discover());
  } catch (error) {
    const unknown = runnerOriginCell('surface discovery', error);
    for (const tool of tools) cells[tool.name] = unknown;
    return {
      surface,
      discovery: { state: 'NOT MEASURED', reason: unknown.reason, evidence: unknown.evidence },
      permissionCeiling,
      cells
    };
  }

  const harmlessReads = [];
  for (const tool of tools) {
    const excluded = selectionReason(selectedTools, tool);
    if (excluded) {
      cells[tool.name] = cell('NOT YET TESTED', excluded);
      continue;
    }
    if (!discovered.has(tool.name)) {
      cells[tool.name] = cell('FAILS', `${surface} discovery completed but did not advertise registry tool ${tool.name}`);
      continue;
    }
    const classification = classify(tool);
    if (classification.class === 'REQUIRES-STAND-IN') {
      cells[tool.name] = cell('NOT APPLICABLE', `real invocation is forbidden; requires ${classification.standIn}`, {
        discovered: true, standIn: classification.standIn
      });
      continue;
    }
    if (classification.class === 'OWNER-PREREQUISITE') {
      cells[tool.name] = cell('OWNER-PREREQUISITE', classification.prerequisite, {
        discovered: true, provider: tool.provider || null
      });
      continue;
    }
    if (classification.class === 'HARMLESS READ') harmlessReads.push(tool);
    else cells[tool.name] = await reversibleWriteCell(adapter, tool);
  }
  await runBounded(harmlessReads, readConcurrency, async tool => {
    cells[tool.name] = await harmlessReadCell(adapter, tool);
  });
  return {
    surface,
    discovery: { state: 'REACHED', advertisedCount: discovered.size },
    permissionCeiling,
    cells
  };
}

function statusCounts(cells) {
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  for (const value of Object.values(cells)) counts[value.status] += 1;
  return counts;
}

async function run({ registeredTools, adapters = {}, surfaces = SURFACES, selectedTools = null, readConcurrency = 1 }) {
  if (!Number.isSafeInteger(readConcurrency) || readConcurrency < 1 || readConcurrency > 32) {
    throw new TypeError('readConcurrency must be an integer from 1 through 32.');
  }
  const measured = census(registeredTools());
  const unknownSurfaces = surfaces.filter(surface => !SURFACES.includes(surface));
  if (unknownSurfaces.length) throw new TypeError(`Unknown surfaces: ${unknownSurfaces.join(', ')}`);
  const results = {};
  for (const surface of SURFACES) {
    if (!surfaces.includes(surface)) {
      results[surface] = await runSurface({ surface, tools: measured.tools, adapter: null, selectedTools, readConcurrency });
      for (const tool of measured.tools) {
        results[surface].cells[tool.name] = cell('NOT YET TESTED', `${surface} was excluded by the explicit surface selection`);
      }
    } else {
      results[surface] = await runSurface({ surface, tools: measured.tools, adapter: adapters[surface], selectedTools, readConcurrency });
    }
    results[surface].counts = statusCounts(results[surface].cells);
  }
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    derivation: 'Called registeredTools({}) at run time; sorted its returned descriptors; grouped each descriptor name before the first dot.',
    census: {
      toolCount: measured.toolCount,
      namespaceCount: measured.namespaceCount,
      namespaces: measured.namespaces,
      classes: measured.classes
    },
    tools: measured.tools.map(tool => ({
      name: tool.name, namespace: namespaceOf(tool.name), effect: tool.effect,
      destructiveHint: tool.annotations.destructiveHint,
      approvalEligible: tool.approvalEligible,
      provider: tool.provider || null,
      descriptorDigest: descriptorDigest(tool),
      classification: classify(tool)
    })),
    surfaces: results
  };
}

async function failureProof(registeredTools) {
  if (typeof registeredTools !== 'function') {
    throw new TypeError('failureProof requires the same run-time registeredTools() inventory as the matrix.');
  }
  const tool = census(registeredTools()).tools.find(entry => classify(entry).class === 'HARMLESS READ');
  if (!tool) throw new Error('failureProof found no registry-derived harmless-read descriptor to exercise.');
  const registry = () => [tool];
  const broken = await run({ registeredTools: registry, surfaces: ['desktop-here'], adapters: {
    'desktop-here': {
      discover: async () => [tool],
      invoke: async () => captureProductExecution(() => { throw new Error('temporarily broken handler'); })
    }
  }});
  const restored = await run({ registeredTools: registry, surfaces: ['desktop-here'], adapters: {
    'desktop-here': {
      discover: async () => [tool],
      invoke: async () => ({ origin: 'product', kind: 'answer', value: { ok: true } })
    }
  }});
  return Object.freeze({
    tool: tool.name,
    broken: broken.surfaces['desktop-here'].cells[tool.name],
    restored: restored.surfaces['desktop-here'].cells[tool.name]
  });
}

module.exports = Object.freeze({
  CLASSES, STATUSES, SURFACES, census, classify, failureProof, run, validateInventory
});
