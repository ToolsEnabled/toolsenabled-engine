#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'registry.json');
const DEFAULT_TOOL_REGISTRY = path.join(ROOT, 'src', 'lib', 'tool-registry.js');
const DECLARING_STATUSES = new Set(['active', 'staged']);
const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]*$/;

function readJson(file, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const wrapped = new Error(`${label} could not be read as JSON: ${error.message}`);
    wrapped.code = 'MANIFEST_NAMESPACE_INPUT_INVALID';
    throw wrapped;
  }
  return parsed;
}

function loadToolNames(toolRegistryPath = DEFAULT_TOOL_REGISTRY) {
  const loaded = require(path.resolve(toolRegistryPath));
  if (!loaded || !Array.isArray(loaded.TOOL_REGISTRY)) {
    const error = new Error('The tool registry does not export TOOL_REGISTRY as an array.');
    error.code = 'MANIFEST_NAMESPACE_INPUT_INVALID';
    throw error;
  }
  return loaded.TOOL_REGISTRY.map((entry, index) => {
    if (!entry || typeof entry.name !== 'string' || !entry.name.includes('.')) {
      const error = new Error(`TOOL_REGISTRY[${index}] has no dotted tool name.`);
      error.code = 'MANIFEST_NAMESPACE_INPUT_INVALID';
      throw error;
    }
    return entry.name;
  });
}

function declaringMcpCapabilities(manifest) {
  if (!manifest || !Array.isArray(manifest.capabilities)) {
    const error = new Error('registry.json must contain a capabilities array.');
    error.code = 'MANIFEST_NAMESPACE_INPUT_INVALID';
    throw error;
  }
  return manifest.capabilities.filter((capability) => capability
    && capability.kind === 'mcp'
    && DECLARING_STATUSES.has(capability.status));
}

function checkManifestNamespaces({
  manifestPath = DEFAULT_MANIFEST,
  toolRegistryPath = DEFAULT_TOOL_REGISTRY,
  manifest,
  toolNames
} = {}) {
  const source = manifest === undefined ? readJson(path.resolve(manifestPath), 'registry.json') : manifest;
  const names = toolNames === undefined ? loadToolNames(toolRegistryPath) : toolNames;
  if (!Array.isArray(names)) {
    const error = new Error('toolNames must be an array.');
    error.code = 'MANIFEST_NAMESPACE_INPUT_INVALID';
    throw error;
  }

  const registeredNamespaces = new Set();
  const registryErrors = [];
  names.forEach((name, index) => {
    if (typeof name !== 'string' || !name.includes('.')) {
      registryErrors.push(`toolNames[${index}] has no dotted tool name`);
      return;
    }
    registeredNamespaces.add(name.slice(0, name.indexOf('.')));
  });

  const claims = declaringMcpCapabilities(source);
  const declarationErrors = [];
  const missing = [];
  const declaredNamespaces = new Set();
  for (const capability of claims) {
    const label = typeof capability.id === 'string' && capability.id ? capability.id : '<unnamed-capability>';
    if (!Array.isArray(capability.toolNamespaces) || capability.toolNamespaces.length === 0) {
      declarationErrors.push(`${label} must declare a non-empty toolNamespaces array`);
      continue;
    }
    const seen = new Set();
    for (const namespace of capability.toolNamespaces) {
      if (typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace)) {
        declarationErrors.push(`${label} declares invalid namespace ${JSON.stringify(namespace)}`);
        continue;
      }
      if (seen.has(namespace)) {
        declarationErrors.push(`${label} declares duplicate namespace ${namespace}`);
        continue;
      }
      seen.add(namespace);
      declaredNamespaces.add(namespace);
      if (!registeredNamespaces.has(namespace)) missing.push({ capabilityId: label, namespace });
    }
  }

  const errors = [
    ...(claims.length === 0 ? ['registry.json declares no active or staged MCP capabilities'] : []),
    ...(names.length === 0 ? ['tool registry exposes no tools'] : []),
    ...registryErrors,
    ...declarationErrors,
    ...missing.map(({ capabilityId, namespace }) => `${capabilityId} declares ${namespace}.*, but the tool registry exposes no ${namespace}.* tool`)
  ];
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    missing: Object.freeze(missing.map((entry) => Object.freeze({ ...entry }))),
    capabilityCount: claims.length,
    toolCount: names.length,
    declaredNamespaceCount: declaredNamespaces.size,
    registeredNamespaceCount: registeredNamespaces.size
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest' || argument === '--registry') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path.`);
      options[argument === '--manifest' ? 'manifestPath' : 'toolRegistryPath'] = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  let result;
  try {
    result = checkManifestNamespaces(parseArguments(argv));
  } catch (error) {
    process.stderr.write(`MANIFEST NAMESPACE GATE ERROR: ${error.message}\n`);
    return 2;
  }
  if (!result.ok) {
    process.stderr.write(`MANIFEST NAMESPACE GATE FAILED (${result.errors.length} error(s))\n`);
    for (const error of result.errors) process.stderr.write(`- ${error}\n`);
    return 1;
  }
  process.stdout.write(
    `Manifest namespace gate passed: ${result.capabilityCount} MCP claims, `
    + `${result.declaredNamespaceCount} declared namespaces, ${result.toolCount} tools, `
    + `${result.registeredNamespaceCount} registered namespaces.\n`
  );
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = Object.freeze({
  DECLARING_STATUSES,
  NAMESPACE_PATTERN,
  checkManifestNamespaces,
  declaringMcpCapabilities,
  loadToolNames,
  main,
  parseArguments
});
