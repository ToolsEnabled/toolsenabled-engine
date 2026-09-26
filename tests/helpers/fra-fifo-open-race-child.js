'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FraWorkspaceHandleBroker } = require('../../src/lib/providers/fra-workspace-handles');

const [root, victim, fifo] = process.argv.slice(2);
if (!root || !victim || !fifo) {
  process.stderr.write('fifo race child requires root, victim and fifo\n');
  process.exitCode = 2;
} else {
  let swapped = false;
  const fsApi = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (targetPath, flags, ...rest) => {
          if (!swapped && path.resolve(targetPath) === path.resolve(victim)) {
            fs.renameSync(targetPath, `${targetPath}.retained`);
            fs.renameSync(fifo, targetPath);
            swapped = true;
          }
          return fs.openSync(targetPath, flags, ...rest);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  try {
    const broker = new FraWorkspaceHandleBroker({ root, fsApi });
    broker._openIdentity(victim, 'file');
    process.stderr.write('fifo replacement was opened\n');
    process.exitCode = 3;
  } catch (error) {
    if (error && ['WORKSPACE_HANDLE_KIND_MISMATCH', 'WORKSPACE_HANDLE_STALE'].includes(error.code)) {
      process.stdout.write('fifo replacement refused\n');
    } else {
      process.stderr.write(`${error?.code || error?.name || 'unknown'}\n`);
      process.exitCode = 4;
    }
  }
}
