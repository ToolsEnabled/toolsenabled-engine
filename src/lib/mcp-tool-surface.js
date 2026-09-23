'use strict';

// Q40: MCP clients cache their tool table at process startup.  A newly spawned
// one-shot broker can prove that the checked-in source works, but it cannot
// prove that another long-lived stdio client has the same surface.  This module
// records only bounded process identity and digests; it never stores tool
// schemas, argv/environment, prompts, paths, credentials, or audit content.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { getStateStore } = require('./state-store');
const { rootPath } = require('./runtime');
const { windowsStartTicks, windowsStartTicksMany } = require('./providers/durable-worker-runtime');

const SCHEMA_VERSION = 1;
const MEMORY_NAMESPACE = 'mcp.tool-surface';
const MEMORY_KEY = 'instances';
const MAX_INSTANCES = 64;
const MAX_CAS_ATTEMPTS = 4;
const HASH_RE = /^[a-f0-9]{64}$/;
const TICKS_RE = /^\d{12,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSPORTS = new Set(['stdio-direct', 'owner-host']);
const REGISTRY_FILE = rootPath('src', 'lib', 'tool-registry.js');
/* WHICH APP INSTANCE AN OWNER-HOST SURFACE BELONGS TO.
 *
 * T159, measured 2026-09-16 and 2026-09-18: a runtime-generation activation is
 * followed by an app restart, and every session bound to the previous instance
 * loses its tools. If the previous main process is still alive -- which is how
 * this box behaves, and what "1 observed 0 fresh" on 09-18 was looking at --
 * its record's PID is alive and, when the two generations happen to carry the
 * same tool registry, its digests match too. Nothing in the record said which
 * app instance it belonged to, so a surface no current client can reach read
 * as FRESH, next action NONE. The owner-host generation is already published
 * in the capability record; recording it is what lets that be told apart.
 *
 * This is bounded process identity, the only thing this module stores: a
 * generation id, no path, no endpoint name and no credential.
 *
 * Deliberately looser than UUID_RE. This value is not minted here -- it is
 * read back from whatever the running host published -- and a validator that
 * is stricter than the producer turns a legitimate record into a refusal. */
const GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY_FILE_NAME = 'owner-host-capability.json';
const MAX_CAPABILITY_BYTES = 4096;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('The advertised MCP surface contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!plainObject(value)) throw new TypeError('The advertised MCP surface contains an unsupported value.');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sourceDigest({ registryFile = REGISTRY_FILE, readFile = fs.readFileSync } = {}) {
  const bytes = readFile(registryFile);
  if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') throw new TypeError('The MCP tool registry could not be read.');
  return sha256(bytes);
}

function surfaceDigest(tools) {
  if (!Array.isArray(tools) || tools.length > 10_000) throw new TypeError('The advertised MCP tool surface is invalid.');
  return { toolCount: tools.length, surfaceSha256: sha256(stableJson(tools)) };
}

// The active allowlist changes the advertised tool table without changing the
// broker source. Persist only a digest of that selector: the status reader
// must never interpret a deliberately narrower direct profile as an old full
// profile, and the selector itself remains out of durable state.
function profileDigest(profileSelector = process.env.TOOLSENABLED_TOOL_ALLOWLIST || '') {
  if (typeof profileSelector !== 'string' || Buffer.byteLength(profileSelector, 'utf8') > 64 * 1024) {
    throw new TypeError('The MCP tool profile selector is invalid.');
  }
  return sha256(`profile:${profileSelector}`);
}

function currentSurface({ tools, registryFile, readFile, profileSelector } = {}) {
  if (!Array.isArray(tools)) throw new TypeError('The advertised MCP tools are required.');
  return Object.freeze({
    registryContentSha256: sourceDigest({ registryFile, readFile }),
    profileSha256: profileDigest(profileSelector),
    ...surfaceDigest(tools)
  });
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
}

function validMs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRecord(value) {
  return plainObject(value)
    && value.schemaVersion === SCHEMA_VERSION
    && typeof value.instanceId === 'string' && UUID_RE.test(value.instanceId)
    && TRANSPORTS.has(value.transport)
    && validPid(value.pid)
    && (value.startTicks === null || (typeof value.startTicks === 'string' && TICKS_RE.test(value.startTicks)))
    && validMs(value.bootedAtMs)
    && typeof value.registryContentSha256 === 'string' && HASH_RE.test(value.registryContentSha256)
    && typeof value.surfaceSha256 === 'string' && HASH_RE.test(value.surfaceSha256)
    // Q40 records written before profile-aware classification have no profile
    // digest. Keep them readable; a mismatched legacy surface is UNKNOWN,
    // never an invented stale verdict.
    && (value.profileSha256 === undefined || (typeof value.profileSha256 === 'string' && HASH_RE.test(value.profileSha256)))
    // Records written before app-instance-aware classification carry no
    // generation. Keep them readable: an instance whose app instance is
    // unknown stays exactly as classifiable as it was, never superseded on a
    // guess.
    && (value.ownerHostGeneration === undefined
      || (typeof value.ownerHostGeneration === 'string' && GENERATION_RE.test(value.ownerHostGeneration)))
    && Number.isSafeInteger(value.toolCount) && value.toolCount >= 0 && value.toolCount <= 10_000;
}

function validEnvelope(value) {
  return plainObject(value) && value.schemaVersion === SCHEMA_VERSION
    && Array.isArray(value.instances) && value.instances.length <= MAX_INSTANCES
    && value.instances.every(validRecord)
    && new Set(value.instances.map(instance => instance.instanceId)).size === value.instances.length;
}

function defaultProcessIdentity(pid) {
  if (!validPid(pid)) return Object.freeze({ state: 'unknown', startTicks: null });
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error && error.code === 'ESRCH') return Object.freeze({ state: 'dead', startTicks: null });
    return Object.freeze({ state: 'unknown', startTicks: null });
  }
  const startTicks = windowsStartTicks(pid);
  return TICKS_RE.test(String(startTicks || ''))
    ? Object.freeze({ state: 'alive', startTicks })
    : Object.freeze({ state: 'unknown', startTicks: null });
}

