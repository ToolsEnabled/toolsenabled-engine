const fs = require('fs');
const path = require('path');

// Ensure test/dev env if not specified
if (!process.env.TOOLSENABLED_RESEARCH_DB) {
  process.env.TOOLSENABLED_RESEARCH_DB = path.join(__dirname, '..', 'state', 'research-evidence.sqlite');
}

const { createWebProvider } = require('../src/lib/providers/web');
const { getSecret } = require('../src/lib/credential-metadata');
// R1162 seccouncil Stage 1b item 3: this CLI used to stub assertActive to a
// no-op below, so the kill switch and policy.mode/provider-enabled gates
// never actually ran for it even though the real mediated `web.lookup` MCP
// tool enforces them on every call. Route through the same real policy path
// instead so this CLI is truthfully gated, not just decorated with a mock.
const { assertActive } = require('../src/lib/policy');

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node tools/research-once.js "question"');
    process.exit(1);
  }

  const config = {
    fetch: { maxResponseBytes: 1048576, timeoutMs: 15000 },
    assertActive, // real, policy-mediated kill switch (was a no-op stub)
  };

  const provider = createWebProvider(config, {
    getSecret,
    evidenceDatabasePath: process.env.TOOLSENABLED_RESEARCH_DB
  });

  try {
    // Fail fast, before any network or DB work, if the kill switch is active
    // or the 'web' provider is not enabled by local policy — the same check
    // the mediated `web.lookup` MCP tool performs.
    assertActive('web.lookup', { provider: 'web' });

    console.warn('Starting lookup for:', query);

    const result = await provider.lookup({ query, max_sources: 5 });

    if (!result || !['success', 'no_results', 'degraded'].includes(result.status)) {
      throw new Error('Research returned an unknown outcome; no packet was produced.');
    }

    if (result.status === 'degraded') {
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
      const details = diagnostics
        .map(item => `${item.stage || 'lookup'}: ${item.message || item.code || 'unavailable'}`)
        .join('; ');
      throw new Error(`Research is unavailable${details ? `: ${details}` : '.'}`);
    }

    if (!Array.isArray(result.evidence)) {
      throw new Error('Research did not report an evidence inventory; no packet was produced.');
    }

    // A successful lookup must have established at least one source. Only the
    // provider's explicit no_results outcome may truthfully produce an empty
    // packet; a malformed or incomplete success must not collapse to "none".
    if (result.status === 'success' && result.evidence.length === 0) {
      throw new Error('Research reported success without evidence; no packet was produced.');
    }
    
    // Tier-4 packet builder (extractive only)
    const packet = {
      packet_version: 1,
      job_id: 'sync-one-shot-' + Date.now(),
      question: query,
      generated_at: new Date().toISOString(),
      model_tier_used: 'deterministic',
      evidence: [],
      summaries: [],
      contradictions: [],
      open_questions: [],
      budget: {
        sources_fetched: 0,
        sources_skipped_robots: 0,
        sources_failed_fetch: 0,
        sources_render_required: 0,
        search_calls_failed: 0,
        token_estimate: 0
      }
    };

    if (result.status === 'success') {
      for (const src of result.evidence) {
        packet.budget.sources_fetched += 1;
        
        // Push the source to evidence
        packet.evidence.push({
          source_id: src.evidenceId,
          url: src.url,
          canonical_url: src.url, // simplified
          retrieved_at: packet.generated_at,
          content_sha256: src.contentHash,
          title: src.extracted_title || src.title,
          locator: '',
          quote: src.snippet || '',
          extraction_model: 'trafilatura-deterministic',
          trust_tier: 'unknown'
        });
        
        // Add a deterministic summary (extractive fallback)
        if (src.extracted_text) {
          const sentences = src.extracted_text.split(/(?<=\.)\s+/).slice(0, 3);
          for (const s of sentences) {
            packet.summaries.push({
              text: s.trim(),
              evidence_ids: [src.evidenceId]
            });
          }
        }
      }
    }
    
    packet.budget.token_estimate = Math.ceil(JSON.stringify(packet).length / 4);

    console.log(JSON.stringify(packet, null, 2));
    
  } catch (err) {
    console.error('Error during research:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

main();
