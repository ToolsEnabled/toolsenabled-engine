'use strict';

require('./lib/isolated-environment').activate('fra-secure-session-boundary');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fra = require('../src/lib/fra-secure-session');
const binding = require('../src/lib/fra-transport-binding');
const handles = require('../src/lib/providers/fra-workspace-handles');
const { fixture } = require('./helpers/fra-private-workspace-socket');
const mcp = require('../src/mcp-server');

const serviceRegistryOptions = { registry: {
  schemaVersion: 1,
  machines: {
    server: { address: '203.0.113.1' },
    client: { address: '203.0.113.2' }
  },
  services: {}
} };

function countedBytes() {
  let calls = 0;
  let seed = 0;
  const randomBytes = length => {
    calls += 1;
    const output = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) output[index] = (seed + index) & 0xff;
    seed += length;
    return output;
  };
  return { randomBytes, calls: () => calls, reset: () => { calls = 0; } };
}

function pair({ generation = 4, entropy = countedBytes() } = {}) {
  const masterKey = fra.deriveMasterKey('fra-boundary-test-secret-0123456789');
  const server = new fra.FraServerSessionManager({
    masterKey,
    serverHost: '203.0.113.1',
    clientHost: '203.0.113.2',
    generation,
    clock: () => 10_000,
    randomBytes: entropy.randomBytes,
    serviceRegistryOptions
  });
  const challenge = server.issueChallenge();
  const client = fra.beginClientHandshake({
    masterKey,
    challenge,
    serverHost: '203.0.113.1',
    clientHost: '203.0.113.2',
    clock: () => 10_000,
    randomBytes: entropy.randomBytes,
    serviceRegistryOptions
  });
  const accepted = server.acceptResponse(client.response);
  return { client: client.complete(accepted.authorization), server: accepted.session, entropy };
}

function actualFrameBytes(frame) {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

function independentFrameEstimate(frame) {
  // Keep the metadata order and empty encoded-value slots identical to the
  // wire serializer, then add the actual encoded value lengths. This is an
  // independent oracle for the preflight estimate, not an implementation call.
  const skeleton = { ...frame, nonce: '', ciphertext: '', tag: '' };
  return Buffer.byteLength(JSON.stringify(skeleton), 'utf8')
    + Buffer.byteLength(frame.nonce, 'utf8')
    + Buffer.byteLength(frame.ciphertext, 'utf8')
    + Buffer.byteLength(frame.tag, 'utf8');
}

function base64urlLength(byteLength) {
  const remainder = byteLength % 3;
  return Math.floor(byteLength / 3) * 4 + (remainder === 0 ? 0 : remainder + 1);
}

function syntheticFrame({ sessionId, generation, direction, sequence, plaintextBytes }) {
  return {
    type: 'fra.frame',
    version: fra.PROTOCOL_VERSION,
    sessionId,
    generation,
    direction,
    sequence,
    nonce: 'A'.repeat(base64urlLength(12)),
    ciphertext: 'A'.repeat(base64urlLength(plaintextBytes)),
    tag: 'A'.repeat(base64urlLength(16))
  };
}

function independentSerializedFrameBytes(metadata, plaintextBytes) {
  const skeleton = syntheticFrame({ ...metadata, plaintextBytes: 0 });
  skeleton.nonce = '';
  skeleton.ciphertext = '';
  skeleton.tag = '';
  return Buffer.byteLength(JSON.stringify(skeleton), 'utf8')
    + base64urlLength(12)
    + base64urlLength(plaintextBytes)
    + base64urlLength(16);
}

function independentUsablePlaintextMaximum(metadata) {
  let low = 0;
  let high = fra.MAX_PLAINTEXT_BYTES;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (independentSerializedFrameBytes(metadata, candidate) <= fra.MAX_FRAME_BYTES) low = candidate;
    else high = candidate - 1;
  }
  return low;
}

