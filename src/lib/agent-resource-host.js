'use strict'

const { randomUUID } = require('node:crypto')
const defaultEngine = { ...require('./agent-resource-admission'), ...require('./agent-resource-monitor') }
const RESOURCE_PREF_KEY = 'mc.resources.v1'
const TERMINAL = new Set(['ended', 'closed', 'failed'])
function fail(code, message) { const error = new Error(message); error.code = code; throw error }

function createAgentResourceHost({ engine = defaultEngine, prefs, sessions, readOrg, readToolMode = null, now = Date.now, schedule = setInterval, unschedule = clearInterval, sample = null, bootId = randomUUID() }) {
  let settings
  try { settings = engine.normalizeSettings(JSON.parse(prefs.snapshot().values[RESOURCE_PREF_KEY] || '{}')) }
  catch { settings = engine.normalizeSettings() }
  let disposed = false
  let bootstrapSession = null
  const challenges = new Map()
  const unavailableListeners = new Set()
  let readSample = sample
  let timer = null

  function identity(agentId, roleId, roleRevision, provider, capability = 'orgRoot') {
    const record = readOrg()
    if (!record?.ok || record.org?.damaged || !Array.isArray(record.org?.agents) || !Array.isArray(record.roles)) return false
    const seat = record.org.agents.find(row => row.id === agentId && row.enabled === true)
    const role = record.roles.find(row => row.id === roleId)
    return !!seat && seat.role === roleId && seat.provider === provider
      && role?.revision === roleRevision && role?.capabilities?.[capability] === true
  }
  function alive(sessionId) {
    const session = sessions.get(sessionId)
    return !!session && !TERMINAL.has(session.state)
  }
  function controller(principal) {
    if (disposed || principal?.kind !== 'agent-session' || !alive(principal.sessionId)) return false
    const session = sessions.get(principal.sessionId)
    const authority = session.agentAuthority
    return !!authority && Number.isSafeInteger(principal.expectedOrgRevision) && Number.isSafeInteger(principal.expectedRoleRevision)
      && ['agentId', 'provider', 'roleId', 'expectedOrgRevision', 'expectedRoleRevision'].every(key => authority[key] === principal[key])
      && session.state === 'ready' && session.agentId === principal.agentId
      && identity(principal.agentId, principal.roleId, principal.expectedRoleRevision, principal.provider)
  }
  const governor = engine.createResourceAdmission({ now, settings: () => settings,
    authorizeAdvice: advice => advice.bootId === bootId && controller(advice.principal),
  })
  let lastTick = now()
  function tick() {
    if (disposed || settings.mode === 'off') return
    if (!readSample) readSample = engine.createResourceSampler({ now })
    const current = now()
    governor.recordSample(readSample({ loopLagMs: Math.max(0, current - lastTick - 1000) }))
    lastTick = current
    for (const [key, challenge] of challenges) if (challenge.expiresAtMs <= current || !alive(challenge.sessionId)) challenges.delete(key)
  }
  function syncSampling() {
    if (settings.mode === 'off' || disposed) {
      if (timer !== null) unschedule(timer)
      timer = null
      challenges.clear()
      if (!sample) readSample = null
      return
    }
    if (timer !== null) return
    lastTick = now()
    tick()
    timer = schedule(tick, 1000)
    timer?.unref?.()
  }
  syncSampling()

  function status(principal = null) {
    if (disposed) fail('AGENT_RESOURCE_UNKNOWN', 'The application resource monitor is stopped.')
    if (principal && !controller(principal)) fail('RESOURCE_CONTROLLER_REQUIRED', 'Only the current declared organisation-root controller may read this resource tool.')
    const state = governor.snapshot()
    const sampleId = state.atMs === null ? null : `${bootId}:${state.atMs}`
    if (principal && state.fresh) {
      const key = `${principal.sessionId}:${sampleId}`
      if (!challenges.has(key)) challenges.set(key, { sessionId: principal.sessionId, atMs: state.atMs, expiresAtMs: state.atMs + 60000 })
      // Bounded by controllers and the last minute's 1 Hz samples, not agents.
    }
    const admission = Object.fromEntries(engine.PROVIDERS.map(provider => {
      const verdict = governor.inspect({ provider })
      // `measured` rides through so a window can classify a hold (memory,
      // CPU, loop stall) before it decides whether to wait again.
      return [provider, { ok: verdict.ok, code: verdict.code || null, reason: verdict.reason || 'Ready for another start.', retryAfterMs: verdict.retryAfterMs || 0,
        ...(verdict.measured ? { measured: verdict.measured } : {}) }]
    }))
    let newControllerTools
    if (typeof readToolMode === 'function') {
      try {
        const mode = readToolMode()
        if (!require('./tool-mode').MODES.includes(mode)) throw new Error('Unknown tool mode')
        newControllerTools = { known: true, mode, available: mode !== 'Native tools only' }
      } catch { newControllerTools = { known: false, mode: null, available: null } }
    }
    return { ok: true, ...state, bootId, sampleId, admission, defaults: engine.DEFAULT_SETTINGS,
      ...(newControllerTools ? { newControllerTools } : {}),
      reservationBasis: { claude: 'Observed 665-748 MiB on 2026-09-03; default reservation 768 MiB. Recalibrate for this machine.', codex: 'Unmeasured estimate; configurable.', local: 'Unmeasured estimate; configurable.' },
      bootstrapSessionId: bootstrapSession && alive(bootstrapSession) ? bootstrapSession : null,
    }
  }
  function advise(args, principal) {
    if (!controller(principal)) fail('RESOURCE_CONTROLLER_REQUIRED', 'Resource advice requires the current declared organisation-root controller.')
    if (!args || Object.keys(args).some(key => !['bootId', 'sampleId', 'provider', 'decision', 'launches', 'expiresAtMs', 'reason'].includes(key))
      || args.bootId !== bootId || typeof args.sampleId !== 'string' || !engine.PROVIDERS.includes(args.provider)
      || !['allow', 'hold'].includes(args.decision) || !Number.isSafeInteger(args.launches) || args.launches < 0 || args.launches > 1000
      || (args.decision === 'allow' && args.launches < 1) || typeof args.reason !== 'string' || args.reason.length < 1 || args.reason.length > 500
      || !Number.isFinite(args.expiresAtMs) || args.expiresAtMs <= now() || args.expiresAtMs > now() + 60000) {
      fail('RESOURCE_ADVICE_INVALID', 'Advice needs the current boot, a measured sample, a finite allowance, a reason, and an expiry no more than 60 seconds away.')
    }
    const challenge = challenges.get(`${principal.sessionId}:${args.sampleId}`)
    if (!challenge || challenge.expiresAtMs <= now() || args.expiresAtMs > challenge.expiresAtMs) {
      fail('RESOURCE_ADVICE_STALE', 'Read a fresh resource status before advising. Advice may not outlive its cited measurement by more than 60 seconds.')
    }
    const value = { ...args, id: `${principal.sessionId}:${args.sampleId}:${args.provider}`, controllerId: principal.agentId,
      measuredAtMs: challenge.atMs, principal: { ...principal } }
    // Same session/sample/provider is one finite budget, never a refill.
    const serialized = JSON.stringify(args)
    if (challenge[args.provider] && challenge[args.provider] !== serialized) fail('RESOURCE_ADVICE_REPLAY', 'This sample already supplied advice for this program. Read a new sample before changing it.')
    if (!governor.setAdvice(value)) fail('RESOURCE_ADVICE_REFUSED', 'This resource advice is stale, revoked, or already used.')
    challenge[args.provider] = serialized
    return status(principal)
  }
  function bootstrap(options) {
    if (!['both', 'controller'].includes(settings.mode)) return false
    const authority = options.agentAuthority
    if (!authority || authority.agentId !== options.agentId || !identity(options.agentId, authority.roleId, authority.expectedRoleRevision, authority.provider)) return false
    if (bootstrapSession && alive(bootstrapSession) && bootstrapSession !== options.sessionId) return false
    for (const [id, session] of sessions) {
      if (id === options.sessionId || !alive(id) || (session.started !== true && session.state === 'starting')) continue
      const existing = session.agentAuthority
      if (existing && existing.agentId === session.agentId
        && identity(existing.agentId, existing.roleId, existing.expectedRoleRevision, existing.provider)) return false
      // A legacy/tombstone session still naming the requested root is not
      // evidence that the root is absent, even without its cached binding.
      if (session.agentId === options.agentId) return false
    }
    return true
  }
  function inspect(options = {}) {
    if (disposed) return { ok: false, code: 'AGENT_RESOURCE_UNKNOWN', reason: 'The application resource monitor is stopped.', retryAfterMs: 1000 }
    return governor.inspect({ ...options, bootstrapController: bootstrap(options) })
  }
  function reserve(options = {}) {
    if (disposed) return inspect(options)
    const result = governor.reserve({ ...options, bootstrapController: bootstrap(options) })
    if (result.ok && result.state.bootstrapController) bootstrapSession = options.sessionId
    return result
  }
  function laneAdmission(state, provider) {
    const mode = state.mode
    const sampleRemaining = ['mechanical', 'both'].includes(mode) ? state.settings.sampleMaxAgeMs - state.ageMs : 60000
    const adviceRemaining = ['controller', 'both'].includes(mode) ? state.controller[provider]?.expiresAtMs - now() : 60000
    return Object.freeze({ mode, measuredAt: state.measuredAt, validForMs: Math.max(0, Math.min(sampleRemaining, adviceRemaining)) })
  }
  function laneReservation(request, validateAuthority = () => {}) {
    if (!request || Object.keys(request).length !== 1 || !engine.PROVIDERS.includes(request.provider)) {
      fail('AGENT_RESOURCE_PROVIDER_UNKNOWN', 'A detached lane must name exactly one supported program.')
    }
    // No caller-controlled acknowledgement or controller-bootstrap exception.
    const provider = request.provider
    const result = governor.reserve({ provider })
    if (!result.ok) fail(result.code, result.reason)
    let released = false
    function revalidate() {
      if (disposed) fail('AGENT_RESOURCE_UNKNOWN', 'The application resource monitor is stopped.')
      if (released) fail('AGENT_RESOURCE_GRANT_USED', 'This lane reservation was released.')
      validateAuthority()
      const checked = governor.revalidate(result.token)
      if (!checked.ok) fail(checked.code, checked.reason)
      return laneAdmission(checked.state, provider)
    }
    return Object.freeze({
      admission: laneAdmission(result.state, provider),
      revalidate,
      beforeRootSpawn: revalidate,
      ready() { if (!released) governor.ready(result.token) },
      release() { if (released) return; released = true; governor.release(result.token) },
    })
  }
  function assertLanePrincipal(principal) {
    if (disposed) fail('AGENT_RESOURCE_UNKNOWN', 'The application resource monitor is stopped.')
    const session = sessions.get(principal?.sessionId)
    const authority = session?.agentAuthority
    // The mission dispatcher already checks its current action capability.
    // Check it again at the OS spawn boundary, against the exact binding the
    // application retained when it opened this still-living parent session.
    if (principal?.kind !== 'agent-session' || !session || session.state !== 'ready'
      || !Number.isSafeInteger(principal.expectedOrgRevision) || !Number.isSafeInteger(principal.expectedRoleRevision)
      || !authority || session.agentId !== principal.agentId
      || ['agentId', 'provider', 'roleId', 'expectedOrgRevision', 'expectedRoleRevision'].some(key => authority[key] !== principal[key])
      || !identity(principal.agentId, principal.roleId, principal.expectedRoleRevision, principal.provider, 'mayMutateMissionBridge')) {
      fail('RESOURCE_LAUNCH_CALLER_REQUIRED', 'A detached application lane requires its current authenticated parent session and declared launch authority.')
    }
  }
  function reserveLane(request, principal) {
    const boundPrincipal = Object.freeze({ ...principal })
    assertLanePrincipal(boundPrincipal)
    // A parent is already alive to ask for this lane; it is not the first root.
    return laneReservation(request, () => assertLanePrincipal(boundPrincipal))
  }
  function reserveServiceLane(request, principal) {
    if (disposed) fail('AGENT_RESOURCE_UNKNOWN', 'The application resource monitor is stopped.')
    // Called only by the app's retained capability-child IPC endpoint. The
    // service derives this principal from HTTP authentication, never JSON body
    // fields. Session launches still recheck the exact live app binding above.
    if (principal?.kind === 'owner-ui' && Object.keys(principal).length === 1) return laneReservation(request)
    return reserveLane(request, principal)
  }
  function configure(value) {
    if (disposed) return { ok: false, code: 'AGENT_RESOURCE_UNKNOWN', reason: 'The application resource monitor is stopped. Reopen Settings after startup.' }
    const keys = ['mode', 'reserveBytes', 'providerBytes', 'maxConcurrentStarts', 'sampleMaxAgeMs', 'settleMs', 'cpuCeilingPercent', 'cpuBusyPercent', 'startIntervalMs', 'busyStartIntervalMs']
    const invalid = reason => ({ ok: false, code: 'RESOURCE_SETTINGS_INVALID', reason })
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
      return invalid('Use only the supported resource policy controls.')
    }
    if (Object.hasOwn(value, 'mode') && !engine.MODES.includes(value.mode)) return invalid('Choose one of the four resource policies.')
    if (Object.hasOwn(value, 'providerBytes') && (!value.providerBytes || typeof value.providerBytes !== 'object' || Array.isArray(value.providerBytes)
      || Object.keys(value.providerBytes).some(key => !engine.PROVIDERS.includes(key)))) return invalid('Choose memory reservations for Claude, Codex, or Local.')
    // A mode-only or one-provider change must preserve every other saved choice.
    const merged = { ...settings, ...value, providerBytes: { ...settings.providerBytes, ...value.providerBytes } }
    if (merged.cpuBusyPercent >= merged.cpuCeilingPercent) return invalid('Slow-start CPU must be below the CPU ceiling.')
    if (merged.busyStartIntervalMs < merged.startIntervalMs) return invalid('The busy-CPU interval must be at least the normal start interval.')
    const next = engine.normalizeSettings(merged)
    for (const key of keys.filter(key => !['mode', 'providerBytes'].includes(key))) {
      if (Object.hasOwn(value, key) && next[key] !== value[key]) return invalid(`Invalid ${key}; use a finite value within the control’s range.`)
    }
    if (value.providerBytes && Object.entries(value.providerBytes).some(([key, amount]) => next.providerBytes[key] !== amount)) {
      return invalid('Each program needs a finite memory reservation between 1 MiB and 1 TiB.')
    }
    let write
    try { write = prefs.set(RESOURCE_PREF_KEY, JSON.stringify(next)) } catch { /* Keep the previous policy on thrown storage failures too. */ }
    if (write?.ok !== true) return { ok: false, code: 'RESOURCE_SETTINGS_WRITE_FAILED', reason: 'Resource settings could not be saved. The previous policy is still active.' }
    settings = next
    syncSampling()
    return status()
  }
  return Object.freeze({ status, advise, inspect, reserve, reserveLane, reserveServiceLane, configure, ready: governor.ready,
    revalidate(token) {
      if (disposed) return { ok: false, code: 'AGENT_RESOURCE_UNKNOWN', reason: 'The application resource monitor is stopped.' }
      return governor.revalidate(token)
    },
    onUnavailable(listener) {
      if (typeof listener !== 'function') throw new TypeError('A resource availability listener must be a function.')
      if (disposed) listener()
      else unavailableListeners.add(listener)
      return () => unavailableListeners.delete(listener)
    },
    release(token, sessionId) { governor.release(token); if (bootstrapSession === sessionId) bootstrapSession = null },
    dispose() {
      if (disposed) return
      disposed = true; syncSampling()
      for (const listener of unavailableListeners) { try { listener() } catch { /* stopped remains authoritative */ } }
      unavailableListeners.clear()
    },
  })
}
module.exports = Object.freeze({ RESOURCE_PREF_KEY, createAgentResourceHost })
