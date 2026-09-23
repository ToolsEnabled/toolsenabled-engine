'use strict';

// Stage A of the owner-authorized iPhone handoff is deliberately a device
// readiness probe, not an iOS data channel. Windows can report a present Apple
// USB/mobile device, but it cannot safely prove pairing/unlock state or expose
// phone content through this capability.
const { execFile } = require('node:child_process');
const audit = require('../audit');
const safety = require('./provider-safety');

const PROBE_TIMEOUT_MS = 7_000;
const DEVICE_STATES = new Set(['absent', 'present', 'present_not_ready', 'probe_unavailable', 'unsupported_platform']);
const PAIRING_STATES = new Set(['not_observable']);
const HANDOFF_STATES = new Set(['unavailable', 'phone_side_bridge_not_configured']);
const POWERSHELL_PROBE = [
  // A failed inventory query must make PowerShell fail rather than converting
  // "could not inspect the machine" into the same empty rows as no device.
  "$ErrorActionPreference='Stop'",
  "$rows=@(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match '^USB\\VID_05AC' -or $_.Class -match 'Portable Devices|WPD' } | Select-Object -First 8 -Property Status,Class)",
  '$rows | ConvertTo-Json -Compress'
].join('; ');

function fail(code, message) { return safety.safeError(code, message); }
function exact(input) {
  let plainInput = false;
  try { plainInput = safety.isPlainObject(input); } catch { plainInput = false; }
  if (!plainInput) throw fail('IPHONE_HANDOFF_STATUS_INVALID', 'The iPhone handoff request is invalid.');
  let keys;
  try { keys = Reflect.ownKeys(input); } catch {
    throw fail('IPHONE_HANDOFF_STATUS_INVALID', 'The iPhone handoff request is invalid.');
  }
  if (keys.length !== 0) throw fail('IPHONE_HANDOFF_STATUS_INVALID', 'The iPhone handoff request is invalid.');
  return input;
}

function runPowershell(command, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

function parseRows(value) {
  if (!value || !value.trim()) throw fail('IPHONE_HANDOFF_PROBE_INVALID', 'The local iPhone readiness probe returned invalid data.');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw fail('IPHONE_HANDOFF_PROBE_INVALID', 'The local iPhone readiness probe returned invalid data.'); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length > 8 || !rows.every(row => row && typeof row === 'object'
      && typeof row.Status === 'string' && typeof row.Class === 'string'
      && row.Status.length <= 64 && row.Class.length <= 128)) {
    throw fail('IPHONE_HANDOFF_PROBE_INVALID', 'The local iPhone readiness probe returned invalid data.');
  }
  return rows;
}

function summarize(rows, available = true) {
  if (!available) return Object.freeze({ device: 'probe_unavailable', pairing: 'not_observable', handoff: 'unavailable' });
  if (rows.length === 0) return Object.freeze({ device: 'absent', pairing: 'not_observable', handoff: 'unavailable' });
  const ready = rows.some(row => /^ok$/i.test(row.Status));
  return Object.freeze({ device: ready ? 'present' : 'present_not_ready', pairing: 'not_observable', handoff: 'phone_side_bridge_not_configured' });
}

// This is the only controller/browser projection of the readiness probe. It
// accepts only the three already-redacted enum values and deliberately has no
// record id, task, provider, device identifier, pairing claim, or action.
function controllerReadiness(value, nowMs = Date.now()) {
  let keys;
  try { keys = safety.isPlainObject(value) ? Reflect.ownKeys(value) : []; } catch { keys = []; }
  const expected = ['device', 'pairing', 'handoff'];
  const values = {};
  const closed = keys.length === expected.length
    && keys.every(key => typeof key === 'string' && expected.includes(key))
    && expected.every(key => {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return false; }
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
      values[key] = descriptor.value;
      return true;
    });
  if (!closed || !DEVICE_STATES.has(values.device) || !PAIRING_STATES.has(values.pairing)
      || !HANDOFF_STATES.has(values.handoff) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw fail('IPHONE_HANDOFF_STATUS_INVALID', 'The local iPhone readiness status is unavailable.');
  }
  return Object.freeze({
    schemaVersion: 1,
    observedAt: new Date(nowMs).toISOString(),
    readiness: Object.freeze({ device: values.device, pairing: values.pairing, handoff: values.handoff })
  });
}

function dependencies(overrides = {}) {
  return {
    audit: overrides.audit || audit,
    platform: overrides.platform || process.platform,
    runProbe: overrides.runProbe || runPowershell
  };
}

async function handoffStatus(input = {}, overrides = {}) {
  exact(input);
  const d = dependencies(overrides);
  let result;
  if (d.platform !== 'win32') result = Object.freeze({ device: 'unsupported_platform', pairing: 'not_observable', handoff: 'unavailable' });
  else {
    let probe;
    try { probe = await d.runProbe(POWERSHELL_PROBE, PROBE_TIMEOUT_MS); } catch {
      throw fail('IPHONE_HANDOFF_PROBE_UNAVAILABLE',
        'The local iPhone readiness probe could not answer; this does NOT claim that an iPhone is absent.');
    }
    if (!probe || probe.ok !== true || typeof probe.stdout !== 'string' || !probe.stdout.trim()) {
      throw fail('IPHONE_HANDOFF_PROBE_UNAVAILABLE',
        'The local iPhone readiness probe could not answer; this does NOT claim that an iPhone is absent.');
    }
    result = summarize(parseRows(probe.stdout));
  }
  d.audit.record('iphone.handoff_status', 'local-mobile-device', result);
  return result;
}

module.exports = {
  DEVICE_STATES, HANDOFF_STATES, PAIRING_STATES,
  POWERSHELL_PROBE, PROBE_TIMEOUT_MS,
  controllerReadiness, handoffStatus, parseRows, summarize
};
