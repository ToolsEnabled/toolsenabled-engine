'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pickFastModel, pickModel } = require('../../src/lib/model-picker');
const model = require('../../src/lib/providers/model');
const role = require('../../src/lib/providers/model-role');
const strong = require('../../src/lib/providers/research-strong');
const monitor = require('../../src/lib/agent-resource-monitor');

const modelPath = path.resolve(__dirname, '../../src/lib/providers/model.js');

function probeWithoutPath() {
  const emptyPath = mkdtempSync(path.join(tmpdir(), 'f47-empty-path-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path')
  );
  environment.PATH = emptyPath;
  try {
    return JSON.parse(execFileSync(process.execPath, [
      '-e',
      'const model = require(process.argv[1]); process.stdout.write(JSON.stringify(model.probeResources()));',
      modelPath
    ], { encoding: 'utf8', env: environment, windowsHide: true }));
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
}

function pickerProbe(freeVramBytes, overrides = {}) {
  return {
    ollamaReachable: true,
    installedModels: ['gpt-oss:20b', 'qwen3.5:9b', 'qwen3.5:4b'],
    residentModels: [], freeRamBytes: 32 * (1024 ** 3), freeVramBytes, onBattery: false,
    ...overrides
  };
}

function strongProbe(freeVramBytes) {
  return {
    ollamaReachable: true, installedModels: [strong.STRONG_MODEL], residentModels: [],
    freeRamBytes: 32 * (1024 ** 3), freeVramBytes, onBattery: false
  };
}

test('an absent nvidia-smi is unmeasurable and probeResources preserves null', () => {
  const resources = probeWithoutPath();
  assert.equal(Object.hasOwn(resources, 'freeVramBytes'), true);
  assert.equal(resources.freeVramBytes, null);
  assert.equal(Number.isNaN(resources.freeVramBytes), false);
});

test('probeLocalModel keeps its existing fail-closed null coercion', async () => {
  const resources = await model.probeLocalModel({
    requestJson: async pathname => pathname === '/api/tags'
      ? { models: [{ name: 'qwen3.5:4b' }] }
      : { models: [] },
    probeResources: () => ({ freeRamBytes: 1, freeVramBytes: null, onBattery: false })
  });
  assert.equal(resources.freeVramBytes, 0);
});

test('probeLocalModel preserves unknown power and cannot enable an AC-only model', async () => {
  for (const power of [null, undefined, 0, 'false']) {
    const resources = await model.probeLocalModel({
      requestJson: async pathname => pathname === '/api/tags'
        ? { models: [{ name: 'qwen3.5:9b' }] } : { models: [] },
      probeResources: () => ({ freeRamBytes: 32 * (1024 ** 3), freeVramBytes: 8 * (1024 ** 3), onBattery: power })
    });
    assert.equal(resources.onBattery, null);
    assert.deepEqual(pickModel(resources), {
      available: false, code: 'MODEL_UNAVAILABLE', reason: 'battery_status_unknown'
    });
  }
});

test('the default model resource probe reads native Linux battery evidence', () => {
  const emptyPath = mkdtempSync(path.join(tmpdir(), 'model-power-empty-path-'));
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'));
    environment.PATH = emptyPath;
    const child = `
      const fs = require('node:fs');
      const originalRead = fs.readFileSync, originalList = fs.readdirSync;
      const files = { 'BAT0/type': 'Battery', 'BAT0/present': '1', 'BAT0/status': 'Discharging',
        'AC0/type': 'Mains', 'AC0/online': '0' };
      const reads = [];
      const prefix = '/sys/class/power_supply';
      const portable = value => String(value).replaceAll('\\\\', '/');
      fs.readdirSync = function (file, ...args) {
        if (portable(file) === prefix) return ['BAT0', 'AC0'];
        return originalList.call(this, file, ...args);
      };
      fs.readFileSync = function (file, ...args) {
        if (!portable(file).startsWith(prefix + '/')) return originalRead.call(this, file, ...args);
        const relative = portable(file).slice(prefix.length + 1); reads.push(relative);
        if (!(relative in files)) throw Object.assign(new Error('absent fixture property'), { code: 'ENOENT' });
        return files[relative] + '\\n';
      };
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const model = require(process.argv[1]);
      process.stdout.write(JSON.stringify({ resources: model.probeResources(), reads }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', child, modelPath], {
      encoding: 'utf8', env: environment, windowsHide: true, timeout: 15_000
    }));
    assert.equal(result.resources.onBattery, true, 'Linux discharging state must not be relabeled AC');
    assert.ok(result.reads.includes('BAT0/status'), 'the default provider must delegate to the native power reader');
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
});

function powerFiles(supplies, { unreadable = null, inventoryError = null } = {}) {
  return {
    readdirSync(directory) {
      assert.equal(directory, '/sys/class/power_supply');
      if (inventoryError) throw Object.assign(new Error('power inventory unavailable'), { code: inventoryError });
      return Object.keys(supplies);
    },
    readFileSync(file, encoding) {
      assert.equal(encoding, 'utf8');
      const prefix = '/sys/class/power_supply/';
      assert.ok(file.startsWith(prefix));
      const relative = file.slice(prefix.length);
      if (relative === unreadable) throw Object.assign(new Error('power property unreadable'), { code: 'EACCES' });
      const [supply, property] = relative.split('/');
      if (!Object.hasOwn(supplies[supply], property)) throw Object.assign(new Error('absent optional property'), { code: 'ENOENT' });
      return `${supplies[supply][property]}\n`;
    }
  };
}

const battery = (status, fields = {}) => ({ type: 'Battery', present: '1', status, ...fields });
const mains = online => ({ type: 'Mains', online });
const powerCases = [
  ['charging on AC', { BAT0: battery('Charging'), AC0: mains('1') }, false],
  ['full on AC', { BAT0: battery('Full'), AC0: mains('1') }, false],
  ['battery present and AC offline', { BAT0: battery('Not charging'), AC0: mains('0') }, true],
  ['discharging without an adapter', { BAT0: battery('Discharging') }, true],
  ['forced discharge while AC is online', { BAT0: battery('Discharging'), AC0: mains('1') }, true],
  ['missing present means present', { BAT0: { type: 'Battery', status: 'Discharging' } }, true],
  ['battery slot empty', { BAT0: { type: 'Battery', present: '0' }, AC0: mains('1') }, false],
  ['no system battery', { AC0: mains('1') }, false],
  ['empty readable inventory', {}, false],
  ['peripheral batteries only', { mouse: { type: 'Battery', scope: 'Device', status: 'Discharging' } }, false],
  ['peripheral USB cannot report computer AC', { BAT0: battery('Full'), AC0: mains('0'), phone: { type: 'USB', scope: 'Device', online: '1' } }, true],
  ['programmable USB supplies power', { BAT0: battery('Full'), USB0: { type: 'USB', online: '2' } }, false],
  ['full does not prove AC', { BAT0: battery('Full') }, null],
  ['charging proves supply without adapter data', { BAT0: battery('Charging') }, false],
  ['contradictory charging and offline adapter', { BAT0: battery('Charging'), AC0: mains('0') }, null],
  ['unknown battery status', { BAT0: battery('Unknown'), AC0: mains('1') }, null],
  ['invalid online value', { BAT0: battery('Full'), AC0: mains('yes') }, null],
  ['unknown supply type does not prove AC', { supply: { type: 'Unknown', online: '1' } }, null],
  ['UPS output alone does not prove AC input', { supply: { type: 'UPS', online: '1' } }, null],
  ['invalid battery presence', { BAT0: battery('Full', { present: 'unknown' }) }, null],
  ['missing system battery status', { BAT0: { type: 'Battery', present: '1' }, AC0: mains('1') }, null]
];

for (const [name, supplies, expected] of powerCases) {
  test(`Linux power observation: ${name}`, () => {
    assert.equal(monitor.readOnBattery({ platform: 'linux', filesystem: powerFiles(supplies) }), expected);
  });
}

test('Linux unreadable or absent power inventory stays unknown', () => {
  for (const inventoryError of ['ENOENT', 'EACCES']) {
    assert.equal(monitor.readOnBattery({ platform: 'linux', filesystem: powerFiles({}, { inventoryError }) }), null);
  }
  assert.equal(monitor.readOnBattery({ platform: 'linux',
    filesystem: powerFiles({ BAT0: battery('Full'), AC0: mains('1') }, { unreadable: 'BAT0/status' }) }), null);
});

test('Windows power readings preserve measured states and keep failed probes unknown', () => {
  for (const [output, expected] of [['desktop', false], ['ac', false], ['battery', true], ['', null], ['unknown', null]]) {
    assert.equal(monitor.readOnBattery({ platform: 'win32', commandText(command, args) {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
      assert.match(args[3], /-ErrorAction Stop/);
      return output;
    } }), expected);
  }
  assert.equal(monitor.readOnBattery({ platform: 'win32', commandText() { throw new Error('query failed'); } }), null);
  assert.equal(monitor.readOnBattery({ platform: 'darwin', filesystem: powerFiles({}) }), null);
});

test('native power observations reach both AC-only model decisions without changing the shared policy', async () => {
  for (const [supplies, expectedTier] of [
    [{ BAT0: battery('Full'), AC0: mains('1') }, 'slow-batch'],
    [{ BAT0: battery('Full'), AC0: mains('0') }, 'workhorse'],
    [{ BAT0: battery('Unknown') }, 'workhorse']
  ]) {
    const resources = await model.probeLocalModel({
      requestJson: async pathname => pathname === '/api/tags'
        ? { models: ['gpt-oss:20b', 'qwen3.5:9b', 'qwen3.5:4b'].map(name => ({ name })) } : { models: [] },
      probeResources: () => ({ freeRamBytes: 32 * (1024 ** 3), freeVramBytes: 8 * (1024 ** 3),
        onBattery: monitor.readOnBattery({ platform: 'linux', filesystem: powerFiles(supplies) }) })
    });
    assert.equal(pickModel(resources, { allowSlowTier: true, batch: true }).tier, expectedTier);
    assert.equal(pickModel(resources).tier, expectedTier === 'slow-batch' ? 'high-capacity' : 'workhorse');
  }
});

test('model-role rejects an unmeasurable VRAM snapshot with its typed error', () => {
  assert.throws(() => role.pickModel({
    installedModels: ['qwen3:8b'], residentModels: [], freeVramBytes: null
  }, 'qwen3:8b'), error => error && error.code === 'MODEL_ROLE_UNAVAILABLE');
});

test('research-strong rejects null through readiness and both real call sites', async () => {
  const resources = strongProbe(null);
  assert.throws(() => strong.readiness(resources, 55, true),
    error => error && error.code === 'STRONG_PROBE_UNAVAILABLE');
  await assert.rejects(strong.complete({ prompt: 'bounded strong work' }, {
    assertAllowed() {}, probe: async () => resources, gpuTemperatureC: () => 55
  }), error => error && error.code === 'STRONG_PROBE_UNAVAILABLE');
  await assert.rejects(strong.status({
    probe: async () => resources, gpuTemperatureC: () => 55,
    policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
  }), error => error && error.code === 'STRONG_PROBE_UNAVAILABLE');
});

test('model pickers make the same tier decisions for null and measured zero', () => {
  for (const overrides of [{}, { residentModels: ['qwen3.5:4b'] }]) {
    const zero = pickerProbe(0, overrides);
    const unmeasurable = pickerProbe(null, overrides);
    assert.deepEqual(pickModel(unmeasurable, { allowSlowTier: true, batch: true }),
      pickModel(zero, { allowSlowTier: true, batch: true }));
    assert.deepEqual(pickFastModel(unmeasurable), pickFastModel(zero));
  }
});
