'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { StateStore } = require('../src/lib/state-store');
const video = require('../src/lib/providers/video');

const SECRET = 'fixture-fal-key-not-a-real-credential';
const REQUEST_ID = '764cabcf-b745-4b3e-ae38-1200304cf45b';
const input = extra => ({ model: 'seedance-2.5', prompt: 'A small boat on a quiet lake.\nThe camera moves slowly.',
  idempotencyKey: 'video-fixture-0001', ...extra });
const response = (body, status = 200) => ({ status, body });

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-provider-'));
  const file = path.join(root, 'operations.sqlite3');
  const calls = [];
  const replies = [];
  const policies = [];
  let secretReads = 0;
  const d = { state: new StateStore({ file }),
    getSecret(key) { secretReads += 1; assert.equal(key, 'fal_api_key'); return SECRET; },
    assertActive(action, options) { policies.push([action, options]); },
    loadPolicy: () => ({ providers: { falVideo: { enabled: true } } }),
    vaultRecordPresence: () => ({ present: null, readable: false }),
    request: async (url, options) => {
      calls.push({ url, options });
      if (!replies.length) return response({ request_id: REQUEST_ID });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply() : reply;
    }
  };
  t.after(() => { d.state.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { d, file, calls, replies, policies, secretReads: () => secretReads };
}

test('model discovery reports unknown credential presence without decrypting or generating', t => {
  const h = harness(t);
  const result = video.models({}, h.d);
  assert.equal(result.credential.present, null);
  assert.equal(result.generationMayIncurCharges, true);
  assert.equal(result.models.find(x => x.id === 'seedance-2.5').maxDurationSeconds, 30);
  assert.equal(result.models.find(x => x.id === 'seedance-2.0').maxDurationSeconds, 15);
  assert.equal(h.secretReads(), 0);
  assert.equal(h.calls.length, 0);
});

test('text generation uses the official endpoint and persists a receipt, without prompt or key', async t => {
  const h = harness(t);
  const generated = await video.generate(input(), h.d);
  assert.equal(generated.requestId, REQUEST_ID);
  assert.equal(generated.state, 'queued');
  assert.equal(generated.submissionState, 'submitted');
  assert.equal(generated.replayed, false);
  assert.equal(h.calls[0].url, 'https://queue.fal.run/bytedance/seedance-2.5/text-to-video');
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.retries, 0);
  assert.equal(h.calls[0].options.redirect, 'manual');
  assert.equal(h.calls[0].options.headers.authorization, `Key ${SECRET}`);
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { prompt: input().prompt, duration: '5', resolution: '720p',
    aspect_ratio: '16:9', generate_audio: true, bitrate_mode: 'standard' });
  const persisted = JSON.stringify(h.d.state.getOperation({ type: 'video.generate', key: generated.jobId }));
  assert.equal(persisted.includes('quiet lake'), false);
  assert.equal(persisted.includes(SECRET), false);
  h.d.state.close();
  h.d.state = new StateStore({ file: h.file });
  const listed = video.jobs({}, h.d);
  assert.equal(listed.items[0].requestId, REQUEST_ID);
  assert.equal(listed.statusSource, 'local-submission-receipts');
  const replay = await video.generate(input(), h.d);
  assert.equal(replay.replayed, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.secretReads(), 1, 'a durable replay does not require the provider credential');
  await assert.rejects(video.generate(input({ durationSeconds: 6 }), h.d), /different|match|input/i);
  assert.equal(h.calls.length, 1);
});

test('image generation carries both frames and honors each model contract', async t => {
  const h = harness(t);
  await video.generate(input({ imageUrl: 'https://images.example.com/first.png', endImageUrl: 'https://images.example.com/last.webp', durationSeconds: 30 }), h.d);
  assert.match(h.calls[0].url, /seedance-2\.5\/image-to-video$/);
  const body = JSON.parse(h.calls[0].options.body);
  assert.equal(body.image_url, 'https://images.example.com/first.png');
  assert.equal(body.end_image_url, 'https://images.example.com/last.webp');
  assert.equal(body.aspect_ratio, 'auto');
  assert.equal(body.duration, '30');
  await video.generate(input({ model: 'seedance-2.0', resolution: '4k', durationSeconds: 15, idempotencyKey: 'video-fixture-0002' }), h.d);
  assert.match(h.calls[1].url, /seedance-2\.0\/text-to-video$/);
});