async function page(call, entry) {
  const response = await call('workspace.list', entry
    ? { directoryHandle: entry.handle, expectedVersion: entry.version, limit: 100 }
    : { limit: 100 });
  assert.notEqual(response.result?.isError, true, JSON.stringify(response));
  assert.ok(response.result?.structuredContent?.entries);
  return response.result.structuredContent;
}

function assertReadProjection(response, expected, filename) {
  assert.notEqual(response.result?.isError, true, JSON.stringify(response));
  const structured = response.result.structuredContent;
  assert.equal(structured.content, expected);
  assert.equal(structured.bytes, Buffer.byteLength(expected, 'utf8'));
  const text = response.result.content?.[0]?.text;
  assert.equal(typeof text, 'string');
  assert.equal(text.includes(expected), false, 'content text must not duplicate file bytes');
  assert.equal(text.includes(filename), false, 'content text must not disclose a path/name');
  assert.match(text, /fileHandle/);
}

const CANONICAL_BOUND_BYTES = 1024 * 1024;
const MAX_PROJECTED_STRING_BYTES = 768 * 1024;
const CANONICAL_BOUND_NUL_PREFIX = 100000;

function independentlySorted(value) {
  if (Array.isArray(value)) return value.map(independentlySorted);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = independentlySorted(value[key]);
    return output;
  }
  return value;
}

function independentCanonicalBytes(value) {
  return Buffer.byteLength(JSON.stringify(independentlySorted(value)), 'utf8');
}

function canonicalDigestValueAt(targetBytes) {
  const nulCount = Math.floor((targetBytes - 2) / 6);
  const asciiCount = targetBytes - 2 - (nulCount * 6);
  const value = '\0'.repeat(nulCount) + 'x'.repeat(asciiCount);
  assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8'), targetBytes);
  assert.ok(Buffer.byteLength(value, 'utf8') < MAX_PROJECTED_STRING_BYTES);
  return value;
}

function canonicalBoundCase(paddingLength) {
  const request = {
    jsonrpc: '2.0',
    id: 17,
    method: 'tools/call',
    params: { name: 'workspace.read', arguments: {} }
  };
  const content = '\0'.repeat(CANONICAL_BOUND_NUL_PREFIX) + 'x'.repeat(paddingLength);
  const contentBytes = Buffer.byteLength(content, 'utf8');
  const response = {
    jsonrpc: '2.0',
    id: 17,
    result: {
      content: [],
      structuredContent: {
        fileHandle: 'B'.repeat(43),
        version: 'a'.repeat(64),
        offset: 0,
        bytes: contentBytes,
        totalBytes: contentBytes,
        fileSha256: 'b'.repeat(64),
        contentSha256: 'c'.repeat(64),
        encoding: 'utf8',
        content,
        eof: true
      }
    }
  };
  const projected = binding.projectMcpResponse(request, response, ['workspace.read']);
  const requestEnvelope = {
    message: request,
    contextDigest: 'd'.repeat(64),
    requestDigest: 'e'.repeat(64)
  };
  const completed = {
    type: binding.RESPONSE_TYPE,
    version: binding.SCHEMA_VERSION,
    contextDigest: requestEnvelope.contextDigest,
    requestDigest: requestEnvelope.requestDigest,
    response: projected,
    responseDigest: '0'.repeat(64)
  };
  return { requestEnvelope, response, completed, bytes: independentCanonicalBytes(completed) };
}

function canonicalBoundCaseAt(targetBytes) {
  let low = 0;
  let high = MAX_PROJECTED_STRING_BYTES - CANONICAL_BOUND_NUL_PREFIX;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = canonicalBoundCase(middle);
    if (candidate.bytes < targetBytes) low = middle + 1;
    else high = middle - 1;
  }
  const candidate = canonicalBoundCase(low);
  assert.equal(candidate.bytes, targetBytes, `no exact canonical fixture for ${targetBytes} bytes`);
  return candidate;
}

