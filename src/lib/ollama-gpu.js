'use strict';

const { requestFields } = require('./local-model-options');

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function residency(payload, model, contextTokens) {
  if (!payload || !Array.isArray(payload.models)) {
    throw fail('LOCAL_NODE_GPU_UNVERIFIED', 'Ollama did not return a readable GPU residency report, so the request was stopped.');
  }
  const names = new Set([model, ...(!model.includes(':') ? [`${model}:latest`] : [])]);
  const loaded = payload.models.find(row => row && (names.has(row.name) || names.has(row.model)));
  const sizeBytes = loaded && loaded.size;
  const vramBytes = loaded && loaded.size_vram;
  const verified = Number.isFinite(sizeBytes) && sizeBytes > 0 && Number.isFinite(vramBytes) &&
    vramBytes >= sizeBytes && loaded.context_length === contextTokens;
  return { model, verified, sizeBytes: sizeBytes ?? null, vramBytes: vramBytes ?? null, contextTokens: loaded?.context_length ?? null };
}

// An empty /api/generate loads only the chosen weights; no user prompt is sent
// before /api/ps proves full GPU residency. Never retry with fewer layers or a
// different model. Rechecking after generation catches a runtime that changed
// placement despite the request options, before any model-requested tool runs.
async function ensureGpu({ model, options, request, preload = true }) {
  if (options.gpuPolicy !== 'Require GPU') return { model, verified: false, policy: options.gpuPolicy };
  let proof;
  try {
    proof = residency(await request({ path: '/api/ps' }), model, options.contextTokens);
    if (!proof.verified && preload) {
      await request({ path: '/api/generate', method: 'POST', payload: { model, stream: false, ...requestFields(options) } });
      proof = residency(await request({ path: '/api/ps' }), model, options.contextTokens);
    }
  } catch (error) {
    if (error && /INTERRUPTED|TIMED_OUT|TIMEOUT/.test(error.code || '')) throw error;
    if (error && error.code === 'LOCAL_NODE_GPU_UNVERIFIED') throw error;
    throw fail('LOCAL_NODE_GPU_UNVERIFIED', 'GPU residency could not be verified with Ollama, so the local request was stopped.', { cause: error?.code || null });
  }
  if (!proof.verified) {
    throw fail('LOCAL_NODE_GPU_REQUIRED',
      `Ollama could not keep all of ${model} on the GPU with a ${options.contextTokens}-token context. Choose a smaller context or model, or explicitly allow CPU fallback in local model settings.`, proof);
  }
  return Object.freeze({ ...proof, policy: options.gpuPolicy });
}

module.exports = { ensureGpu, residency };
