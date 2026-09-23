'use strict';

// The application installs one in-process tree host. Policy reads its paired
// capabilities here without importing fleet dispatch. This module starts no
// work and makes no authorization decision; dispatch still checks the caller
// and forwards requests to the application's retained tree authority.
const TREE_SPAWN_HOST_REQUIRED = Object.freeze(['spawn', 'isTreeSession']);
let host = null;

function installTreeSpawnHost(value) {
  if (!value || typeof value !== 'object') {
    throw Object.assign(new Error('A tree spawn host must be an object.'), { code: 'TREE_SPAWN_HOST_INVALID' });
  }
  for (const name of TREE_SPAWN_HOST_REQUIRED) {
    if (typeof value[name] !== 'function') {
      throw Object.assign(new Error(`A tree spawn host must provide ${TREE_SPAWN_HOST_REQUIRED.join(' and ')}; ${name} is missing.`), { code: 'TREE_SPAWN_HOST_INVALID' });
    }
  }
  host = value;
  return true;
}

function clearTreeSpawnHost() { host = null; }
function treeSpawnHost() { return host; }

// Legacy callbacks alone never establish paired confined support. Read the
// installed object each time, preserving replacement/clear and mutation
// semantics of the former in-module slot.
function supportsConfinedTreeSpawn() {
  return host?.confinedTreeSpawnVersion === 1 && typeof host.spawnConfined === 'function';
}
function supportsConfinedTreeLifecycle() {
  return host?.confinedTreeLifecycleVersion === 1 && typeof host.commandConfined === 'function';
}

module.exports = Object.freeze({
  TREE_SPAWN_HOST_REQUIRED,
  installTreeSpawnHost,
  clearTreeSpawnHost,
  treeSpawnHost,
  supportsConfinedTreeSpawn,
  supportsConfinedTreeLifecycle,
});
