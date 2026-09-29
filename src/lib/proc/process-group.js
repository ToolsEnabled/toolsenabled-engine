'use strict';

// Ending a worker's whole process tree inside an OpenShell sandbox, without
// pidfd.
//
// The engine's usual custodian (src/lib/linux-process-control.js) supervises a
// provider's process tree through pidfd_open, and OpenShell's seccomp profile
// answers pidfd_open with ENOSYS. So inside a sandbox each worker is started as
// the leader of its own process group instead (a new session), and it is ended
// here, by group and by descendant, from what /proc says at the moment of the
// stop:
//
//   1. Read the process table once and take the worker's leader, every process
//      below it, and every process group any of them lead or belong to. A
//      provider CLI can move a helper into a group of its own (tool runners do),
//      so the group of the leader alone is not the whole tree.
//   2. SIGTERM every one of those groups and processes.
//   3. Wait a bounded grace for them to go, checking each by pid AND start time
//      so a recycled pid is never mistaken for a survivor or killed in its
//      place.
//   4. SIGKILL whatever is left, including anything that started below a
//      survivor during the grace.
//
// A worker that the MCP server could not stop itself (the server was killed
// outright) is found again by the same pid and start time when the tree is
// next loaded, and ended then (see src/lib/openshell-tree-store.js).
//
// Linux only. Nothing here starts a process.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_GRACE_MS = 3_000;
const POLL_MS = 50;

function parseStat(text) {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt
  // cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime
  // comm may itself contain spaces and parentheses, so fields are read after
  // the LAST closing parenthesis.
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const pid = Number.parseInt(text.slice(0, text.indexOf(' ')), 10);
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number.parseInt(fields[1], 10);
  const pgid = Number.parseInt(fields[2], 10);
  const startTime = fields[19];
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !startTime) return null;
  return Object.freeze({ pid, ppid, pgid, state, startTime });
}

/** Every live process /proc lists, keyed by pid. Zombies are kept: they still hold a pid. */
function readProcessTable({ procRoot = '/proc', fileSystem = fs } = {}) {
  const table = new Map();
  let entries;
  try { entries = fileSystem.readdirSync(procRoot); } catch { return table; }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let text;
    try { text = fileSystem.readFileSync(path.join(procRoot, entry, 'stat'), 'utf8'); } catch { continue; }
    const row = parseStat(text);
    if (row) table.set(row.pid, row);
  }
  return table;
}

/** The start time of one pid, or null when it no longer exists. */
function processStartTime(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const { procRoot = '/proc', fileSystem = fs } = options;
  try {
    const row = parseStat(fileSystem.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8'));
    return row && row.state !== 'Z' && row.state !== 'X' ? row.startTime : null;
  } catch {
    return null;
  }
}

/** True when this pid is still the very process first seen with that start time. */
function sameProcessAlive(pid, startTime, options = {}) {
  const current = processStartTime(pid, options);
  return current !== null && (startTime === null || startTime === undefined || current === String(startTime));
}

/** The leader and everything below it, by parent links, from one table read. */
function treeOf(rootPid, table) {
  const children = new Map();
  for (const row of table.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const found = [];
  const seen = new Set();
  const queue = table.has(rootPid) ? [table.get(rootPid)] : [];
  while (queue.length > 0) {
    const row = queue.shift();
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    found.push(row);
    for (const child of children.get(row.pid) || []) queue.push(child);
  }
  return found;
}

function send(kill, target, signal) {
  try { kill(target, signal); return true; } catch { return false; }
}

/**
 * End one worker's process tree. `pid` is the group leader the worker was
 * started as; `startTime` (from /proc) proves it is still that process. Never
 * signals this process's own group, and never a pid below 2.
 *
 * Resolves with what was signalled and what, if anything, was still there after
 * the final SIGKILL (normally nothing).
 */
async function terminateProcessTree({ pid, startTime = null } = {}, {
  graceMs = DEFAULT_GRACE_MS,
  kill = process.kill.bind(process),
  readTable = readProcessTable,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ownGroup = safeOwnGroup(),
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 2) return Object.freeze({ signalled: [], survivors: [] });
  const first = readTable();
  const leader = first.get(pid);
  const expected = startTime === null || startTime === undefined ? null : String(startTime);
  // A pid that now belongs to a different process means the worker's group is
  // gone: Linux does not hand out a number still in use as a process group.
  if (leader && expected !== null && leader.startTime !== expected) return Object.freeze({ signalled: [], survivors: [] });
  // Everything below the leader, and every member of its group even when the
  // leader is gone or a member was reparented away from it.
  const seeds = [...(leader ? [leader] : []), ...[...first.values()].filter(row => row.pgid === pid)];
  let members = [...new Map(seeds.flatMap(row => treeOf(row.pid, first)).map(row => [row.pid, row])).values()];
  if (members.length === 0) return Object.freeze({ signalled: [], survivors: [] });
  const groups = () => [...new Set(members.map(row => row.pgid))].filter(group => group > 1 && group !== ownGroup);
  const signalAll = signal => {
    for (const group of groups()) send(kill, -group, signal);
    for (const row of members) if (row.pid > 1 && row.pid !== process.pid) send(kill, row.pid, signal);
  };
  signalAll('SIGTERM');
  const signalled = members.map(row => row.pid);
  const deadline = Date.now() + Math.max(0, graceMs);
  const alive = table => members.filter(row => {
    const now = table.get(row.pid);
    return now && now.startTime === row.startTime && now.state !== 'Z' && now.state !== 'X';
  });
  let table = first;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    table = readTable();
    if (alive(table).length === 0) return Object.freeze({ signalled, survivors: [] });
  }
  // Anything still here, and anything that started below a survivor meanwhile.
  table = readTable();
  const remaining = alive(table);
  const extra = remaining.flatMap(row => treeOf(row.pid, table));
  members = [...new Map([...remaining, ...extra].map(row => [row.pid, row])).values()];
  signalAll('SIGKILL');
  await sleep(POLL_MS);
  const survivors = alive(readTable()).map(row => row.pid);
  return Object.freeze({ signalled, survivors });
}

function safeOwnGroup() {
  const row = parseStat(safeRead(`/proc/${process.pid}/stat`));
  return row ? row.pgid : null;
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

module.exports = Object.freeze({
  DEFAULT_GRACE_MS,
  parseStat,
  readProcessTable,
  processStartTime,
  sameProcessAlive,
  treeOf,
  terminateProcessTree,
});
