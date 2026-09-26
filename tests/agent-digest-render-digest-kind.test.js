'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { renderDigest, renderFallback } = require('../src/lib/agent-digest/render');

const state = {
  observedAtMs: Date.UTC(2026, 7, 27, 12, 0),
  degradedReason: 'collector-unavailable',
  auditStatus: null,
  delta: { available: false, reason: 'no-baseline' },
  queue: {
    source: 'fixture', depth: 0, phases: [], counts: {}, inFlight: [], open: [], blocked: []
  },
  declared: { source: 'fixture', revision: 1, agents: [], relationships: [] },
  observed: {
    auditState: 'verified', provenance: { state: 'signed', headSequence: 7 }, freshness: 'fresh',
    eventsInWindow: 0, lifecycle: 'available', agents: [], phases: [], providerControls: [],
    runs: {
      available: true, total: 0, active: 0, openHelp: 0, stale: [], byStatus: {},
      outcomes: {
        source: 'durable-run-lifecycle', completed: 0, failed: 0, cancelled: 0,
        needsHelp: 0, outcomeUnknown: 0
      }
    },
    meters: {
      state: 'available', subscriptionUsage: 'recorded', savingsState: 'recorded', providers: [],
      waste: { retryOrFailureCount: 0, duplicateReviewCount: 0, cacheMissCount: 0, measuredEvidenceCount: 0, sourceState: 'durable' }
    }
  },
  gaps: []
};

let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawn = childProcess.spawn;
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
childProcess.spawn = (...args) => { spawns += 1; return originalSpawn(...args); };

try {
  for (const rendered of [
    renderDigest({ state, kind: 'digest', fireKey: 'digest-slot' }),
    renderFallback({ state, kind: 'digest', fireKey: 'digest-slot' })
  ]) {
    assert.equal(rendered.kind, 'digest');
    assert.match(rendered.subject, /^Agentic workflow digest\b/);
    assert.match(rendered.text, /^AGENTIC WORKFLOW DIGEST\b/);
    assert.match(rendered.html, /TOOLSENABLED &middot; DIGEST/);
  }
  assert.equal(writes, 0, 'rendering the digest-kind response must not write files');
  assert.equal(spawns, 0, 'rendering the digest-kind response must not spawn processes');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  childProcess.spawn = originalSpawn;
}

process.stdout.write('agent-digest DIGEST kind: driven full and fallback renderers without effects\n');
