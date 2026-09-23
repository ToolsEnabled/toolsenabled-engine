'use strict';

// Crash-safe cross-process exclusion for installation-owned state writers.
// This primitive owns no digest, fleet, comms, policy, or ledger behavior.
// Historical AgentDigest error names/codes remain part of its compatibility API.
//
// The fixed JSON file is deliberately *not* the authoritative mutex. A stale
// fixed pathname cannot be reclaimed safely with a check followed by unlink:
// another process can publish a replacement between those two operations. The
// same defect applies to an adjacent fixed "reclaiming" file. Instead, every
// contender publishes a nonce-unique claim and uses Lamport's bakery ordering.
// A unique claim pathname is never reused, so stale cleanup cannot delete a
// replacement generation. The fixed JSON remains for older binaries and for
// operator status, and legacy records are moved to nonce-unique quarantine
// paths (then byte-verified) rather than unlinked in place.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HOLDER_ABSENT = 'absent';
const HOLDER_UNREADABLE = 'unreadable';
const HOLDER_HELD = 'held';

const PUBLISH_GRACE_MS = 250;
const PUBLISH_POLLS = 5;
const CLAIM_DIRECTORY_SUFFIX = '.claims';
const LEGACY_RECLAIM_GUARD_SUFFIX = '.reclaiming';
const CLAIM_PROTOCOL = 'toolsenabled-nonce-claim-lock';
const STATUS_VERSION = 2;
const WINDOWS_TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const LEGACY_START_TOLERANCE_TICKS = 20_000_000n; // two seconds
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_PATTERN = /^[\x21-\x7e]{1,256}$/;

class AgentDigestLockError extends Error {
  constructor(message, holderPid) {
    super(message);
    this.code = 'AGENT_DIGEST_ALREADY_RUNNING';
    this.holderPid = holderPid;
  }
}

class AgentDigestLockUnreadableError extends Error {
  constructor(file) {
    super(`Could not read a valid holder from agent-digest lock ${file}; this does NOT claim the lock is absent.`);
    this.code = 'AGENT_DIGEST_LOCK_UNREADABLE';
  }
}

class AgentDigestProcessIdentityError extends Error {
  constructor(pid, cause) {
    super(`Could not verify the exact start identity of process ${pid}; refusing to infer that a lock is stale.`);
    this.code = 'AGENT_DIGEST_PROCESS_IDENTITY_UNVERIFIED';
    this.pid = pid;
    if (cause) this.cause = cause;
  }
}

// process.kill(pid, 0) sends no signal; it only probes whether the pid could
// be signaled. ESRCH is the sole proof of absence. EPERM is uncertain but must
// remain conservatively alive at this compatibility surface.
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (error && error.code === 'EPERM') return true;
    throw error;
  }
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A caller can extend the time its ticket waits without slowing observation
// of a release. The tree directory grants ten seconds; dividing that by the
// default five polls slept for two seconds after even a short collision.
// Keep the normal 50 ms polling granularity while the existing deadlines
// retain the caller's full grace and the same queue position.
function contentionPollMs({ publishGraceMs, polls }) {
  return Math.max(1, Math.min(
    PUBLISH_GRACE_MS / PUBLISH_POLLS,
    Math.ceil(publishGraceMs / Math.max(1, polls))
  ));
}

function unreadableLockError(file) {
  return new AgentDigestLockUnreadableError(file);
}

function unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function readHolderState(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { state: HOLDER_ABSENT, holder: null, contents: null };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { state: HOLDER_UNREADABLE, holder: null, contents };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
    throw new TypeError(`Agent-digest lock ${file} does not contain a valid pid.`);
  }
  return { state: HOLDER_HELD, holder: parsed, contents };
}

function readHolder(file) {
  const read = readHolderState(file);
  if (read.state === HOLDER_UNREADABLE) throw unreadableLockError(file);
  return read.state === HOLDER_HELD ? read.holder : null;
}

function sameHolder(left, right) {
  if (!left || !right || left.pid !== right.pid) return false;
  if (left.nonce !== undefined || right.nonce !== undefined) return left.nonce === right.nonce;
  return left.startedAt === right.startedAt;
}

