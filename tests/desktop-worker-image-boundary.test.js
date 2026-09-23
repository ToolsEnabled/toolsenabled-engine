'use strict';
/* screen.read_capture RETURNED NO PICTURE, AND SAID NOTHING ABOUT IT.
 *
 * readCapture() attaches its PNG as a NON-ENUMERABLE property
 * (`Object.defineProperty(output, '__mcpImage', { enumerable: false, ... })`)
 * on purpose: mcp-server.js's `structured()` copies only enumerable fields, so
 * the pixels can never reach `structuredContent` or ordinary JSON logging by
 * accident. That worked while the call ran on the main thread. Since 46189b9b
 * ("Keep tool metering and desktop capture off the main thread") every
 * screen.read_capture goes through `runDesktopAsync` -> a worker_threads
 * worker -> `postMessage`, and the structured-clone algorithm postMessage uses
 * does not carry non-enumerable properties. By the time
 * `mcp-server.js#toolResult()` asks `Buffer.isBuffer(output.__mcpImage)` the
 * property is gone, so the image content block is never appended: the call
 * SUCCEEDS, returns correct metadata, and simply has no picture in it. No
 * error, anywhere.
 *
 * The first test below verifies that diagnosis independently rather than
 * taking it on trust -- it drives a REAL worker and a REAL postMessage and
 * shows the property being dropped, with a positive control proving the probe
 * attached it in the first place and that the ordinary fields did cross. If
 * that test ever passes for the wrong reason, the rest of this file is
 * meaningless.
 *
 * The fix does not try to make a non-enumerable property survive a clone.
 * The worker hands the bytes back as an ORDINARY named field, and the client
 * side of the boundary converts it back to the same non-enumerable Buffer and
 * EXPLICITLY strips the named field. So the protection the original design
 * bought is preserved by a deliberate delete rather than by a JavaScript
 * visibility flag that a structured clone does not respect -- and everything
 * downstream (toolResult, structured, every other runDesktopAsync caller) is
 * unchanged and still sees exactly what it saw before 46189b9b.
 *
 *   node tests\run-isolated.js tests/desktop-worker-image-boundary.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

const DESKTOP_MODULE = require.resolve('../src/lib/desktop.js');
const desktop = require('../src/lib/desktop.js');

// A PNG signature followed by distinguishable bytes: real enough to assert on,
// small enough to inline. Never a real screenshot -- these tests must not
// depend on a desktop session being present.
const PIXELS = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44]);
const PIXELS_BASE64 = PIXELS.toString('base64');

function firstMessage(worker) {
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`probe worker exited before answering (${code})`)));
  });
}

/* createDesktopWorkerClient takes WorkerImpl and workerFile as injection
   points. Passing the REAL node:worker_threads.Worker through this subclass
   (which only adds eval:true) means the boundary under test is the real one --
   a real thread, a real postMessage, a real structured clone -- while
   workerFile carries a source string instead of a file path. */
class EvalWorker extends Worker {
  constructor(source, options) {
    super(source, { ...options, eval: true });
  }
}

/* The worker requires the SHIPPED src/lib/desktop.js, which registers the
   shipped `parentPort.on('message')` handler, and then replaces only
   readCapture's body -- the part that shells out to PowerShell for a real
   screenshot. Everything the boundary does is the shipped code, on both sides:
   the handler still resolves `module.exports[message.operation]` at call time,
   still posts the result the shipped way, and the client still receives it the
   shipped way. */
const WORKER_WITH_SHIPPED_HANDLER = `
  const desktop = require(${JSON.stringify(DESKTOP_MODULE)});
  desktop.readCapture = () => {
    const output = {
      path: 'thumb.png', width: 4, height: 4, bytes: ${PIXELS.length},
      mimeType: 'image/png', thumbnail: true, contentTrust: 'untrusted', grantsAuthority: false
    };
    Object.defineProperty(output, '__mcpImage', {
      value: Buffer.from(${JSON.stringify(PIXELS_BASE64)}, 'base64'),
      enumerable: false, configurable: false, writable: false
    });
    return output;
  };
`;

