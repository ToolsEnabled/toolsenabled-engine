'use strict';

const assert = require('node:assert/strict');
const { loadPolicy } = require('../../src/lib/policy');
const { researchConfiguration, classifyQueryIntent } = require('../../src/lib/providers/web');

console.log('Running research hardening tests (H1-H4)...');

// H2: Policy validation contract test
try {
  const policy = loadPolicy();
  const config = researchConfiguration(policy.research);
  assert.ok(config, 'shipped policy research section must validate cleanly');
  console.log('ok   H2: shipped research policy validates without error');
} catch (err) {
  assert.fail(`H2 contract test failed: ${err.message}`);
}

const customSearx = researchConfiguration({
  search: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:54321/search' }
});
assert.equal(customSearx.search.searxngUrl, 'http://127.0.0.1:54321/search',
  'the declared SearXNG port is configuration, not a fixed runtime value');
assert.throws(
  () => researchConfiguration({ search: { provider: 'searxng' } }),
  error => error && error.code === 'WEB_POLICY_INVALID',
  'SearXNG selection must declare its endpoint instead of receiving a hidden default'
);
console.log('ok   H2: SearXNG endpoint comes from policy');

// H4: Intent classifier test
const pricingIntent = classifyQueryIntent('Google Gemini Flash Lite API pricing per million tokens');
assert.equal(pricingIntent, 'commercial/pricing', 'pricing query should classify as commercial/pricing');

const techIntent = classifyQueryIntent('how to fix node.js EPIPE error in stream');
assert.equal(techIntent, 'technical-docs', 'technical query should classify as technical-docs');

const scholarlyIntent = classifyQueryIntent('attention is all you need paper abstract');
assert.equal(scholarlyIntent, 'scholarly', 'scholarly query should classify as scholarly');

console.log('ok   H4: query intent classifier maps intents correctly');

console.log('all research hardening tests passed');
