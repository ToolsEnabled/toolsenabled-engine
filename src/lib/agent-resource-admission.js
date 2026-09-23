'use strict';

// Admission is about current capacity, never a ceiling on running agents.
// The default Claude reservation comes from the application's 2026-09-03
// observation (665–748 MiB private bytes including its MCP children). Other
// provider figures are deliberately labelled estimates, not measurements.
const MIB = 1024 * 1024;
const MODES = Object.freeze(['both', 'controller', 'mechanical', 'off']);
const DEFAULT_SETTINGS = Object.freeze({
  mode: 'off', reserveBytes: 2048 * MIB,
  providerBytes: Object.freeze({ claude: 768 * MIB, codex: 1024 * MIB, gemini: 1024 * MIB, grok: 1024 * MIB, local: 1024 * MIB }),
  maxConcurrentStarts: 8, sampleMaxAgeMs: 6000, settleMs: 4000,
  cpuCeilingPercent: 97, cpuBusyPercent: 80, startIntervalMs: 250, busyStartIntervalMs: 5000,
});
const PROVIDERS = Object.freeze(['claude', 'codex', 'gemini', 'grok', 'local']);
const finite = value => typeof value === 'number' && Number.isFinite(value);

function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const bounded = (number, fallback, min, max) => finite(number) && number >= min && number <= max ? number : fallback;
  const cpuCeilingPercent = Math.floor(bounded(value.cpuCeilingPercent, DEFAULT_SETTINGS.cpuCeilingPercent, 50, 99));
  const cpuBusyPercent = Math.floor(bounded(value.cpuBusyPercent, Math.min(DEFAULT_SETTINGS.cpuBusyPercent, cpuCeilingPercent - 1), 20, cpuCeilingPercent - 1));
  const startIntervalMs = Math.floor(bounded(value.startIntervalMs, DEFAULT_SETTINGS.startIntervalMs, 50, 10000));
  const busyStartIntervalMs = Math.floor(bounded(value.busyStartIntervalMs, Math.max(DEFAULT_SETTINGS.busyStartIntervalMs, startIntervalMs), Math.max(250, startIntervalMs), 30000));
  const costs = value.providerBytes && typeof value.providerBytes === 'object' ? value.providerBytes : {};
  return Object.freeze({
    mode: MODES.includes(value.mode) ? value.mode : DEFAULT_SETTINGS.mode,
    reserveBytes: bounded(value.reserveBytes, DEFAULT_SETTINGS.reserveBytes, 0, 1024 * 1024 * MIB),
    providerBytes: Object.freeze(Object.fromEntries(PROVIDERS.map(provider => [provider,
      bounded(costs[provider], DEFAULT_SETTINGS.providerBytes[provider], MIB, 1024 * 1024 * MIB)]))),
    maxConcurrentStarts: Math.floor(bounded(value.maxConcurrentStarts, DEFAULT_SETTINGS.maxConcurrentStarts, 1, 64)),
    sampleMaxAgeMs: bounded(value.sampleMaxAgeMs, DEFAULT_SETTINGS.sampleMaxAgeMs, 1000, 30000),
    settleMs: bounded(value.settleMs, DEFAULT_SETTINGS.settleMs, 1000, 30000),
    cpuCeilingPercent, cpuBusyPercent, startIntervalMs, busyStartIntervalMs,
  });
}

