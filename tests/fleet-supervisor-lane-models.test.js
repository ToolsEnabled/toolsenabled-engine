/*
 * Mutation check: changed `const DEFAULT_BACKEND = 'vertex';` to
 * `const DEFAULT_BACKEND = 'subscription';` in lane-models.js.
 * The edit landed: yes.
 * This isolated test went red: yes (exit 1).
 * The module was restored and its original SHA-256 was confirmed.
 */
'use strict';

const assert = require('node:assert/strict');
const laneModels = require('../src/lib/fleet-supervisor/lane-models.js');
const modelFloor = require('../src/lib/model-floor.js');

let checks = 0;
function check(label, assertion) {
  assertion();
  checks += 1;
  void label;
}

check('exports the backend-specific model choices and immutable derived views', () => {
  assert.deepEqual(laneModels.BACKENDS, ['subscription', 'vertex']);
  assert.equal(laneModels.DEFAULT_BACKEND, 'vertex');
  assert.equal(laneModels.DEFAULT_LANE_MODEL, 'gemini-3.1-pro-preview');
  assert.equal(laneModels.DEFAULT_VERTEX_LANE_MODEL, 'gemini-2.5-pro');
  assert.deepEqual(laneModels.ALLOWED_LANE_MODELS, ['gemini-3.1-pro-preview']);
  assert.deepEqual(laneModels.ALLOWED_VERTEX_LANE_MODELS, ['gemini-2.5-pro']);
  assert.ok(Object.isFrozen(laneModels.ALLOWED_LANE_MODELS));
  assert.ok(Object.isFrozen(laneModels.ALLOWED_VERTEX_LANE_MODELS));
  assert.ok(Object.isFrozen(laneModels.NOT_SERVABLE));
  assert.ok(Object.isFrozen(laneModels.NOT_SERVABLE.vertex));
});

check('defaults a missing backend to vertex and refuses an unknown backend', () => {
  assert.equal(laneModels.assertBackend(), 'vertex');
  assert.equal(laneModels.assertBackend(null), 'vertex');
  assert.equal(laneModels.assertBackend('subscription'), 'subscription');
  assert.throws(
    () => laneModels.assertBackend('vertx'),
    (error) => error.code === 'FLEET_BACKEND_INVALID' && /got vertx/.test(error.message)
  );
});

check('returns the correct floor for each backend without sharing mutable arrays', () => {
  assert.deepEqual(laneModels.backendFloor('subscription'), {
    models: ['gemini-3.1-pro-preview'],
    fallback: 'gemini-3.1-pro-preview'
  });
  assert.deepEqual(laneModels.backendFloor(), {
    models: ['gemini-2.5-pro'],
    fallback: 'gemini-2.5-pro'
  });
});

check('accepts defaults and on-floor values, but never falls back from a refused value', () => {
  assert.equal(laneModels.assertLaneModel(), 'gemini-3.1-pro-preview');
  assert.equal(laneModels.assertLaneModel('gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
  assert.equal(laneModels.assertLaneModelFor('subscription'), 'gemini-3.1-pro-preview');
  assert.equal(laneModels.assertLaneModelFor('vertex', 'gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.throws(
    () => laneModels.assertLaneModel('gemini-3.5-flash'),
    (error) => error.code === 'FLEET_MODEL_REFUSED' && /never a fallback/.test(error.message)
  );
  assert.throws(
    () => laneModels.assertLaneModelFor('vertex', 'unknown-model'),
    (error) => error.code === 'FLEET_MODEL_REFUSED' && /vertex model floor/.test(error.message)
  );
});

check('distinguishes a known non-servable model from an ordinary floor refusal', () => {
  const reason = laneModels.notServableReason('vertex', 'gemini-2.5-flash');
  assert.equal(reason, modelFloor.notServableReason('vertex', 'gemini-2.5-flash'));
  assert.ok(reason, 'the current floor configuration must provide the refusal reason');
  assert.equal(laneModels.notServableReason('vertex', 'gemini-2.5-pro'), null);
  assert.throws(
    () => laneModels.assertLaneModelFor('vertex', 'gemini-2.5-flash'),
    (error) => error.code === 'FLEET_MODEL_NOT_SERVABLE' && error.message === reason
  );
});

check('reports served downgrades, compliance, mixed receipts, and honest unknowns', () => {
  assert.deepEqual(
    laneModels.servedBelowFloor('subscription', ['gemini-3.1-flash-lite']),
    ['gemini-3.1-flash-lite']
  );
  assert.deepEqual(laneModels.servedBelowFloor('subscription', ['gemini-3.1-pro-preview']), []);
  assert.deepEqual(
    laneModels.servedBelowFloor('vertex', ['gemini-2.5-pro', 'gemini-3-flash-preview']),
    ['gemini-3-flash-preview']
  );
  assert.equal(laneModels.servedBelowFloor('vertex', []), null);
  assert.equal(laneModels.servedBelowFloor('vertex', undefined), null);
});

check('derives status metadata from current config without inherited request authority', () => {
  const floor = modelFloor.loadFloor();
  const expectedModels = new Set();
  for (const spec of Object.values(floor.backends)) {
    for (const model of spec.allowed) expectedModels.add(model);
    for (const model of Object.keys(spec.notServable || {})) expectedModels.add(model);
  }
  assert.deepEqual(Object.keys(laneModels.LANE_MODEL_THINKING).sort(), [...expectedModels].sort());
  for (const description of Object.values(laneModels.LANE_MODEL_THINKING)) {
    assert.match(description, /current configured model floor|configured model floor/);
  }
});

console.log(`fleet-supervisor lane-models tests passed (${checks} behavior groups)`);
