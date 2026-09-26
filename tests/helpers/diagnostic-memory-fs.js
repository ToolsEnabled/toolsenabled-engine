'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

function memoryFs() {
  const files = new Map(), dirs = new Set(), links = new Set(), unlinks = [];
  let serial = 0, directoryReads = 0;
  const error = code => Object.assign(new Error(code), { code });
  const lookup = file => { const row = files.get(file); if (!row) throw error('ENOENT'); return row; };
  function writeFileSync(file, data, options = {}) {
    if (options.flag === 'wx' && files.has(file)) throw error('EEXIST');
    files.set(file, { text: String(data), ino: ++serial, mtimeMs: serial });
  }
  function lstatSync(file) {
    if (dirs.has(file)) return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => links.has(file) };
    const row = lookup(file);
    return { size: row.size ?? Buffer.byteLength(row.text), dev: 1, ino: row.ino, mtimeMs: row.mtimeMs, nlink: 1,
      isDirectory: () => false, isFile: () => true, isSymbolicLink: () => links.has(file) };
  }
  const fs = {
    constants: { COPYFILE_EXCL: 1 }, files, dirs, links, unlinks,
    mkdirSync: file => dirs.add(file), lstatSync, realpathSync: file => file,
    writeFileSync, readFileSync: file => lookup(file).text,
    appendFileSync(file, line) { const row = lookup(file); row.text += line; row.mtimeMs = ++serial; },
    renameSync(from, to) { const row = lookup(from); files.set(to, row); files.delete(from); row.mtimeMs = ++serial; },
    directoryReads: () => directoryReads,
  };
  fs.promises = {
    lstat: async file => lstatSync(file), realpath: async file => file,
    readFile: async file => lookup(file).text, mkdir: async (file, options = {}) => { if (!options.recursive && dirs.has(file)) throw error('EEXIST'); dirs.add(file); },
    rename: async (from, to) => fs.renameSync(from, to),
    unlink: async file => { lookup(file); unlinks.push(file); files.delete(file); },
    open: async (file, flag) => { writeFileSync(file, '', { flag }); return { close: async () => {} }; },
    copyFile: async (from, to) => { writeFileSync(to, lookup(from).text, { flag: 'wx' }); },
    opendir: async root => {
      const names = [...files.keys()].filter(file => path.dirname(file) === root).map(file => path.basename(file));
      let index = 0, closed = false;
      return { async read() { assert.equal(closed, false); directoryReads++; const name = names[index++]; return name ? { name, isFile: () => true } : null; },
        async close() { closed = true; } };
    },
  };
  return fs;
}
module.exports = { memoryFs };