test('binding wire patterns stay equal to the broker contract', () => {
  assert.equal(binding.WORKSPACE_HANDLE_RE.source, handles.HANDLE_RE.source);
  assert.equal(binding.WORKSPACE_VERSION_RE.source, handles.VERSION_RE.source);
});

test('FRA frame cap matches actual encrypted JSON across generation and sequence widths', () => {
  const selectedSequences = [0, 9, 10, 99, 100];
  for (const generation of selectedSequences) {
    for (const sequence of selectedSequences) {
      const setup = pair({ generation });
      for (let current = 0; current < sequence; current += 1) {
        assert.equal(setup.client.seal('advance').sequence, current);
        assert.equal(setup.server.seal('advance').sequence, current);
      }
      // Keep both directions at the same metadata width; each has a distinct
      // session direction and independently computed usable cap.
      const clientCap = setup.client.usablePlaintextMaximum;
      const serverCap = setup.server.usablePlaintextMaximum;
      assert.equal(clientCap, fra.effectiveUsablePlaintextMaximum({
        sessionId: setup.client.sessionId,
        generation,
        direction: 'client-to-server',
        sequence
      }));
      assert.equal(serverCap, fra.effectiveUsablePlaintextMaximum({
        sessionId: setup.server.sessionId,
        generation,
        direction: 'server-to-client',
        sequence
      }));
      const clientFrame = setup.client.seal('c'.repeat(clientCap));
      const serverFrame = setup.server.seal('s'.repeat(serverCap));
      assert.equal(clientFrame.sequence, sequence);
      assert.equal(serverFrame.sequence, sequence);
      assert.ok(actualFrameBytes(clientFrame) <= fra.MAX_FRAME_BYTES);
      assert.ok(actualFrameBytes(serverFrame) <= fra.MAX_FRAME_BYTES);
      assert.equal(independentFrameEstimate(clientFrame), actualFrameBytes(clientFrame));
      assert.equal(independentFrameEstimate(serverFrame), actualFrameBytes(serverFrame));
      assert.throws(() => setup.client.seal('c'.repeat(clientCap + 1)),
        error => error?.code === 'FRA_MESSAGE_TOO_LARGE');
      assert.throws(() => setup.server.seal('s'.repeat(serverCap + 1)),
        error => error?.code === 'FRA_MESSAGE_TOO_LARGE');
      assert.equal(setup.client.seal('next').sequence, sequence + 1);
      assert.equal(setup.server.seal('next').sequence, sequence + 1);
      setup.client.close();
      setup.server.close();
    }
  }
});

test('FRA arithmetic estimator covers every metadata digit width without advancing sequence', () => {
  const widths = [0];
  for (let power = 1; power <= 15; power += 1) {
    widths.push(10 ** (power - 1), (10 ** power) - 1);
  }
  widths.push(Number.MAX_SAFE_INTEGER);
  const sessionId = 'A'.repeat(22);
  for (const generation of widths) {
    for (const sequence of widths) {
      for (const direction of ['client-to-server', 'server-to-client']) {
        const metadata = { sessionId, generation, direction, sequence };
        const synthetic = syntheticFrame({ ...metadata, plaintextBytes: 1 });
        assert.equal(
          independentSerializedFrameBytes(metadata, 1),
          actualFrameBytes(synthetic),
          `synthetic frame arithmetic at generation ${generation}, sequence ${sequence}, ${direction}`
        );
        const expected = independentUsablePlaintextMaximum(metadata);
        const actual = fra.effectiveUsablePlaintextMaximum(metadata);
        assert.equal(actual, expected,
          `usable cap at generation ${generation}, sequence ${sequence}, ${direction}`);
        assert.ok(independentSerializedFrameBytes(metadata, actual) <= fra.MAX_FRAME_BYTES);
        assert.ok(independentSerializedFrameBytes(metadata, actual + 1) > fra.MAX_FRAME_BYTES);
      }
    }
  }
});

