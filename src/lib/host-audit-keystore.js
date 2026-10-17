'use strict';

// Host audit's two generated records only. This never substitutes for the
// generic credential vault. Private files remain readable by same-user
// processes and do not provide tamper-proof custody against those processes.
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SIGNING_KEY = 'toolsenabled_audit_signing_key_v1';
const HEAD_KEY = 'toolsenabled_audit_head_v1';
const HELPER = path.join(__dirname, 'host-audit-keystore.py');
const FALLBACK = new Set(['SECRET_BACKEND_UNAVAILABLE', 'SECRET_BACKEND_LOCKED',
  'SECRET_BACKEND_IDENTITY_INVALID', 'SECRET_HELPER_UNAVAILABLE']);
const MESSAGES = Object.freeze({
  SECRET_ACCESS_DENIED: 'Only Fleet host audit signing and head records use this store.',
  SECRET_NOT_CONFIGURED: 'The requested host audit record is not configured.',
  SECRET_INPUT_INVALID: 'The host audit storage request is invalid.',
  SECRET_VAULT_UNREADABLE: 'The private host audit record is unreadable or invalid; existing state was retained.',
  SECRET_VAULT_PATH_UNSAFE: 'Host audit storage requires owned private directories and files without links or unsupported access metadata.',
  SECRET_VAULT_LOCK_TIMEOUT: 'The private host audit store is busy; its kernel lock could not be acquired.',
  SECRET_VAULT_WRITE_FAILED: 'The private host audit record could not be stored durably.',
  SECRET_MONOTONIC_CONFLICT: 'The host audit head cannot move backward or change at the same sequence.',
  SECRET_HELPER_UNAVAILABLE: 'Private host audit storage requires the installed helper and system Python 3.'
});
function failure(code) {
  const known = Object.hasOwn(MESSAGES, code) ? code : 'SECRET_VAULT_UNREADABLE';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}
function enabled(env = process.env) {
  return process.platform === 'linux' && env.TOOLSENABLED_RUNTIME_MODE === 'host' && env.OPENSHELL_SANDBOX !== '1';
}

function createHostAuditKeyStore({ env = process.env, runtime } = {}) {
  if (!enabled(env)) throw failure('SECRET_ACCESS_DENIED');
  const root = env.TOOLSENABLED_STATE_ROOT;
  if (typeof root !== 'string' || !path.isAbsolute(root) || root === '/' || path.normalize(root) !== root) throw failure('SECRET_VAULT_PATH_UNSAFE');
  let selected = null, provisional = null, unavailable = false;

  function helper(request) {
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', HELPER, root], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore']
    });
    if (result.error || result.signal || result.status !== 0) throw failure('SECRET_HELPER_UNAVAILABLE');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw failure('SECRET_VAULT_UNREADABLE'); }
    if (!response || response.ok !== true) throw failure(response?.code);
    return response.value;
  }
  function checkKey(key) {
    if (![SIGNING_KEY, HEAD_KEY].includes(key)) throw failure('SECRET_ACCESS_DENIED');
  }
  function loadSelection() {
    if (!selected) selected = helper({ operation: 'peek' });
    return selected;
  }
  function select(kind) {
    selected = helper({ operation: 'select', kind });
    provisional = null;
    return selected;
  }
  function privateRead(key) {
    const value = helper({ operation: 'get', key });
    if (key === SIGNING_KEY) {
      try {
        if (crypto.createPrivateKey(value).asymmetricKeyType !== 'ed25519') throw new Error();
      } catch { throw failure('SECRET_VAULT_UNREADABLE'); }
    }
    return value;
  }
  function getSecret(key) {
    checkKey(key);
    if (loadSelection() === 'private-file' || provisional === 'private-file') return privateRead(key);
    if (selected === 'os-keyring') return runtime.getSecret(key);
    // Probe only the Fleet signing record. An unreadable/corrupt vault is
    // unknown, not absence; only explicit unavailable-backend codes fall back.
    try {
      const value = runtime.getSecret(SIGNING_KEY);
      if (select('os-keyring') === 'private-file') return privateRead(key);
      return key === SIGNING_KEY ? value : runtime.getSecret(key);
    } catch (error) {
      if (error?.code === 'SECRET_NOT_CONFIGURED') {
        provisional = 'os-keyring';
        throw error;
      }
      if (!selected && FALLBACK.has(error?.code)) {
        // Do not persist a new backend here. audit.js first proves an empty
        // canonical ledger, then calls getOrCreate. Existing history may
        // never mint a replacement signing identity after keyring failure.
        provisional = 'private-file';
        return privateRead(key);
      }
      throw error;
    }
  }
  function getOrCreateSecret(key, value) {
    checkKey(key);
    if (key !== SIGNING_KEY) throw failure('SECRET_ACCESS_DENIED');
    if (!selected && !provisional) {
      try { return getSecret(key); } catch (error) { if (error?.code !== 'SECRET_NOT_CONFIGURED') throw error; }
    }
    const kind = selected || select(provisional);
    return kind === 'private-file' ? helper({ operation: 'getOrCreate', key, value }) : runtime.getOrCreateSecret(key, value);
  }
  function setMonotonicSecret(key, value, sequence) {
    checkKey(key);
    if (key !== HEAD_KEY || !loadSelection()) throw failure('SECRET_ACCESS_DENIED');
    return selected === 'private-file' ? helper({ operation: 'setMonotonic', key, value, sequence })
      : runtime.setMonotonicSecret(key, value, sequence);
  }
  function guard(operation) {
    return (...args) => {
      try { const value = operation(...args); unavailable = false; return value; }
      catch (error) {
        unavailable = !['SECRET_NOT_CONFIGURED', 'SECRET_MONOTONIC_CONFLICT', 'SECRET_ACCESS_DENIED'].includes(error?.code);
        throw error;
      }
    };
  }
  function status() {
    if (unavailable) return { kind: 'unavailable' };
    const kind = selected || provisional || 'unselected';
    return kind === 'private-file' ? { kind, sameUserReadable: true, boundary: false } : { kind };
  }
  return Object.freeze({ getSecret: guard(getSecret), getOrCreateSecret: guard(getOrCreateSecret),
    setMonotonicSecret: guard(setMonotonicSecret), status });
}

module.exports = { createHostAuditKeyStore, enabled };
