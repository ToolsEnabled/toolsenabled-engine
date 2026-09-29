'use strict';

// THE CONFIGURED-PROJECT BOUNDARY.
//
// This module answers two questions about a separately-configured project that
// an installation may be managing, and that gets stricter handling than
// anything else this product touches:
//
//   1. where is that project's checkout on this machine, and
//   2. which published Store item belongs to it.
//
// It is a SECURITY BOUNDARY, not a settings helper. Its answers decide whether
// providers/chrome-web-store.js applies its upload fence, its audit-target
// redaction, and its audit-details gate. Renaming or "tidying" anything here
// changes what those three controls protect, so treat a change to this file as
// a change to a control.
//
// There is deliberately NO DEFAULT for either value. There is no path or item
// id a fresh installation could guess that would ever be correct, so absence is
// reported as its own distinguishable state rather than silently substituted
// with a value that would be wrong for everyone. A missing config returns null
// (or false), while unreadable or malformed configuration refuses the check;
// inability to read a configured boundary must not silently switch it off.
//
// WHY THE GENERIC NAME. This file used to be named, and its functions used to
// be named, after the specific product the builder happens to configure here.
// That welded a boundary check to one product's name in a repository that is
// published: a reader could not tell that this is the mechanism behind the
// upload fence, and a comment in src/lib/tool-registry.js wrongly asserted the
// file was no longer reachable and therefore deletable -- deleting it would
// have taken the fence with it. The names now describe the ROLE. What product
// is configured is data, supplied at run time, and appears nowhere in here.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./runtime');

const ROOT_ENV_VAR = 'TOOLSENABLED_PROTECTED_PROJECT_ROOT';
const STORE_ITEM_ID_ENV_VAR = 'TOOLSENABLED_PROTECTED_STORE_ITEM_ID';

// Covered by the repo's blanket `*.local.json` gitignore rule, same
// per-installation-override convention as config/machines.profile.json and
// config/coordinator-backup-duty.local.json.
const LOCAL_CONFIG_FILE = path.join(ROOT, 'config', 'protected-project.local.json');

// Three distinguishable states, per the owner's direction: "not configured"
// must read differently from "configured but missing" and from "the check
// itself failed" -- never a silent empty result standing in for any of them.
const STATE = Object.freeze({
  NOT_CONFIGURED: 'not-configured',
  READY: 'ready',
  MISSING: 'configured-but-missing',
  CHECK_FAILED: 'check-failed'
});

function readJsonValue(file, fileKey, io) {
  let raw;
  try {
    raw = io.readFileSync(file, 'utf8');
  } catch (error) {
    // A file that is not present means this source is not configured. Any
    // other read failure means its contents are unknown, not absent.
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (parsed && Object.hasOwn(parsed, fileKey) && typeof parsed[fileKey] !== 'string') {
    throw new TypeError(`Configured project ${fileKey} in ${file} must be a string.`);
  }
  const candidate = parsed && typeof parsed[fileKey] === 'string' ? parsed[fileKey].trim() : '';
  return candidate !== '' ? candidate : null;
}

// One reader for both values: current environment variable, then the current
// install-local config file, then "not configured". Historical project names
// are deliberately not authority inputs for a fresh customer installation.
function readConfiguredValue(envVar, fileKey, { env = process.env, io = fs } = {}) {
  const fromEnv = typeof env[envVar] === 'string' ? env[envVar].trim() : '';
  if (fromEnv !== '') return fromEnv;
  return readJsonValue(LOCAL_CONFIG_FILE, fileKey, io);
}

function readConfiguredRoot(options = {}) {
  return readConfiguredValue(ROOT_ENV_VAR, 'root', options);
}

// The full, distinguishable status. Callers that need to explain themselves
// to a human (an error message, a status report) should use this rather than
// resolveConfiguredRoot(), which refuses CHECK_FAILED and maps other unusable
// states to null.
function configuredRootStatus(options = {}) {
  const io = options.io || fs;
  let configured;
  try {
    configured = readConfiguredRoot(options);
  } catch {
    return Object.freeze({ state: STATE.CHECK_FAILED, root: null });
  }
  if (configured === null) return Object.freeze({ state: STATE.NOT_CONFIGURED, root: null });
  try {
    io.statSync(configured);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return Object.freeze({ state: STATE.MISSING, root: configured });
    }
    return Object.freeze({ state: STATE.CHECK_FAILED, root: configured });
  }
  return Object.freeze({ state: STATE.READY, root: configured });
}

// Convenience for a caller that only needs a usable path or null. It refuses a
// failed check; a caller that must distinguish absent from missing should call
// configuredRootStatus() instead.
function resolveConfiguredRoot(options = {}) {
  const status = configuredRootStatus(options);
  if (status.state === STATE.CHECK_FAILED) {
    throw new Error('Could not establish the configured project root.');
  }
  return status.state === STATE.READY ? status.root : null;
}

// The configured Store item id, or null. No default: on an installation that
// configures no project this is simply absent.
function protectedStoreItemId(options = {}) {
  return readConfiguredValue(STORE_ITEM_ID_ENV_VAR, 'storeItemId', options);
}

// The comparison the fence actually wants. Returns false -- never throws --
// when the item id is absent, when it is not a string, or when this
// installation configures no project. That last case is the important one: a
// user with no configured project must see the ordinary generic behaviour on
// every one of these paths, not an error and not a special case.
function isProtectedStoreItem(itemId, options = {}) {
  if (typeof itemId !== 'string' || itemId === '') return false;
  const configured = protectedStoreItemId(options);
  return configured !== null && itemId === configured;
}

// True when a resolved path lies inside the configured project's checkout.
// When no project is configured, nothing is ever inside it. A configured root
// that is missing or could not be checked refuses rather than disabling the
// boundary with a false answer.
function isWithinConfiguredRoot(resolvedPath, options = {}) {
  const status = configuredRootStatus(options);
  if (status.state === STATE.NOT_CONFIGURED) return false;
  if (status.state !== STATE.READY) {
    throw new Error(`Refusing configured-project boundary check: root is ${status.state}.`);
  }
  const relative = path.relative(status.root, resolvedPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = Object.freeze({
  ROOT_ENV_VAR,
  STORE_ITEM_ID_ENV_VAR,
  LOCAL_CONFIG_FILE,
  STATE,
  configuredRootStatus,
  isProtectedStoreItem,
  isWithinConfiguredRoot,
  protectedStoreItemId,
  readConfiguredRoot,
  readConfiguredValue,
  resolveConfiguredRoot
});