test('empty and over-maximum plaintext refusals leave both sessions usable', () => {
  const setup = pair();
  for (const session of [setup.client, setup.server]) {
    assert.throws(() => session.seal(''), error => error?.code === 'FRA_MESSAGE_TOO_LARGE');
    assert.throws(() => session.seal('x'.repeat(fra.MAX_PLAINTEXT_BYTES + 1)),
      error => error?.code === 'FRA_MESSAGE_TOO_LARGE');
    assert.equal(session.closed, false);
    assert.equal(session.seal('after-control').sequence, 0);
  }
  setup.client.close();
  setup.server.close();
});

test('effective usable plaintext bound refuses before entropy and preserves sequence', () => {
  const entropy = countedBytes();
  const setup = pair({ entropy });
  entropy.reset();
  const metadata = {
    sessionId: setup.client.sessionId,
    generation: setup.client.generation,
    direction: 'client-to-server',
    sequence: 0
  };
  const maximum = fra.effectiveUsablePlaintextMaximum(metadata);
  assert.ok(maximum > 0);
  assert.ok(maximum < fra.MAX_PLAINTEXT_BYTES);
  const accepted = setup.client.seal('a'.repeat(maximum));
  assert.equal(accepted.sequence, 0);
  assert.throws(() => setup.client.seal('a'.repeat(maximum + 1)), error => error?.code === 'FRA_MESSAGE_TOO_LARGE');
  assert.equal(setup.client.closed, false, 'outbound size refusal keeps the session open');
  assert.equal(entropy.calls(), 1, 'oversize preflight does not consume a nonce');
  const next = setup.client.seal('next');
  assert.equal(next.sequence, 1, 'oversize preflight does not consume a sequence');
  setup.client.close();
  setup.server.close();
});

test('workspace.read preserves 130850 quote-heavy bytes once and keeps the session usable', async t => {
  const filename = 'quote-heavy.txt';
  const content = '"'.repeat(130850);
  const f = await fixture(t, { [filename]: content });
  const call = await f.connect();
  const top = await page(call);
  const entry = top.entries.find(value => value.name === filename);
  assert.ok(entry?.handle);
  const response = await call('workspace.read', { fileHandle: entry.handle, expectedVersion: entry.version });
  assertReadProjection(response, content, filename);
  await page(call);
});

test('workspace.read preserves a default 262144 all-quote read and keeps the session usable', async t => {
  const filename = 'all-quotes.txt';
  const content = '"'.repeat(262144);
  const f = await fixture(t, { [filename]: content });
  const call = await f.connect();
  const top = await page(call);
  const entry = top.entries.find(value => value.name === filename);
  assert.ok(entry?.handle);
  const response = await call('workspace.read', { fileHandle: entry.handle, expectedVersion: entry.version });
  assertReadProjection(response, content, filename);
  await page(call);
});

test('oversize authenticated workspace responses are bounded refusals, not socket retirement', async t => {
  const canonicalOverflow = '\0'.repeat(262144);
  const frameOverflow = '\u0001'.repeat(132000);
  const safeFilename = 'safe-follow-up.txt';
  const safeContent = 'safe';
  const f = await fixture(t, {
    'canonical-overflow.txt': canonicalOverflow,
    'frame-overflow.txt': frameOverflow,
    [safeFilename]: safeContent
  });
  const call = await f.connect();
  const top = await page(call);
  const safeEntry = top.entries.find(value => value.name === safeFilename);
  assert.ok(safeEntry?.handle);
  for (const [filename, code] of [
    ['canonical-overflow.txt', 'FRA_RESULT_PROJECTION_TOO_LARGE'],
    ['frame-overflow.txt', 'FRA_RESULT_PROJECTION_TOO_LARGE']
  ]) {
    const entry = top.entries.find(value => value.name === filename);
    assert.ok(entry?.handle);
    const response = await call('workspace.read', { fileHandle: entry.handle, expectedVersion: entry.version });
    assert.equal(response.result?.isError, true, filename);
    assert.equal(response.result?.structuredContent?.error?.code, code, filename);
    assert.equal(response.result?.structuredContent?.error?.message,
      'FRA response exceeds the authenticated size bound; request a smaller range.', filename);
    const followUp = await call('workspace.read', {
      fileHandle: safeEntry.handle,
      expectedVersion: safeEntry.version
    });
    assertReadProjection(followUp, safeContent, safeFilename);
  }
});

