'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RESEARCH_ACCESS_VERSION = 1;
const FILE_TOOLS = new Set([
  'host.list_dir',
  'host.read_file',
  'host.write_file',
  'host.patch_file'
]);
const WRITE_TOOLS = new Set(['host.write_file', 'host.patch_file']);
const ROOT_IDENTITY = Symbol('researchRootIdentity');

class ResearchAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResearchAccessError';
    this.code = code;
  }
}

function refuse(message) {
  throw new ResearchAccessError('RESEARCH_ACCESS_REFUSED', message);
}

function canonicalFolder(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    refuse('researchAccess.root must be an absolute folder.');
  }
  let stat;
  try { stat = fs.lstatSync(value); } catch { refuse('The research root is unavailable.'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.isReparsePoint?.()) {
    refuse('The research root must be a real directory.');
  }
  let root;
  try { root = fs.realpathSync.native(value); } catch { refuse('The research root is unavailable.'); }
  if (path.resolve(root) !== path.resolve(value)) refuse('The research root must not resolve through a link.');
  return root;
}

function rootStamp(root) {
  try {
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.isReparsePoint?.()) return null;
    const real = fs.realpathSync.native(root);
    if (path.resolve(real) !== path.resolve(root)) return null;
    return Object.freeze({ real, dev: String(stat.dev), ino: String(stat.ino) });
  } catch { return null; }
}

function validateResearchAccess(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Reflect.ownKeys(value).some(key => typeof key === 'string'
        && !['version', 'mode', 'root', 'access'].includes(key))
      || value.version !== RESEARCH_ACCESS_VERSION
      || !['folder', 'clean-room'].includes(value.mode)
      || !['read-only', 'read-write'].includes(value.access)) {
    refuse('researchAccess must be {version:1, mode, root, access}.');
  }
  const originalIdentity = value[ROOT_IDENTITY];
  if (originalIdentity) assertFresh(value);
  const root = canonicalFolder(value.root);
  const identity = originalIdentity || rootStamp(root);
  if (!identity) refuse('The research root is unavailable.');
  const normalized = {
    version: RESEARCH_ACCESS_VERSION,
    mode: value.mode,
    root: path.resolve(root),
    access: value.access
  };
  Object.defineProperty(normalized, ROOT_IDENTITY, { value: identity, enumerable: false });
  assertFresh(normalized);
  return Object.freeze(normalized);
}

function assertFresh(scope) {
  if (!scope) return;
  const now = rootStamp(scope.root);
  const identity = scope[ROOT_IDENTITY];
  if (!now || path.resolve(now.real) !== path.resolve(scope.root)
      || (identity && (now.dev !== identity.dev || now.ino !== identity.ino))) {
    refuse('The research root is stale or unavailable.');
  }
}

function pathArgument(args, toolName) {
  if (toolName === 'host.list_dir' && args.path === undefined) return '';
  if (typeof args.path !== 'string') refuse(`${toolName} requires a path.`);
  return args.path;
}

function resolvePath(scope, raw, toolName) {
  assertFresh(scope);
  const root = path.resolve(scope.root);
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse(`${toolName} path is outside the research root.`);
  }
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error?.code === 'ENOENT' && cursor === absolute && WRITE_TOOLS.has(toolName)) break;
      refuse(`${toolName} path is unavailable.`);
    }
    if (stat.isSymbolicLink() || stat.isReparsePoint?.()) refuse(`${toolName} path contains a link or reparse point.`);
    if (cursor === absolute && stat.isFile() && Number(stat.nlink) > 1) {
      refuse(`${toolName} refuses hard-linked files.`);
    }
  }
  return absolute;
}

function researchAccessToolNames(scope) {
  if (!scope) return undefined;
  const names = ['host.list_dir', 'host.read_file'];
  if (scope.access === 'read-write') names.push('host.write_file', 'host.patch_file');
  names.push('agent.spawn');
  return Object.freeze(names);
}

function enforceResearchAccess(toolName, args, scope) {
  if (!scope) return args;
  assertFresh(scope);
  if (toolName === 'agent.spawn') return args;
  if (!FILE_TOOLS.has(toolName)) refuse(`${toolName} is not available in a research session.`);
  if (WRITE_TOOLS.has(toolName) && scope.access === 'read-only') {
    refuse(`${toolName} is unavailable in a read-only research session.`);
  }
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const raw = pathArgument(input, toolName);
  const normalized = resolvePath(scope, raw, toolName);
  return Object.freeze({ ...input, path: normalized });
}

module.exports = {
  RESEARCH_ACCESS_VERSION,
  ResearchAccessError,
  validateResearchAccess,
  researchAccessToolNames,
  enforceResearchAccess
};
