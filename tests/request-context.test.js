/*
 * Mutation check: changed getActiveRequest()'s `return marker.requestId;` to `return null;`.
 * The edit landed in src/lib/request-context.js and was verified before the isolated run.
 * This file went red (exit 1), proving its round-trip assertion guards that behavior.
 * The module was then restored and its original SHA-256 confirmed.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const requestContext = require('../src/lib/request-context');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'request-context-test-'));
const markerFile = path.join(scratch, 'nested', 'active-request.json');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

try {
  check('set, get, and clear round-trip an active request through the requested file', () => {
    const marker = requestContext.setActiveRequest('Q31.2', {
      file: markerFile,
      setBy: 'request context test',
      ttlMs: requestContext.MIN_TTL_MS
    });

    assert.deepEqual(marker, {
      version: requestContext.VERSION,
      requestId: 'Q31.2',
      setBy: 'request context test',
      setAtMs: marker.setAtMs,
      expiresAtMs: marker.setAtMs + requestContext.MIN_TTL_MS
    });
    assert.equal(Object.isFrozen(marker), true);
    assert.equal(requestContext.getActiveRequest({ file: markerFile }), 'Q31.2');
    assert.equal(JSON.parse(fs.readFileSync(markerFile, 'utf8')).requestId, 'Q31.2');

    /* CLEARING NOW NAMES WHO IS CLEARING, and the intent of this block -- write,
       read, clear -- is unchanged by that. Before 2026-08-27 clearActiveRequest
       took no owner at all and deleted whatever marker it found, so ANY caller
       could clear a marker another request had set. With agents running as a
       tree that is one lane silently cancelling another's outward context. */
    assert.equal(requestContext.clearActiveRequest('R-someone-else', { file: markerFile }), false,
      'a request that does not own the marker cleared it anyway');
    assert.equal(requestContext.getActiveRequest({ file: markerFile }), 'Q31.2',
      'and the owner lost its marker to a caller that did not set it');

    assert.equal(requestContext.clearActiveRequest({ file: markerFile }), false,
      'a caller naming no request at all cleared a marker somebody owns');
    assert.equal(requestContext.getActiveRequest({ file: markerFile }), 'Q31.2');

    assert.equal(requestContext.clearActiveRequest('Q31.2', { file: markerFile }), true,
      'the owner could not clear its own marker, which is the whole point of the verb');
    assert.equal(requestContext.getActiveRequest({ file: markerFile }), null);
    assert.doesNotThrow(() => requestContext.clearActiveRequest('Q31.2', { file: markerFile }),
      'clearing an already-absent marker stays a quiet no-op for the owner');
  });

  check('the environment override selects storage when no file option is supplied', () => {
    const envFile = path.join(scratch, 'from-env.json');
    const previous = process.env.TOOLSENABLED_ACTIVE_REQUEST_PATH;
    process.env.TOOLSENABLED_ACTIVE_REQUEST_PATH = envFile;
    try {
      requestContext.setActiveRequest('R7', { setBy: 'env', ttlMs: requestContext.MIN_TTL_MS });
      assert.equal(requestContext.getActiveRequest(), 'R7');
      requestContext.clearActiveRequest('R7');
      assert.equal(fs.existsSync(envFile), false);
    } finally {
      if (previous === undefined) delete process.env.TOOLSENABLED_ACTIVE_REQUEST_PATH;
      else process.env.TOOLSENABLED_ACTIVE_REQUEST_PATH = previous;
    }
  });

  check('expired markers are inactive and invalid persisted markers fail visibly', () => {
    fs.writeFileSync(markerFile, JSON.stringify({
      version: requestContext.VERSION,
      requestId: 'Q9',
      setBy: 'fixture',
      setAtMs: 1,
      expiresAtMs: 1
    }));
    assert.equal(requestContext.getActiveRequest({ file: markerFile }), null);

    fs.writeFileSync(markerFile, '{"version":1,"requestId":"bad id","expiresAtMs":2}');
    assert.throws(
      () => requestContext.getActiveRequest({ file: markerFile }),
      /Active request marker is invalid/
    );
  });

  check('invalid identifiers and TTLs are rejected without writing a marker', () => {
    fs.rmSync(markerFile, { force: true });
    assert.throws(
      () => requestContext.setActiveRequest('not allowed!', { file: markerFile }),
      /requestId must be a non-empty bounded identifier/
    );
    assert.throws(
      () => requestContext.setActiveRequest('Q31', { file: markerFile, ttlMs: requestContext.MIN_TTL_MS - 1 }),
      /ttlMs must be an integer between/
    );
    assert.throws(
      () => requestContext.setActiveRequest('Q31', { file: markerFile, setBy: 'not/allowed' }),
      /setBy is invalid/
    );
    assert.equal(fs.existsSync(markerFile), false);
  });

  console.log(`request-context: ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