function envValue(environment, wanted) {
  const key = Object.keys(environment || {}).find(candidate => candidate.toLowerCase() === wanted.toLowerCase());
  return key ? environment[key] : undefined;
}

function scrubbedSystemEnvironment(environment) {
  const clean = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT']) {
    const value = envValue(environment, key);
    if (typeof value === 'string' && value.length > 0) clean[key] = value;
  }
  return clean;
}

function windowsPowerShellPath(environment) {
  const configured = envValue(environment, 'SystemRoot') || envValue(environment, 'WINDIR') || 'C:\\Windows';
  if (!path.win32.isAbsolute(configured)) {
    throw new AgentDigestProcessIdentityError(process.pid,
      new Error('Windows system root is not absolute.'));
  }
  const resolved = path.win32.resolve(configured);
  if (/^[a-z]:\\users(?:\\|$)/i.test(resolved)) {
    throw new AgentDigestProcessIdentityError(process.pid,
      new Error('Windows system root resolves inside a user profile.'));
  }
  return path.win32.join(resolved, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Return a stable OS process-generation identity, null for proven absence, and
// throw for uncertainty. Windows process creation ticks are exact for a PID
// generation and therefore distinguish a recycled PID from the recorded owner.
/* THIS PROCESS'S OWN GENERATION, ASKED ONCE.
 *
 * MEASURED 2026-09-02 on the installed 1.0.41: taking any tree or broker lock
 * spawned powershell.exe to run Get-Process against a pid -- and the pid it
 * asks about first is almost always this process's own, because the writer
 * records itself as the owner. A cold powershell.exe costs roughly a third of
 * a second on the Electron main thread, per lock, forever.
 *
 * A process cannot be recycled while it is the one asking, so its own start
 * ticks are immutable for as long as this cache can be read: remembering them
 * is exact, not an approximation. Every OTHER pid is still asked for real,
 * every time, which is the case the recycled-pid check exists for. */
const selfIdentityCache = new Map();

/* AND THE FIRST ASK IS THE EXPENSIVE ONE, so its budget has to cover a cold
 * image. Measured 2026-09-02 on Windows 10 with the fleet running: the first
 * two launches of powershell.exe in a fresh process cost 5.30 s and 5.31 s;
 * every launch afterwards cost about 0.3 s. A five second budget therefore
 * expired on the one probe every process makes, and this path throws on
 * uncertainty -- so the first digest lock in a fresh process failed rather
 * than waiting. Thirty seconds bounds a wedged PowerShell; it is not a
 * latency target, because the cache above means it is paid at most once. */
const WINDOWS_IDENTITY_PROBE_TIMEOUT_MS = 30_000;

function processStartIdentity(pid, {
  platform = process.platform,
  execute = execFileSync,
  environment = process.env,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    throw new AgentDigestProcessIdentityError(pid, new TypeError('pid is invalid'));
  }
  const cacheable = pid === process.pid && execute === execFileSync && environment === process.env;
  if (cacheable && selfIdentityCache.has(platform)) return selfIdentityCache.get(platform);

  if (platform === 'win32') {
    const command = "$ErrorActionPreference='SilentlyContinue'; "
      + `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
      + "if ($null -eq $p) { [Console]::Write('ABSENT'); exit 0 }; "
      + "try { $ticks = $p.StartTime.ToUniversalTime().Ticks; "
      + "[Console]::Write('LIVE=' + $ticks); exit 0 } "
      + "catch { [Console]::Write('UNKNOWN'); exit 0 }";
    let output;
    try {
      output = String(execute(windowsPowerShellPath(environment), [
        '-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-Command', command
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: WINDOWS_IDENTITY_PROBE_TIMEOUT_MS,
        env: scrubbedSystemEnvironment(environment)
      })).trim();
    } catch (error) {
      throw new AgentDigestProcessIdentityError(pid, error);
    }
    if (output === 'ABSENT') return null;
    const match = /^LIVE=(\d{12,20})$/.exec(output);
    if (match) {
      const identity = `win32:${match[1]}`;
      if (cacheable) selfIdentityCache.set(platform, identity);
      return identity;
    }
    throw new AgentDigestProcessIdentityError(pid,
      new Error(output === 'UNKNOWN' ? 'process start time is inaccessible' : 'unexpected PowerShell output'));
  }

  if (platform === 'linux') {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw new AgentDigestProcessIdentityError(pid, error);
    }
    const close = stat.lastIndexOf(')');
    const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/) : [];
    const startTicks = fields[19]; // field 22; fields starts at proc field 3
    if (!/^\d+$/.test(startTicks || '')) {
      throw new AgentDigestProcessIdentityError(pid, new Error('/proc stat start time is invalid'));
    }
    let bootId;
    try {
      bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch (error) {
      throw new AgentDigestProcessIdentityError(pid, error);
    }
    if (!/^[0-9a-f-]{36}$/i.test(bootId)) {
      throw new AgentDigestProcessIdentityError(pid, new Error('Linux boot id is invalid'));
    }
    return `linux:${bootId}:${startTicks}`;
  }

  try {
    if (!pidAlive(pid)) return null;
  } catch (error) {
    throw new AgentDigestProcessIdentityError(pid, error);
  }
  throw new AgentDigestProcessIdentityError(pid,
    new Error(`exact process identity is unsupported on ${platform}`));
}

let cachedSelfIdentity = null;
function defaultProcessIdentity(pid) {
  if (pid === process.pid && cachedSelfIdentity) return cachedSelfIdentity;
  const identity = processStartIdentity(pid);
  if (pid === process.pid && identity) cachedSelfIdentity = identity;
  return identity;
}

function validIdentity(value) {
  return typeof value === 'string' && IDENTITY_PATTERN.test(value);
}

function processIdentityHash(identity) {
  return crypto.createHash('sha256').update(identity, 'utf8').digest('hex');
}

function normalizeIdentityResult(value, pid) {
  if (value === null) return null;
  if (!validIdentity(value)) {
    throw new AgentDigestProcessIdentityError(pid, new TypeError('process identity is invalid'));
  }
  return value;
}

function identityContext({ pid, isAlive, getProcessIdentity }) {
  // Synthetic-PID tests and embedders retain the legacy liveness seam, but a
  // wrapper around liveness must not silently downgrade a real process to PID-
  // only ownership. A real caller may wrap process.kill(0) while still passing
  // the actual process.pid; the wrapper does not make PID reuse safe.
  const compatibilityMode = typeof getProcessIdentity !== 'function'
    && isAlive !== pidAlive && pid !== process.pid;
  const exactProvider = typeof getProcessIdentity === 'function' ? getProcessIdentity : defaultProcessIdentity;
  let ownIdentity;
  if (compatibilityMode) {
    // Existing tests/callers which deliberately inject synthetic PIDs retain
    // their synchronous liveness seam. Production callers use pidAlive and the
    // exact OS generation provider above.
    ownIdentity = `pid-compat:${pid}`;
  } else {
    ownIdentity = normalizeIdentityResult(exactProvider(pid), pid);
    if (!ownIdentity) {
      throw new AgentDigestProcessIdentityError(pid, new Error('the acquiring process is absent'));
    }
  }
  return {
    pid,
    isAlive,
    exactProvider,
    exactAvailable: !compatibilityMode || typeof getProcessIdentity === 'function',
    identityMode: compatibilityMode ? 'pid-compat' : 'exact',
    ownIdentity,
    ownIdentityHash: processIdentityHash(ownIdentity),
  };
}

function probeExactIdentity(context, pid) {
  try {
    const identity = normalizeIdentityResult(context.exactProvider(pid), pid);
    return identity === null ? { state: 'stale', identity: null } : { state: 'live', identity };
  } catch (error) {
    try {
      if (!context.isAlive(pid)) return { state: 'stale', identity: null };
    } catch { /* uncertainty remains uncertainty */ }
    return { state: 'uncertain', error };
  }
}

function probeClaim(context, claim) {
  if (claim.identityMode === 'pid-compat') {
    try {
      return context.isAlive(claim.pid) ? { state: 'live' } : { state: 'stale' };
    } catch (error) {
      return { state: 'uncertain', error };
    }
  }
  const probe = probeExactIdentity(context, claim.pid);
  if (probe.state !== 'live') return probe;
  return processIdentityHash(probe.identity) === claim.processStartIdentityHash
    ? { state: 'live' } : { state: 'stale' };
}

function claimDirectory(file) {
  return `${file}${CLAIM_DIRECTORY_SUFFIX}`;
}

function removeEmptyClaimDirectory(file) {
  try {
    // rmdir is conditional in the filesystem: if another contender has
    // already published a claim, ENOTEMPTY preserves the shared namespace.
    // If it has only observed the old empty directory, its subsequent wx
    // publication fails ENOENT and cannot become an untracked holder.
    fs.rmdirSync(claimDirectory(file));
  } catch (error) {
    if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function ensureClaimDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unreadableLockError(directory);
}

function claimFileName(phase, ticket, record) {
  const mode = record.identityMode === 'exact' ? 'e' : 'p';
  const identity = `${mode}.${record.pid}.${record.processStartIdentityHash}.${record.nonce}`;
  return phase === 'choosing'
    ? `choosing.${identity}.claim`
    : `ticket.${ticket}.${identity}.claim`;
}

function isTicketClaimName(value) {
  return typeof value === 'string'
    && /^ticket\.\d+\.[ep]\.\d+\.[0-9a-f]{64}\.[0-9a-f-]{36}\.claim$/i.test(value);
}

function claimFromFileName(fileName, file) {
  let match = /^choosing\.(e|p)\.(\d+)\.([0-9a-f]{64})\.([0-9a-f-]{36})\.claim$/i.exec(fileName);
  let phase = 'choosing';
  let ticket = null;
  if (!match) {
    match = /^ticket\.(\d+)\.(e|p)\.(\d+)\.([0-9a-f]{64})\.([0-9a-f-]{36})\.claim$/i.exec(fileName);
    phase = 'ticket';
    if (!match) throw unreadableLockError(file);
    ticket = Number(match[1]);
    match = [match[0], match[2], match[3], match[4], match[5]];
  }
  const pid = Number(match[2]);
  const nonce = match[4];
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff
      || phase === 'ticket' && (!Number.isSafeInteger(ticket) || ticket <= 0)
      || !UUID_PATTERN.test(nonce)) {
    throw unreadableLockError(file);
  }
  return {
    phase,
    ticket,
    identityMode: match[1].toLowerCase() === 'e' ? 'exact' : 'pid-compat',
    pid,
    processStartIdentityHash: match[3].toLowerCase(),
    nonce: nonce.toLowerCase(),
  };
}

function readClaim(directory, fileName) {
  const file = path.join(directory, fileName);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw unreadableLockError(file);
  // The directory entry is the atomic record. Its nonce-unique filename holds
  // the PID and exact-generation hash, so a crash immediately after wx leaves
  // a complete, classifiable claim rather than an ownerless zero-byte file.
  return { file, fileName, record: claimFromFileName(fileName, file) };
}

function scanClaims(directory) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw unreadableLockError(directory);
    throw error;
  }
  const claims = [];
  for (const fileName of names) {
    const claim = readClaim(directory, fileName);
    if (claim) claims.push(claim);
  }
  return claims;
}

function scanClaimsWithGrace(directory, { publishGraceMs, polls, sleep }) {
  let lastError = null;
  for (let attempt = 0; attempt <= polls; attempt += 1) {
    try { return scanClaims(directory); }
    catch (error) {
      if (!(error instanceof AgentDigestLockUnreadableError)) throw error;
      lastError = error;
      if (attempt < polls) sleep(Math.ceil(publishGraceMs / Math.max(1, polls)));
    }
  }
  throw lastError || unreadableLockError(directory);
}

function removeStaleUniqueClaim(claim) {
  // Protocol claim names contain a cryptographic nonce and are never reused.
  // ENOENT means the owner released or advanced from choosing to ticket.
  unlinkIfPresent(claim.file);
}

function compareTicket(left, right) {
  if (left.record.ticket !== right.record.ticket) return left.record.ticket - right.record.ticket;
  return left.record.nonce.localeCompare(right.record.nonce);
}

function liveOrStaleClaim(context, claim) {
  const result = probeClaim(context, claim.record);
  if (result.state === 'stale') {
    removeStaleUniqueClaim(claim);
    return 'stale';
  }
  if (result.state === 'uncertain') throw unreadableLockError(claim.file);
  return 'live';
}

function createClaim(file, context, timing) {
  const directory = claimDirectory(file);
  const nonce = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const choosingRecord = {
    phase: 'choosing',
    pid: context.pid,
    processStartIdentityHash: context.ownIdentityHash,
    identityMode: context.identityMode,
    ticket: null,
    nonce,
  };
  const choosingName = claimFileName('choosing', null, choosingRecord);
  const choosingFile = path.join(directory, choosingName);
  let ticketFile = null;
  let ticketName = null;
  let acquired = false;
  let choosingPublished = false;
  for (let attempt = 0; attempt < 2 && !choosingPublished; attempt += 1) {
    try {
      ensureClaimDirectory(directory);
      fs.writeFileSync(choosingFile, '', { flag: 'wx', mode: 0o600 });
      choosingPublished = true;
    } catch (error) {
      // The previous holder may remove an empty namespace after our mkdir but
      // before this first claim. Recreate once; no claim existed to lose.
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  if (!choosingPublished) throw unreadableLockError(directory);
  try {
    let initial;
    let maxTicket;
    for (;;) {
      initial = scanClaimsWithGrace(directory, timing);
      maxTicket = 0;
      for (const claim of initial) {
        if (claim.record.phase === 'ticket') maxTicket = Math.max(maxTicket, claim.record.ticket);
      }
      if (Number.isSafeInteger(maxTicket + 1)) break;

      // Do not probe every ordinary ticket here: with a real contention herd,
      // that turns ticket selection into N-squared OS process inspections and
      // can exhaust the consumers' outer lock timeout. Only overflow blocks
      // allocation, so classify the maximum generation(s) on that exceptional
      // path and then rescan after stale removal.
      const maximumClaims = initial.filter(claim => claim.record.phase === 'ticket'
        && claim.record.ticket === maxTicket);
      let removedStale = false;
      for (const claim of maximumClaims) {
        if (liveOrStaleClaim(context, claim) === 'stale') {
          removedStale = true;
          continue;
        }
        throw new AgentDigestLockError(
          `Another agent-digest process (PID ${claim.record.pid}) owns the maximum lock ticket; `
            + 'refusing to infer that it is absent.',
          claim.record.pid
        );
      }
      if (!removedStale) throw unreadableLockError(directory);
    }
    const ticket = maxTicket + 1;
    const ticketRecord = { ...choosingRecord, phase: 'ticket', ticket };
    ticketName = claimFileName('ticket', ticket, ticketRecord);
    ticketFile = path.join(directory, ticketName);
    fs.writeFileSync(ticketFile, '', { flag: 'wx', mode: 0o600 });
    unlinkIfPresent(choosingFile);

    const deadline = Date.now() + timing.publishGraceMs;
    let contentionDeadline = null;
    for (;;) {
      const claims = scanClaimsWithGrace(directory, timing);
      let retryChoosing = false;
      for (const claim of claims) {
        if (claim.record.nonce === nonce || claim.record.phase !== 'choosing') continue;
        // A choosing claim normally exists for only the two local filesystem
        // operations which publish its ticket. Do not spend that whole window
        // spawning an OS identity probe: let the owner finish first, then use
        // exact identity only if the unique path survives the grace period.
        if (Date.now() < deadline) {
          retryChoosing = true;
          continue;
        }
        const refreshed = readClaim(directory, claim.fileName);
        if (!refreshed) continue;
        const state = liveOrStaleClaim(context, refreshed);
        if (state === 'live') {
          throw new AgentDigestLockError(
            'Another process is still publishing its lock claim; refusing to infer that it is absent.',
            claim.record.pid
          );
        }
      }
      if (retryChoosing) {
        timing.sleep(contentionPollMs(timing));
        continue;
      }

      const own = claims.find(claim => claim.fileName === ticketName);
      if (!own || !sameHolder(own.record, ticketRecord)) throw unreadableLockError(ticketFile);
      const earlier = claims
        .filter(claim => claim.record.phase === 'ticket'
          && claim.record.nonce !== nonce && compareTicket(claim, own) < 0)
        .sort(compareTicket);
      const stillPresent = earlier.filter(claim => readClaim(directory, claim.fileName));
      if (stillPresent.length > 0) {
        if (contentionDeadline === null) contentionDeadline = Date.now() + timing.publishGraceMs;
        if (Date.now() < contentionDeadline) {
          // Keep this ticket while a short mutation ahead of us finishes. This
          // turns a simultaneous start into a stable queue instead of a
          // thundering herd which discards/reissues random tickets and can
          // starve despite an outer caller retrying for seconds. A long-lived
          // digest holder still gets the same bounded fail-fast answer below.
          timing.sleep(contentionPollMs(timing));
          continue;
        }
      }
      let removedStale = false;
      for (const claim of stillPresent) {
        const state = liveOrStaleClaim(context, claim);
        if (state === 'stale') {
          removedStale = true;
          continue;
        }
        throw new AgentDigestLockError(
          `Another agent-digest process (PID ${claim.record.pid}) is already running; refusing to start a `
            + 'second one, which could race the schedule store and double-send.',
          claim.record.pid
        );
      }
      if (removedStale) continue;
      acquired = true;
      return { directory, nonce, startedAt, ticketFile, ticketName, ticketRecord };
    }
  } finally {
    unlinkIfPresent(choosingFile);
    if (!acquired) {
      if (ticketFile) unlinkIfPresent(ticketFile);
      removeEmptyClaimDirectory(file);
    }
  }
}

function exactIdentityAfterLegacyTimestamp(identity, startedAt) {
  const match = /^win32:(\d{12,20})$/.exec(identity || '');
  const milliseconds = Date.parse(startedAt);
  if (!match || !Number.isFinite(milliseconds)) return false;
  const recordedTicks = WINDOWS_TICKS_AT_UNIX_EPOCH + (BigInt(Math.trunc(milliseconds)) * 10_000n);
  return BigInt(match[1]) > recordedTicks + LEGACY_START_TOLERANCE_TICKS;
}

function classifyFixedHolder(context, holder) {
  if (holder.protocol === CLAIM_PROTOCOL) {
    if (holder.version !== STATUS_VERSION || !UUID_PATTERN.test(holder.nonce || '')
        || holder.identityMode !== 'exact' && holder.identityMode !== 'pid-compat'
        || !validIdentity(holder.processStartIdentity)
        || !isTicketClaimName(holder.claimName)
        || !Number.isFinite(Date.parse(holder.startedAt))) {
      return { state: 'uncertain' };
    }
    if (holder.identityMode === 'pid-compat') {
      try { return { state: context.isAlive(holder.pid) ? 'live' : 'stale' }; }
      catch { return { state: 'uncertain' }; }
    }
    const probe = probeExactIdentity(context, holder.pid);
    if (probe.state !== 'live') return probe;
    return { state: probe.identity === holder.processStartIdentity ? 'live' : 'stale' };
  }
  if (holder.protocol !== undefined || holder.version === STATUS_VERSION) return { state: 'uncertain' };

  if (context.exactAvailable) {
    const probe = probeExactIdentity(context, holder.pid);
    if (probe.state !== 'live') return probe;
    if (typeof holder.processStartIdentity === 'string') {
      return { state: probe.identity === holder.processStartIdentity ? 'live' : 'stale' };
    }
    if (exactIdentityAfterLegacyTimestamp(probe.identity, holder.startedAt)) return { state: 'stale' };
    return { state: 'live' };
  }
  try { return { state: context.isAlive(holder.pid) ? 'live' : 'stale' }; }
  catch { return { state: 'uncertain' }; }
}

function readFixedWithGrace(file, timing) {
  let read = readHolderState(file);
  for (let poll = 0; read.state === HOLDER_UNREADABLE && poll < timing.polls; poll += 1) {
    timing.sleep(Math.ceil(timing.publishGraceMs / Math.max(1, timing.polls)));
    read = readHolderState(file);
  }
  if (read.state === HOLDER_UNREADABLE) throw unreadableLockError(file);
  return read;
}

function restoreQuarantine(quarantine, file) {
  try {
    fs.renameSync(quarantine, file);
    return true;
  } catch {
    // Never delete the moved generation when restoration is blocked by a new
    // publisher. Keeping its nonce-unique evidence is safer than guessing.
    return false;
  }
}

function quarantineStaleGeneration(file, observed, nonce, context) {
  const confirmed = readHolderState(file);
  if (confirmed.state === HOLDER_ABSENT) return { changed: true, quarantine: null };
  if (confirmed.state === HOLDER_UNREADABLE) throw unreadableLockError(file);
  if (confirmed.contents !== observed.contents) return { changed: true, quarantine: null };
  const quarantine = `${file}.stale.${nonce}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(file, quarantine);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { changed: true, quarantine: null };
    throw error;
  }
  const moved = readHolderState(quarantine);
  if (moved.state !== HOLDER_HELD || moved.contents !== observed.contents) {
    restoreQuarantine(quarantine, file);
    throw unreadableLockError(file);
  }
  // Equal bytes do not prove equal generations. A dead PID can be recycled and
  // a legacy writer can publish the same record after our first classification
  // but before rename. Once the inode is at its nonce-unique quarantine path,
  // classify it again: only that post-move result can authorize deletion.
  const movedClassification = classifyFixedHolder(context, moved.holder);
  if (movedClassification.state === 'uncertain') {
    restoreQuarantine(quarantine, file);
    throw unreadableLockError(file);
  }
  if (movedClassification.state === 'live') {
    restoreQuarantine(quarantine, file);
    throw new AgentDigestLockError(
      `Another agent-digest process (PID ${moved.holder.pid}) is already running; refusing to start a `
        + 'second one, which could race the schedule store and double-send.',
      moved.holder.pid
    );
  }
  return { changed: false, quarantine };
}

function inspectCompatibilityPath(file, context, timing, nonce) {
  const observed = readFixedWithGrace(file, timing);
  if (observed.state === HOLDER_ABSENT) return { state: 'absent', quarantine: null };
  const classification = classifyFixedHolder(context, observed.holder);
  if (classification.state === 'uncertain') throw unreadableLockError(file);
  if (classification.state === 'live') {
    throw new AgentDigestLockError(
      `Another agent-digest process (PID ${observed.holder.pid}) is already running; refusing to start a `
        + 'second one, which could race the schedule store and double-send.',
      observed.holder.pid
    );
  }
  const moved = quarantineStaleGeneration(file, observed, nonce, context);
  return moved.changed ? { state: 'changed', quarantine: null }
    : { state: 'stale', quarantine: moved.quarantine };
}

function statusRecord(context, claim) {
  return {
    protocol: CLAIM_PROTOCOL,
    version: STATUS_VERSION,
    pid: context.pid,
    processStartIdentity: context.ownIdentity,
    identityMode: context.identityMode,
    startedAt: claim.startedAt,
    nonce: claim.nonce,
    claimName: claim.ticketName,
  };
}

function publishCompleteStatusExclusive(file, contents, nonce) {
  const staged = `${file}.publishing.${nonce}.${crypto.randomUUID()}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(staged, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // link is an atomic no-overwrite publication of an already complete inode.
    // Unlike writeFile(..., wx), the public path has no zero-byte interval.
    fs.linkSync(staged, file);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* the primary error is authoritative */ }
    }
    unlinkIfPresent(staged);
  }
}

function publishCompatibilityStatus(file, context, claim, timing) {
  const quarantines = [];
  const guardFile = `${file}${LEGACY_RECLAIM_GUARD_SUFFIX}`;
  const expected = statusRecord(context, claim);
  const expectedContents = JSON.stringify(expected);
  let published = false;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const guard = inspectCompatibilityPath(guardFile, context, timing, claim.nonce);
      if (guard.quarantine) quarantines.push(guard.quarantine);
      if (guard.state === 'changed') continue;

      const main = inspectCompatibilityPath(file, context, timing, claim.nonce);
      if (main.quarantine) quarantines.push(main.quarantine);
      if (main.state === 'changed') continue;

      // A legacy reclaimer can enter after the first observation. Check the
      // guard again immediately before status publication; EEXIST below is the
      // other half of the same race and is never treated as absence.
      if (readFixedWithGrace(guardFile, timing).state !== HOLDER_ABSENT) continue;
      try {
        publishCompleteStatusExclusive(file, expectedContents, claim.nonce);
      } catch (error) {
        if (error && error.code === 'EEXIST') continue;
        throw error;
      }
      const verified = readHolderState(file);
      if (verified.state !== HOLDER_HELD || verified.contents !== expectedContents
          || !sameHolder(verified.holder, expected)) {
        throw unreadableLockError(file);
      }
      published = true;
      return expected;
    }
    throw new AgentDigestLockError('Could not publish the compatibility lock status without a concurrent change.', null);
  } finally {
    for (const quarantine of quarantines) {
      try { unlinkIfPresent(quarantine); }
      catch {
        // These paths were byte-verified and reclassified stale after their
        // atomic move. They are non-authoritative evidence, so an inability to
        // garbage-collect one must not unwind a successfully published lock and
        // strand its fixed status after the authoritative claim is removed.
      }
    }
    if (!published) {
      const current = readHolderState(file);
      if (current.state === HOLDER_HELD && sameHolder(current.holder, expected)) {
        removeOwnedStatus(file, expected);
      }
    }
  }
}

function removeOwnedStatus(file, expected) {
  const observed = readHolderState(file);
  if (observed.state === HOLDER_ABSENT) return;
  if (observed.state === HOLDER_UNREADABLE) throw unreadableLockError(file);
  if (!sameHolder(observed.holder, expected)) return;
  const quarantine = `${file}.release.${expected.nonce}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(file, quarantine);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  const moved = readHolderState(quarantine);
  if (moved.state === HOLDER_HELD && moved.contents === observed.contents
      && sameHolder(moved.holder, expected)) {
    unlinkIfPresent(quarantine);
    return;
  }
  restoreQuarantine(quarantine, file);
  throw unreadableLockError(file);
}

function releaseLock(file, pid, nonce, claimName) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof nonce !== 'string') return;
  let recordedClaimName = claimName;
  let releaseError = null;
  try {
    const holder = readHolder(file);
    if (holder && holder.pid === pid && holder.nonce === nonce) {
      if (!recordedClaimName && typeof holder.claimName === 'string') recordedClaimName = holder.claimName;
      removeOwnedStatus(file, { pid, nonce });
    }
  } catch (error) {
    releaseError = error;
  } finally {
    if (isTicketClaimName(recordedClaimName)) {
      try { unlinkIfPresent(path.join(claimDirectory(file), recordedClaimName)); }
      catch (error) { if (!releaseError) releaseError = error; }
    }
    try { removeEmptyClaimDirectory(file); }
    catch (error) { if (!releaseError) releaseError = error; }
  }
  if (releaseError) throw releaseError;
}