// ONE SPAWN FOR A WHOLE SWEEP, INSTEAD OF ONE PER INSTANCE.
//
// defaultProcessIdentity() is right for a single lookup and wrong for the sweeps
// below, which call it once per recorded instance. Measured 2026-08-17 on a cold
// mcp-server: 19 powershell.exe spawns, 6.34s -- essentially the whole time a
// client waits for its first response, and it grows with the number of instances
// ever recorded rather than staying flat.
//
// This resolves every PID in the sweep with one spawn and hands back a
// drop-in replacement for defaultProcessIdentity. The liveness half stays
// per-process and free (process.kill(pid, 0)), so the EPERM-is-not-dead rule
// that defaultProcessIdentity documents is preserved exactly; only the
// expensive start-ticks half is batched.
// A FAILED OR INCOMPLETE LOOKUP MUST NOT CONVICT AN INSTANCE.
//
// The failure mode this guards is not obvious and an earlier version of this
// function got it wrong, so it is written down. A missing start-ticks result is
// not proof that a process is dead: the lookup may have timed out, lacked
// permission, or returned incomplete output. classifyInstance() must preserve
// identity.state === 'unknown' before comparing start ticks, otherwise null
// silently becomes a definite dead verdict and recordStartup() purges the
// record.
//
// So a total batch failure falls back to the per-PID path and inherits its
// isolation. Only a batch that actually SUCCEEDED is allowed to answer for the
// whole set, where an absent PID is a real answer about that PID rather than an
// artefact of the lookup.
function batchedProcessIdentity(instances, { startTicksMany = windowsStartTicksMany, extraPids = [] } = {}) {
  const pids = [];
  for (const instance of instances || []) {
    if (instance && validPid(instance.pid)) pids.push(instance.pid);
  }
  // A caller may need a verdict for a PID that is not in the envelope yet --
  // the starting process's own. It rides the same sweep rather than paying a
  // second PowerShell for one number.
  for (const extra of extraPids) {
    if (validPid(extra) && !pids.includes(extra)) pids.push(extra);
  }
  let ticksByPid = null;
  try {
    const resolved = startTicksMany(pids);
    if (resolved instanceof Map) ticksByPid = resolved;
  } catch {
    ticksByPid = null;
  }
  // Could not batch -- answer exactly as the unbatched code did, one PID at a
  // time, so a failure costs one verdict rather than all of them.
  if (ticksByPid === null) return defaultProcessIdentity;
  return function identity(pid) {
    if (!validPid(pid)) return Object.freeze({ state: 'unknown', startTicks: null });
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && error.code === 'ESRCH') return Object.freeze({ state: 'dead', startTicks: null });
      return Object.freeze({ state: 'unknown', startTicks: null });
    }
    const startTicks = ticksByPid.get(Number(pid)) || null;
    return TICKS_RE.test(String(startTicks || ''))
      ? Object.freeze({ state: 'alive', startTicks })
      : Object.freeze({ state: 'unknown', startTicks: null });
  };
}

