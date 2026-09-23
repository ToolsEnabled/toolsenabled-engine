'use strict';

// Guards the seam introduced when controller-projection.js stopped importing
// the Vertex provider modules to learn which account backs each Gemini lane.
//
// Before: controller-projection.js read vertexGemini.ACCOUNT_ALIAS and
// vertexGeminiSeat.ACCOUNT_ALIAS directly. One source of truth, but a
// controller -> providers.gateway require, which tools/package-check.js:264
// counts as a SIDEWAYS_DOMAIN_IMPORT -- and this module is a browser egress
// boundary with no other business reaching into a provider.
//
// After: the dashboard reads the lane accounts from the account profile via
// google-accounts.js, which it already depended on, and the providers keep
// their own binding constants. That removes the edge but creates the risk
// this file exists to eliminate: the profile could name one account for the
// "vertex" row while the seat provider only ever authenticates as another,
// and the dashboard would attribute spend to an account that never spent it.
// Nothing else would notice, because neither side reads the other any more.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const googleAccounts = require(path.join(ROOT, 'src', 'lib', 'google-accounts'));
const vertexGemini = require(path.join(ROOT, 'src', 'lib', 'providers', 'vertex-gemini'));
const vertexGeminiSeat = require(path.join(ROOT, 'src', 'lib', 'providers', 'vertex-gemini-seat'));

// 1. The layering property itself. This is the part that must never regress
// silently: re-adding either require would restore the violation that the
// committed package-check baseline no longer has room for. Asserted against
// the source text rather than a package-check run so this fails in the same
// second as the mistake, not at the next boundary sweep.
const projectionSource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'controller-projection.js'), 'utf8');
for (const forbidden of ['./providers/vertex-gemini', './providers/vertex-gemini-seat']) {
  assert.ok(!new RegExp(`require\\(\\s*['"\`]${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(projectionSource),
    `controller-projection.js must not require ${forbidden}: the dashboard reads lane accounts from the account profile, `
    + 'and this require is a controller -> providers.gateway boundary violation (tools/package-check.js:264)');
}

// 2. The contract that replaced it. If load() ever stops returning these keys
// the reserved rows do not error -- they silently vanish, which is the
// absence-as-emptiness failure this codebase has shipped before. Assert the
// keys are present as keys, independently of whether they are configured.
const profile = googleAccounts.load();
for (const key of ['vertexSeatAccount', 'vertexApiAccount']) {
  assert.ok(Object.prototype.hasOwnProperty.call(profile, key),
    `google-accounts.load() must always expose ${key}, even as null; a missing key makes a configured lane silently disappear`);
}

// 3. The drift guard. Only meaningful on an installation that has actually
// configured a lane -- an unconfigured one is a legitimate state, not a
// failure, so it reports honestly instead of asserting on nothing.
const lanes = [
  { key: 'vertexSeatAccount', lane: 'vertex', provider: 'vertex-gemini-seat.js', readAlias: () => vertexGeminiSeat.ACCOUNT_ALIAS },
  { key: 'vertexApiAccount', lane: 'api', provider: 'vertex-gemini.js', readAlias: () => vertexGemini.ACCOUNT_ALIAS }
];
const configured = lanes.filter(entry => profile[entry.key]);
for (const entry of configured) {
  const alias = entry.readAlias();
  assert.equal(profile[entry.key], alias,
    `config/google-accounts.profile.json ${entry.key} names '${profile[entry.key]}' for the '${entry.lane}' Gemini lane, `
    + `but src/lib/providers/${entry.provider} authenticates as '${alias}'. The dashboard would attribute that lane's `
    + 'spend to an account that never spent it. Change one to match the other.');
}

const summary = configured.length === lanes.length
  ? 'both lanes configured and bound'
  : configured.length === 0
    ? 'no Vertex lane configured on this installation (a normal state; the drift check had nothing to compare)'
    : `${configured.length} of ${lanes.length} lanes configured; the rest are unconfigured, which is a normal state`;
console.log(`Gemini account lane binding tests passed (no provider require in the projection, load() contract intact, ${summary}).`);
