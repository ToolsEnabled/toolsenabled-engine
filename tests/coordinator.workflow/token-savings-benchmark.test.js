'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeTokenSavings, recordBenchmark } = require('../../src/lib/research/token-analyzer');
const { buildEvidencePacket } = require('../../src/lib/research/model-enrichment');
const { rootPath } = require('../../src/lib/runtime');

console.log('Running Token Savings & Iteration Comparison Benchmark Test...');

// Sample raw HTML / long web page content
const rawWebPages = [
  `<html><head><title>Stripe API Pricing</title></head><body>` +
  `<h1>Stripe Pricing and Fees</h1>` +
  `<p>${'Detailed explanation of Stripe 2.9% + 30c pricing per transaction with all fine print. '.repeat(100)}</p>` +
  `<div>${'Nav links, header, footer, sidebar scripts, ads, CSS styles, tracking pixels. '.repeat(150)}</div>` +
  `</body></html>`,

  `<html><head><title>Paddle Pricing & Merchant of Record</title></head><body>` +
  `<h1>Paddle Fees & Tax Compliance</h1>` +
  `<p>${'Paddle charges 5% + 50c as a Merchant of Record taking care of global tax. '.repeat(120)}</p>` +
  `<div>${'Extremely long navigation, footer content, terms of service boilerplate, marketing banners. '.repeat(200)}</div>` +
  `</body></html>`
];

// Iteration 1: Standard Compact Evidence Extraction
const compactEvidence = [
  {
    url: 'https://stripe.com/pricing',
    title: 'Stripe API Pricing',
    snippet: 'Stripe charges 2.9% + 30c per transaction.',
    contentHash: 'hash-stripe-1',
    evidenceId: 'ev-stripe-1'
  },
  {
    url: 'https://paddle.com/pricing',
    title: 'Paddle Pricing & Merchant of Record',
    snippet: 'Paddle charges 5% + 50c as a Merchant of Record taking care of global tax.',
    contentHash: 'hash-paddle-1',
    evidenceId: 'ev-paddle-1'
  }
];

const packet1 = buildEvidencePacket('stripe vs paddle pricing', compactEvidence, [], { ollamaReachable: false });
const analysis1 = analyzeTokenSavings({ query: 'stripe vs paddle pricing', rawPages: rawWebPages, evidencePacket: packet1 });

console.log('\n--- Iteration 1: Standard Compact Extraction ---');
console.log(`Raw Estimated Tokens:    ${analysis1.raw_tokens_est}`);
console.log(`Packet Estimated Tokens: ${analysis1.packet_tokens_est}`);
console.log(`Token Savings:           ${analysis1.savings_percent}% (${analysis1.tokens_saved} tokens saved)`);

assert.ok(analysis1.savings_percent > 80, 'Compact extraction should achieve >80% token savings over raw web pages');

// Iteration 2: Rich Data Extraction (Detailed extracts included)
const richEvidence = [
  {
    url: 'https://stripe.com/pricing',
    title: 'Stripe API Pricing',
    snippet: 'Stripe charges 2.9% + 30c per transaction.',
    extracted_text: 'Detailed explanation of Stripe pricing: 2.9% + 30c per successful card charge. Custom volume discounts available above $80k/mo. Includes radar fraud protection.',
    contentHash: 'hash-stripe-1',
    evidenceId: 'ev-stripe-1'
  },
  {
    url: 'https://paddle.com/pricing',
    title: 'Paddle Pricing & Merchant of Record',
    snippet: 'Paddle charges 5% + 50c as a Merchant of Record taking care of global tax.',
    extracted_text: 'Paddle acts as Merchant of Record charging 5% + $0.50 per transaction. Automatically remits EU VAT, US sales tax, and handles buyer chargebacks.',
    contentHash: 'hash-paddle-1',
    evidenceId: 'ev-paddle-1'
  }
];

const packet2 = buildEvidencePacket('stripe vs paddle pricing', richEvidence, [], { ollamaReachable: false });
const analysis2 = analyzeTokenSavings({ query: 'stripe vs paddle pricing', rawPages: rawWebPages, evidencePacket: packet2 });

console.log('\n--- Iteration 2: Rich Data Extraction ---');
console.log(`Raw Estimated Tokens:    ${analysis2.raw_tokens_est}`);
console.log(`Packet Estimated Tokens: ${analysis2.packet_tokens_est}`);
console.log(`Token Savings:           ${analysis2.savings_percent}% (${analysis2.tokens_saved} tokens saved)`);

assert.ok(analysis2.packet_tokens_est > analysis1.packet_tokens_est, 'Richer data iteration should show higher token count than compact iteration');
assert.ok(analysis2.savings_percent > 70, 'Rich data extraction should still maintain >70% token savings vs raw web bloat');

// Record benchmark history
const benchmarkPath = rootPath('state', 'test-token-savings-history.jsonl');
recordBenchmark(analysis1, benchmarkPath);
recordBenchmark(analysis2, benchmarkPath);

assert.ok(fs.existsSync(benchmarkPath), 'Benchmark log file should exist after recording');
const historyLines = fs.readFileSync(benchmarkPath, 'utf8').trim().split('\n');
assert.equal(historyLines.length, 2, 'Benchmark log should contain 2 iteration records');

// Persistence failures must reach the caller instead of reporting a successful benchmark.
assert.throws(
  () => recordBenchmark(analysis1, path.join(benchmarkPath, 'unwritable.jsonl')),
  'Benchmark recording should surface filesystem failures'
);

// Clean up temporary benchmark file
fs.unlinkSync(benchmarkPath);

console.log('\nok   Token savings benchmark and iteration comparison tests passed cleanly!\n');