function classifyInstance(instance, {
  registryContentSha256, surfaceSha256, profileSha256, publishedGeneration = null,
  processIdentity = defaultProcessIdentity
} = {}) {
  if (!validRecord(instance)) return Object.freeze({ state: 'unknown', transport: null });
  if (instance.startTicks === null) return Object.freeze({ state: 'unknown', transport: instance.transport });
  let identity;
  try { identity = processIdentity(instance.pid); } catch { identity = null; }
  if (!identity || !['alive', 'dead', 'unknown'].includes(identity.state)) {
    return Object.freeze({ state: 'unknown', transport: instance.transport });
  }
  if (identity.state === 'unknown') return Object.freeze({ state: 'unknown', transport: instance.transport });
  if (identity.state === 'dead' || identity.startTicks !== instance.startTicks) {
    return Object.freeze({ state: 'dead', transport: instance.transport });
  }
  /* A LIVE PROCESS SERVING AN APP INSTANCE THAT NO LONGER EXISTS.
     Checked before the digests because it is the more specific answer and the
     only actionable one: matching bytes say nothing about whether any current
     client can reach this surface. Both sides must be KNOWN -- a record with
     no recorded generation, or a lookup that could not read the published one,
     leaves this alone rather than inventing a verdict from an absence. */
  if (instance.transport === 'owner-host'
      && typeof instance.ownerHostGeneration === 'string'
      && typeof publishedGeneration === 'string'
      && instance.ownerHostGeneration !== publishedGeneration) {
    return Object.freeze({ state: 'stale', transport: instance.transport, superseded: true });
  }
  if (instance.registryContentSha256 !== registryContentSha256) {
    return Object.freeze({ state: 'stale', transport: instance.transport });
  }
  // An exact registry + advertised-surface match is sufficient evidence even
  // if one process expressed an equivalent profile differently (for example,
  // an explicit full allowlist versus the implicit full profile).
  if (instance.surfaceSha256 === surfaceSha256) {
    return Object.freeze({ state: 'fresh', transport: instance.transport });
  }
  if (typeof instance.profileSha256 === 'string' && instance.profileSha256 !== profileSha256) {
    return Object.freeze({ state: 'unknown', transport: instance.transport });
  }
  if (instance.profileSha256 === undefined && instance.surfaceSha256 !== surfaceSha256) {
    return Object.freeze({ state: 'unknown', transport: instance.transport });
  }
  return Object.freeze({
    state: 'stale',
    transport: instance.transport
  });
}

function loadEnvelope(state) {
  const entry = state.getMemory({ namespace: MEMORY_NAMESPACE, key: MEMORY_KEY });
  if (entry === null) return { entry: null, envelope: { schemaVersion: SCHEMA_VERSION, instances: [] } };
  if (!entry || !validEnvelope(entry.value)) {
    const error = new Error('The stored MCP tool-surface records are invalid.');
    error.code = 'MCP_TOOL_SURFACE_RECORD_INVALID';
    throw error;
  }
  return { entry, envelope: entry.value };
}

