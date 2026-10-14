'use strict';

// A native route is a bounded selection plan. It carries no provider catalog,
// repository verification, allowance, task receipt, or permission to submit.
function dataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(Object.getOwnPropertyDescriptors(value))
      .every(descriptor => Object.prototype.hasOwnProperty.call(descriptor, 'value'));
}

function text(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function projectNativeCloudRoute(value, { account, provider } = {}) {
  const refused = code => Object.freeze({
    nativeRoute: null, availability: 'refused', nativeRouteReason: code
  });
  if (value === undefined || value === null) return Object.freeze({
    nativeRoute: null, availability: null, nativeRouteReason: null
  });
  if (!dataObject(value)) return refused('NATIVE_CLOUD_ROUTE_INVALID');
  if (!text(account, 128) || provider !== 'codex'
      || value.account !== account || value.provider !== provider) {
    return refused('NATIVE_CLOUD_SELECTION_OWNER_MISMATCH');
  }
  if (value.auth !== 'native-cli' || value.credentialCustody !== 'vendor-cli'
      || value.signIn !== 'unknown' || value.catalog !== 'unavailable') {
    return refused('NATIVE_CLOUD_ROUTE_INVALID');
  }
  if (!dataObject(value.picker) || value.picker.interactive !== true
      || !Array.isArray(value.picker.argv) || value.picker.argv.length !== 1
      || Object.getOwnPropertyDescriptor(value.picker.argv, '0')?.value !== 'cloud') return refused('NATIVE_CLOUD_PICKER_INVALID');
  let manualSelection = null;
  if (value.manualSelection !== null && value.manualSelection !== undefined) {
    const manual = value.manualSelection;
    if (!dataObject(manual)) return refused('NATIVE_CLOUD_SELECTION_INVALID');
    if (manual.account !== account || manual.provider !== provider
        || manual.source !== 'owner-declared' || manual.requiresProviderBinding !== false
        || manual.environmentSource !== 'person-entered' || manual.providerConfirmed !== false) {
      return refused('NATIVE_CLOUD_SELECTION_OWNER_MISMATCH');
    }
    if (typeof manual.environmentId !== 'string'
        || !/^[0-9a-f]{32}$/.test(manual.environmentId)) {
      return refused('NATIVE_CLOUD_ENVIRONMENT_INVALID');
    }
    const declaredRepository = manual.declaredRepository == null ? null : manual.declaredRepository;
    if (declaredRepository !== null && (!text(declaredRepository, 201)
        || !/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(declaredRepository))) {
      return refused('NATIVE_CLOUD_REPOSITORY_INVALID');
    }
    const branch = manual.branch == null ? null : manual.branch;
    if (branch !== null && (!text(branch, 200)
        || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..'))) {
      return refused('NATIVE_CLOUD_BRANCH_INVALID');
    }
    manualSelection = Object.freeze({
      account, provider, environmentId: manual.environmentId, declaredRepository, branch,
      source: 'owner-declared', environmentSource: 'person-entered', providerConfirmed: false, requiresProviderBinding: false,
      argv: Object.freeze(['cloud', 'exec', '--env', manual.environmentId,
        ...(branch === null ? [] : ['--branch', branch])])
    });
  }
  return Object.freeze({
    availability: 'native-picker-or-explicit-id', nativeRouteReason: null,
    nativeRoute: Object.freeze({
      auth: 'native-cli', credentialCustody: 'vendor-cli', account, provider,
      signIn: 'unknown', catalog: 'unavailable',
      picker: Object.freeze({ argv: Object.freeze(['cloud']), interactive: true }),
      manualSelection
    })
  });
}

module.exports = Object.freeze({ projectNativeCloudRoute });
