'use strict';

/* WHAT ONE TICK OF THE APPLICATION'S TREE COURIER COSTS THE ELECTRON MAIN
 * THREAD, WITH THE RUNTIME MEMO HITTING AND WITH IT MISSING.
 *
 * WHY THIS FILE EXISTS. src/lib/providers/agent-comms-local.js grew a memo on
 * 2026-09-02 to stop what its own header calls "a standing rebuild storm on the
 * Electron main thread": the desktop application polls every live tree session
 * every TREE_POLL_MS and calls provider.inbox() for each, and each call used to
 * build a whole runtime -- the control-plane snapshot out of sqlite, the
 * declared-agent file, the presence file, and a rewrite of the machine-wide
 * broker file under its claim-directory lock.
 *
 * THE MEMO'S WINDOW WAS SHORTER THAN THE POLL THAT IS ITS ONLY CALLER.
 * RUNTIME_MEMO_MS was 1,000 ms; the application's TREE_POLL_MS (desktop-app
 * shell/agent-host.cjs) is 1,200 ms. The memo therefore hit for sessions 2..N
 * WITHIN one tick and expired BETWEEN every pair of ticks, so the rebuild it was
 * written to remove still happened once every tick, for as long as any circle
 * was on the tree. The memo's own comment said its lifetime bounds staleness "to
 * the same second the poll already rounds to" -- the poll does not round to a
 * second, which was the whole of the defect.
 *
 * FIXED 2026-09-03: RUNTIME_MEMO_MS is 30,000 ms, argued in the memo's own
 * comment from the floor (the poll period) and the ceiling (what the memo key
 * cannot already see). RE-MEASURED here after the change, same 8 nodes, same
 * machine: spaced median 14.5 ms, back to back median 14.3 ms -- 0.3 ms apart,
 * i.e. the two arms became the same measurement, which is what a memo that
 * outlives the poll looks like. Both arms drifted up in absolute terms because
 * nineteen other build lanes were running; the collapse of the DIFFERENCE from
 * ~15 ms to ~0.3 ms is the result, not the medians.
 *
 * THE TWO ARMS ARE KEPT ANYWAY. They are how anyone re-establishes the relation
 * between the poll period and the lifetime if either number moves again: an arm
 * gap that reopens means the lifetime has fallen back under the poll.
 *
 * WHAT IT MEASURES. Two arms, identical work, differing only in whether the
 * ticks are spaced by the real poll interval (memo expires) or run back to back
 * (memo hits). Pass `reverse` to swap the arm order and rule out warm-cache
 * effects; measured 2026-09-03 the difference held either way.
 *
 * MEASURED 2026-09-03 AT THE OLD 1,000 ms LIFETIME, 8 registered tree nodes,
 * scratch state root, this machine:
 *
 *   spaced by 1,200 ms (shipped)   median 21.3-23.5 ms per tick
 *   back to back (memo hits)       median  6.2- 8.8 ms per tick
 *   -> ~15 ms of main-thread work per 1,200 ms tick, continuously, while
 *      any circle is on the tree
 *
 * A WALL-CLOCK MEDIAN IS NOT THE STRONGEST FORM OF THIS MEASUREMENT, and on a
 * loaded machine it is not even a stable one. The exact rebuild count for the
 * same workload -- the courier driven on an injected clock -- is 49 rebuilds
 * per simulated minute at 1,000 ms against 1 at 30,000 ms, for 400 calls
 * either way. That count is what the memo's comment quotes.
 *
 * IT NEVER TOUCHES A LIVE STORE. The state root is given on the command line
 * and must be a directory this tool may create; point it somewhere scratch.
 *
 * Usage:
 *   node tools/measure-tree-courier-tick.js <state-root> [agents] [ticks] [reverse]
 */

const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');
/* The application's poll interval, quoted rather than derived: it lives in the
   desktop application's shell/agent-host.cjs, which this tree cannot import.
   If that number moves, this one has to move with it or the measurement stops
   describing the thing it is named after. */
const APP_TREE_POLL_MS = 1_200;

const stateRoot = process.argv[2];
const AGENTS = Number(process.argv[3] || 8);
const TICKS = Number(process.argv[4] || 8);
const REVERSED = process.argv[5] === 'reverse';

if (!stateRoot || !path.isAbsolute(stateRoot)) {
  console.error('usage: node tools/measure-tree-courier-tick.js <absolute-scratch-state-root> [agents] [ticks] [reverse]');
  process.exitCode = 2;
  return;
}

fs.mkdirSync(stateRoot, { recursive: true });
process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
process.env.TOOLSENABLED_HOME = stateRoot;

const providerModule = require(path.join(REPO_ROOT, 'src', 'lib', 'providers', 'agent-comms-local.js'));
const directoryModule = require(path.join(REPO_ROOT, 'src', 'lib', 'agent-comms', 'tree-node-directory.js'));

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

(async () => {
  const directory = directoryModule.createTreeNodeDirectory();
  const agentIds = [];
  for (let index = 0; index < AGENTS; index += 1) {
    try {
      const entry = directory.registerNode({
        sessionId: `measure-session-${index}`,
        nodeName: `measure-node-${index}`,
        managerName: index === 0 ? null : 'measure-node-0',
        pid: process.pid
      });
      agentIds.push(entry && (entry.agentId || (entry.node && entry.node.agentId)));
    } catch (error) {
      console.log(`registerNode ${index} refused: ${error && error.code}`);
    }
  }
  const live = agentIds.filter(Boolean);
  console.log(`registered ${live.length} tree node(s) under ${stateRoot}`);
  if (live.length === 0) { console.log('nothing registered; cannot measure'); return; }

  const provider = providerModule.createLocalAgentMessageProvider({ directory });

  // The first build pays module init and the sqlite open once; not a tick.
  await provider.inbox({ agentId: live[0], cursor: 0, limit: 10 });

  async function arm(label, pauseMs) {
    const samples = [];
    for (let tick = 0; tick < TICKS; tick += 1) {
      const started = process.hrtime.bigint();
      for (const agentId of live) {
        await provider.inbox({ agentId, cursor: 0, limit: 10 });
      }
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
    const value = median(samples);
    console.log(`\n${label}`);
    console.log(`  ${TICKS} tick(s), ${live.length} session(s): median ${value.toFixed(1)} ms per tick`);
    console.log(`  values: ${samples.map(sample => sample.toFixed(1)).sort((a, b) => a - b).join(', ')}`);
    return value;
  }

  const MISS = `SPACED BY THE APPLICATION'S ${APP_TREE_POLL_MS} ms POLL -- the memo expires between ticks (shipped)`;
  const HIT = 'BACK TO BACK -- the memo hits';

  let missMedian;
  let hitMedian;
  if (REVERSED) {
    hitMedian = await arm(HIT, 0);
    missMedian = await arm(MISS, APP_TREE_POLL_MS);
  } else {
    missMedian = await arm(MISS, APP_TREE_POLL_MS);
    hitMedian = await arm(HIT, 0);
  }

  console.log(`\nmain-thread work the expiry costs: ${(missMedian - hitMedian).toFixed(1)} ms per ${APP_TREE_POLL_MS} ms tick`);
})().catch(error => { console.error(error); process.exitCode = 1; });
