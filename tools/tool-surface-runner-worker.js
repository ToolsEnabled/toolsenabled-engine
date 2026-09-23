#!/usr/bin/env node
'use strict';

const registry = require('../src/lib/tool-registry');
const { captureProductExecution } = require('./lib/tool-surface-product-outcome');

async function main() {
  const encoded = process.argv[2];
  if (!encoded) throw new Error('Worker request is missing.');
  const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (request.operation === 'discover') {
    process.stdout.write(`${JSON.stringify({ ok: true, tools: registry.listTools({}) })}\n`);
    return;
  }
  if (request.operation !== 'invoke' || typeof request.tool !== 'string') {
    throw new Error('Worker request operation is invalid.');
  }
  const args = request.arguments === undefined ? {} : request.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Worker request arguments must be an object.');
  }
  const result = await captureProductExecution(() => registry.executeTool(request.tool, args, {
      permissionSession: request.permissionSession
  }));
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
