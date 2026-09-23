'use strict';

/*
 * T867 composition fixture. This module is deliberately independent of node:test:
 * callers obtain a real owner-request-store and MinorLedgerAgentControl backed by
 * a retained Map filesystem, then pass readTasks() to the real continuation
 * controller. Map entries are retained for the caller; only store lock/stage
 * entries may be unlinked by the store's normal atomic-write protocol.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

const engineRoot = process.env.T850_ENGINE_ROOT || path.resolve(__dirname, '..', '..');
const engineLib = path.join(engineRoot, 'src', 'lib');
const workLib = path.resolve(__dirname, '..', '..', 'src', 'lib');
const baseLib = engineLib;
const candidateLib = workLib;

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function createMemoryFs(root) {
  const files = new Map();
  const descriptors = new Map();
  let serial = 0;
  let nextDescriptor = 10;

  function touch(row) {
    row.mtimeNs = row.ctimeNs = BigInt(++serial) * 1000000n;
  }

  function put(file, value) {
    const row = files.get(file) || { ino: ++serial, bytes: Buffer.alloc(0) };
    row.bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value));
    touch(row);
    files.set(file, row);
    return row;
  }

  function rowFor(file) {
    const row = typeof file === 'number'
      ? descriptors.get(file)?.row
      : files.get(file);
    if (!row) throw codedError('ENOENT');
    return row;
  }

  function statFor(file) {
    const row = rowFor(file);
    return {
      size: row.bytes.length,
      dev: 1,
      ino: row.ino,
      mtimeNs: row.mtimeNs,
      ctimeNs: row.ctimeNs,
      mtimeMs: Number(row.mtimeNs) / 1e6,
      ctimeMs: Number(row.ctimeNs) / 1e6,
      isFile: () => true
    };
  }

  const memory = {
    mkdirSync() {},
    existsSync: file => files.has(file),
    statSync: statFor,
    lstatSync: statFor,
    fstatSync: statFor,
    readFileSync(file, encoding) {
      const bytes = Buffer.from(rowFor(file).bytes);
      return encoding
        ? bytes.toString(typeof encoding === 'string' ? encoding : encoding.encoding)
        : bytes;
    },
    writeFileSync(file, value, options = {}) {
      if (typeof file === 'number') {
        const row = rowFor(file);
        row.bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value));
        touch(row);
        return;
      }
      if (options && options.flag === 'wx' && files.has(file)) {
        throw codedError('EEXIST');
      }
      put(file, value);
    },
    openSync(file, flag) {
      if (flag === 'wx' && files.has(file)) throw codedError('EEXIST');
      let row = files.get(file);
      if (!row && flag === 'r') throw codedError('ENOENT');
      if (!row) row = put(file, '');
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, { file, row, append: flag === 'a' });
      return descriptor;
    },
    writeSync(descriptor, value) {
      const handle = descriptors.get(descriptor);
      if (!handle) throw codedError('EBADF');
      const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value));
      handle.row.bytes = handle.append
        ? Buffer.concat([handle.row.bytes, bytes])
        : bytes;
      touch(handle.row);
      return bytes.length;
    },
    readSync(descriptor, buffer, offset, length, position) {
      const bytes = rowFor(descriptor).bytes;
      return bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length));
    },
    fsyncSync() {},
    closeSync(descriptor) {
      if (!descriptors.delete(descriptor)) throw codedError('EBADF');
    },
    linkSync(from, to) {
      if (files.has(to)) throw codedError('EEXIST');
      files.set(to, rowFor(from));
    },
    renameSync(from, to) {
      const row = rowFor(from);
      files.set(to, row);
      files.delete(from);
      touch(row);
    },
    unlinkSync(file) {
      if (!files.delete(file)) throw codedError('ENOENT');
    }
  };

  return { memory, files, descriptors, root };
}

function loadSource(file, overrides = {}, cache = new Map(), requireLib = engineLib) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const source = fs.readFileSync(absolute, 'utf8');
  const module = { exports: {} };
  cache.set(absolute, module);
  const sourceRequire = Module.createRequire(path.join(requireLib, path.basename(absolute)));
  const localRequire = id => {
    if (overrides[id]) return overrides[id]();
    if ((id.endsWith('/runtime-state-root') || id === './runtime-state-root')
      && overrides['./runtime-state-root']) {
      return overrides['./runtime-state-root']();
    }
    return sourceRequire(id);
  };
  const wrapper = vm.runInThisContext(
    '(function(require,module,exports,__filename,__dirname){\n' + source + '\n})',
    { filename: absolute }
  );
  wrapper(localRequire, module, module.exports, absolute, path.dirname(absolute));
  return module.exports;
}

function createMapLedgerFixture({ variant = 'candidate', label = 'composition', verifyHistory = false, lib: candidateLibOverride = null, engine: engineRootOverride = null } = {}) {
  if (variant !== 'candidate' && variant !== 'base') {
    throw new TypeError('variant must be candidate or base');
  }
  const fixtureEngineRoot = engineRootOverride || engineRoot;
  const fixtureEngineLib = path.join(fixtureEngineRoot, 'src', 'lib');
  const fixtureCandidateLib = candidateLibOverride || candidateLib;
  const root = path.join('/t850-map-ledger', label + '-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
  const retained = createMemoryFs(root);
  const selectedLib = variant === 'candidate' ? fixtureCandidateLib : fixtureEngineLib;
  const helper = loadSource(path.join(fixtureCandidateLib, 'task-waiting.js'), {}, new Map(), fixtureEngineLib);
  const cache = new Map();
  let store;
  const loadStore = () => {
    if (!store) {
      store = loadSource(path.join(selectedLib, 'owner-request-store.js'), {
        'node:fs': () => retained.memory,
        './task-waiting': () => helper,
        './runtime-state-root': () => ({ statePath: (...parts) => path.join(root, ...parts) })
      }, cache, fixtureEngineLib);
    }
    return store;
  };
  const storeModule = loadStore();
  const opts = {
    rootPath: (...parts) => path.join(root, ...parts),
    loadSettings: () => ({
      values: { 'ledger.verify_history': verifyHistory },
      provenance: { 'ledger.verify_history': { source: 't867-map-fixture' } }
    })
  };
  const ledgerFile = storeModule.ledgerFileFor(opts);
  const historyFile = storeModule.historyFileFor(opts);
  const reader = Object.freeze({
    readAll: query => storeModule.readAll({ ...query, ...opts }),
    verifyHistory: () => storeModule.verifyHistory(opts)
  });
  const readWorkOptions = Object.freeze({ store: reader, readSettings: opts.loadSettings });
  let gateModule;
  const loadGate = () => {
    if (!gateModule) {
      gateModule = loadSource(path.join(selectedLib, 'minor-ledger-agent-gate.js'), {
        'node:fs': () => retained.memory,
        './owner-request-store': () => storeModule,
        './task-waiting': () => helper,
        './runtime-state-root': () => ({ statePath: (...parts) => path.join(root, ...parts) })
      }, cache, fixtureEngineLib);
    }
    return gateModule;
  };
  const readTasks = () => storeModule.readAll({ ...opts, kinds: ['T'] }).records;
  const findTask = id => readTasks().find(record => record.id === id) || null;
  const progress = args => storeModule.progressTask(args, opts);
  const complete = args => storeModule.completeTask(args, opts);
  const fileTask = args => storeModule.fileTask(args, opts);
  const gate = ({ auditRequireAsync = async () => ({ durable: true }), loadSettings = opts.loadSettings } = {}) => {
    const Control = loadGate().MinorLedgerAgentControl;
    return new Control({
      store: storeModule,
      ledgerOptions: opts,
      loadSettings,
      auditRequireAsync
    });
  };
  return Object.freeze({
    variant,
    root,
    files: retained.files,
    descriptors: retained.descriptors,
    memory: retained.memory,
    opts,
    store: storeModule,
    reader,
    readWorkOptions,
    ledgerFile,
    historyFile,
    readTasks,
    findTask,
    fileTask,
    progress,
    complete,
    gate,
    readLedger: () => JSON.parse(Buffer.from(retained.files.get(ledgerFile).bytes).toString('utf8')),
    readHistory: () => Buffer.from(retained.files.get(historyFile).bytes).toString('utf8'),
    fileBytes: file => retained.files.get(file)?.bytes ? Buffer.from(retained.files.get(file).bytes) : null
  });
}

function createMemoryWorld({ lib = null, engine = null, label = 'composition-world', variant = 'candidate' } = {}) {
  const fixture = createMapLedgerFixture({ variant, label, lib, engine });
  return Object.freeze({ ...fixture, control: fixture.gate(), options: fixture.opts });
}

module.exports = { createMapLedgerFixture, createMemoryWorld };
