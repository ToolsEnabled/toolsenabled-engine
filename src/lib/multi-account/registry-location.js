'use strict';

// THE ONE LOCATION OF THE INSTALLED PRODUCT'S ACCOUNT REGISTRY.
//
// The running application gives its capability layer one identity-bearing
// state root: TOOLSENABLED_STATE_ROOT=<Electron userData>/capability. A renamed
// test build, a portable profile, and --user-data-dir therefore each get their
// own registry without this module guessing the product name or the user's
// filesystem layout. A cut payload started without the shell reaches the same
// answer through runtime-state-root's PAYLOAD.json identity.
//
// There is deliberately no registry-specific environment override and no
// source/program fallback. Either would be a second registry location. A source
// checkout has no installed-product identity, so it gets a named refusal rather
// than a plausible missing path that a caller can misread as an empty account
// list.

const path = require('node:path');

const { resolveStateRoot, statePath } = require('../runtime-state-root');

const REGISTRY_NOT_PRESENT_HERE = 'ACCOUNTS_REGISTRY_NOT_PRESENT_HERE';

function registryLocationRefusal(reason) {
  const error = new Error(
    'The installed product account registry is not present in this source checkout. Run this through the installed product so its account-registry identity is available.'
  );
  error.name = 'AccountRegistryLocationError';
  error.code = REGISTRY_NOT_PRESENT_HERE;
  error.details = Object.freeze({ reason: reason || 'installation-identity-unavailable' });
  return error;
}

function accountRegistryPath({
  environment = process.env,
  programRoot,
  platform = process.platform,
  fsImpl,
  homedir,
  resolveStateRootImpl = resolveStateRoot
} = {}) {
  const identity = resolveStateRootImpl({ environment, programRoot, platform, fsImpl, homedir });
  if (!identity || identity.reason === 'source-checkout') {
    throw registryLocationRefusal(identity && identity.reason);
  }
  return path.join(identity.root, 'config', 'accounts.json');
}

// Account homes are written only by an installed product call that has already
// resolved the registry above. statePath keeps the existing provider-home layout
// under that same capability state root.
function accountHomesRoot(provider) {
  return statePath(`${provider}-homes`);
}

module.exports = Object.freeze({
  REGISTRY_NOT_PRESENT_HERE,
  accountHomesRoot,
  accountRegistryPath
});