// Acquire the lock or throw. The public API stays synchronous and the returned
// handle retains the existing file/pid/nonce/release shape used by callers.
function acquireLock(file, {
  pid = process.pid,
  isAlive = pidAlive,
  getProcessIdentity,
  publishGraceMs = PUBLISH_GRACE_MS,
  polls = PUBLISH_POLLS,
  sleep = sleepSync,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    throw new TypeError('Agent-digest lock pid is invalid.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const timing = {
    publishGraceMs: Math.max(0, Number(publishGraceMs) || 0),
    polls: Math.max(0, Math.trunc(Number(polls) || 0)),
    sleep,
  };
  const context = identityContext({ pid, isAlive, getProcessIdentity });
  const claim = createClaim(file, context, timing);
  let statusPublished = false;
  try {
    publishCompatibilityStatus(file, context, claim, timing);
    statusPublished = true;
    return {
      file,
      pid,
      nonce: claim.nonce,
      release: () => releaseLock(file, pid, claim.nonce, claim.ticketName)
    };
  } finally {
    if (!statusPublished) {
      unlinkIfPresent(claim.ticketFile);
      removeEmptyClaimDirectory(file);
    }
  }
}

module.exports = {
  AgentDigestLockError,
  AgentDigestLockUnreadableError,
  AgentDigestProcessIdentityError,
  acquireLock,
  pidAlive,
  processStartIdentity,
  readHolderState,
  releaseLock,
};
