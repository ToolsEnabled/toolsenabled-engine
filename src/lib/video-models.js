'use strict';

// Provider contracts checked against the official fal model schemas on 2026-09-08.
// Keep model-specific bounds here so discovery and execution use the same data.
const ASPECT_RATIOS = Object.freeze(['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const MODELS = Object.freeze({
  'seedance-2.5': Object.freeze({
    id: 'seedance-2.5', label: 'Seedance 2.5', provider: 'fal',
    endpoint: 'bytedance/seedance-2.5', minDurationSeconds: 4, maxDurationSeconds: 30,
    resolutions: Object.freeze(['480p', '720p', '1080p']),
    textAspectRatios: ASPECT_RATIOS, imageAspectRatios: Object.freeze(['auto']),
    documentation: 'https://fal.ai/models/bytedance/seedance-2.5/text-to-video/api'
  }),
  'seedance-2.0': Object.freeze({
    id: 'seedance-2.0', label: 'Seedance 2.0', provider: 'fal',
    endpoint: 'bytedance/seedance-2.0', minDurationSeconds: 4, maxDurationSeconds: 15,
    resolutions: Object.freeze(['480p', '720p', '1080p', '4k']),
    textAspectRatios: ASPECT_RATIOS, imageAspectRatios: ASPECT_RATIOS,
    documentation: 'https://fal.ai/models/bytedance/seedance-2.0/text-to-video/api'
  })
});

module.exports = { MODELS, ASPECT_RATIOS };
