'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { resolveServicesRoot } = require('./durable-memory-file');
const { loadSettings } = require('./settings');
const { taskDependenciesReady } = require('./task-waiting');

const SETTING_ID = 'agent.persistent_continuation';
const INTERVAL_MS = 5000;
const MAX_UNCHANGED_TURNS = 3;

/* A SAVED ROW IN ONE OF THESE STATUSES IS BEING HELD ON PURPOSE.
 *
 * 'stopped' is the person's Stop. 'blocked' is a recorded hard failure.
 * 'uncertain' is custody nobody has resolved yet. save() in
 * agent-continuation-state.js already excludes exactly these three from what
 * it will write, and success()/failed() accept none of them either, so
 * reaching them with a live handle raises CONTINUATION_FENCE_LOST and
 * persist()'s catch below announces "could not be updated".
 *
 * That sentence describes a write failure. Nothing failed to be written: the
 * hold is doing its job. The person stopped Codex Terra circle
 * node-8-0dbad425, the Controller resumed that node into a new session, and
 * the chat told them their saved continuation could not be updated. What it
 * should have told them is that their own Stop was still in force.
 *
 * Naming the hold is the whole change. Nothing here widens the statuses the
 * store accepts, retries a stale fence, or lets an agent-origin start clear a
 * Stop. The legitimate revival already exists and is unchanged: an explicit
 * person or brief turn calls track(..., { resume: true }), which writes a
 * fresh row at fence+1 with reason person_resumed and refuses
 * CONTINUATION_ACTIVE while another attempt holds a live lease. */
const HELD_STATUSES = Object.freeze(['stopped', 'blocked', 'uncertain']);

/* A ROW IN ONE OF THESE IS WAITING FOR ITS OWN SCHEDULED TIME, NOT AVAILABLE.
 *
 * completed() schedules the next ledger review DEFAULT_BASE_DELAY_MS after a
 * turn finishes, and the host polls tick() every INTERVAL_MS. Those do not
 * divide into one another: at 15 seconds and 5 seconds, two polls in every
 * three arrive before the row is due. That is normal and is the majority case.
 * See the guard in tick(). */
const WAITING_STATUSES = Object.freeze(['ready', 'retry_wait']);

/* 'end_turn' is the raw ACP session/prompt stopReason (acp-adapter.js:
   `status: stopReason`) a real ACP turn ends with on success -- see the
   commit history and tests/agent-continuation-acp-success-status.test.js
   for the measured evidence. Only ever add a status a producer actually
   emits. Claude CLI and LocalNodeAdapter emit 'success' from their actual
   successful result paths. */
const SUCCESS_STATUSES = Object.freeze(['completed', 'end_turn', 'success']);
/* Every terminal status the recovery path's "is this a real terminal turn"
   gate accepts; see SUCCESS_STATUSES for which of these are success. */
const KNOWN_TERMINAL_STATUSES = Object.freeze([...SUCCESS_STATUSES, 'failed', 'cancelled', 'interrupted']);

/* WHAT THE PERSON IS TOLD WHEN A HELD ROW STOPS AUTONOMOUS+.
 *
 * Each sentence names the cause and the one thing the person can do, in the
 * shape the other pauses in this file already use, and does not explain the
 * mechanism. The tests compare against this map rather than the words, so
 * these can be reworded here without touching a test. */
const HELD_PAUSE = Object.freeze({
  stopped: 'Autonomous+ is not running because you stopped this agent. Send it a message to resume.',
  blocked: 'Autonomous+ is not running because its last turn needs your attention. Send it a message to resume.',
  uncertain: 'Autonomous+ is not running because an earlier turn was interrupted and its outcome is still unknown. Send it a message to resume.'
});

/* WHAT A SESSION IS TOLD WHEN THE CIRCLE ABOVE IT HAS STOPPED (ledger T123).
 *
 * THE DEFECT, MEASURED 2026-09-15. A manager's session failed every turn from
 * 21:47Z. Five circles reporting to it each finished one item, sent the report
 * to a circle that could no longer read it, and then sat idle for over three
 * hours under a working policy whose entire point is that they do not. This
 * scheduler was already sending those sessions their next turn without asking
 * any manager; what it had no way to learn was that the manager was GONE, so
 * the turn text never said so and no ancestor was ever told. A refused send
 * therefore read to the worker as the end of its work.
 *
 * ONLY THE HOST CAN ANSWER "IS MY MANAGER STILL RUNNING". This process knows
 * about ledger rows and turns, not about which running circle is which node on
 * the person's tree. So the observation arrives as an injected reading --
 * readManagerState(session) -> fact or null -- and this file owns only the
 * decision: what the next turn says, and who above the gap is told once.
 *
 * TWO SENTENCES, EACH SAID ONCE PER EPISODE. The hold sentence rides every
 * continuation turn for as long as the outage lasts, because a worker that
 * started a turn during the outage needs it whether or not it was the first.
 * The release sentence rides exactly ONE turn, the first after the manager (or
 * a successor under the same node key) is reachable again -- repeating it would
 * make one queued report be sent over and over.
 *
 * NEITHER SENTENCE WIDENS ANYTHING. No spawn, no reassignment, no stop, no new
 * permission: the agent keeps the authority it already had and is told, in
 * words, that nothing has been reassigned on the strength of this. */