test('a non-enumerable property does not survive the real worker_threads boundary', async () => {
  /* The diagnosis this whole fix rests on, checked rather than assumed, at the
     real boundary. Two positive controls sit alongside the finding so a broken
     probe cannot masquerade as a confirmation. */
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const payload = { path: 'thumb.png', width: 4 };
    Object.defineProperty(payload, '__mcpImage', {
      value: Buffer.from([1, 2, 3]), enumerable: false, configurable: false, writable: false
    });
    parentPort.postMessage({
      attachedInsideTheWorker: Buffer.isBuffer(payload.__mcpImage),
      payload
    });
  `, { eval: true, execArgv: [] });

  try {
    const received = await firstMessage(worker);
    assert.equal(received.attachedInsideTheWorker, true,
      'positive control failed: the probe never attached the property, so its absence on this side proves nothing');
    assert.equal(received.payload.width, 4,
      'positive control failed: ordinary fields did not cross either, so the clone is not what dropped the attachment');
    assert.equal(received.payload.__mcpImage, undefined,
      'a non-enumerable property DID survive structured clone -- the diagnosis behind this fix is wrong and the fix should be reconsidered');
  } finally {
    await worker.terminate();
  }
});

test('screen.read_capture keeps its image across the worker boundary', async () => {
  const client = desktop.createDesktopWorkerClient({
    WorkerImpl: EvalWorker,
    workerFile: WORKER_WITH_SHIPPED_HANDLER
  });
  try {
    const result = await client.run('readCapture', {});

    assert.ok(Buffer.isBuffer(result.__mcpImage),
      'the image did not survive the boundary, so screen.read_capture returns metadata with no picture');
    assert.ok(result.__mcpImage.equals(PIXELS),
      'the bytes that crossed are not the bytes the capture produced');

    // The metadata still arrives intact; the fix must not have traded one for
    // the other.
    assert.equal(result.width, 4);
    assert.equal(result.mimeType, 'image/png');

    // mcp-server.js#toolResult() is what turns this into an MCP image block.
    // Its exact check, run here against the real post-boundary object.
    assert.equal(Buffer.isBuffer(result.__mcpImage) && result.__mcpImage.length >= 1
      && result.__mcpImage.length <= 1024 * 1024, true,
      'toolResult would still refuse to append the image content block');
  } finally {
    await client.close();
  }
});

test('the pixels stay out of structuredContent and out of ordinary JSON', async () => {
  /* The property being non-enumerable was never decoration: mcp-server.js's
     `structured()` is literally `Object.fromEntries(Object.entries(value))`,
     so anything enumerable on this object is published to every MCP client and
     written into ordinary logs. Carrying the bytes across as a named field is
     only safe if that field is gone again before anyone sees the result. */
  const client = desktop.createDesktopWorkerClient({
    WorkerImpl: EvalWorker,
    workerFile: WORKER_WITH_SHIPPED_HANDLER
  });
  try {
    const result = await client.run('readCapture', {});

    assert.equal(Object.keys(result).includes('__mcpImage'), false,
      'the image became an enumerable property and will now be published in structuredContent');

    const structuredContent = Object.fromEntries(Object.entries(result));
    const published = JSON.stringify(structuredContent);
    assert.equal(published.includes(PIXELS_BASE64), false,
      'the transport field carrying the pixels was left on the result and is now published to every MCP client');
    assert.equal(Object.hasOwn(structuredContent, '__mcpImage'), false);

    // JSON.stringify is also what toolResult puts in the text content block.
    assert.equal(JSON.stringify(result).includes(PIXELS_BASE64), false,
      'the pixels are now inlined in the text content block of every capture read');
  } finally {
    await client.close();
  }
});

test('an unusable image attachment is refused by name, not silently dropped', async () => {
  /* A silent drop is the exact defect this file exists to fix. If the bytes
     that cross the boundary are not usable, the caller is told so with a code
     rather than handed a successful result with no picture in it. */
  const client = desktop.createDesktopWorkerClient({
    WorkerImpl: EvalWorker,
    workerFile: `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', message => {
        parentPort.postMessage({ id: message.id, result: { path: 'thumb.png', __mcpImageBase64: 12345 } });
      });
    `
  });
  try {
    await assert.rejects(
      () => client.run('readCapture', {}),
      error => {
        assert.equal(error.code, 'DESKTOP_WORKER_IMAGE_INVALID');
        return true;
      },
      'an unusable attachment resolved successfully with no image, which is the original defect wearing a new shape');
  } finally {
    await client.close();
  }
});
