#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function usage(message) {
  const error = new Error(message || 'Invalid merge-client-hooks arguments.');
  error.code = 'CLIENT_HOOKS_USAGE';
  throw error;
}

function parseArgs(argv) {
  const allowed = new Set(['--settings', '--template', '--client']);
  const values = {};
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value === '') usage(`Unknown or incomplete option ${flag}.`);
    if (Object.hasOwn(values, flag)) usage(`Duplicate ${flag}.`);
    values[flag] = value;
  }
  for (const flag of allowed) if (!Object.hasOwn(values, flag)) usage(`Missing ${flag}.`);
  return Object.freeze({
    settingsPath: path.resolve(values['--settings']),
    templatePath: path.resolve(values['--template']),
    clientName: String(values['--client']).trim()
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readObject(filePath, label, { allowMissing = false } = {}) {
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return {};
    throw new Error(`${label} is missing: '${filePath}'.`);
  }
  if (!fs.statSync(filePath).isFile()) throw new Error(`${label} is not a file: '${filePath}'.`);
  let value;
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
  if (!isObject(value)) throw new Error(`${label} must contain a JSON object.`);
  return value;
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

function requireObjectArray(value, label) {
  if (!Array.isArray(value) || value.some(item => !isObject(item))) {
    throw new Error(`${label} must be an array of JSON objects.`);
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mergedSettings(settings, template, clientName) {
  const merged = JSON.parse(JSON.stringify(settings));

  if (Object.hasOwn(template, 'permissions')) {
    const templatePermissions = requireObject(template.permissions, `${clientName} template permissions`);
    const wanted = requireStringArray(templatePermissions.allow, `${clientName} template permissions.allow`);
    if (!Object.hasOwn(merged, 'permissions')) merged.permissions = {};
    const permissions = requireObject(merged.permissions, `${clientName} settings permissions`);
    if (!Object.hasOwn(permissions, 'allow')) permissions.allow = [];
    const allowed = requireStringArray(permissions.allow, `${clientName} settings permissions.allow`);
    for (const permission of wanted) if (!allowed.includes(permission)) allowed.push(permission);
  }

  if (Object.hasOwn(template, 'hooks')) {
    const templateHooks = requireObject(template.hooks, `${clientName} template hooks`);
    if (!Object.hasOwn(merged, 'hooks')) merged.hooks = {};
    const hooks = requireObject(merged.hooks, `${clientName} settings hooks`);
    for (const [eventName, wantedGroupsValue] of Object.entries(templateHooks)) {
      const wantedGroups = requireObjectArray(wantedGroupsValue, `${clientName} template hook '${eventName}'`);
      if (!Object.hasOwn(hooks, eventName)) hooks[eventName] = [];
      const existingGroups = requireObjectArray(hooks[eventName], `${clientName} hook '${eventName}'`);
      const signatures = new Set(existingGroups.map(stableStringify));
      for (const group of wantedGroups) {
        const signature = stableStringify(group);
        if (!signatures.has(signature)) {
          existingGroups.push(group);
          signatures.add(signature);
        }
      }
    }
  }

  return merged;
}

function writeAtomic(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

function mergeClientHooks({ settingsPath, templatePath, clientName }) {
  if (!clientName) usage('--client must not be blank.');
  // Validate both complete documents and build the complete result before the
  // first filesystem mutation. A missing or malformed template/settings file
  // therefore cannot truncate a customer's existing client configuration.
  const template = readObject(templatePath, `${clientName} hook template`);
  const settings = readObject(settingsPath, `${clientName} settings`, { allowMissing: true });
  const merged = mergedSettings(settings, template, clientName);
  writeAtomic(settingsPath, merged);
  return Object.freeze({ ok: true, client: clientName, settingsPath });
}

function main(argv = process.argv) {
  const result = mergeClientHooks(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.code || 'CLIENT_HOOKS_ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { mergeClientHooks, mergedSettings, parseArgs, stableStringify };
