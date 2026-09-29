'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { getSecret } = require('../runtime');
const { loadPolicy, assertActive } = require('../policy');
const { vaultRecordPresence } = require('../vault-presence');
const { getStateStore, hashInput } = require('../state-store');
const { request } = require('../http');
const { isPublicAddress } = require('../ssrf-guard');
const { isIP } = require('node:net');
const { MODELS } = require('../video-models');
const artifacts = require('../video-artifacts');
const safety = require('./provider-safety');

const PROVIDER = 'falVideo';
const VAULT_KEY = 'fal_api_key';
const QUEUE_ROOT = 'https://queue.fal.run';
const OPERATION = 'video.generate';
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function dependencies(overrides = {}) {
  return { request, getSecret, assertActive, loadPolicy, vaultRecordPresence, hashInput,
    now: Date.now, sleep: (ms, signal) => delay(ms, undefined, { signal }), downloadArtifact: artifacts.download, ...overrides };
}
function stateFor(d) { return d.state || getStateStore(); }
function fail(code, message) { throw safety.safeError(code, message); }
function modelFor(id) {
  if (typeof id !== 'string' || !Object.hasOwn(MODELS, id)) fail('VIDEO_MODEL_INVALID', 'Choose a model returned by video.models.');
  return MODELS[id];
}
function oneOf(value, values, label, fallback) {
  const selected = value === undefined ? fallback : value;
  if (!values.includes(selected)) throw new TypeError(`${label} must be one of: ${values.join(', ')}.`);
  return selected;
}
function mediaUrl(value, label) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new TypeError(`${label} must be a public HTTPS URL.`);
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be a public HTTPS URL.`); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !hostname.includes('.') && !isIP(hostname) || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname)
    || isIP(hostname) && !isPublicAddress(hostname)) throw new TypeError(`${label} must be a public HTTPS URL.`);
  return url.href;
}
function generationInput(input) {
  safety.exactKeys(input, ['model', 'prompt', 'imageUrl', 'endImageUrl', 'durationSeconds', 'resolution', 'aspectRatio', 'generateAudio', 'bitrateMode', 'idempotencyKey'], 'video.generate');
  const model = modelFor(input.model);
  const key = safety.idempotencyKey(input.idempotencyKey);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 10000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.prompt) || safety.PLAINTEXT_SECRET.test(input.prompt)) {
    throw new TypeError('prompt must contain 1 through 10000 characters and no plaintext credentials.');
  }
  const mode = input.imageUrl === undefined ? 'text-to-video' : 'image-to-video';
  if (input.endImageUrl !== undefined && mode !== 'image-to-video') throw new TypeError('endImageUrl requires imageUrl.');
  const durationSeconds = safety.boundedInteger(input.durationSeconds, 'durationSeconds', 5, model.minDurationSeconds, model.maxDurationSeconds);
  const aspectRatio = oneOf(input.aspectRatio, mode === 'image-to-video' ? model.imageAspectRatios : model.textAspectRatios,
    'aspectRatio', mode === 'image-to-video' ? 'auto' : '16:9');
  const resolution = oneOf(input.resolution, model.resolutions, 'resolution', '720p');
  const bitrateMode = oneOf(input.bitrateMode, ['standard', 'high'], 'bitrateMode', 'standard');
  if (input.generateAudio !== undefined && typeof input.generateAudio !== 'boolean') throw new TypeError('generateAudio must be a boolean.');
  const body = { prompt: input.prompt, duration: String(durationSeconds), resolution, aspect_ratio: aspectRatio,
    generate_audio: input.generateAudio ?? true, bitrate_mode: bitrateMode };
  if (input.imageUrl !== undefined) body.image_url = mediaUrl(input.imageUrl, 'imageUrl');
  if (input.endImageUrl !== undefined) body.end_image_url = mediaUrl(input.endImageUrl, 'endImageUrl');
  return { model, mode, key, body, durationSeconds, resolution, aspectRatio };
}

function models(input = {}, overrides = {}) {
  safety.exactKeys(input, [], 'video.models');
  const d = dependencies(overrides);
  const presence = d.vaultRecordPresence(VAULT_KEY);
  return { provider: 'fal', enabled: d.loadPolicy()?.providers?.[PROVIDER]?.enabled === true,
    credential: { key: VAULT_KEY, present: presence.present, readable: presence.readable },
    models: Object.values(MODELS).map(({ endpoint, ...model }) => ({ ...model, modes: ['text-to-video', 'image-to-video'], audio: true })),
    requiresProviderAccount: true, generationMayIncurCharges: true, defaultDurationSeconds: 5,
    ...safety.UNTRUSTED_CONTENT };
}

async function api(d, path, { method = 'GET', body, secret, timeoutMs = 30000 } = {}) {
  d.signal?.throwIfAborted();
  if (d.readDeadline !== undefined) timeoutMs = Math.max(1, Math.min(timeoutMs, d.readDeadline - d.now()));
  try {
    const result = await d.request(`${QUEUE_ROOT}/${path}`, { method, retries: 0, redirect: 'manual',
      timeoutMs, signal: d.signal, maxResponseBytes: 1024 * 1024,
      headers: { authorization: `Key ${secret}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300 || !safety.isPlainObject(result.body)) {
      fail('VIDEO_RESPONSE_INVALID', 'The video provider returned an invalid response.');
    }
    return result;
  } catch (error) {
    if (d.signal?.aborted) throw d.signal.reason;
    if (error.code === 'VIDEO_RESPONSE_INVALID') throw error;
    if (error.status === 401 || error.status === 403) fail('VIDEO_AUTH_REQUIRED', 'The video provider refused access. Check the fal account, model access, and fal_api_key credential.');
    if (error.status === 404) fail('VIDEO_PROVIDER_JOB_NOT_FOUND', 'The provider could not find this model or job. Retain the local receipt and check the fal dashboard before generating again.');
    if (error.status === 429) fail('VIDEO_RATE_LIMITED', 'The video provider is rate limited. Wait before checking again; generation was not automatically resubmitted.');
    fail('VIDEO_REQUEST_FAILED', 'The video provider request did not complete. Check video.jobs for the saved submission state before submitting another generation.');
  }
}

