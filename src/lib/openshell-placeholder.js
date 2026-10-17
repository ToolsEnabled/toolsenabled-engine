'use strict';

// OpenShell owns the revisioned credential handle. Its suffix need not equal
// the environment variable name. Read only that variable; never manufacture a
// replacement, read a credential file, coerce a value, or fall back to a key.
function readOpenShellPlaceholder(env, name) {
  let value;
  try {
    if (env && typeof env === 'object' && !Array.isArray(env)
      && typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
      const descriptor = Object.getOwnPropertyDescriptor(env, name);
      if (descriptor && Object.hasOwn(descriptor, 'value')) value = descriptor.value;
    }
  } catch { /* A failed environment lookup never supplies authority. */ }
  if (typeof value !== 'string' || !/^openshell:resolve:env:[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw Object.assign(new Error(`The selected model variable ${typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ? name : '(invalid name)'} must contain an OpenShell provider placeholder. Attach the provider before running this worker.`),
      { code: 'MODEL_API_AUTH_INVALID' });
  }
  return value;
}

module.exports = Object.freeze({ readOpenShellPlaceholder });
