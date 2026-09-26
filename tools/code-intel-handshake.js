#!/usr/bin/env node
'use strict';

// Fresh-client readiness probe for the semantic code-intelligence surface.
//
// A configured MCP entry is not proof that the current client can reach the
// broker, that its workspace root is valid, or that any language server is
// usable there. This adapter deliberately uses the existing one-shot MCP
// client, so normal proxy, allowlist, actor, and audit boundaries still apply.
// It reports a typed failure instead of encouraging a quiet grep fallback.

const path = require('node:path');
const { invoke } = require('./mcp-call');

const ROOT = path.resolve(__dirname, '..');

function failure(code, detail) {
  return { ok: false, code, detail };
}

function safeRoot(value) {
  return typeof value === 'string' && value ? path.resolve(value) : null;
}

function assessStatusResponse(response, expectedRoot) {
  const result = response && response.result;
  if (!result || result.isError === true) {
    const code = result && result.structuredContent && result.structuredContent.error && result.structuredContent.error.code;
    return failure(code === 'TOOL_NOT_FOUND' ? 'CODE_INTEL_TOOL_UNREACHABLE' : 'CODE_INTEL_MCP_UNREACHABLE',
      'code.status did not return a usable MCP result.');
  }
  const status = result.structuredContent;
  if (!status || status.tool !== 'code.status' ||
      !Array.isArray(status.languages) ||
      !status.languages.every(language => language &&
        typeof language.language === 'string' &&
        typeof language.available === 'boolean') ||
      !Array.isArray(status.implementedMethods) ||
      !status.implementedMethods.every(method => typeof method === 'string')) {
    return failure('CODE_INTEL_STATUS_INVALID', 'code.status returned an unexpected capability report.');
  }
  if (status.rootError) {
    return failure('CODE_INTEL_ROOT_INVALID', 'The requested workspace root was rejected by code.status.');
  }
  const actualRoot = safeRoot(status.workspaceRoot);
  if (!actualRoot || actualRoot !== expectedRoot) {
    return failure('CODE_INTEL_ROOT_UNCONFIRMED', 'code.status did not confirm the requested workspace root.');
  }
  const available = status.languages
    .filter(language => language.available)
    .map(language => language.language)
    .sort();
  if (!available.length) {
    return failure('CODE_INTEL_SERVER_UNAVAILABLE', 'No usable language server is available for this workspace.');
  }
  return {
    ok: true,
    code: 'CODE_INTEL_READY',
    workspaceRoot: actualRoot,
    languages: available,
    implementedMethods: [...status.implementedMethods].sort()
  };
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('CODE_INTEL_HANDSHAKE_USAGE');
  if (argv.length === 0) return { root: ROOT };
  if (argv.length === 2 && argv[0] === '--root' && argv[1]) return { root: path.resolve(argv[1]) };
  throw new Error('CODE_INTEL_HANDSHAKE_USAGE');
}

async function run(argv = process.argv.slice(2), invokeMcp = invoke) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { return failure(error.message === 'CODE_INTEL_HANDSHAKE_USAGE' ? error.message : 'CODE_INTEL_HANDSHAKE_USAGE', 'Usage: node tools/code-intel-handshake.js [--root <workspace>].'); }
  try {
    const response = await invokeMcp({ tool: 'code.status', arguments: { root: options.root } });
    return assessStatusResponse(response, options.root);
  } catch {
    return failure('CODE_INTEL_MCP_UNREACHABLE', 'The configured MCP transport could not complete code.status.');
  }
}

if (require.main === module) {
  run().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 2;
  });
}

module.exports = { ROOT, assessStatusResponse, parseArgs, run };
