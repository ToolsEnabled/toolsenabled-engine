'use strict';

const fs = require('node:fs');
const path = require('node:path');

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function capabilityDependencies() {
  const catalog = {
    tools: [{
      name: 'task.get', effect: 'local-read', approvalEligible: false,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    }],
    roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: []
  };
  const configuration = {
    schemaVersion: 1,
    profiles: [{
      id: 'elevation-proof-base', tools: ['task.get'], roots: [], domains: [],
      httpMethods: [], commandIds: [], secretHandles: [], externalActions: [],
      approvalRequiredActions: [], deniedTools: [], completionCriteria: ['proof'],
      maxTtlMs: 60_000
    }]
  };
  return { catalog, configuration, auditWrite: () => ({ durable: true }), enabled: true };
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'write') {
    const target = path.resolve(process.env.PROOF_TARGET);
    const holdMs = Number(process.env.PROOF_HOLD_MS || 0);
    const releaseFile = process.env.PROOF_RELEASE_FILE;
    const originalRename = fs.renameSync;
    fs.renameSync = function proofRename(from, to) {
      if (path.resolve(to) === target && (holdMs > 0 || releaseFile)) {
        process.stdout.write('WRITE_LOCK_HELD\n');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        if (releaseFile) {
          const deadline = Date.now() + 60_000;
          while (!fs.existsSync(releaseFile)) {
            if (Date.now() >= deadline) throw new Error('proof writer release was not received');
            Atomics.wait(wait, 0, 0, 10);
          }
        } else {
          Atomics.wait(wait, 0, 0, holdMs);
        }
      }
      return originalRename.apply(this, arguments);
    };
    try {
      const result = await require('../../src/lib/providers/host-control').writeFile({
        path: target,
        content: process.env.PROOF_CONTENT || 'proof'
      });
      output({ ok: true, result });
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: error && error.code, message: error && error.message })}\n`);
      process.exitCode = 3;
    }
    return;
  }

  const { getStateStore, closeStateStore } = require('../../src/lib/state-store');
  const provider = require('../../src/lib/providers/capability-manifests');
  const dependencies = capabilityDependencies();
  try {
    if (mode === 'create' || mode === 'create-authorize') {
      const state = getStateStore();
      const task = state.submitTask({
        queue: 'proof', type: 'capability', idempotencyKey: process.env.PROOF_TASK_KEY,
        payload: { title: 'Elevation lifecycle proof', objective: 'Exercise the real capability-profile lease.' }
      }).task;
      const profileId = process.env.PROOF_PROFILE_ID;
      let compiledAtMs;
      const compiled = provider.compile({
        profileId, version: 1, taskId: task.id, baseProfileId: 'elevation-proof-base',
        requested: {
          tools: ['task.get'], roots: [], domains: [], httpMethods: [], commandIds: [],
          secretHandles: [], externalActions: [], approvalRequiredActions: [], completionCriteria: ['proof'],
          expiresAtMs: Date.now() + 60_000
        }
      }, { ...dependencies, now: () => { compiledAtMs = Date.now(); return compiledAtMs; } });
      // Observe the real clock; do not advance or replace it. Authorize in the
      // already-started process so a fresh Node startup cannot consume the
      // whole short lease before the test's first authorization.
      const before = mode === 'create-authorize' ? provider.authorizeBoundRequest({
        requestId: 'expiry-before-0001', requestKind: 'tool', profileId, version: 1,
        request: { taskId: task.id, tool: 'task.get' }
      }, dependencies) : null;
      output({ ok: true, taskId: task.id, profileId, compiledAtMs, expiresAtMs: compiled.profile.expiresAtMs,
        status: compiled.profile.status, ...(before ? { before: { ok: true, requestHash: before.requestHash } } : {}) });
      return;
    }
    if (mode === 'inspect') {
      const profile = provider.profile({ profileId: process.env.PROOF_PROFILE_ID, version: 1 }, dependencies);
      output({ ok: true, status: profile && profile.status, expiresAtMs: profile && profile.expiresAtMs });
      return;
    }
    if (mode === 'authorize') {
      const authorized = provider.authorizeBoundRequest({
        requestId: process.env.PROOF_REQUEST_ID,
        requestKind: 'tool', profileId: process.env.PROOF_PROFILE_ID, version: 1,
        request: { taskId: process.env.PROOF_TASK_ID, tool: 'task.get' }
      }, dependencies);
      output({ ok: true, requestHash: authorized.requestHash });
      return;
    }
    throw Object.assign(new Error(`Unknown proof mode: ${mode}`), { code: 'PROOF_MODE_INVALID' });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error && error.code, message: error && error.message })}\n`);
    process.exitCode = 3;
  } finally {
    try { closeStateStore(); } catch { /* child is already reporting the primary failure */ }
  }
}

main();
