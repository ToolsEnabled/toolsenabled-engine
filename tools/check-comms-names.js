#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const POLICY_PATH = path.join(ROOT, 'config', 'toolsenabled.policy.json');
const MANIFEST_PATH = path.join(ROOT, 'config', 'comms-systems.json');
const INPUT_FLAGS = new Set(['--identifier', '--branch', '--doc', '--label']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function reservedProviderNamespaces(policy = readJson(POLICY_PATH)) {
  if (!policy || typeof policy !== 'object' || !policy.providers || typeof policy.providers !== 'object') {
    throw new Error('COMMS_NAMES_POLICY_INVALID: policy.providers must be an object.');
  }
  const namespaces = Object.keys(policy.providers);
  if (namespaces.length === 0) {
    throw new Error('COMMS_NAMES_POLICY_INVALID: policy.providers must declare at least one namespace.');
  }
  return Object.freeze(namespaces.map(value => value.toLowerCase()).sort());
}

function validateManifest(manifest = readJson(MANIFEST_PATH)) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.systems) || manifest.systems.length !== 3) {
    throw new Error('COMMS_NAMES_MANIFEST_INVALID: expected exactly three canonical layers.');
  }
  const ids = manifest.systems.map(system => system && system.id);
  const expected = ['agent-comms', 'secure-agent-channel', 'reserved-external-provider-namespaces'];
  if (ids.length !== expected.length || expected.some((id, index) => ids[index] !== id)) {
    throw new Error('COMMS_NAMES_MANIFEST_INVALID: canonical layer order is invalid.');
  }
  return manifest;
}

// Until 2026-08-22 this file also refused a manifest naming Discord and
// carried a "public Discord community" allowance for labels. Discord was
// removed from the product entirely (owner ruling, O4), including its
// reserved provider namespace in config/toolsenabled.policy.json, so neither
// special case has anything left to guard; collisions come only from the
// namespaces the policy still declares.
function collisionFor(value, namespaces) {
  const normalized = String(value).toLowerCase();
  for (const namespace of namespaces) {
    const escaped = namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(normalized)) return namespace;
  }
  return null;
}

function parseArgs(argv) {
  const inputs = [];
  let historical = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--historical') {
      historical = true;
      continue;
    }
    if (!INPUT_FLAGS.has(flag)) throw new Error(`COMMS_NAMES_USAGE: unsupported flag ${flag}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`COMMS_NAMES_USAGE: ${flag} requires a value.`);
    inputs.push({ kind: flag.slice(2), value });
    index += 1;
  }
  if (inputs.length === 0) throw new Error('COMMS_NAMES_USAGE: provide at least one identifier, branch, doc, or label.');
  return { historical, inputs };
}

function check(inputs, options = {}) {
  validateManifest(options.manifest);
  const namespaces = reservedProviderNamespaces(options.policy);
  if (options.historical === true) {
    return { ok: true, skipped: true, reason: 'historical-or-archived', namespaces, collisions: [] };
  }
  const collisions = inputs.map(input => ({ ...input, namespace: collisionFor(input.value, namespaces) })).filter(input => input.namespace);
  return { ok: collisions.length === 0, skipped: false, namespaces, collisions };
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const result = check(parsed.inputs, parsed);
  if (result.ok) {
    process.stdout.write(`COMMS_NAMES_OK: ${result.skipped ? result.reason : 'no reserved provider namespace collision'}\n`);
    return result;
  }
  for (const collision of result.collisions) {
    process.stderr.write(`COMMS_NAMES_COLLISION: ${collision.kind} '${collision.value}' collides with reserved provider namespace '${collision.namespace}'.\n`);
  }
  process.exitCode = 1;
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { check, collisionFor, parseArgs, reservedProviderNamespaces, validateManifest };