/* ONE PROCESS SWEEP PER STARTUP RECORD, NOT TWO PLUS ONE PER RETRY.
 *
 * MEASURED 2026-09-02 on the installed 1.0.41: every agent's MCP server ran
 * this before it read its first line of protocol, and it spawned powershell
 * twice -- once for this process's own start ticks (the default argument
 * below) and once to sweep the recorded instances -- plus one more sweep for
 * every revision conflict, which is exactly what a burst of agents starting
 * together produces. A cold powershell.exe is roughly a third of a second, so
 * this was most of a second of an agent's start, before it could answer
 * anything.
 *
 * The two questions have one answer: the sweep is asked for the recorded PIDs
 * AND this one, and the record's own start ticks are read out of it. A retry
 * re-uses that sweep unless the recorded PID set actually changed, because a
 * conflict means another writer edited the envelope, not that these processes
 * died. An injected processIdentity (every test double is one) still answers
 * for itself and is never swept. */
function recordStartup({
  state = getStateStore(), transport = 'stdio-direct', pid = process.pid,
  startTicks, bootedAtMs = Date.now(), instanceId = crypto.randomUUID(),
  tools, registryFile, readFile, profileSelector, processIdentity, ownerHostGeneration
} = {}) {
  if (!TRANSPORTS.has(transport) || !validPid(pid) || !validMs(bootedAtMs) || !UUID_RE.test(instanceId)) {
    throw new TypeError('The MCP startup record is invalid.');
  }
  // Absent is allowed and means "this surface does not belong to a published
  // app instance". A PRESENT but malformed value is refused rather than
  // quietly dropped: silently writing a record with no generation is how a
  // superseded instance would go back to reading fresh.
  if (ownerHostGeneration !== undefined
      && (typeof ownerHostGeneration !== 'string' || !GENERATION_RE.test(ownerHostGeneration))) {
    throw new TypeError('The MCP startup record names an invalid owner-host generation.');
  }
  const surface = currentSurface({ tools, registryFile, readFile, profileSelector });
  let sweep = null;
  let sweptPidKey = null;
  let resolvedTicks = startTicks;
  let record = null;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const loaded = loadEnvelope(state);
    let identityForSweep = processIdentity;
    if (!identityForSweep) {
      const pidKey = (loaded.envelope.instances || []).map(instance => instance && instance.pid).join(',');
      if (sweep === null || pidKey !== sweptPidKey) {
        sweep = batchedProcessIdentity(loaded.envelope.instances, { extraPids: [pid] });
        sweptPidKey = pidKey;
      }
      identityForSweep = sweep;
    }
    if (resolvedTicks === undefined) {
      let own = null;
      try { own = identityForSweep(pid); } catch { own = null; }
      resolvedTicks = own && own.startTicks ? own.startTicks : null;
      // An injected identity that does not know this PID leaves the record's
      // ticks null, which classifyInstance already treats as unverifiable --
      // the same answer a failed lookup gave before.
      if (resolvedTicks === null && processIdentity) resolvedTicks = windowsStartTicks(pid);
    }
    if (record === null) {
      record = Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        instanceId,
        transport,
        pid,
        startTicks: TICKS_RE.test(String(resolvedTicks || '')) ? String(resolvedTicks) : null,
        bootedAtMs,
        registryContentSha256: surface.registryContentSha256,
        profileSha256: surface.profileSha256,
        surfaceSha256: surface.surfaceSha256,
        ...(ownerHostGeneration === undefined ? {} : { ownerHostGeneration }),
        toolCount: surface.toolCount
      });
    }
    const retained = loaded.envelope.instances.filter(instance => {
      const stateForInstance = classifyInstance(instance, {
        registryContentSha256: surface.registryContentSha256,
        profileSha256: surface.profileSha256,
        surfaceSha256: surface.surfaceSha256,
        processIdentity: identityForSweep
      });
      return stateForInstance.state !== 'dead';
    });
    const withoutThis = retained.filter(instance => instance.instanceId !== record.instanceId);
    if (withoutThis.length >= MAX_INSTANCES) {
      const error = new Error('Too many active or unverifiable MCP tool-surface records exist.');
      error.code = 'MCP_TOOL_SURFACE_CAPACITY_REACHED';
      throw error;
    }
    const next = { schemaVersion: SCHEMA_VERSION, instances: [...withoutThis, record] };
    // Do not overwrite the durable surface record with a digest assembled
    // across a registry save.  A direct process with an uncertain source
    // boundary must remain unknown; a false fresh record is worse than no
    // diagnostic record at all.  Re-check immediately before the only write.
    if (sourceDigest({ registryFile, readFile }) !== surface.registryContentSha256) {
      const error = new Error('The MCP registry changed while startup surface metadata was being assembled.');
      error.code = 'MCP_TOOL_SURFACE_REGISTRY_CHANGED';
      throw error;
    }
    try {
      const saved = state.setMemory({
        namespace: MEMORY_NAMESPACE,
        key: MEMORY_KEY,
        value: next,
        note: 'Bounded MCP process surface metadata only.',
        tags: ['mcp', 'surface'],
        expectedRevision: loaded.entry ? loaded.entry.revision : 0
      });
      return Object.freeze({ record, revision: saved.entry.revision, replayed: saved.replayed });
    } catch (error) {
      if (!error || error.code !== 'MEMORY_REVISION_CONFLICT' || attempt + 1 >= MAX_CAS_ATTEMPTS) throw error;
    }
  }
  throw new Error('The MCP tool-surface record could not be saved.');
}

