'use strict';

/* A PASTED PICTURE HAS TO REACH THE MODEL.
 *
 * The owner's report, 2026-09-15: "images paste into chat but DONT get sent to
 * the agent and cause an error." The app was never the problem -- it saves the
 * file, allowlists it and hands the adapter a validated path. This adapter then
 * refused the whole turn:
 *
 *   throw new ClaudeCliError('CLAUDE_CLI_IMAGES_UNSUPPORTED',
 *     'This Claude session cannot take images yet, so nothing was sent.')
 *
 * Refusing was the right call while nothing here could carry a picture. It is
 * the wrong call now that it can. This file pins what "can" means, by reading
 * what was actually written to the transport -- the real stream-json user
 * message the CLI receives -- rather than by asking the adapter what it thinks
 * it did.
 *
 * EVERY ASSERTION CALLS THE ADAPTER WITH VALUES. Nothing here pins a spelling
 * of the implementation: a better implementation that still puts the person's
 * picture in the message passes this file unchanged.
 *
 * Run alone with:
 *   node tests/run-isolated.js tests/agent-engine/claude-cli-image-turn.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ClaudeCliAdapter } = require('../../src/lib/agent-engine/claude-cli-adapter');

const THREAD_ID = '7cf7c88e-6912-4388-a181-78aef262c494';

/* A REAL FILE, not a fixture path that does not exist: the loader under test
 * opens what it is given, so a test that never wrote bytes would prove that a
 * missing file refuses and nothing else. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-image-turn-'));
const pngPath = path.join(scratch, 'pasted.png');
/* A 1x1 PNG. Written from its own bytes so the expected base64 below is
 * derived from the file on disk, never from a string copied beside it. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
fs.writeFileSync(pngPath, PNG_BYTES);
const expectedData = fs.readFileSync(pngPath).toString('base64');

function recordingAdapter() {
  const written = [];
  const transport = {
    send(message) { written.push(message); },
    onData() {}, onExit() {}, close() {}, kill() {}
  };
  return { adapter: new ClaudeCliAdapter({ transport }), written };
}

/* Settle whatever sendTurn installed so one case cannot leave the next one
 * looking "already working on a turn". The result packet is the CLI's; this
 * only needs the adapter to stop waiting. */
function abandon(adapter) {
  try { adapter.close(); } catch { /* closing an already-closed session is not a failure here */ }
}

async function sent(adapter, written, request) {
  const promise = adapter.sendTurn(request);
  promise.catch(() => { /* the turn never completes here; only the written message is under test */ });
  await new Promise(resolve => setImmediate(resolve));
  return written;
}

function userContent(written) {
  assert.equal(written.length, 1, 'exactly one user message must be written for one turn');
  const message = written[0];
  assert.equal(message.type, 'user');
  assert.equal(message.message.role, 'user');
  assert.ok(Array.isArray(message.message.content), 'the user message must carry content blocks');
  return message.message.content;
}

(async () => {
  /* ---------------------------------------------------------------- 1 -- */
  /* CONTROL: words alone still travel exactly as they did. A fix that carries
     pictures by changing what a plain message looks like is a regression. */
  {
    const { adapter, written } = recordingAdapter();
    await sent(adapter, written, { threadId: THREAD_ID, text: 'no picture here' });
    const content = userContent(written);
    assert.deepEqual(content, [{ type: 'text', text: 'no picture here' }],
      'a turn with no picture must still be a single text block');
    abandon(adapter);
  }

  /* ---------------------------------------------------------------- 2 -- */
  /* THE DEFECT THIS FILE EXISTS FOR: one pasted picture, and the bytes the
     person pasted are in the message the CLI receives. */
  {
    const { adapter, written } = recordingAdapter();
    await sent(adapter, written, {
      threadId: THREAD_ID,
      text: 'what is in this picture?',
      images: [{ path: pngPath }]
    });
    const content = userContent(written);

    const text = content.filter(block => block && block.type === 'text');
    assert.equal(text.length, 1, "the person's words must still be in the message");
    assert.equal(text[0].text, 'what is in this picture?');

    const images = content.filter(block => block && block.type === 'image');
    assert.equal(images.length, 1, 'the pasted picture must be in the message exactly once');
    assert.equal(images[0].source.type, 'base64');
    assert.equal(images[0].source.media_type, 'image/png',
      'the media type must describe the file that was pasted');
    assert.equal(images[0].source.data, expectedData,
      'the bytes sent must be the bytes on disk, not a placeholder or a path');

    abandon(adapter);
  }

  /* ---------------------------------------------------------------- 3 -- */
  /* ORDER IS PART OF THE MEANING: a question about a picture reads as a
     question about the picture above it. Text first, then the pictures. */
  {
    const { adapter, written } = recordingAdapter();
    await sent(adapter, written, {
      threadId: THREAD_ID,
      text: 'and this one?',
      images: [{ path: pngPath }, { path: pngPath }]
    });
    const content = userContent(written);
    assert.equal(content[0].type, 'text');
    assert.equal(content.filter(block => block.type === 'image').length, 2,
      'two pasted pictures must both travel');
    abandon(adapter);
  }

  /* ---------------------------------------------------------------- 4 -- */
  /* A PICTURE THAT CANNOT BE READ STILL REFUSES, BY NAME, AND SENDS NOTHING.
     The old behaviour's one virtue was that it never answered a question about
     a picture the model never received; losing that would trade one silent
     wrong answer for another. */
  {
    const { adapter, written } = recordingAdapter();
    const missing = path.join(scratch, 'not-written.png');
    await assert.rejects(
      adapter.sendTurn({ threadId: THREAD_ID, text: 'read this', images: [{ path: missing }] }),
      error => typeof error.code === 'string'
        && error.code.startsWith('CLAUDE_CLI_IMAGE')
        && error.code !== 'CLAUDE_CLI_IMAGES_UNSUPPORTED',
      'an unreadable picture must refuse under its own code, not the blanket unsupported one'
    );
    assert.equal(written.length, 0, 'nothing may be written when the picture could not be read');
    abandon(adapter);
  }

  /* ---------------------------------------------------------------- 5 -- */
  /* A FILE THAT IS NOT AN IMAGE REFUSES RATHER THAN BEING LABELLED ONE.
     The path arrives from the app's allowlist, which proves a person chose it,
     not that it is a picture. */
  {
    const { adapter, written } = recordingAdapter();
    const notAnImage = path.join(scratch, 'notes.txt');
    fs.writeFileSync(notAnImage, 'these are words, not pixels');
    await assert.rejects(
      adapter.sendTurn({ threadId: THREAD_ID, text: 'read this', images: [{ path: notAnImage }] }),
      error => typeof error.code === 'string' && error.code.startsWith('CLAUDE_CLI_IMAGE'),
      'a non-image file must refuse rather than ride as an image block'
    );
    assert.equal(written.length, 0, 'nothing may be written when the file is not an image');
    abandon(adapter);
  }

  process.stdout.write('Claude CLI pasted-image turn tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