const MANAGER_OUTAGE_HOLD = 'Your manager cannot read a report right now: the circle above you on this computer is not reachable from here.'
  + ' Hold the report you would send it, keep working this task, and keep recording honest progress in the task ledger.'
  + ' Do not spawn a replacement, do not stop, and do not reassign anyone. This computer has already told the nearest circle above the gap once, so you do not need to tell anyone again.';
const MANAGER_OUTAGE_RELEASE = 'Your manager is reachable again.'
  + ' Send the report you were holding to it now, then carry on with this task.'
  + ' This is said once; later turns will not repeat it.';

function enabled(settings) {
  return require('./runtime-policy').resolveRuntimePolicy(settings).continuationEnabled;
}

function fingerprint(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function nodeOf(keys) {
  return typeof keys?.threadId === 'string' && keys.threadId
    && Array.isArray(keys.treeAnchors) && keys.treeAnchors.at(-1) === keys.threadId ? keys.threadId : null;
}
function assignedTo(task, sessionId, requestKeys) {
  const key = typeof task.scopeKey === 'string' && task.scopeKey ? task.scopeKey : task.threadId;
  const node = nodeOf(requestKeys);
  return task.scope === 'session' && typeof sessionId === 'string' && sessionId && key === sessionId
    || (task.scope === 'thread' || task.scope === 'tree') && node !== null && key === node;
}

// Durable work stays in the canonical ledger. This scheduler never completes,
// claims, reopens or edits a task itself. It only sends a running session another
// turn through the host's existing authority, cancellation and account gates.
function createLedgerContinuation({ send, canSend, isLive = canSend, readSettings = loadSettings,
  readTasks, selectTasks, now = Date.now, onPause = () => {},
  /* T123. Both are OPTIONAL and default to "this caller can say nothing about
     any manager", so a host built before they existed behaves exactly as it
     did: readManagerState answering null means no outage is being claimed, and
     nothing below then changes a single turn. See MANAGER_OUTAGE_HOLD. */
  readManagerState = () => null, onManagerUnavailable = () => null,
  stateFactory = () => require('./agent-continuation-state').createContinuationState({
    file: path.join(resolveServicesRoot(), 'agent-continuations.sqlite'), now,
  }) } = {}) {
  if (typeof readTasks !== 'function') throw new TypeError('ledger continuation requires a readTasks function');
  if (typeof selectTasks !== 'function') throw new TypeError('ledger continuation requires a selectTasks function');
  const states = new Map();
  const reservations = new Map();
  let closed = false;
  let lastReadAt = -Infinity;
  let durable;
  const backend = () => durable === undefined ? (durable = stateFactory()) : durable;
  let workFailure = null, workRetryAt = 0, workFailures = 0, workPolicyRevision = null;
  function taskRecords() {
    const settings = readSettings();
    const policy = require('./runtime-policy').resolveRuntimePolicy(settings);
    const revision = JSON.stringify([settings.revision, policy.verifyHistory, policy.continuationEnabled]);
    if (revision !== workPolicyRevision) {
      workPolicyRevision = revision; workFailure = null; workRetryAt = 0; workFailures = 0;
    }
    if (workFailure && now() < workRetryAt) throw workFailure;
    try {
      const records = readTasks().filter(row => row.kind === 'T');
      workFailure = null; workRetryAt = 0; workFailures = 0;
      return records;
    } catch (error) {
      workFailure = error; workFailures += 1;
      workRetryAt = now() + Math.min(300000, 30000 * 2 ** Math.min(workFailures - 1, 4));
      if (workFailures === 1) for (const state of states.values()) {
        try { onPause(state.session, 'Automatic task continuation is waiting because its task list could not be read. It will retry; manual messages and goals remain available.'); } catch { /* keep the actual read refusal */ }
      }
      throw error;
    }
  }

  /* A SETTING WE CANNOT READ IS NOT A SETTING THAT IS OFF.
     allowed() used to answer false for both, so a transient failure to read
     the settings file silently disabled every continuation write and looked
     exactly like the person having switched Autonomous+ off. The tri-state
     keeps allowed()'s answer identical for both -- nothing downstream starts
     running on an unreadable setting -- while letting persist() tell the two
     apart and say so. */
  function settingState() {
    try { return enabled(readSettings()) ? 'on' : 'off'; } catch { return 'unreadable'; }
  }
  function allowed() { return settingState() === 'on'; }
  // THE LEDGER IS READ ONCE PER TICK AND THE TURN IS SENT A MICROTASK LATER.
  // tick() reads T records synchronously, reserves the task, then defers the
  // claim and the send through Promise.resolve().then(). A category reset
  // (owner-request-store resetKind) can commit inside that window, and readAll
  // drops reset records entirely, so the deferred half would otherwise claim a
  // handle, write a checkpoint and send a turn naming a task that no longer
  // exists. Re-reading here is what makes the reservation a fence rather than
  // a guess: it costs one extra read per dispatch, only on the path that is
  // about to send.
  function stillOffered(taskId, signature) {
    let current;
    try { current = taskRecords(); }
    catch { return false; } // Unreadable work never authorizes a turn, same as tick.
    const fresh = current.find(row => row.id === taskId);
    return Boolean(fresh) && ['open', 'in-progress'].includes(fresh.status)
      && fingerprint(fresh) === signature
      && taskDependenciesReady(fresh, new Map(current.map(row => [row.id, row])));
  }
  // Forget ONLY what named the vanished task. Clearing the session wholesale
  // would throw away engagement with tasks the reset did not touch, and setting
  // `stopped` would refuse the next turn as if the session had failed -- a
  // reset is not a failure and must not block later work or a resume after Stop.
  // checkpointOf() is built from taskId and lastFingerprint, so clearing those
  // is what drops the stale checkpoint; the previously persisted one is left for
  // the next real turn to overwrite rather than rewritten on an abort path.
  function forgetReset(state, taskId) {
    reservations.delete(taskId);
    if (state.taskId === taskId) { state.taskId = null; state.lastFingerprint = null; state.unchanged = 0; }
    if (state.engagementTaskId === taskId) state.engagementTaskId = null;
    if (state.turnEngagementTaskId === taskId) state.turnEngagementTaskId = null;
    if (state.pendingEngagementTaskId === taskId) state.pendingEngagementTaskId = null;
  }
  function checkpointOf(state) {
    return state.taskId && state.lastFingerprint
      ? { taskId: state.taskId, fingerprint: state.lastFingerprint, unchanged: state.unchanged,
        ...(state.engagementTaskId ? { engagementTaskId: state.engagementTaskId, engagementHostId: state.session.sessionId } : {}) } : undefined;
  }
  /* OBSERVE THE DURABLE ROW BEFORE WRITING TO IT.
   *
   * A local handle goes stale in two ways. stopSaved() marks the session
   * stopped but leaves state.handle on the row the turn began with, and a Stop
   * issued through another host handle never touches this process at all.
   * Either way the handle can still say 'running' with a claimId while the
   * durable row is held, and then tick()'s heartbeat, tick()'s descriptor save
   * or update()'s save raises CONTINUATION_FENCE_LOST -- announced by persist()
   * below as a write failure, once every five seconds.
   *
   * So: read, adopt the durable row, and settle this session. This never
   * renews a lease the attempt no longer owns and never hands a refreshed
   * handle to save/heartbeat to get it past their fence; a held row is one
   * these callers must not write, and they return instead. A row that is
   * 'running' under somebody else's lease is NOT adopted here: that is a real
   * custody conflict and keeps its existing refusal.
   *
   * Returns the held status for the caller that announces it, or null. */
  function heldRow(state, storage) {
    if (!state.handle) return null;
    const saved = storage.get(state.handle.key);
    if (!saved || !HELD_STATUSES.includes(saved.status)) return null;
    state.handle = saved;
    state.stopped = true;
    state.success = false;
    return saved.status;
  }
  function persist(state, operation) {
    /* THIS FUNCTION HAD TWO FAILURE MODES AND ONLY ONE OF THEM TOLD ANYBODY.
       The catch below pauses the agent and says so. The guard above it
       returned false with no pause, no log and no signal, and no caller looked
       at the return value -- so every success and failure write could be
       skipped in silence. An unreadable settings file reached that guard by
       the same route as a switched-off setting, which is the shape of defect
       this whole area keeps producing: a mechanism that stops working and says
       nothing.
       OFF STAYS SILENT ON PURPOSE. The person turned it off; there is nothing
       to report. Only "cannot tell" is announced.
       pauseAnnounced records whether THIS call already spoke, so the caller can
       add its own report without the person being told the same thing twice. */
    state.pauseAnnounced = false;
    const setting = settingState();
    if (setting === 'unreadable') {
      state.stopped = true;
      state.pauseAnnounced = true;
      onPause(state.session, 'Autonomous+ paused because its own setting could not be read, so it cannot tell whether it is still switched on.');
      return false;
    }
    if (setting === 'off' || !state.descriptor) return false;
    try {
      const storage = backend();
      return Boolean(storage) && operation(storage) !== false;
    } catch (error) {
      state.stopped = true;
      state.pauseAnnounced = true;
      onPause(state.session, `Autonomous+ paused because its saved continuation could not be updated (${error.code || 'unavailable'}).`);
      return false;
    }
  }
  function remember(session, descriptor) {
    if (closed) return;
    const state = stateFor(session);
    state.descriptor = descriptor;
    persist(state, storage => {
      state.handle = storage.track(descriptor);
      const saved = state.handle.checkpoint;
      if (saved) {
        state.taskId = saved.taskId; state.lastFingerprint = saved.fingerprint; state.unchanged = saved.unchanged;
        state.engagementTaskId = saved.engagementHostId === session.sessionId ? saved.engagementTaskId : null;
      }
    });
  }

  function stateFor(session) {
    let state = states.get(session.sessionId);
    if (!state || state.session !== session) {
      state = { session, success: false, stopped: false, inFlight: false,
        lastSentAt: -Infinity, lastFingerprint: null, unchanged: 0 };
      states.set(session.sessionId, state);
    }
    return state;
  }
  function started(session, origin) {
    if (closed) return;
    const state = stateFor(session);
    state.success = false;
    if (origin === 'continuation' && state.pendingEngagementTaskId) {
      state.turnEngagementTaskId = state.pendingEngagementTaskId;
      state.pendingEngagementTaskId = null;
    }
    if (origin !== 'continuation') { state.recoveryRevision = null; state.dispatch = null; }
    if (origin === 'person' || origin === 'brief') {
      state.stopped = false;
      state.unchanged = 0;
      // A new instruction starts a new episode; a previous workflow never
      // authorizes this turn to take unrelated shared work after it finishes.
      state.taskId = state.lastFingerprint = state.engagementTaskId = state.pendingEngagementTaskId = state.turnEngagementTaskId = null;
      for (const [id, held] of reservations) if (held.sessionId === session.sessionId) reservations.delete(id);
    }
    persist(state, storage => {
      if (origin === 'continuation') return;
      state.handle = storage.track(state.descriptor, { resume: origin === 'person' || origin === 'brief' });
      if (['idle', 'ready', 'retry_wait'].includes(state.handle.status)) state.handle = storage.begin(state.handle, { observed: true });
    });
  }
  function completed(session, event) {
    if (closed) return;
    const state = stateFor(session);
    if (state.stopped || state.success && state.handle?.status === 'ready') return;
    // A native terminal event owns this attempt even if its send promise later
    // rejects. Never replace its observed outcome with a pre-accept retry.
    if (state.dispatch) state.dispatch.completed = true;
    state.success = SUCCESS_STATUSES.includes(event.status);
    if (state.success && state.turnEngagementTaskId) state.engagementTaskId = state.turnEngagementTaskId;
    state.turnEngagementTaskId = null;
    let held = null;
    const written = persist(state, storage => {
      if (!state.handle) state.handle = storage.track(state.descriptor);
      held = heldRow(state, storage);
      if (held) return;
      state.handle = state.success ? storage.success(state.handle, { checkpoint: checkpointOf(state) })
        : storage.failed(state.handle, event, { retrySafe: event.status === 'failed' });
    });
    /* THE RETURN VALUE IS READ HERE BECAUSE THIS IS THE CALL THAT MATTERS.
       How a turn ended is the one thing the scheduler cannot reconstruct
       later: if this write is skipped, the row stays exactly as it was --
       `running` -- and nothing will ever revisit it. That is the measured
       silence, so a tracked session whose outcome went unrecorded while the
       setting was on now says so instead of leaving a row that looks busy.
       A held row is not this case: heldRow() settled it deliberately and the
       branch below reports which hold is in force. Nor is a session with no
       descriptor, which this scheduler was never tracking. */
    if (!written && !held && !state.pauseAnnounced && state.descriptor && allowed()) {
      onPause(session, 'Autonomous+ could not record how that turn ended, so it will not continue this session on its own. Send a message to resume.');
    }
    if (held) {
      // The turn itself already happened and is not undone here. heldRow() has
      // settled the scheduler; this only tells the person which hold is in
      // force, rather than that a write failed.
      onPause(session, HELD_PAUSE[held]);
      return;
    }
    if (!state.success) state.stopped = !['retry_wait', 'uncertain'].includes(state.handle?.status);
  }
  function stop(session) {
    if (closed) return;
    const state = stateFor(session);
    state.stopped = true;
    state.success = false;
    // Stop is durable even if the owner switched the preset off first.
    if (state.descriptor) {
      const storage = backend();
      if (storage) { const row = state.handle || storage.track(state.descriptor); state.handle = storage.stop(row.key); }
    }
  }
  function forget(session) {
    states.delete(session.sessionId);
    for (const [id, held] of reservations) if (held.sessionId === session.sessionId) reservations.delete(id);
  }
  function actionableTasks(records, sessionId, requestKeys, checkpoint, custody) {
    // Context is not assignment. Shared work needs evidence that this scheduler
    // continued this session's own task in the current episode. Historic tasks,
    // another session's checkpoint and pre-fix global checkpoints confer none.
    const engaged = typeof sessionId === 'string' && sessionId && checkpoint?.engagementHostId === sessionId && records.some(task =>
      task.id === checkpoint.engagementTaskId && ['open', 'in-progress', 'done', 'recurring'].includes(task.status)
      && assignedTo(task, sessionId, requestKeys));
    const elsewhere = new Set();
    for (const state of states.values()) {
      if (!state.stopped && state.taskId && state.session.sessionId !== sessionId) elsewhere.add(state.taskId);
    }
    // Saved custody survives a host restart and cannot be stolen on a content
    // update. An unreadable custody store refuses the entire scheduling read.
    // `custody` is the same listing taken once by a caller that asks about
    // many rows in one synchronous pass (pendingRecoveries). Omitted, it is
    // read here, as before.
    for (const row of custody || backend()?.list() || []) {
      const sameNode = nodeOf(requestKeys) && nodeOf(row.descriptor.requestKeys) === nodeOf(requestKeys)
        && row.descriptor.requestKeys.treeAnchors[0] === requestKeys.treeAnchors[0];
      if (row.checkpoint?.taskId && row.descriptor.sessionId !== sessionId
        && !sameNode && !['stopped', 'blocked'].includes(row.status)) elsewhere.add(row.checkpoint.taskId);
    }
    const own = [], shared = [];
    const byId = new Map(records.map(row => [row.id, row]));
    for (const task of selectTasks(records, { sessionId, ...requestKeys })) {
      if (!['open', 'in-progress'].includes(task.status) || elsewhere.has(task.id)
        || !taskDependenciesReady(task, byId)) continue;
      const assigned = assignedTo(task, sessionId, requestKeys);
      const held = reservations.get(task.id);
      if (held && (held.sessionId !== sessionId || held.paused && held.fingerprint === fingerprint(task))) continue;
      if (checkpoint?.unchanged >= MAX_UNCHANGED_TURNS && checkpoint.taskId === task.id && checkpoint.fingerprint === fingerprint(task)) continue;
      if (assigned) own.push(task);
      else if (engaged && (task.scope === 'global' || task.scope === 'tree')
        && (checkpoint.taskId === task.id || task.status === 'open' && (task.filedBy == null || task.filedBy === 'owner'))) shared.push(task);
    }
    return own.concat(shared);
  }
  function direction({ sessionId, requestKeys } = {}) {
    if (closed || !allowed()) return { actionable: false, taskIds: [], reason: 'continuation-disabled' };
    try {
      if (!requestKeys?.threadId || !Array.isArray(requestKeys.treeAnchors) || !requestKeys.treeAnchors.length) {
        return { actionable: false, taskIds: [], reason: 'tree-identity-required' };
      }
      const sameNode = keys => keys?.threadId === requestKeys.threadId && keys.treeAnchors?.[0] === requestKeys.treeAnchors[0];
      const state = [...states.values()].find(row => sameNode(row.session.treeRequestIdentity));
      const checkpoint = state ? checkpointOf(state) : backend()?.list().find(row => sameNode(row.descriptor?.requestKeys))?.checkpoint;
      const records = taskRecords();
      const taskIds = actionableTasks(records, sessionId, requestKeys, checkpoint).map(task => task.id);
      return { actionable: taskIds.length > 0, taskIds, reason: taskIds.length ? 'open-ledger-work' : 'no-actionable-ledger-work' };
    } catch { return { actionable: false, taskIds: [], reason: 'ledger-unavailable' }; }
  }
  /* WHETHER THIS SESSION'S NEXT TURN CARRIES THE OUTAGE SENTENCE, THE RELEASE
     SENTENCE, OR NEITHER -- and the one moment the circle above the gap is
     told. Answers 'hold', 'release' or null; see MANAGER_OUTAGE_HOLD.

     ATTEMPTED ONCE PER EPISODE, NOT ONCE PER TICK. The episode id is the
     host's, frozen for as long as one outage lasts and different the next time
     one starts, so remembering the id this session has already escalated is
     what keeps the ancestor from being told once per poll -- which, at a
     five-second poll, is the spam this must not produce. The attempt is
     recorded whether or not the host accepted it: the host refuses only a fact
     it can never use or a session that is no longer running, and re-offering
     either on every poll would be the same spam with nothing delivered.

     A READING THAT THROWS IS NOT AN OUTAGE. An injected reader that fails says
     nothing about the manager, and a claim this scheduler cannot evidence is
     the one thing worse than the idling it exists to end: a worker abandoning
     a manager that was about to answer. */
  function observeManager(state, applicable) {
    let fact = null;
    try { fact = readManagerState(state.session); } catch { fact = null; }
    if (fact && typeof fact.episodeId === 'string' && fact.episodeId !== '') {
      state.managerHeldEpisodeId = fact.episodeId;
      if (state.managerEscalatedEpisodeId !== fact.episodeId) {
        state.managerEscalatedEpisodeId = fact.episodeId;
        try { onManagerUnavailable(state.session, fact, applicable.map(row => row.id)); }
        catch { /* the sentence below still reaches the worker; an undelivered
                   escalation does not strand it */ }
      }
      return 'hold';
    }
    /* REACHABLE AGAIN. The host answers null the moment a circle takes that
       node key back, which is how a resumed manager or a successor under the
       same key returns to the tree. */
    state.managerEscalatedEpisodeId = null;
    return state.managerHeldEpisodeId ? 'release' : null;
  }

  function tick() {
    if (closed || now() - lastReadAt < INTERVAL_MS) return;
    lastReadAt = now();
    let records;
    try {
      if (!allowed()) return;
      for (const state of states.values()) persist(state, storage => {
        if (!state.handle) state.handle = storage.track(state.descriptor);
        // No announcement here: the person pressed Stop and does not need
        // telling once per tick. completed() speaks when a turn ends.
        if (heldRow(state, storage)) return;
        if (state.descriptorDirty && !HELD_STATUSES.includes(state.handle.status)) {
          state.handle = storage.save(state.handle, { descriptor: state.descriptor }); state.descriptorDirty = false;
        }
        if (isLive(state.session) && state.handle.status === 'running' && state.handle.claimId) state.handle = storage.heartbeat(state.handle);
        if (state.handle.status === 'retry_wait' && state.handle.dueAtMs <= now()) { state.stopped = false; state.success = true; }
      });
      if (![...states.values()].some(state => state.success && !state.stopped && canSend(state.session))) return;
      records = taskRecords();
    } catch { return; } // Unreadable authority/work never authorizes a turn.
    const fingerprints = new Map(records.filter(row => ['open', 'in-progress'].includes(row.status)).map(row => [row.id, fingerprint(row)]));
    for (const [id, held] of reservations) {
      if (!fingerprints.has(id)) reservations.delete(id);
    }
    for (const state of states.values()) {
      const session = state.session;
      if (state.stopped || state.awaitingAttachment || !state.success || state.inFlight || !canSend(session)
        || now() - state.lastSentAt < INTERVAL_MS) continue;
      /* WAITING COSTS NOTHING. Everything below this line spends something: it
         selects a task, increments state.unchanged against the unchanged-turn
         budget, takes a reservation another session then cannot have, and
         stamps lastSentAt. All of that used to run on a poll that arrived
         before the row was due, and storage.claim() would then refuse the row
         for exactly that reason and return null -- which the dispatch read as a
         lost race and answered with state.stopped = true, permanently.
         Autonomous+ therefore died at the first poll after the first completed
         turn, silently: no send, no pause, no error, nothing written.
         It was invisible until b591f18d, because until then the delay and the
         poll interval were both 5000 and the first poll was always exactly due.
         A row that is merely early is not work yet, so skip it whole. */
      if (WAITING_STATUSES.includes(state.handle?.status) && state.handle.dueAtMs > now()) continue;
      const keys = {
        ...session.treeRequestIdentity,
        threadId: session.treeRequestIdentity?.threadId || session.threadId,
      };
      let applicable;
      try { applicable = actionableTasks(records, session.sessionId, keys, checkpointOf(state)); }
      catch { continue; }
      /* BEFORE THE TASK IS CHOSEN, because the circle above the gap has to be
         told whether or not this session has a next task to be given. */
      const managerTelling = observeManager(state, applicable);
      const task = applicable[0];
      if (!task) continue;
      const signature = fingerprints.get(task.id);
      const unchanged = signature === state.lastFingerprint ? state.unchanged + 1 : 0;
      const held = { sessionId: session.sessionId, fingerprint: signature, paused: false };
      reservations.set(task.id, held);
      state.inFlight = true;
      let dispatch = null;
      const text = `[Autonomous+ continuation]\nContinue the work and workflow you are already authorized to carry out. The applicable task ledger still lists ${task.id} (${task.status}). Read its current words and related task, workflow, claim and decision records before acting. Coordinate existing ownership; do not duplicate another worker's active claim. Work through the next concrete step, then record honest progress with t_ledger.progress or completion with t_ledger.complete in the task ledger. If that task is blocked, record the blocker and continue other authorized work. Do not invent completion, retry an unchanged hard blocker, widen access, exceed account limits or resume cancelled work. Purchases and new permissions still need their existing approval. This scheduled continuation is not a new instruction from the person and grants no additional authority.`
        + (managerTelling === 'hold' ? `\n\n${MANAGER_OUTAGE_HOLD}` : '')
        + (managerTelling === 'release' ? `\n\n${MANAGER_OUTAGE_RELEASE}` : '');
      // Reserve before sending: two sessions cannot receive the same unchanged
      // ledger item in one host round. Never await one provider's whole turn.
      Promise.resolve().then(() => {
        if (closed || state.stopped || !canSend(session) || !allowed()) return;
        if (!stillOffered(task.id, signature)) { forgetReset(state, task.id); return; }
        if (unchanged >= MAX_UNCHANGED_TURNS) {
          state.unchanged = unchanged;
          held.paused = true;
          persist(state, storage => { if (state.handle) state.handle = storage.save(state.handle, { checkpoint: checkpointOf(state) }); });
          onPause(session, `Autonomous+ paused ${task.id} after three follow-ups without a task checkpoint. Update its ledger progress or send a message to resume.`);
          return;
        }
        // A skipped, unavailable or refused write is not a claim receipt. Read
        // enablement again in persist(), then claim/checkpoint/send without an
        // asynchronous gap. Cancelled reservations spend no turn budget.
        const prepared = persist(state, storage => {
          if (!state.handle) state.handle = storage.track(state.descriptor);
          if (state.handle.status === 'idle') state.handle = storage.success(state.handle, { delayMs: 0 });
          const claimed = storage.claim(state.handle);
          // This row was due when selected: null is changed custody, not an
          // early poll. Keep the existing fail-closed hold on a lost claim.
          if (!claimed) { state.stopped = true; return false; }
          state.handle = storage.begin(claimed);
          const checkpoint = { taskId: task.id, fingerprint: signature, unchanged,
            ...(state.engagementTaskId ? { engagementTaskId: state.engagementTaskId, engagementHostId: session.sessionId } : {}) };
          state.handle = storage.save(state.handle, { checkpoint });
          state.taskId = task.id;
          state.pendingEngagementTaskId = assignedTo(task, session.sessionId, keys) ? task.id : null;
          state.lastFingerprint = signature;
          state.unchanged = unchanged;
          state.lastSentAt = now();
        });
        if (!prepared || state.stopped) return;
        dispatch = { handle: state.handle, completed: false };
        state.dispatch = dispatch;
        /* THE RELEASE IS SPENT ON A TURN THAT IS ACTUALLY GOING OUT, not on
           one that was composed and then skipped. Cleared here, at the last
           point before the send, so a queued report is asked for once and a
           refused or abandoned dispatch still asks for it on the next turn. */
        if (managerTelling === 'release') state.managerHeldEpisodeId = null;
        return send(session, text);
      }).catch(error => {
        // For a scheduled send this catch owns the pre-accept refusal; the
        // host's refused() notification defers to it. A native completion,
        // person turn or Stop already owns its own distinct outcome.
        if (!closed && dispatch && state.dispatch === dispatch && !dispatch.completed && !state.stopped && error?.code !== 'AGENT_TURN_ACTIVE') {
          state.success = false;
          let heldStatus = null;
          const settled = persist(state, storage => {
            heldStatus = heldRow(state, storage);
            if (heldStatus) return;
            // Metadata saves and heartbeats advance our own revision without
            // changing the attempt. Use that acknowledged handle, while the
            // exact private lease identity and the store's CAS still fence a
            // replacement or an unobserved concurrent write.
            if (state.handle?.key !== dispatch.handle.key || state.handle.fence !== dispatch.handle.fence
              || state.handle.claimId !== dispatch.handle.claimId) {
              throw Object.assign(new Error('The scheduled continuation no longer owns this attempt.'), { code: 'CONTINUATION_FENCE_LOST' });
            }
            state.handle = storage.failed(state.handle, error, { retrySafe: true });
          });
          if (heldStatus) onPause(session, HELD_PAUSE[heldStatus]);
          else if (settled) {
            state.stopped = state.handle.status !== 'retry_wait';
            if (state.stopped) onPause(session, 'Autonomous+ paused because the session refused its next turn. Resolve the reported problem and send a message to resume.');
          } else state.stopped = true;
        }
      }).finally(() => {
        state.inFlight = false;
        state.pendingEngagementTaskId = null;
        if (state.dispatch === dispatch) state.dispatch = null;
        if (!dispatch && !held.paused && reservations.get(task.id) === held) reservations.delete(task.id);
      });
    }
  }
  function pendingRecoveries() {
    if (!allowed()) return [];
    const storage = backend();
    if (!storage) return [];
    const tasks = taskRecords();
    // ONE CUSTODY LISTING PER READ, NOT ONE PER DUE ROW. actionableTasks lists
    // every saved row to find work held elsewhere. Asked once per due row that
    // was rows x due SQLite reads on the main thread for each five-second
    // window poll: measured 2.4-3.0 s per poll with 345 rows, 195 of them due.
    // Nothing in this synchronous filter writes a row, so the listing taken
    // after dueRecoveries() (which may expire leases) is the one every row saw.
    let custody = null;
    return storage.dueRecoveries({ includeUncertain: true }).filter(row => {
      if ([...states.values()].some(state => state.descriptor && state.handle?.key === row.key && isLive(state.session))) return false;
      const keys = row.descriptor.requestKeys;
      if (!keys) return keys;
      custody = custody || storage.list();
      return actionableTasks(tasks, row.descriptor.sessionId, keys, row.checkpoint, custody).length > 0;
    });
  }
  async function recover({ key, revision }, start, { close = async () => {} } = {}) {
    if (!allowed()) throw new Error('Autonomous+ is switched off.');
    const storage = backend();
    const row = pendingRecoveries().find(item => item.key === key && item.revision === revision);
    if (!row) throw new Error('This continuation changed or is no longer eligible.');
    let handle = storage.claim(row);
    if (!handle) throw new Error('Another recovery owns this continuation.');
    const reconciling = handle.status === 'reconciling';
    if (!reconciling) handle = storage.begin(handle);
    let leaseError = null;
    const renew = () => {
      try { handle = storage.heartbeat(handle); }
      catch (error) { leaseError = error; }
    };
    const timer = setInterval(renew, 10000);
    timer.unref?.();
    try {
      renew(); if (leaseError) throw leaseError;
      const result = await start(row.descriptor);
      renew(); if (leaseError) { await close(); throw leaseError; }
      if (result?.ended || result?.threadId !== row.descriptor.resumeThreadId) throw new Error('The exact saved conversation was not restored.');
      const turns = result.resumed?.turns;
      // Some providers restore the exact conversation without exporting old
      // turns. A durable completed boundary still authorizes its next ledger
      // review; an interrupted running row requires fresh terminal observation.
      const terminal = (Array.isArray(turns) ? turns.at(-1) : null)
        || (!reconciling && row.status === 'ready' ? { status: 'completed' } : null);
      if (!terminal || !KNOWN_TERMINAL_STATUSES.includes(terminal.status)) {
        if (reconciling) handle = storage.reconcile(handle, { observedThreadId: result.threadId, terminalStatus: 'unknown' });
        throw new Error('The saved conversation has no verified terminal turn. Its interrupted work remains uncertain; resume it explicitly after reviewing its task custody.');
      }
      const status = terminal.status;
      // The durable store has a canonical vocabulary. Normalize only actual
      // producer-backed success; unknown and failure statuses keep their holds.
      if (reconciling) handle = storage.reconcile(handle, { observedThreadId: result.threadId, terminalStatus: SUCCESS_STATUSES.includes(status) ? 'completed' : status, error: terminal.error, retrySafe: ['failed', 'interrupted'].includes(status) });
      else if (SUCCESS_STATUSES.includes(status)) handle = storage.success(handle);
      else if (status === 'interrupted') handle = storage.failed(handle, { code: 'PROVIDER_PROCESS_EXITED' });
      else if (status === 'cancelled') handle = storage.stop(key);
      else handle = storage.failed(handle, terminal.error, { retrySafe: true });
      if (['stopped', 'blocked', 'uncertain'].includes(handle.status)) { await close(); throw new Error(`Saved continuation paused: ${handle.reason}.`); }
      const state = [...states.values()].find(item => item.session.sessionId === result.sessionId);
      if (state) { state.awaitingAttachment = true; state.recoveryRevision = handle.revision; state.handle = handle; state.success = handle.status === 'ready'; state.stopped = ['stopped', 'blocked', 'uncertain'].includes(handle.status); }
      return { ...result, continuation: { key, revision: handle.revision, status: handle.status, reason: handle.reason } };
    } catch (error) {
      await close().catch(() => {});
      try { storage.failed(handle, error, { retrySafe: true }); } catch { /* A concurrent Stop keeps its fence. */ }
      throw error;
    } finally { clearInterval(timer); }
  }
  function attached(key, sessionId, revision) {
    const state = states.get(sessionId);
    if (!state || state.handle?.key !== key || state.handle.revision !== revision || !isLive(state.session)) throw new Error('The recovered session is not attached to this continuation.');
    const current = backend()?.get(key);
    if (!current || current.revision !== revision || ['stopped', 'blocked', 'uncertain'].includes(current.status)) throw new Error('This continuation was stopped or changed before attachment.');
    state.awaitingAttachment = false;
    return { ok: true };
  }
  function attachmentSession(key, sessionId, revision) {
    const state = states.get(sessionId);
    return state?.handle?.key === key && state.recoveryRevision === revision ? state.session : null;
  }
  function stopSaved(key) {
    for (const state of states.values()) if (state.handle?.key === key) { state.stopped = true; state.success = false; }
    const storage = backend(); return storage?.stop(key);
  }
  function exited(session, error) {
    if (closed) return;
    const state = stateFor(session);
    if (state.stopped || !state.descriptor) return;
    state.success = false;
    persist(state, storage => {
      if (!state.handle) state.handle = storage.track(state.descriptor);
      if (['idle', 'ready', 'retry_wait'].includes(state.handle.status)) state.handle = storage.begin(state.handle, { observed: true });
      if (state.handle.status === 'running') state.handle = storage.failed(state.handle, error, { retrySafe: false });
    });
  }
  function update(session, descriptor) {
    if (closed) return;
    const state = stateFor(session);
    if (!state.descriptor) return;
    state.descriptor = { ...state.descriptor, ...descriptor };
    state.descriptorDirty = true;
    persist(state, storage => {
      if (heldRow(state, storage)) return;
      if (state.handle && !HELD_STATUSES.includes(state.handle.status)) {
        state.handle = storage.save(state.handle, { descriptor: state.descriptor }); state.descriptorDirty = false;
      }
    });
  }
  function refused(session, error) {
    if (closed) return;
    const state = stateFor(session);
    // send() rethrows definite pre-accept refusals. The scheduled attempt's
    // catch owns that durable outcome; person/agent sends still settle here.
    if (state.dispatch) return;
    if (!state.stopped && (!state.handle || state.handle.status === 'running')) completed(session, { status: 'failed', code: error?.code });
  }
  function instructions() {
    try { if (!enabled(readSettings())) return null; } catch { return null; }
    return '[Working policy: Autonomous+] Keep working through the current authorized objective and its workflow. Maintain unfinished actionable work as scoped T ledger tasks using t_ledger.file, with honest checkpoints through t_ledger.progress and completion through t_ledger.complete. Existing task claims, cancellation, permissions and account limits still govern. Record genuine blockers and work on other eligible tasks. Do not create work after the objective is complete; a repeated unchanged checkpoint is not progress.';
  }
  return Object.freeze({ enabled: allowed, direction, remember, update, refused, exited, pendingRecoveries, recover, attached, attachmentSession, stopSaved, instructions, started, completed, stop, forget, tick, close() { closed = true; states.clear(); reservations.clear(); durable?.close(); } });
}

module.exports = { SETTING_ID, INTERVAL_MS, MAX_UNCHANGED_TURNS, HELD_STATUSES, HELD_PAUSE, MANAGER_OUTAGE_HOLD, MANAGER_OUTAGE_RELEASE, enabled, createLedgerContinuation };