function createResourceAdmission({ now = Date.now, settings = () => DEFAULT_SETTINGS, authorizeAdvice = () => false } = {}) {
  const samples = [];
  const reservations = new Map();
  const advice = new Map();
  const seenAdvice = new Map();
  let sequence = 0;
  let pressure = false;
  /* WHY THE PRESSURE LATCHED, kept beside the latch. Measured in the owner's
     signed spawn record 2026-09-14T09Z: 558 AGENT_RESOURCE_PRESSURE refusals
     in one hour for one node, and the reason text named "97% CPU" for every
     one of them although the latch below also trips on application loop lag
     and on an unreadable sample. A retry loop cannot classify what it is
     waiting for from a code alone, and a person reading the record cannot
     tell a measured loop stall from CPU pressure. The sample does not identify its cause. */
  let pressureCause = null;
  let pressureTrigger = null;
  let recoverySamples = 0;
  let nextStartAt = 0;
  let nextRootAt = 0;

  function config() { return normalizeSettings(settings()); }
  function adviceAuthorized(value) { try { return authorizeAdvice(value) === true; } catch { return false; } }
  function recordSample(sample) {
    const at = sample?.atMs;
    if (!finite(at) || at > now() || (samples.length && at <= samples.at(-1).atMs)) return false;
    const valid = finite(sample.cpuPercent) && sample.cpuPercent >= 0 && sample.cpuPercent <= 100
      && finite(sample.freeBytes) && sample.freeBytes >= 0
      && finite(sample.totalBytes) && sample.totalBytes > 0 && sample.freeBytes <= sample.totalBytes;
    samples.push(Object.freeze({ ...sample, valid }));
    if (samples.length > 60) samples.shift();
    const cfg = config();
    const cause = !valid ? 'unreadable-sample'
      : sample.cpuPercent >= cfg.cpuCeilingPercent ? 'cpu-ceiling'
        : (finite(sample.loopLagMs) && sample.loopLagMs >= 500) ? 'loop-lag' : null;
    if (cause) {
      pressure = true; pressureCause = cause; recoverySamples = 0;
      pressureTrigger = Object.freeze({ atMs: at, cpuPercent: valid ? sample.cpuPercent : null,
        freeBytes: valid ? sample.freeBytes : null, loopLagMs: finite(sample.loopLagMs) ? sample.loopLagMs : null });
    } else if (pressure) {
      recoverySamples = sample.cpuPercent <= cfg.cpuCeilingPercent - 7 && (!finite(sample.loopLagMs) || sample.loopLagMs < 200) ? recoverySamples + 1 : 0;
      if (recoverySamples >= 3) { pressure = false; pressureCause = null; pressureTrigger = null; recoverySamples = 0; }
    }
    // A completed launch remains reserved until a NEW physical-memory reading
    // has observed its settling window. Advancing wall time alone cannot free it.
    for (const [id, reservation] of reservations) {
      if (valid && reservation.readyAt !== null && at >= reservation.readyAt + config().settleMs) reservations.delete(id);
    }
    return true;
  }

  function setAdvice(value) {
    if (!value || !PROVIDERS.includes(value.provider) || typeof value.id !== 'string'
      || !['allow', 'hold'].includes(value.decision) || typeof value.controllerId !== 'string'
      || !finite(value.expiresAtMs) || value.expiresAtMs <= now()
      || value.expiresAtMs > now() + 60000
      || !Number.isSafeInteger(value.launches) || value.launches < 0
      || (value.decision === 'allow' && value.launches < 1)
      || !adviceAuthorized(value)) return false;
    const previous = advice.get(value.provider);
    // Re-reading the same durable instruction must not refill spent credit.
    if (previous?.id === value.id) return true;
    for (const [id, expiry] of seenAdvice) if (expiry <= now()) seenAdvice.delete(id);
    if (seenAdvice.has(value.id)) return false;
    seenAdvice.set(value.id, value.expiresAtMs);
    advice.set(value.provider, { ...value, remaining: value.launches });
    return true;
  }

  function snapshot() {
    const cfg = config();
    const reading = samples.at(-1) || null;
    const ageMs = reading ? now() - reading.atMs : null;
    const fresh = reading?.valid === true && ageMs >= 0 && ageMs <= cfg.sampleMaxAgeMs;
    const recent = samples.filter(sample => sample.valid && now() - sample.atMs <= cfg.sampleMaxAgeMs);
    const lastThree = recent.slice(-3);
    const readyWindow = fresh && lastThree.length === 3 && lastThree.at(-1).atMs - lastThree[0].atMs >= 1500;
    const cpuWindowMaxPercent = readyWindow ? Math.max(...lastThree.map(row => row.cpuPercent)) : null;
    const stable = readyWindow && cpuWindowMaxPercent - Math.min(...lastThree.map(row => row.cpuPercent)) <= 10;
    // Ordinary low-load fluctuations are not evidence of capacity pressure.
    // Require a measured window everywhere; require tight steadiness only near
    // capacity. Every sample must be below the cautious band, not just the last.
    const headroomWindow = readyWindow && cpuWindowMaxPercent < cfg.cpuBusyPercent;
    const outstanding = [...reservations.values()];
    return {
      mode: cfg.mode, measuredAt: reading ? new Date(reading.atMs).toISOString() : null,
      atMs: reading?.atMs ?? null, ageMs, fresh, readyWindow, stable, headroomWindow, cpuWindowMaxPercent, pressure,
      pressureCause: pressure ? pressureCause : null,
      pressureTrigger: pressure ? pressureTrigger : null, recoverySamples,
      cpuPercent: fresh ? reading.cpuPercent : null,
      freeBytes: fresh ? reading.freeBytes : null, totalBytes: reading?.totalBytes ?? null,
      logicalProcessors: reading?.logicalProcessors ?? null,
      loopLagMs: reading?.loopLagMs ?? null,
      // Physical RAM is not Windows commit headroom. Do not relabel it.
      commitAvailableBytes: null,
      reservedBytes: outstanding.reduce((sum, row) => sum + row.bytes, 0),
      starting: outstanding.filter(row => row.readyAt === null).length,
      settling: outstanding.filter(row => row.readyAt !== null).length,
      startIntervalMs: headroomWindow ? cfg.startIntervalMs : cfg.busyStartIntervalMs,
      startSlots: headroomWindow ? cfg.maxConcurrentStarts : 1,
      settings: cfg,
      controller: Object.fromEntries(PROVIDERS.map(provider => {
        const current = advice.get(provider);
        return [provider, current && current.expiresAtMs > now() && adviceAuthorized(current)
          ? { id: current.id, controllerId: current.controllerId, decision: current.decision, remaining: current.remaining, expiresAtMs: current.expiresAtMs, reason: current.reason }
          : null];
      })),
    };
  }

  /* THE MEASURED REASON, NOT THE CODE'S USUAL SENTENCE. Every refusal below
     carries `measured`: which scarcity tripped it and the figures it tripped
     on, so a caller can classify before it retries and a record can keep the
     figures beside the code. A CPU ceiling, an application loop stall and an
     unreadable sample all refuse as AGENT_RESOURCE_PRESSURE, and until this was
     written they all read "97% CPU". */
  function measuredPressure(state) {
    // Without a latched cause the refusal came from the three-sample window
    // itself, which only ever reads CPU.
    const cause = state.pressureCause || 'cpu-ceiling';
    const figures = { cause, cpuPercent: state.cpuPercent, cpuWindowMaxPercent: state.cpuWindowMaxPercent,
      loopLagMs: state.loopLagMs, freeBytes: state.freeBytes, cpuCeilingPercent: state.settings.cpuCeilingPercent,
      trigger: state.pressureTrigger, recoverySamples: state.recoverySamples };
    const mib = bytes => finite(bytes) ? `${Math.round(bytes / MIB)} MiB free` : 'free memory unread';
    const trigger = state.pressureTrigger;
    const recovery = state.pressure ? ` Recovery measurements: ${state.recoverySamples} of 3 below the configured CPU recovery threshold with no reported loop lag at or above 200 ms.` : '';
    const sentence = (cause === 'loop-lag'
      ? `New starts are held after an application event-loop stall of ${finite(trigger?.loopLagMs) ? `${Math.round(trigger.loopLagMs)} ms` : 'at least 500 ms'}. Latest loop lag ${finite(state.loopLagMs) ? `${Math.round(state.loopLagMs)} ms` : 'unread'}, CPU ${finite(state.cpuPercent) ? `${Math.round(state.cpuPercent)}%` : 'unread'}, ${mib(state.freeBytes)}. The stall's cause was not measured.`
      : cause === 'unreadable-sample'
        ? `New starts are held after an unreadable resource sample. Latest CPU ${finite(state.cpuPercent) ? `${Math.round(state.cpuPercent)}%` : 'unread'}, ${mib(state.freeBytes)}.`
        : `New starts are held after CPU reached the ${state.settings.cpuCeilingPercent}% ceiling: measured ${finite(state.cpuPercent) ? `${Math.round(state.cpuPercent)}%` : 'unread'} now, ${finite(state.cpuWindowMaxPercent) ? `${Math.round(state.cpuWindowMaxPercent)}%` : 'unread'} peak over the last three samples (${mib(state.freeBytes)}).`) + recovery;
    return { sentence, figures };
  }
  function mechanicalRefusal(state, refuse) {
    if (!state.fresh) return refuse('AGENT_RESOURCE_UNKNOWN', 'Resource readings are missing or stale. Waiting for a fresh measurement before starting more agents.');
    if (state.pressure || state.cpuPercent >= state.settings.cpuCeilingPercent || state.cpuWindowMaxPercent >= state.settings.cpuCeilingPercent) {
      const { sentence, figures } = measuredPressure(state);
      return { ...refuse('AGENT_RESOURCE_PRESSURE', sentence), measured: figures };
    }
    if (!state.readyWindow) return refuse('AGENT_RESOURCE_WARMING', 'Measuring three fresh resource samples before starting more agents.');
    if (!state.headroomWindow && !state.stable) return refuse('AGENT_RESOURCE_WARMING', 'CPU has been near capacity and is fluctuating. Waiting for a steady resource window before starting more agents.');
    return null;
  }

  function inspect({ provider = 'codex', acknowledged = false, bootstrapController = false } = {}) {
    const state = snapshot();
    const cfg = state.settings;
    if (bootstrapController && ['both', 'controller'].includes(cfg.mode)) {
      state.configuredMode = state.mode;
      state.mode = 'mechanical';
      state.bootstrapController = true;
    }
    const mode = state.mode;
    const refuse = (code, reason, retryAfterMs = 1000) => ({ ok: false, code, reason, retryAfterMs, state });
    if (!PROVIDERS.includes(provider)) return refuse('AGENT_RESOURCE_PROVIDER_UNKNOWN', 'This program has no resource estimate. Choose a supported program before starting it.');
    if (mode === 'off') return { ok: true, state };
    // Bounded work in flight, NOT an agent limit. Even controller-only mode
    // must yield between launches; it never refuses based on running count.
    if (state.starting >= cfg.maxConcurrentStarts) return refuse('AGENT_RESOURCE_STARTS_BUSY', 'Other agents are still starting. The remaining drafts will wait.');
    if (mode === 'mechanical' || mode === 'both') {
      const unsafe = mechanicalRefusal(state, refuse);
      if (unsafe) return unsafe;
      const needed = cfg.reserveBytes + cfg.providerBytes[provider] + state.reservedBytes;
      if (!acknowledged && state.freeBytes < needed) {
        return { ...refuse('AGENT_MEMORY_LOW', `The available physical memory (${Math.round(state.freeBytes / MIB)} MiB free) does not cover another agent, outstanding launch reservations, and the configured reserve (${Math.round(needed / MIB)} MiB needed).`),
          measured: { cause: 'memory', freeBytes: state.freeBytes, neededBytes: needed, reservedBytes: state.reservedBytes, cpuPercent: state.cpuPercent, loopLagMs: state.loopLagMs } };
      }
      // At 85% stable, probe one additional start slowly. At 99%, hold above.
      // Neither decision uses how many agents happen to be running.
      const slots = state.startSlots;
      if (state.starting >= slots || now() < nextStartAt) return refuse('AGENT_RESOURCE_PACING', 'Letting the current launch settle before admitting another.', Math.max(250, nextStartAt - now()));
    }
    if (mode === 'controller' || mode === 'both') {
      const current = advice.get(provider);
      if (!current || current.expiresAtMs <= now() || !adviceAuthorized(current)) return refuse('AGENT_RESOURCE_CONTROLLER_UNKNOWN', 'Waiting for current resource advice from the authorised controller.');
      if (current.decision === 'hold') return refuse('AGENT_RESOURCE_CONTROLLER_HOLD', current.reason || 'The controller has paused additional starts.');
      if (current.remaining < 1) return refuse('AGENT_RESOURCE_CONTROLLER_UNKNOWN', 'The controller’s additional-start allowance is used. Waiting for fresh advice.');
    }
    return { ok: true, state };
  }

  function reserve(options = {}) {
    const result = inspect(options);
    if (!result.ok || result.state.mode === 'off') return { ...result, token: null };
    const provider = options.provider || 'codex';
    const token = `launch-${++sequence}`;
    reservations.set(token, { provider, bytes: result.state.settings.providerBytes[provider], readyAt: null,
      policy: JSON.stringify(result.state.settings), mode: result.state.mode, rootChecked: false,
      acknowledged: options.acknowledged === true, bootstrapController: result.state.bootstrapController === true,
      adviceId: ['both', 'controller'].includes(result.state.mode) ? advice.get(provider).id : null });
    if (result.state.mode === 'both' || result.state.mode === 'controller') advice.get(provider).remaining -= 1;
    nextStartAt = now() + result.state.startIntervalMs;
    return { ...result, token };
  }
  function revalidate(token) {
    const state = snapshot();
    const cfg = state.settings;
    const entry = reservations.get(token);
    const refuse = (code, reason) => ({ ok: false, code, reason, retryAfterMs: 1000, state });
    if (entry?.rootChecked || entry?.readyAt !== null && entry?.readyAt !== undefined) {
      return refuse('AGENT_RESOURCE_GRANT_USED', 'This reservation already permitted its provider root.');
    }
    // All off disables policy even for a previously admitted wrapper. A change
    // in the other direction needs a fresh debit, never an uncharged old grant.
    if (cfg.mode === 'off') { if (entry) entry.rootChecked = true; return { ok: true, state }; }
    if (!entry || entry.policy !== JSON.stringify(cfg)) return refuse('AGENT_RESOURCE_POLICY_CHANGED', 'The resource policy changed while this lane prepared. Retry with the current policy.');
    if (entry.bootstrapController && ['both', 'controller'].includes(cfg.mode)) {
      state.configuredMode = cfg.mode;
      state.mode = 'mechanical';
      state.bootstrapController = true;
    }
    if (state.mode === 'mechanical' || state.mode === 'both') {
      const unsafe = mechanicalRefusal(state, refuse);
      if (unsafe) return unsafe;
      // This pending launch is already included in reservedBytes. Adding its
      // provider estimate again would charge the same RAM twice.
      if (!entry.acknowledged && state.freeBytes < cfg.reserveBytes + state.reservedBytes) return refuse('AGENT_MEMORY_LOW', 'New physical-memory readings no longer cover the outstanding launch reservations and configured reserve.');
      if (now() < nextRootAt) return refuse('AGENT_RESOURCE_PACING', 'Letting the last provider root begin before permitting another.');
    }
    if (state.mode === 'controller' || state.mode === 'both') {
      const current = advice.get(entry.provider);
      if (!current || current.expiresAtMs <= now() || !adviceAuthorized(current)) return refuse('AGENT_RESOURCE_CONTROLLER_UNKNOWN', 'The controller advice is expired or its authority was revoked.');
      if (current.decision === 'hold') return refuse('AGENT_RESOURCE_CONTROLLER_HOLD', current.reason || 'The controller has paused additional starts.');
      if (current.id !== entry.adviceId) return refuse('AGENT_RESOURCE_CONTROLLER_UNKNOWN', 'New controller advice superseded this pending launch. Retry against the current allowance.');
      // remaining may be zero: this exact reservation already spent its one
      // credit. Revalidation neither spends it again nor replenishes it.
    }
    entry.rootChecked = true;
    if (state.mode === 'mechanical' || state.mode === 'both') nextRootAt = now() + state.startIntervalMs;
    return { ok: true, state };
  }
  function ready(token) {
    const reservation = reservations.get(token);
    if (reservation && reservation.readyAt === null) reservation.readyAt = now();
  }
  function release(token) { return reservations.delete(token); }
  return Object.freeze({ recordSample, setAdvice, inspect, reserve, revalidate, ready, release, snapshot });
}

module.exports = Object.freeze({ DEFAULT_SETTINGS, MODES, PROVIDERS, normalizeSettings, createResourceAdmission });
