'use strict';

// Trusted owner-setup entrypoint, NOT an agent tool or a package installer.
// The packaged provider resolves immutable context from its program root and
// lock/state from its profile-local runtime state root. No caller path/image,
// Docker endpoint or command crosses this boundary. UI owner authorization
// and an out-of-process execution boundary belong to the app integration.
function prepareSandboxImage(input = {}) {
  return require('./providers/agent-sandbox').prepareImage(input);
}
function createSandboxImageProvisioner({ onImageBuildStart } = {}) {
  if (typeof onImageBuildStart !== 'function') throw new TypeError('A trusted synchronous build lifecycle hook is required.');
  const provider = require('./providers/agent-sandbox').createSandboxProvider({ onImageBuildStart });
  return Object.freeze({ prepareSandboxImage: input => provider.prepareImage(input) });
}
module.exports = { prepareSandboxImage, createSandboxImageProvisioner };
