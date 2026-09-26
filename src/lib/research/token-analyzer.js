'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { rootPath } = require('../runtime');

const CHARS_PER_TOKEN = 3.8;

function estimateTokens(text = '') {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function analyzeTokenSavings({ query, rawPages = [], evidencePacket = {} }) {
  const rawText = rawPages.map(p => typeof p === 'string' ? p : (p.content || p.text || '')).join('\n\n');
  const rawBytes = Buffer.byteLength(rawText, 'utf8');
  const rawTokens = estimateTokens(rawText);

  const packetJson = JSON.stringify(evidencePacket);
  const packetBytes = Buffer.byteLength(packetJson, 'utf8');
  const packetTokens = estimateTokens(packetJson);

  const savingsTokens = Math.max(0, rawTokens - packetTokens);
  const savingsPercent = rawTokens > 0 ? Number(((savingsTokens / rawTokens) * 100).toFixed(2)) : 0;

  const analysis = {
    timestamp: new Date().toISOString(),
    query: query || evidencePacket.query || 'unknown',
    intent: evidencePacket.intent || 'general',
    model_tier_used: evidencePacket.model_tier_used || 'deterministic',
    raw_sources_count: rawPages.length,
    evidence_count: evidencePacket.evidence_count || (evidencePacket.evidence ? evidencePacket.evidence.length : 0),
    raw_bytes: rawBytes,
    raw_tokens_est: rawTokens,
    packet_bytes: packetBytes,
    packet_tokens_est: packetTokens,
    tokens_saved: savingsTokens,
    savings_percent: savingsPercent
  };

  return analysis;
}

function recordBenchmark(analysis, logFile = rootPath('state', 'token-savings-history.jsonl')) {
  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify(analysis) + '\n', 'utf8');
}

module.exports = {
  estimateTokens,
  analyzeTokenSavings,
  recordBenchmark
};
