'use strict';

const os = require('node:os');
const fs = require('node:fs');

const LINUX_POWER_SUPPLIES = '/sys/class/power_supply';
const EXTERNAL_POWER_TYPES = new Set([
  'Mains', 'USB', 'USB_DCP', 'USB_CDP', 'USB_ACA', 'USB_C',
  'USB_PD', 'USB_PD_DRP', 'BrickID', 'Wireless'
]);

// Native observation only. Model eligibility remains in model-picker.js.
// Linux Device-scoped supplies belong to peripherals, not the computer; a
// missing scope is normal for ACPI batteries. Missing present means present
// under the kernel power_supply ABI. Unknown observations never become AC.
function readOnBattery({ platform = process.platform, filesystem = fs, commandText = () => '' } = {}) {
  if (platform === 'win32') {
    try {
      const state = commandText('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "try { $battery = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1; if ($null -eq $battery) { 'desktop' } elseif ([bool]$battery.PowerOnline) { 'ac' } else { 'battery' } } catch { 'unknown' }"
      ]).trim().toLowerCase();
      if (state === 'desktop' || state === 'ac') return false;
      return state === 'battery' ? true : null;
    } catch { return null; }
  }
  if (platform !== 'linux') return null;
  try {
    const supplies = filesystem.readdirSync(LINUX_POWER_SUPPLIES);
    if (!Array.isArray(supplies) || supplies.length > 128) return null;
    let batteries = 0;
    let charging = false;
    const online = [];
    const read = (name, property, optional = false) => {
      try {
        const value = filesystem.readFileSync(`${LINUX_POWER_SUPPLIES}/${name}/${property}`, 'utf8');
        if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid power property');
        return value.trim();
      } catch (error) {
        if (optional && error.code === 'ENOENT') return null;
        throw error;
      }
    };
    for (const name of supplies) {
      if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) return null;
      const scope = read(name, 'scope', true);
      if (scope === 'Device') continue;
      if (scope !== null && scope !== 'System' && scope !== 'Unknown') return null;
      const type = read(name, 'type');
      if (!type) return null;
      if (type === 'Battery') {
        const present = read(name, 'present', true);
        if (present === '0') continue;
        if (present !== null && present !== '1') return null;
        batteries++;
        const status = read(name, 'status');
        if (status === 'Discharging') return true;
        if (!['Charging', 'Full', 'Not charging'].includes(status)) return null;
        charging ||= status === 'Charging';
      } else {
        // An unknown type or a UPS is not proof of an ordinary AC adapter.
        if (!EXTERNAL_POWER_TYPES.has(type)) return null;
        const state = read(name, 'online');
        // USB programmable supplies report 2 rather than 1 when online.
        if (!['0', '1', '2'].includes(state)) return null;
        online.push(state !== '0');
      }
    }
    if (batteries === 0) return false;
    if (online.some(Boolean)) return false;
    // A charging battery proves external supply when no adapter is exposed;
    // contradictory charging/offline readings may straddle a transition.
    if (charging) return online.length ? null : false;
    return online.length ? true : null;
  } catch { return null; }
}

// Native cumulative CPU counters: no PowerShell process, provider probe,
// registry scan or filesystem access per sample. One elapsed interval is
// required; the first reading correctly carries an unknown CPU value.
function createResourceSampler({ cpus = os.cpus, freeMemory = os.freemem, totalMemory = os.totalmem, now = Date.now } = {}) {
  let previous = null;
  return function sample({ loopLagMs = null } = {}) {
    const atMs = now();
    try {
      const cores = cpus();
      if (!Array.isArray(cores) || !cores.length) throw new Error('CPU counters unavailable');
      let idle = 0;
      let total = 0;
      for (const core of cores) {
        if (!core?.times || !Object.values(core.times).every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid CPU counters');
        idle += core.times.idle;
        total += Object.values(core.times).reduce((sum, value) => sum + value, 0);
      }
      let cpuPercent = null;
      const elapsed = previous ? atMs - previous.atMs : 0;
      const dt = previous ? total - previous.total : 0;
      const di = previous ? idle - previous.idle : 0;
      if (previous?.cores === cores.length && elapsed >= 250 && elapsed <= 10000 && dt > 0 && di >= 0 && di <= dt) {
        cpuPercent = Math.round((1 - di / dt) * 10000) / 100;
      }
      previous = { atMs, total, idle, cores: cores.length };
      return { atMs, cpuPercent, freeBytes: freeMemory(), totalBytes: totalMemory(), logicalProcessors: cores.length, loopLagMs };
    } catch {
      previous = null;
      return { atMs, cpuPercent: null, freeBytes: null, totalBytes: null, logicalProcessors: null, loopLagMs };
    }
  };
}

module.exports = Object.freeze({ createResourceSampler, readOnBattery });
