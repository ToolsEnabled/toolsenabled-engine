'use strict';

// One installed location decision for shell writers and engine authority
// readers. Compatibility is read-only: never copy, merge, or remove histories.
const fs = require('node:fs');
const path = require('node:path');
const { createDurableMemoryFile, resolveServicesRoot } = require('./durable-memory-file');
const { NAMESPACE, createCustomRoleStore, DEFAULT_ROLE_DEFINITIONS } = require('./custom-role-store');
const defaultRoleIds = new Set(DEFAULT_ROLE_DEFINITIONS.map(role => role.id));

const CUSTOM_ROLES_FILE = 'custom-roles.json';
const LEGACY_ROLES_FILE = 'durable-memory.json';

function refuse(code, message, details) {
  throw Object.assign(new Error(message), { name: 'InstalledRoleMemoryError', code, details });
}

function installedRoleMemoryFiles({ env = process.env } = {}) {
  const root = resolveServicesRoot({ env });
  return Object.freeze([path.join(root, CUSTOM_ROLES_FILE), path.join(root, LEGACY_ROLES_FILE)]);
}

function inspect(file, fileSystem) {
  // A missing file is the only absence claim. An unreadable or redirected
  // candidate is not evidence that this installation has no role history.
  if (process.platform === 'win32') {
    require('./account-profile-boundary').assertAccountProfilePath(file, {
      field: 'installed role memory', requireOwnedProfile: true, fileSystem
    });
  }
  let stat;
  try { stat = fileSystem.lstatSync(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { present: false, roleHistory: false };
    refuse('INSTALLED_ROLE_MEMORY_UNAVAILABLE', 'An installed role-memory candidate could not be inspected.', { file, cause: error?.code });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    refuse('INSTALLED_ROLE_MEMORY_UNAVAILABLE', 'An installed role-memory candidate is not an ordinary file.', { file });
  }
  const memory = createDurableMemoryFile({ file, fileSystem });
  // Do NOT use listRoles or a text query: default overrides and unknown or
  // tombstone-like records in the role namespace also carry authority history.
  // The backend validates the whole document before answering this question.
  const entries = memory.searchMemory({ namespace: NAMESPACE, query: '', limit: Number.MAX_SAFE_INTEGER });
  return { present: true, roleHistory: entries.length > 0, entries, memory };
}

function selectInstalledRoleMemoryFile(files, { fileSystem = fs } = {}) {
  const [canonicalFile, legacyFile] = files;
  const canonical = inspect(canonicalFile, fileSystem);
  const legacy = inspect(legacyFile, fileSystem);
  if (canonical.present && legacy.roleHistory) {
    // An empty canonical file may be an intentional reset. Even two equal
    // visible definitions do not establish a common revision/deletion history.
    refuse('INSTALLED_ROLE_MEMORY_CONFLICT',
      'Both installed role-memory locations carry possible role history. No history was merged or changed. Preserve both files and explicitly reconcile the authoritative location before retrying.',
      { canonicalFile, legacyFile });
  }
  const selected = legacy.roleHistory ? legacy : canonical;
  if (selected.roleHistory) {
    // Validate through the role store itself, not a second definition schema.
    // A missing note/tag must not hide a malformed or unsupported role entry
    // from listRoles' text search and manufacture a default-only vocabulary.
    const roles = createCustomRoleStore({ stateStore: selected.memory });
    const listed = new Set(roles.listRoles().map(role => role.id));
    for (const entry of selected.entries) {
      const id = entry.key.slice(entry.key.indexOf(':') + 1);
      const record = roles.getRoleRecord(id);
      // Both shipped roles and valid no-base custom roles have a null base.
      // Use the store's shipped identity set, not inheritance, to check the key.
      const kind = defaultRoleIds.has(id) ? 'default' : 'custom';
      if (!record || !listed.has(id) || entry.key !== `${kind}:${record.definition.id}` || record.revision !== entry.revision) {
        refuse('CUSTOM_ROLE_STORE_DAMAGED', 'The installed role-memory file contains an unsupported role-history entry.', { file: legacy.roleHistory ? legacyFile : canonicalFile });
      }
    }
  }
  return Object.freeze(legacy.roleHistory
    ? { file: legacyFile, source: 'legacy-compatibility' }
    : { file: canonicalFile, source: 'canonical' });
}

module.exports = Object.freeze({
  CUSTOM_ROLES_FILE, LEGACY_ROLES_FILE, installedRoleMemoryFiles, selectInstalledRoleMemoryFile
});