test('canonical-size defense remains a distinct binding error', () => {
  assert.doesNotThrow(() => binding.digest(
    'ToolsEnabled/FRA/boundary-test/v1', '\0'.repeat(160000)
  ));
  assert.throws(
    () => binding.digest('ToolsEnabled/FRA/boundary-test/v1', '\0'.repeat(200000)),
    error => error?.code === 'FRA_CANONICAL_VALUE_TOO_LARGE'
  );
  for (const targetBytes of [CANONICAL_BOUND_BYTES - 1, CANONICAL_BOUND_BYTES, CANONICAL_BOUND_BYTES + 1]) {
    const value = canonicalDigestValueAt(targetBytes);
    if (targetBytes < CANONICAL_BOUND_BYTES) {
      assert.doesNotThrow(() => binding.digest('ToolsEnabled/FRA/exact-canonical-bound/v1', value));
    } else if (targetBytes === CANONICAL_BOUND_BYTES) {
      assert.doesNotThrow(() => binding.digest('ToolsEnabled/FRA/exact-canonical-bound/v1', value));
    } else {
      assert.throws(
        () => binding.digest('ToolsEnabled/FRA/exact-canonical-bound/v1', value),
        error => error?.code === 'FRA_CANONICAL_VALUE_TOO_LARGE'
      );
    }
  }
});

test('canonical serialized bound accepts exact maximum and rejects one byte over', () => {
  const allowedTools = ['workspace.read'];
  for (const targetBytes of [CANONICAL_BOUND_BYTES - 1, CANONICAL_BOUND_BYTES, CANONICAL_BOUND_BYTES + 1]) {
    const candidate = canonicalBoundCaseAt(targetBytes);
    const create = () => binding.createBoundResponse({
      requestEnvelope: candidate.requestEnvelope,
      response: candidate.response,
      allowedTools
    });
    if (targetBytes <= CANONICAL_BOUND_BYTES) {
      const bound = create();
      assert.equal(
        independentCanonicalBytes({ ...bound, responseDigest: '0'.repeat(64) }),
        targetBytes
      );
    } else {
      assert.throws(create, error => error?.code === 'FRA_RESULT_PROJECTION_TOO_LARGE');
    }
  }
});

test('malformed workspace results remain fail-closed, not bounded refusals', () => {
  const validRead = {
    fileHandle: 'B'.repeat(43),
    version: binding.digest('test/version', 'valid'),
    offset: 0,
    bytes: 4,
    totalBytes: 4,
    fileSha256: binding.digest('test/file', 'data'),
    contentSha256: binding.digest('test/content', 'data'),
    encoding: 'utf8',
    content: 'data',
    eof: true
  };
  const readRequest = {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'workspace.read', arguments: {} }
  };
  const malformedReads = [
    { ...validRead, fileHandle: '/home/example/file' },
    { ...validRead, version: 'not-a-version' },
    Object.fromEntries(Object.entries(validRead).filter(([key]) => key !== 'content'))
  ];
  for (const structuredContent of malformedReads) {
    assert.throws(() => binding.projectMcpResponse(readRequest, {
      jsonrpc: '2.0', id: 3,
      result: { content: [], structuredContent }
    }, ['workspace.read']), error => error?.code === 'FRA_RESULT_PROJECTION_INVALID');
  }

  const listRequest = {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'workspace.list', arguments: {} }
  };
  assert.throws(() => binding.projectMcpResponse(listRequest, {
    jsonrpc: '2.0', id: 4,
    result: {
      content: [],
      structuredContent: {
        directoryHandle: 'D'.repeat(43),
        version: binding.digest('test/version', 'directory'),
        entries: [],
        nextCursor: '/tmp/not-an-opaque-cursor',
        complete: false
      }
    }
  }, ['workspace.list']), error => error?.code === 'FRA_RESULT_PROJECTION_INVALID');
});

