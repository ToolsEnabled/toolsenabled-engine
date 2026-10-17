'use strict';

// The entry supplies these facts only after validating its host configuration.
// Diagnostics retain no signing material and do not re-open provider profiles.
let configuration = null;

function configureHostStatus(config) {
  configuration = Object.freeze({ workspace: config.workspace, workers: config.workers === true });
}

function hostStatus(auditKeyStore, env = process.env) {
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host') return null;
  return {
    workspace: configuration?.workspace ?? null,
    workers: { enabled: configuration?.workers ?? null, experimental: true },
    auditKeyStore
  };
}

module.exports = { configureHostStatus, hostStatus };