async function generate(input, overrides = {}) {
  const normalized = generationInput(input);
  const { model, mode, key, body, durationSeconds, resolution, aspectRatio } = normalized;
  const d = dependencies(overrides);
  d.assertActive(OPERATION, { provider: PROVIDER });
  return safety.mutate({ state: stateFor(d), hashInput: d.hashInput, now: d.now,
    type: OPERATION, key, input: { model: model.id, mode, body },
    execute: async attempted => {
      const secret = safety.secretValue(d.getSecret, VAULT_KEY);
      d.signal?.throwIfAborted();
      d.assertActive(OPERATION, { provider: PROVIDER });
      attempted();
      const response = await api(d, `${model.endpoint}/${mode}`, { method: 'POST', body, secret });
      const requestId = response.body.request_id;
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || safety.redactText(requestId, secret) !== requestId) {
        fail('VIDEO_RESPONSE_INVALID', 'The provider did not return a usable request ID. Submission may have succeeded; check the fal dashboard before generating again.');
      }
      // Only the accepted submission is persisted. Provider job completion is
      // a separate observation; neither a 200 nor COMPLETED alone proves video.
      return { jobId: key, provider: 'fal', model: model.id, mode, requestId,
        submissionState: 'submitted', state: 'queued', durationSeconds, resolution, aspectRatio,
        submittedAt: new Date(d.now()).toISOString(), ...safety.UNTRUSTED_CONTENT };
    }
  });
}

function jobRecord(operation) {
  if (!operation) fail('VIDEO_JOB_NOT_FOUND', 'No local video submission has that job ID. Use video.jobs to find a saved receipt.');
  if (operation.status !== 'succeeded') return {
    jobId: operation.key, submissionState: operation.status,
    state: operation.status === 'uncertain' ? 'submission_uncertain' : operation.status === 'retryable_failed' ? 'submission_failed' : 'submitting',
    error: operation.error ? { code: operation.error.code, message: operation.error.message } : null,
    createdAt: operation.createdAt, ...safety.UNTRUSTED_CONTENT
  };
  const value = operation.result;
  if (!safety.isPlainObject(value) || value.jobId !== operation.key || !REQUEST_ID.test(value.requestId || '')
    || !['text-to-video', 'image-to-video'].includes(value.mode)) fail('VIDEO_RECEIPT_INVALID', 'The saved video receipt is invalid.');
  modelFor(value.model);
  return { ...value };
}
function readJob(jobId, d) {
  const key = safety.idempotencyKey(jobId);
  return jobRecord(stateFor(d).getOperation({ type: OPERATION, key }));
}
function jobs(input = {}, overrides = {}) {
  safety.exactKeys(input, ['limit'], 'video.jobs');
  const limit = safety.boundedInteger(input.limit, 'limit', 20, 1, 100);
  const d = dependencies(overrides);
  const items = stateFor(d).listOperations({ type: OPERATION, limit }).map(jobRecord);
  return { items, count: items.length, statusSource: 'local-submission-receipts',
    next: 'Use video.status to check a submitted job with the provider.', ...safety.UNTRUSTED_CONTENT };
}