test('inbound oversized frames still close the receiving session', () => {
  const setup = pair();
  const oversized = {
    type: 'fra.frame',
    version: fra.PROTOCOL_VERSION,
    sessionId: setup.client.sessionId,
    generation: setup.client.generation,
    direction: 'client-to-server',
    sequence: 0,
    nonce: 'A'.repeat(fra.MAX_FRAME_BYTES),
    ciphertext: '',
    tag: ''
  };
  assert.throws(() => setup.server.open(oversized), error => error?.code === 'FRA_MESSAGE_TOO_LARGE');
  assert.equal(setup.server.closed, true);
  setup.client.close();
});

test('authenticated malformed dispatch response closes the FRA socket', async t => {
  const f = await fixture(t, { 'malformed.txt': 'data' });
  const call = await f.connect();
  const prior = mcp.processLine;
  mcp.processLine = async (line, respond) => {
    const request = JSON.parse(line);
    respond({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [], structuredContent: { fileHandle: '/home/example/file' } }
    });
  };
  try {
    await assert.rejects(
      call('workspace.read', {
        fileHandle: 'B'.repeat(43),
        expectedVersion: binding.digest('test/version', 'malformed')
      }),
      error => error?.message === 'FRA fixture socket closed'
    );
  } finally {
    mcp.processLine = prior;
  }
});

test('authenticated dispatch authority failure closes the FRA socket', async t => {
  const f = await fixture(t, { 'authority.txt': 'data' });
  const call = await f.connect();
  const prior = mcp.processLine;
  mcp.processLine = async () => {
    throw Object.assign(new Error('synthetic authority refusal'), {
      code: 'FRA_AUTHORITY_TEST_FAILURE'
    });
  };
  try {
    await assert.rejects(
      call('workspace.list', { limit: 100 }),
      error => error?.message === 'FRA fixture socket closed'
    );
  } finally {
    mcp.processLine = prior;
  }
});

test('authenticated canonical defense refusal retains the session', async t => {
  const filename = 'canonical-defense.txt';
  const content = 'data';
  const f = await fixture(t, { [filename]: content });
  const call = await f.connect();
  const top = await page(call);
  const entry = top.entries.find(value => value.name === filename);
  assert.ok(entry?.handle);
  const prior = mcp.processLine;
  mcp.processLine = async (line, respond) => {
    const request = JSON.parse(line);
    const result = { content: [] };
    Object.defineProperty(result, 'structuredContent', {
      enumerable: true,
      get() {
        throw Object.assign(new Error('fault-injected canonical overflow'), {
          code: 'FRA_CANONICAL_VALUE_TOO_LARGE'
        });
      }
    });
    respond({ jsonrpc: '2.0', id: request.id, result });
  };
  try {
    const refusal = await call('workspace.read', {
      fileHandle: entry.handle,
      expectedVersion: entry.version
    });
    assert.equal(refusal.result?.isError, true);
    assert.equal(refusal.result?.structuredContent?.error?.code,
      'FRA_CANONICAL_VALUE_TOO_LARGE');
    assert.equal(refusal.result?.structuredContent?.error?.message,
      'FRA response exceeds the authenticated size bound; request a smaller range.');
  } finally {
    mcp.processLine = prior;
  }
  const response = await call('workspace.read', {
    fileHandle: entry.handle,
    expectedVersion: entry.version
  });
  assertReadProjection(response, content, filename);
});

