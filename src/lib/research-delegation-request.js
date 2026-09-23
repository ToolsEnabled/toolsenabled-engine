'use strict';

// This request names inputs, never authority. The desktop host independently
// resolves the parent's current scope and issues the actual child permit.
const path = require('node:path');
const MAX_FILES = 32;
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_PROMPT_CHARS = 16000;
const bad = message => Object.assign(new Error(message), { code: 'RESEARCH_DELEGATION_INVALID' });
const plain = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const own = (value, key) => Object.hasOwn(value, key);

function portableInputPath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\\\:\x00-\x1f\x7f]/.test(value)) return false;
  return value.split('/').every(part => part && part !== '.' && part !== '..'
    && !part.startsWith('.') && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function normalizeResearchDelegation(value) {
  if (!plain(value) || Reflect.ownKeys(value).some(key =>
    !['mode', 'access', 'folder', 'prompt', 'files'].includes(key))) {
    throw bad('Research delegation needs an explicit mode, access and prompt.');
  }
  if (!['folder', 'clean-room'].includes(value.mode)
      || !['read-only', 'read-write'].includes(value.access)
      || typeof value.prompt !== 'string' || !value.prompt.trim()
      || value.prompt.length > MAX_PROMPT_CHARS || value.prompt.includes('\0')) {
    throw bad('Choose folder or clean-room access and provide the intended prompt.');
  }
  if (value.mode === 'folder') {
    if (typeof value.folder !== 'string' || value.folder.length > 4096
        || !path.isAbsolute(value.folder) || /[\x00-\x1f\x7f]/.test(value.folder)
        || own(value, 'files')) {
      throw bad('Folder delegation needs one absolute folder and does not accept copied inputs.');
    }
    return Object.freeze({ mode: value.mode, access: value.access, folder: value.folder, prompt: value.prompt });
  }
  if (own(value, 'folder') || (own(value, 'files') && !Array.isArray(value.files))) {
    throw bad('A clean room accepts explicit file contents, not an existing folder.');
  }
  const files = value.files || [];
  if (files.length > MAX_FILES || Reflect.ownKeys(files).length !== files.length + 1
      || Array.from({ length: files.length }, (_, index) => index).some(index => !own(files, index))) {
    throw bad('The clean-room file list is invalid or too large.');
  }
  const names = new Set();
  let bytes = Buffer.byteLength(value.prompt, 'utf8');
  const copied = files.map(file => {
    if (!plain(file) || Reflect.ownKeys(file).length !== 2 || !own(file, 'path') || !own(file, 'content')
        || !portableInputPath(file.path) || typeof file.content !== 'string' || file.content.includes('\0')) {
      throw bad('Every clean-room input needs a portable relative file path and UTF-8 text.');
    }
    const key = file.path.toLowerCase();
    if (names.has(key) || [...names].some(name => name.startsWith(key + '/') || key.startsWith(name + '/'))) {
      throw bad('Clean-room input paths must be distinct on Windows and Linux.');
    }
    names.add(key);
    bytes += Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_INPUT_BYTES) throw bad('Clean-room inputs exceed the bounded text allowance.');
    return Object.freeze({ path: file.path, content: file.content });
  });
  return Object.freeze({ mode: value.mode, access: value.access, prompt: value.prompt, files: Object.freeze(copied) });
}

function researchDelegationForSpawn(value, parentScope, fallbackPrompt) {
  if (value === undefined && parentScope === undefined) return null;
  // A restricted parent's omitted option inherits the boundary, never an
  // ordinary broad start. The host revalidates root identity at admission.
  if (parentScope !== undefined) {
    if (!plain(parentScope) || parentScope.version !== 1
        || !['folder', 'clean-room'].includes(parentScope.mode)
        || typeof parentScope.root !== 'string' || !path.isAbsolute(parentScope.root)
        || !['read-only', 'read-write'].includes(parentScope.access)) {
      throw bad('The parent research boundary is unavailable.');
    }
    if (value === undefined) value = {
      mode: 'folder', folder: parentScope.root, access: parentScope.access, prompt: fallbackPrompt
    };
  }
  const result = normalizeResearchDelegation(value);
  if (parentScope !== undefined) {
    if (parentScope.access === 'read-only' && result.access !== 'read-only') {
      throw bad('A research child cannot gain write access from a read-only parent.');
    }
    if (result.mode === 'folder') {
      const relative = path.relative(parentScope.root, path.resolve(result.folder));
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
        throw bad('A research child folder must stay inside its parent boundary.');
      }
    }
  }
  return result;
}

module.exports = { MAX_FILES, MAX_INPUT_BYTES, MAX_PROMPT_CHARS,
  portableInputPath, normalizeResearchDelegation, researchDelegationForSpawn };