async function observe(job, d, timeoutMs) {
  const model = modelFor(job.model);
  d.assertActive('video.status', { provider: PROVIDER });
  const secret = safety.secretValue(d.getSecret, VAULT_KEY);
  const requestPath = `${model.endpoint}/requests/${job.requestId}`;
  const { body } = await api(d, `${requestPath}/status`, { secret, timeoutMs });
  if (body.request_id !== undefined && body.request_id !== job.requestId) fail('VIDEO_RESPONSE_INVALID', 'The provider returned a different job ID.');
  if (body.status === 'IN_QUEUE' || body.status === 'IN_PROGRESS') return {
    ...job, state: body.status === 'IN_QUEUE' ? 'queued' : 'running', terminal: false,
    queuePosition: Number.isSafeInteger(body.queue_position) && body.queue_position >= 0 ? body.queue_position : null
  };
  if (body.status !== 'COMPLETED') fail('VIDEO_RESPONSE_INVALID', 'The provider returned an unknown job state.');
  if (body.error != null || body.error_type != null) return { ...job, state: 'failed', terminal: true,
    error: { code: 'VIDEO_GENERATION_FAILED', message: safety.redactText(typeof body.error === 'string' ? body.error : 'Video generation failed. Check the fal dashboard.', secret, 1000) } };
  d.assertActive('video.status', { provider: PROVIDER });
  const result = await api(d, requestPath, { secret, timeoutMs });
  const video = result.body.video;
  if (!safety.isPlainObject(video) || typeof video.url !== 'string'
    || safety.redactText(video.url, secret, 8193) !== video.url) fail('VIDEO_RESPONSE_INVALID', 'A completed job did not contain a usable video.');
  let url;
  try { url = mediaUrl(video.url, 'video.url'); } catch { fail('VIDEO_RESPONSE_INVALID', 'A completed job did not contain a public HTTPS video URL.'); }
  return { ...job, state: 'succeeded', terminal: true,
    video: { url, contentType: typeof video.content_type === 'string' ? safety.redactText(video.content_type, secret, 100) : null,
      fileSize: Number.isSafeInteger(video.file_size) && video.file_size >= 0 ? video.file_size : null },
    seed: Number.isSafeInteger(result.body.seed) ? result.body.seed : null,
    downloadRequired: true, note: 'Provider URLs expire. Download the video to keep it.' };
}

async function status(input, overrides = {}) {
  safety.exactKeys(input, ['jobId', 'waitSeconds'], 'video.status');
  const waitSeconds = safety.boundedInteger(input.waitSeconds, 'waitSeconds', 0, 0, 30);
  const d = dependencies(overrides);
  const job = readJob(input.jobId, d);
  if (job.submissionState !== 'submitted') return { ...job, terminal: false };
  const deadline = d.now() + waitSeconds * 1000;
  if (waitSeconds) d.readDeadline = deadline;
  let observed;
  do {
    d.signal?.throwIfAborted();
    observed = await observe(job, d, waitSeconds ? Math.max(1, Math.min(30000, deadline - d.now())) : 30000);
    if (observed.terminal || !waitSeconds || d.now() >= deadline) return observed;
    await d.sleep(Math.min(2000, deadline - d.now()), d.signal);
  } while (d.now() < deadline);
  return observed;
}

async function cancel(input, overrides = {}) {
  safety.exactKeys(input, ['jobId'], 'video.cancel');
  const d = dependencies(overrides);
  const job = readJob(input.jobId, d);
  if (job.submissionState !== 'submitted') fail('VIDEO_REQUEST_ID_UNAVAILABLE', 'This submission has no confirmed provider request ID to cancel. Inspect video.jobs and the fal dashboard.');
  d.assertActive('video.cancel', { provider: PROVIDER });
  const secret = safety.secretValue(d.getSecret, VAULT_KEY);
  const result = await api(d, `${modelFor(job.model).endpoint}/requests/${job.requestId}/cancel`, { method: 'PUT', secret });
  if (result.status !== 202 || result.body.status !== 'CANCELLATION_REQUESTED') fail('VIDEO_RESPONSE_INVALID', 'The provider did not confirm a cancellation request. Check video.status.');
  return { ...job, state: 'cancellation_requested', terminal: false,
    note: 'The provider accepted cancellation. A running job can still finish; check video.status.', ...safety.UNTRUSTED_CONTENT };
}

async function download(input, overrides = {}) {
  safety.exactKeys(input, ['jobId', 'maxBytes'], 'video.download');
  const maxBytes = safety.boundedInteger(input.maxBytes, 'maxBytes', 256 * 1024 * 1024, 12, 1024 * 1024 * 1024);
  const d = dependencies(overrides);
  d.assertActive('video.download', { provider: PROVIDER });
  const observed = await status({ jobId: input.jobId }, d);
  if (observed.state !== 'succeeded') fail('VIDEO_NOT_READY', 'This job has no completed video to download. Check video.status.');
  const artifact = await d.downloadArtifact(observed.video.url, { maxBytes, signal: d.signal,
    assertCurrent: () => d.assertActive('video.download', { provider: PROVIDER }) });
  return { jobId: observed.jobId, model: observed.model, state: 'downloaded', artifact, ...safety.UNTRUSTED_CONTENT };
}

module.exports = { models, generate, jobs, status, cancel, download };