test('authenticated FRA_MESSAGE_TOO_LARGE fault injection refuses without retiring the session', async t => {
  const filename = 'message-size-defense.txt';
  const content = 'data';
  const f = await fixture(t, { [filename]: content });
  const call = await f.connect();
  const top = await page(call);
  const entry = top.entries.find(value => value.name === filename);
  assert.ok(entry?.handle);
  const prior = mcp.processLine;
  mcp.processLine = async (line, respond) => {
    const request = JSON.parse(line);
    const result = { content: [] };
    Object.defineProperty(result, 'structuredContent', {
      enumerable: true,
      get() {
        throw Object.assign(new Error('fault-injected message overflow'), {
          code: 'FRA_MESSAGE_TOO_LARGE'
        });
      }
    });
    respond({ jsonrpc: '2.0', id: request.id, result });
  };
  try {
    const refusal = await call('workspace.read', {
      fileHandle: entry.handle,
      expectedVersion: entry.version
    });
    assert.equal(refusal.result?.isError, true);
    assert.equal(refusal.result?.structuredContent?.error?.code,
      'FRA_MESSAGE_TOO_LARGE');
    assert.equal(refusal.result?.structuredContent?.error?.message,
      'FRA response exceeds the authenticated size bound; request a smaller range.');
  } finally {
    mcp.processLine = prior;
  }
  const response = await call('workspace.read', {
    fileHandle: entry.handle,
    expectedVersion: entry.version
  });
  assertReadProjection(response, content, filename);
});

test('non-workspace bound projection retains its existing text representation', () => {
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'unrelated.tool', arguments: {} } };
  const structuredContent = { answer: 'unchanged', nested: { value: 7 } };
  const projected = binding.projectMcpResponse(request, {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'ignored by the bound projector' }], structuredContent }
  }, ['unrelated.tool']);
  assert.equal(projected.result.content[0].text, JSON.stringify(structuredContent));
  assert.deepEqual(projected.result.structuredContent, structuredContent);
});

test('projector v1 peers are refused by the binding digest', () => {
  const allowedTools = ['workspace.list', 'workspace.read'];
  const oldPeerDigest = binding.digest('ToolsEnabled/FRA/result-projectors/v1', {
    projectorVersion: 'fra.closed-mcp-result-projector.v1',
    tools: allowedTools.map(name => ({
      name,
      projector: `closed-${name}-result.v1`
    }))
  });
  const profile = {
    schemaVersion: 5,
    registryNameDigest: binding.digest('test/registry', 'boundary'),
    allowedToolNamesDigest: crypto.createHash('sha256').update(allowedTools.join('\n'), 'utf8').digest('hex'),
    allowedToolCount: allowedTools.length,
    allowedTools,
    excludedTools: ['host.exec'],
    desktopCapabilities: { clipboard: false, ocr: false, screenCapture: false },
    transportPolicy: binding.TRANSPORT_POLICY_DESCRIPTOR
  };
  const session = { sessionId: 'A'.repeat(22), generation: 4 };
  const rootIdentity = { valid: true, rootIdentityDigest: 'a'.repeat(64) };
  const rootAccessReport = {
    schemaVersion: 1,
    valid: true,
    policyDigest: 'b'.repeat(64),
    descriptorDigest: 'c'.repeat(64),
    secretValuesEmitted: false
  };
  const bindingValue = binding.createServerBinding({
    session,
    serverHost: '203.0.113.1',
    clientHost: '203.0.113.2',
    serviceRegistryOptions,
    capabilityProfile: profile,
    runtimeDigest: 'd'.repeat(64),
    policyDigest: 'e'.repeat(64),
    rootIdentity,
    rootAccessReport
  });
  assert.notEqual(binding.projectorSetDigest(allowedTools), oldPeerDigest);
  assert.throws(() => binding.validateServerBinding({
    ...bindingValue,
    resultProjectorDigest: oldPeerDigest
  }, {
    session,
    serverHost: '203.0.113.1',
    clientHost: '203.0.113.2',
    serviceRegistryOptions,
    capabilityProfile: profile,
    runtimeDigest: 'd'.repeat(64),
    policyDigest: 'e'.repeat(64),
    rootAccessPolicyDigest: rootAccessReport.policyDigest
  }), error => error?.code === 'FRA_BINDING_MISMATCH');
});