/* THE APP INSTANCE THAT IS CURRENTLY PUBLISHED, or nothing.
 *
 * "Could not look" and "not there" are the same answer here on purpose, and
 * both are null: without a published generation to compare against, no
 * instance is called superseded. Every failure to read therefore costs one
 * missing diagnostic, never a wrong verdict. Nothing but the generation id is
 * taken from the record -- not the endpoint name, which is not this module's
 * business to hold. */
function publishedOwnerHostGeneration() {
  try {
    const file = require('./runtime-state-root').statePath('state', CAPABILITY_FILE_NAME);
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length > MAX_CAPABILITY_BYTES) return null;
    const parsed = JSON.parse(raw);
    return plainObject(parsed) && typeof parsed.generation === 'string' && GENERATION_RE.test(parsed.generation)
      ? parsed.generation
      : null;
  } catch {
    return null;
  }
}

function status({
  state = getStateStore(), tools, registryFile, readFile, profileSelector, processIdentity,
  publishedGeneration
} = {}) {
  let surface;
  try { surface = currentSurface({ tools, registryFile, readFile, profileSelector }); }
  catch (error) {
    // ENOENT is the only read failure that answers "the registry is absent".
    // Resource exhaustion, interrupted I/O, permissions, and every other read
    // failure answer only that this attempt could not inspect it. In particular,
    // never turn a busy machine into a durable-looking claim that its checked-in
    // registry needs repair. status() deliberately retains neither result, so a
    // later call retries the read.
    if (!error || error.code !== 'ENOENT') {
      return Object.freeze({
        schemaVersion: SCHEMA_VERSION, state: 'unavailable', reason: 'MCP_TOOL_SURFACE_REGISTRY_CHECK_FAILED',
        nextAction: 'retry the registry check; this result is not claiming that the MCP tool registry is absent',
        counts: { observed: 0, fresh: 0, stale: 0, unknown: 0, deadIgnored: 0 }
      });
    }
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION, state: 'unavailable', reason: 'MCP_TOOL_SURFACE_REGISTRY_UNAVAILABLE',
      nextAction: 'repair the checked-in registry before relying on MCP surface status',
      counts: { observed: 0, fresh: 0, stale: 0, unknown: 0, deadIgnored: 0 }
    });
  }
  let loaded;
  try { loaded = loadEnvelope(state); }
  catch {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION, state: 'unavailable', reason: 'MCP_TOOL_SURFACE_STATE_UNAVAILABLE',
      nextAction: 'repair durable state before relying on MCP surface status',
      counts: { observed: 0, fresh: 0, stale: 0, unknown: 0, deadIgnored: 0 }
    });
  }
  const counts = { observed: loaded.envelope.instances.length, fresh: 0, stale: 0, unknown: 0, deadIgnored: 0 };
  let directObserved = false;
  let supersededObserved = false;
  // Read only if some record actually claims an app instance: a checkout, a
  // one-shot broker and every pre-generation record answer this question
  // without touching the filesystem.
  const publishedForSweep = publishedGeneration !== undefined
    ? publishedGeneration
    : (loaded.envelope.instances.some(instance => typeof instance?.ownerHostGeneration === 'string')
      ? publishedOwnerHostGeneration()
      : null);
  // Same batching as the startup sweep; an injected processIdentity still wins.
  const identityForSweep = processIdentity || batchedProcessIdentity(loaded.envelope.instances);
  for (const instance of loaded.envelope.instances) {
    const classified = classifyInstance(instance, {
      registryContentSha256: surface.registryContentSha256,
      profileSha256: surface.profileSha256,
      surfaceSha256: surface.surfaceSha256,
      publishedGeneration: publishedForSweep,
      processIdentity: identityForSweep
    });
    if (classified.state === 'dead') { counts.deadIgnored += 1; continue; }
    if (classified.transport === 'stdio-direct') directObserved = true;
    if (classified.superseded === true) supersededObserved = true;
    counts[classified.state] += 1;
  }
  // A dashboard/doctor cannot associate an arbitrary direct stdio MCP server
  // with the particular client currently looking at this report. Therefore a
  // matching one-shot direct broker is evidence, not a green light for another
  // direct client. An exact stale record *is* actionable and remains stale.
  if (counts.stale > 0) {
    /* A superseded instance is still stale, and it is the more useful thing to
       say: it names WHY -- this computer restarted the app into another
       runtime -- and what recovers it, which is resuming the agents bound to
       the instance that went away, not editing anything. */
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      state: 'stale',
      reason: supersededObserved ? 'MCP_TOOL_SURFACE_GENERATION_SUPERSEDED' : 'MCP_TOOL_SURFACE_STALE_INSTANCE',
      nextAction: supersededObserved
        ? 'a previous app instance is still holding an MCP tool surface; resume the agent sessions bound to it from the app, and restart the affected MCP client at its next session boundary'
        : 'restart the affected MCP client at its next session boundary',
      counts, directSessionScopeUnverified: directObserved
    });
  }
  if (counts.unknown > 0 || directObserved || counts.fresh === 0) {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION, state: 'unknown',
      reason: counts.unknown > 0 ? 'MCP_TOOL_SURFACE_INSTANCE_UNVERIFIABLE'
        : directObserved ? 'MCP_TOOL_SURFACE_DIRECT_SESSION_UNBOUND'
          : 'MCP_TOOL_SURFACE_NO_LIVE_RECORD',
      nextAction: 'restart the MCP client at its next session boundary; a one-shot recovery does not prove another direct session is current',
      counts, directSessionScopeUnverified: directObserved
    });
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION, state: 'fresh', reason: 'MCP_TOOL_SURFACE_MATCHED_OWNER_HOST',
    nextAction: 'none', counts, directSessionScopeUnverified: false
  });
}

