'use strict';

const MAX_WAITING_TASKS = 16;
const TASK_ID = /^T[1-9]\d{0,9}$/;
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'T_LEDGER_WAIT_INVALID' });
}
function normalizeWaitingFor(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_WAITING_TASKS
      || Array.from(value).some(id => typeof id !== 'string' || !TASK_ID.test(id))
      || new Set(value).size !== value.length) {
    invalid('waitingFor must contain at most 16 distinct task IDs.');
  }
  return [...value].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
// Disk edits must not lock the person out of unrelated ledger operations.
// Keep invalid waits explicit and non-array so readiness remains fail-closed.
const INVALID_WAITING_FOR = Object.freeze({ invalid: true });
function readWaitingFor(value) {
  try { return normalizeWaitingFor(value); }
  catch { return INVALID_WAITING_FOR; }
}
function assertTaskDependencies(id, value, records) {
  if (typeof id !== 'string' || !TASK_ID.test(id)) invalid('A task wait needs a valid task ID.');
  const waitingFor = normalizeWaitingFor(value);
  const tasks = new Map((Array.isArray(records) ? records : []).filter(row => row?.kind === 'T').map(row => [row.id, row]));
  const prior = readWaitingFor(tasks.get(id)?.waitingFor);
  const previous = new Set(Array.isArray(prior) ? prior : []);
  const added = waitingFor.filter(dependencyId => !previous.has(dependencyId));
  // An earlier wait may survive an unavailable prerequisite. Apply status
  // admission only to new edges; keep shape, existence and cycle validation.
  for (const dependencyId of added) {
    const dependency = tasks.get(dependencyId);
    if (!dependency) invalid('Every waitingFor task must exist.');
    const reset = dependency.reset && typeof dependency.reset === 'object' && !Array.isArray(dependency.reset);
    if (reset || !['open', 'in-progress', 'blocked-external', 'done'].includes(dependency.status)) {
      throw Object.assign(new Error(`Task ${dependencyId} cannot complete this wait. Choose another prerequisite or leave the wait unset.`),
        { code: 'T_LEDGER_WAIT_UNAVAILABLE' });
    }
  }
  const pending = waitingFor.map(id => ({ id, exiting: false }));
  const visiting = new Set();
  const visited = new Set();
  while (pending.length) {
    const frame = pending.pop();
    const dependencyId = frame.id;
    if (frame.exiting) { visiting.delete(dependencyId); visited.add(dependencyId); continue; }
    if (dependencyId === id || visiting.has(dependencyId)) {
      invalid('A task cannot wait on itself or form a dependency cycle.');
    }
    if (visited.has(dependencyId)) continue;
    const dependency = tasks.get(dependencyId);
    if (!dependency) invalid('Every waitingFor task must exist.');
    visiting.add(dependencyId);
    pending.push({ id: dependencyId, exiting: true });
    for (const next of normalizeWaitingFor(dependency.waitingFor)) pending.push({ id: next, exiting: false });
  }
  return waitingFor;
}
function taskDependenciesReady(task, tasks) {
  try {
    return normalizeWaitingFor(task.waitingFor).every(id => {
      if (id === task.id) return false;
      const dependency = tasks.get(id);
      return dependency?.kind === 'T' && dependency.status === 'done';
    });
  } catch {
    return false;
  }
}

module.exports = { MAX_WAITING_TASKS, normalizeWaitingFor, readWaitingFor, assertTaskDependencies, taskDependenciesReady };
