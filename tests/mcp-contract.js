'use strict';

// The stdio server's header promises one contract-driven path for MCP metadata,
// validation, policy/audit-aware dispatch, and JSON-RPC replies. These checks
// exercise that public boundary; they do not call registry handlers directly.

require('./lib/isolated-environment').activate('mcp-contract');

const assert = require('node:assert/strict');
const mcp = require('../src/mcp-server');
const registry = require('../src/lib/tool-registry');

const permissionSession = Object.freeze({ origin: 'local', tier: 'full' });
let checks = 0;

function checkEqual(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function checkDeepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

function checkOk(value, message) {
  assert.ok(value, message);
  checks += 1;
}

async function checkRejects(block, predicate, message) {
  await assert.rejects(block, predicate, message);
  checks += 1;
}

async function main() {
  const view = { permissionSession };
  const listed = await mcp.dispatch({
    jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {}
  }, view);
  const canonical = registry.listTools(view);
  checkOk(Array.isArray(listed.tools) && listed.tools.length > 0,
    'metadata contract: tools/list must return a non-empty tool array');
  checkDeepEqual(listed.tools, canonical,
    'metadata contract: MCP discovery must be the registry public view byte-for-byte');
  checkOk(listed.tools.every(tool => Object.keys(tool).sort().join(',') === 'annotations,description,inputSchema,name'),
    'metadata contract: MCP discovery must expose only public tool metadata');
  checkOk(listed.tools.every(tool => !Object.hasOwn(tool, 'handler') && !Object.hasOwn(tool, 'effect')),
    'metadata contract: MCP discovery must not expose handlers or internal policy fields');

  const negotiated = await mcp.dispatch({
    jsonrpc: '2.0', id: 'init-1', method: 'initialize',
    params: { protocolVersion: '2025-06-18' }
  }, view);
  checkEqual(negotiated.protocolVersion, '2025-06-18',
    'protocol contract: a supported requested version must be preserved');
  checkDeepEqual(negotiated.capabilities, { tools: { listChanged: false } },
    'protocol contract: the server advertises the stable registry capability');
  checkEqual(negotiated.serverInfo.name, 'toolsenabled',
    'protocol contract: initialize identifies this server');
  const fallback = await mcp.dispatch({
    jsonrpc: '2.0', id: 'init-2', method: 'initialize',
    params: { protocolVersion: '1900-01-01' }
  }, view);
  checkEqual(fallback.protocolVersion, mcp.SUPPORTED_PROTOCOLS[0],
    'protocol contract: an unsupported request falls back to the preferred supported version');

  const noArgTool = 'system.kill_switch_status';
  checkOk(listed.tools.some(tool => tool.name === noArgTool),
    'dispatch precondition: the harmless status tool must be advertised');
  const invalidCall = {
    jsonrpc: '2.0', id: 'call-invalid', method: 'tools/call',
    params: { name: noArgTool, arguments: { unexpected: true } }
  };
  // Registry validation names the caller's actual field, not an invented
  // $.arguments wrapper. Invalid input still throws RpcError and is serialized
  // as a JSON-RPC error, never accepted as a successful tool result.
  const invalidError = {
    code: -32602,
    message: 'Invalid input: unexpected: additional property is not allowed',
    data: [{ path: 'unexpected', keyword: 'additionalProperties', message: 'additional property is not allowed' }]
  };
  const killSwitch = require('../src/lib/kill-switch');
  const originalStatus = killSwitch.status;
  let invalidHandlerCalls = 0;
  killSwitch.status = () => { invalidHandlerCalls += 1; throw new Error('invalid arguments reached the handler'); };
  try {
    await checkRejects(
      () => mcp.dispatch(invalidCall, view),
      error => {
        checkOk(error instanceof mcp.RpcError, 'invalid tool input must remain a protocol error');
        checkEqual(error.code, invalidError.code, 'invalid tool input must retain the invalid-params code');
        checkEqual(error.message, invalidError.message, 'validation must name the actual caller field');
        checkDeepEqual(error.data, invalidError.data, 'the structured validation path must match the caller field');
        return true;
      },
      'validation contract: schema-invalid arguments must be refused before dispatch'
    );
    const rejected = [];
    await mcp.processLine(JSON.stringify(invalidCall), value => rejected.push(value), view);
    checkDeepEqual(rejected, [{ jsonrpc: '2.0', id: 'call-invalid', error: invalidError }],
      'the wire response must carry the same invalid-params error, not a tool success');
    checkEqual(invalidHandlerCalls, 0, 'neither invalid-call path may invoke the real tool handler');
  } finally {
    killSwitch.status = originalStatus;
  }
  await checkRejects(
    () => mcp.dispatch({
      jsonrpc: '2.0', id: 'call-unknown', method: 'tools/call',
      params: { name: 'phantom.mcp_tool', arguments: {} }
    }, view),
    error => error instanceof mcp.RpcError && error.code === -32602 && /unknown.*tool/i.test(error.message),
    'validation contract: an unknown registry name must be rejected before dispatch'
  );
  const called = await mcp.dispatch({
    jsonrpc: '2.0', id: 'call-ok', method: 'tools/call',
    params: { name: noArgTool }
  }, view);
  checkEqual(called.isError, undefined,
    'dispatch contract: a successful registry call must not be marked as an error');
  checkEqual(called.content.length, 1,
    'dispatch contract: a normal registry result must have one MCP text block');
  checkEqual(called.content[0].type, 'text',
    'dispatch contract: a normal registry result must be represented as text');
  checkDeepEqual(JSON.parse(called.content[0].text), called.structuredContent,
    'dispatch contract: text and structured results must describe the same handler value');

  const writes = [];
  await mcp.processLine('{not-json', value => writes.push(value), view);
  checkEqual(writes.length, 1,
    'JSON-RPC contract: malformed JSON must produce exactly one response');
  checkEqual(writes[0].error.code, -32700,
    'JSON-RPC contract: malformed JSON must be a parse error');
  checkEqual(writes[0].id, null,
    'JSON-RPC contract: a parse error cannot claim a request id');
  writes.length = 0;
  const notification = {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {}
  };
  checkEqual(await mcp.dispatch(notification, view), undefined,
    'JSON-RPC contract: an initialized notification must be acknowledged without a result');
  await mcp.processLine(JSON.stringify(notification), value => writes.push(value), view);
  checkEqual(writes.length, 0,
    'JSON-RPC contract: a notification must never receive a response');

  process.stdout.write(`mcp contract: ${checks} checks passed\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
