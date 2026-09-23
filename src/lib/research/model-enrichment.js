'use strict';

const { pickModel } = require('../model-picker');

function buildEvidencePacket(query, evidenceList = [], diagnostics = [], probeData = {}, options = {}) {
  const modelChoice = pickModel(probeData, options);
  const modelTierUsed = modelChoice.available ? modelChoice.tier : 'deterministic';
  
  const formattedEvidence = evidenceList.map((item, idx) => {
    return {
      citation_id: `src-${idx + 1}`,
      url: item.url,
      title: item.title || item.extracted_title || 'Untitled',
      snippet: item.snippet || (item.extracted_text ? item.extracted_text.slice(0, 300) : ''),
      extracted_text: item.extracted_text || undefined,
      contentHash: item.contentHash,
      evidenceId: item.evidenceId
    };
  });

  return {
    query,
    status: diagnostics.length > 0 ? 'degraded' : (formattedEvidence.length === 0 ? 'no_results' : 'success'),
    model_tier_used: modelTierUsed,
    model_name: modelChoice.available ? modelChoice.model : null,
    evidence_count: formattedEvidence.length,
    evidence: formattedEvidence,
    diagnostics
  };
}

module.exports = {
  buildEvidencePacket
};