test('invalid model combinations and credential-shaped inputs fail before state or network', async t => {
  const h = harness(t);
  for (const invalid of [
    { model: 'constructor' }, { model: 'arbitrary/model' }, { prompt: ' ' },
    { model: 'seedance-2.0', durationSeconds: 16 }, { durationSeconds: 31 }, { resolution: '4k' },
    { imageUrl: 'https://images.example.com/a.png', aspectRatio: '16:9' },
    { imageUrl: 'http://images.example.com/a.png' }, { imageUrl: 'https://127.0.0.1/a.png' },
    { imageUrl: 'https://user:pass@example.com/a.png' }, { imageUrl: 'https://[::1]/a.png' },
    { imageUrl: 'https://example.local/a.png' }, { endImageUrl: 'https://images.example.com/a.png' },
    { apiKey: SECRET }, { generateAudio: 'yes' }
  ]) await assert.rejects(video.generate(input(invalid), h.d));
  assert.equal(h.calls.length, 0);
  assert.equal(h.secretReads(), 0);
  assert.deepEqual(h.d.state.listOperations({ type: 'video.generate' }), []);
});

test('uncertain submission survives restart and blocks a duplicate paid request', async t => {
  const h = harness(t);
  h.replies.push(new Error(`network lost after accept; echoed ${SECRET}`));
  await assert.rejects(video.generate(input(), h.d), error => error.code === 'VIDEO_REQUEST_FAILED' && !error.message.includes(SECRET));
  h.d.state.close();
  h.d.state = new StateStore({ file: h.file });
  assert.equal(video.jobs({}, h.d).items[0].state, 'submission_uncertain');
  await assert.rejects(video.generate(input(), h.d), /uncertain/i);
  const result = await video.status({ jobId: input().idempotencyKey }, h.d);
  assert.equal(result.state, 'submission_uncertain');
  assert.equal(h.calls.length, 1);
});

test('missing credential is a pre-request failure that can be corrected with the same job ID', async t => {
  const h = harness(t);
  const getSecret = h.d.getSecret;
  h.d.getSecret = () => null;
  await assert.rejects(video.generate(input(), h.d), error => error.code === 'VAULT_SECRET_UNAVAILABLE');
  assert.equal(video.jobs({}, h.d).items[0].state, 'submission_failed');
  assert.equal(h.calls.length, 0);
  h.d.getSecret = getSecret;
  assert.equal((await video.generate(input(), h.d)).submissionState, 'submitted');
  assert.equal(h.calls.length, 1);
});

test('completion requires the actual video result and ignores untrusted convenience URLs', async t => {
  const h = harness(t);
  const job = await video.generate(input(), h.d);
  h.replies.push(response({ status: 'IN_PROGRESS', response_url: 'https://attacker.invalid/steal' }));
  assert.equal((await video.status({ jobId: job.jobId }, h.d)).state, 'running');
  h.replies.push(response({ status: 'COMPLETED', request_id: REQUEST_ID, response_url: 'https://attacker.invalid/steal' }),
    response({ video: { url: 'https://v3.fal.media/files/generated.mp4', content_type: 'video/mp4', file_size: 1000 }, seed: 42 }));
  const completed = await video.status({ jobId: job.jobId }, h.d);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.terminal, true);
  assert.equal(completed.video.fileSize, 1000);
  assert.equal(completed.downloadRequired, true);
  assert.equal(h.calls[2].url, `https://queue.fal.run/bytedance/seedance-2.5/requests/${REQUEST_ID}/status`);
  assert.equal(h.calls[3].url, `https://queue.fal.run/bytedance/seedance-2.5/requests/${REQUEST_ID}`);
  assert.equal(h.calls.every(call => call.url.startsWith('https://queue.fal.run/')), true);
});

test('completed provider failures and malformed results cannot be reported as successful videos', async t => {
  const h = harness(t);
  const job = await video.generate(input(), h.d);
  h.replies.push(response({ status: 'COMPLETED', error: `refused ${SECRET}`, error_type: 'validation' }));
  const failed = await video.status({ jobId: job.jobId }, h.d);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.terminal, true);
  assert.equal(JSON.stringify(failed).includes(SECRET), false);
  for (const result of [{}, { video: { url: 'http://example.com/unsafe.mp4' } }, { video: { url: `https://example.com/${SECRET}.mp4` } }]) {
    h.replies.push(response({ status: 'COMPLETED' }), response(result));
    await assert.rejects(video.status({ jobId: job.jobId }, h.d), error => error.code === 'VIDEO_RESPONSE_INVALID');
  }
  h.replies.push(response({ status: 'IN_QUEUE', request_id: 'wrong-id' }));
  await assert.rejects(video.status({ jobId: job.jobId }, h.d), error => error.code === 'VIDEO_RESPONSE_INVALID');
});