function browserProjection(value) {
  const report = value && typeof value === 'object' ? value : null;
  const states = new Set(['fresh', 'stale', 'unknown', 'unavailable']);
  if (!report || report.schemaVersion !== SCHEMA_VERSION || !states.has(report.state)
      || typeof report.reason !== 'string' || typeof report.nextAction !== 'string'
      || !plainObject(report.counts)) {
    throw new TypeError('The MCP tool-surface status is invalid.');
  }
  const counts = {};
  for (const key of ['observed', 'fresh', 'stale', 'unknown', 'deadIgnored']) {
    if (!Number.isSafeInteger(report.counts[key]) || report.counts[key] < 0) {
      throw new TypeError('The MCP tool-surface status counts are invalid.');
    }
    counts[key] = report.counts[key];
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    state: report.state,
    reason: report.reason,
    nextAction: report.nextAction,
    counts,
    directSessionScopeUnverified: report.directSessionScopeUnverified === true
  });
}

module.exports = Object.freeze({
  MAX_CAS_ATTEMPTS, MAX_INSTANCES, MEMORY_KEY, MEMORY_NAMESPACE, REGISTRY_FILE, SCHEMA_VERSION,
  batchedProcessIdentity, browserProjection, classifyInstance, currentSurface, defaultProcessIdentity, recordStartup,
  profileDigest, stableJson, status, surfaceDigest, validEnvelope, validRecord
});
