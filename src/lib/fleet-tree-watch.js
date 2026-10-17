'use strict';

const store = require('./openshell-tree-store');
const { projectTrees } = require('./fleet-tree-view');

// The watcher reads the same private files as a one-shot tree command. It
// emits only when the public view changes, so server-private inbox/brief
// updates do not leak through timing or produce unnecessary UI work.
function watchTrees({ readTrees, jsonLines = false, output = process.stdout,
  intervalMs = 500, signal } = {}) {
  if (typeof readTrees !== 'function') throw new TypeError('readTrees is required');
  const ownController = signal ? null : new AbortController();
  const watchSignal = signal || ownController.signal;
  return new Promise((resolve, reject) => {
    let timer = null;
    let ended = false;
    let previous = null;
    const onProcessSignal = () => ownController.abort();
    const finish = error => {
      if (ended) return;
      ended = true;
      if (timer) clearInterval(timer);
      watchSignal.removeEventListener('abort', onAbort);
      if (ownController) {
        process.removeListener('SIGINT', onProcessSignal);
        process.removeListener('SIGTERM', onProcessSignal);
      }
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish();
    const tick = () => {
      try {
        const trees = readTrees();
        const publicJson = JSON.stringify(projectTrees(trees));
        if (publicJson === previous) return;
        previous = publicJson;
        if (jsonLines) output.write(`${publicJson}\n`);
        else {
          const frame = `${store.formatTrees(trees).join('\n')}\n`;
          output.write(output.isTTY ? `\x1b[H\x1b[2J${frame}` : `${frame}\n`);
        }
      } catch (error) { finish(error); }
    };
    watchSignal.addEventListener('abort', onAbort, { once: true });
    if (ownController) {
      process.once('SIGINT', onProcessSignal);
      process.once('SIGTERM', onProcessSignal);
    }
    if (watchSignal.aborted) { finish(); return; }
    tick();
    if (!ended) timer = setInterval(tick, intervalMs);
  });
}

module.exports = { watchTrees };