test('cancel acknowledgement remains nonterminal and can be followed by a completed result', async t => {
  const h = harness(t);
  const job = await video.generate(input(), h.d);
  h.replies.push(response({ status: 'CANCELLATION_REQUESTED' }, 202));
  const cancelled = await video.cancel({ jobId: job.jobId }, h.d);
  assert.equal(cancelled.state, 'cancellation_requested');
  assert.equal(cancelled.terminal, false);
  assert.equal(h.calls[1].options.method, 'PUT');
  assert.equal(h.calls[1].options.retries, 0);
  h.replies.push(response({ status: 'COMPLETED' }), response({ video: { url: 'https://v3.fal.media/files/done.mp4' } }));
  assert.equal((await video.status({ jobId: job.jobId }, h.d)).state, 'succeeded');
});

test('bounded waiting preserves a pending job and forwards caller cancellation', async t => {
  const h = harness(t);
  const job = await video.generate(input(), h.d);
  let now = 1000;
  h.d.now = () => now;
  h.d.sleep = async ms => { now += ms; };
  h.replies.push(response({ status: 'IN_QUEUE', queue_position: 2 }), response({ status: 'IN_PROGRESS' }));
  assert.equal((await video.status({ jobId: job.jobId, waitSeconds: 3 }, h.d)).state, 'running');
  assert.equal(now, 4000);
  const controller = new AbortController();
  const reason = new Error('fixture user stopped waiting');
  h.d.signal = controller.signal;
  h.d.sleep = async () => { controller.abort(reason); throw reason; };
  h.replies.push(response({ status: 'IN_PROGRESS' }));
  await assert.rejects(video.status({ jobId: job.jobId, waitSeconds: 3 }, h.d), error => error === reason);
  assert.equal(h.calls.at(-1).options.signal, controller.signal);
  assert.equal(h.d.state.getOperation({ type: 'video.generate', key: job.jobId }).status, 'succeeded');
});

test('policy is rechecked on every provider action and a kill switch stops a waiting poll', async t => {
  const h = harness(t);
  const job = await video.generate(input(), h.d);
  let now = 0;
  let killed = false;
  h.d.now = () => now;
  h.d.assertActive = () => { if (killed) throw new Error('KILLSWITCH is active'); };
  h.replies.push(response({ status: 'IN_PROGRESS' }));
  h.d.sleep = async ms => { now += ms; killed = true; };
  await assert.rejects(video.status({ jobId: job.jobId, waitSeconds: 4 }, h.d), /KILLSWITCH/);
  assert.equal(h.calls.length, 2);
  await assert.rejects(video.cancel({ jobId: job.jobId }, h.d), /KILLSWITCH/);
  assert.equal(h.calls.length, 2);
});

test('concurrent submissions sharing a job ID send only one paid request', async t => {
  const h = harness(t);
  let accepted;
  h.replies.push(() => new Promise(resolve => { accepted = resolve; }));
  const first = video.generate(input(), h.d);
  await assert.rejects(video.generate(input(), h.d), /in.progress|executing|busy|lease/i);
  assert.equal(h.calls.length, 1);
  accepted(response({ request_id: REQUEST_ID }));
  await first;
  assert.equal((await video.generate(input(), h.d)).replayed, true);
  assert.equal(h.calls.length, 1);
});

test('download refreshes a completed result and forwards bounds and cancellation without resubmitting', async t => {
  const h = harness(t);
  const job = await video.generate(input(), h.d);
  const controller = new AbortController();
  h.d.signal = controller.signal;
  h.replies.push(response({ status: 'IN_QUEUE' }));
  await assert.rejects(video.download({ jobId: job.jobId }, h.d), error => error.code === 'VIDEO_NOT_READY');
  h.replies.push(response({ status: 'COMPLETED' }), response({ video: { url: 'https://v3.fal.media/files/video.mp4' } }));
  let downloads = 0;
  const artifact = { path: '/fixture/video.mp4', bytes: 24, sha256: 'fixture-digest' };
  h.d.downloadArtifact = async (url, options) => {
    downloads += 1;
    assert.equal(url, 'https://v3.fal.media/files/video.mp4');
    assert.equal(options.maxBytes, 1024);
    assert.equal(options.signal, controller.signal);
    options.assertCurrent();
    return artifact;
  };
  assert.deepEqual((await video.download({ jobId: job.jobId, maxBytes: 1024 }, h.d)).artifact, artifact);
  assert.equal(downloads, 1);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('MCP discovery declares the video workflow and normal consequential-action metadata', () => {
  const registry = require('../src/lib/tool-registry');
  const tools = registry.listTools();
  for (const name of ['video.models', 'video.generate', 'video.jobs', 'video.status', 'video.cancel', 'video.download']) {
    assert.ok(tools.find(tool => tool.name === name), name);
  }
  const generate = registry.getTool('video.generate');
  assert.equal(generate.effect, 'external-write');
  assert.equal(generate.provider, 'falVideo');
  assert.equal(generate.approvalEligible, true);
  assert.equal(generate.annotations.idempotentHint, true);
  assert.ok(generate.inputSchema.properties.approvalToken);
});
