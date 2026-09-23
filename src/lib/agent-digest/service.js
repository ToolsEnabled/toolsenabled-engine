'use strict';

// The tick. This is where the four hard-won invariants from Portfolio
// Dashboard's app/scheduler.py live, and the reason each one exists:
//
//   1. FIRE KEY PERSISTED BEFORE GENERATION. markFired() runs before generate()
//      is even called. A crash mid-generation therefore LOSES that slot rather
//      than double-sending it, and a restart inside the same slot cannot
//      re-fire it. Losing one pulse is recoverable; mailing the owner twice
//      from a crash loop is not.
//   2. BOUNDED GRACE. Enforced in schedule.js (GRACE_S / CATCHUP_GRACE_S): a
//      machine that was down for hours delivers at most ONE freshest missed
//      slot and never replays the day.
//   3. HARD TIMEOUT ON GENERATION. tick() is single-flight; a generation that
//      hangs (a wedged provider read, a stuck ledger verification) would
//      otherwise park this tick forever and freeze EVERY future slot. That is
//      exactly how the reference schedule silently died for 11 hours. Bounding
//      it guarantees the grid always advances.
//   4. A SCHEDULED SLOT ALWAYS SENDS. If rich generation fails or times out,
//      a data-only snapshot goes out instead, so the pulse never goes dark and
//      silence never gets mistaken for a quiet system.

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_TIMEOUT_MS = 60 * 1000;
const DEFAULT_SEND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TICK_MS = 30 * 1000;

function safeReason(error) {
  if (!error) return 'unknown';
  if (error && error.code === 'AGENT_DIGEST_TIMEOUT') return 'generation-timed-out';
  if (error && error.code === 'AGENT_DIGEST_SEND_TIMEOUT') return 'delivery-timed-out';
  if (typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code)) return error.code;
  const message = typeof error.message === 'string' ? error.message : '';
  // Reasons are shown to the owner and written to a log; keep them short and
  // free of anything that could carry credential-shaped or personal content.
  return message.replace(/[^A-Za-z0-9 ._:'\-]/g, ' ').trim().slice(0, 120) || 'unknown';
}

// Race a promise against a timer without leaving an unhandled rejection behind
// when the loser eventually settles. The abandoned work is NOT cancelled --
// JavaScript cannot cancel it -- but it can no longer hold the grid.
function withTimeout(
  promise,
  timeoutMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutCode = 'AGENT_DIGEST_TIMEOUT',
  operation = 'generation'
) {
  let timer = null;
  const settled = Promise.resolve(promise);
  settled.catch(() => { /* the loser must never become an unhandled rejection */ });
  return Promise.race([
    settled,
    new Promise((_resolve, reject) => {
      timer = setTimer(() => {
        const error = new Error(`Agent digest ${operation} exceeded ${timeoutMs}ms and was abandoned so the grid keeps advancing.`);
        error.code = timeoutCode;
        reject(error);
      }, timeoutMs);
      // Deliberately NOT unref'd. A hung generation holds no handle of its own,
      // so an unref'd timer let the whole `--once` process exit silently before
      // the bound could fire -- the timeout would then exist only in `--serve`,
      // where the tick interval happens to keep the loop alive. This timer is
      // the thing that guarantees the slot resolves, so it must keep the
      // process alive until it does.
    })
  ]).finally(() => { if (timer !== null) clearTimer(timer); });
}

class AgentDigestService {
  constructor({
    schedule,
    generate,
    fallback,
    send,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fallbackTimeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    tickMs = DEFAULT_TICK_MS,
    now = () => new Date(),
    log = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    if (!schedule || typeof schedule.catchupDue !== 'function' || typeof schedule.markFired !== 'function') {
      throw new TypeError('AgentDigestService requires a DigestSchedule.');
    }
    for (const [name, value] of Object.entries({ generate, fallback, send })) {
      if (typeof value !== 'function') throw new TypeError(`AgentDigestService requires a ${name} function.`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number.');
    if (!Number.isFinite(sendTimeoutMs) || sendTimeoutMs <= 0) throw new TypeError('sendTimeoutMs must be a positive number.');
    this.schedule = schedule;
    this.generate = generate;
    this.fallback = fallback;
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.fallbackTimeoutMs = fallbackTimeoutMs;
    this.sendTimeoutMs = sendTimeoutMs;
    this.tickMs = tickMs;
    this.now = now;
    this.log = log;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this._inFlight = false;
    this._interval = null;
  }

  async tick() {
    // Single-flight. The reference scheduler gets this from APScheduler's
    // max_instances=1; here it is explicit, because two overlapping ticks
    // could both read an unfired slot before either marked it.
    if (this._inFlight) return { fired: false, reason: 'tick-already-running' };
    this._inFlight = true;
    try {
      return await this._runOnce();
    } catch (error) {
      // A tick must never throw into the interval and kill the loop.
      this.log('error', `agent digest tick failed: ${safeReason(error)}`);
      // The failure may have happened while persisting the fire key (including
      // after the store committed it), so it is not evidence that no slot
      // fired. Preserve that uncertainty for callers instead of inventing a
      // negative answer.
      return { fired: null, reason: `tick-failed:${safeReason(error)}` };
    } finally {
      this._inFlight = false;
    }
  }

  async _runOnce() {
    const now = this.now();
    let hit = null;
    try {
      hit = this.schedule.catchupDue(now);
    } catch (error) {
      this.log('error', `agent digest schedule unreadable: ${safeReason(error)}`);
      // An unreadable schedule cannot establish whether a slot is due.
      return { fired: null, reason: `schedule-unreadable:${safeReason(error)}` };
    }
    if (!hit) return { fired: false, reason: 'no-due-slot' };
    const { fireKey, kind } = hit;

    // INVARIANT 1 -- before anything that can hang, fail, or crash the process.
    this.schedule.markFired(fireKey);
    this.log('info', `agent digest slot ${fireKey} -> ${kind}`);

    let message = null;
    let mode = 'full';
    let degradedReason = null;
    try {
      // INVARIANT 3.
      message = await withTimeout(this.generate({ fireKey, kind, now }), this.timeoutMs, this.setTimer, this.clearTimer);
      if (!message || typeof message.subject !== 'string' || typeof message.text !== 'string') {
        throw Object.assign(new Error('generation produced no message'), { code: 'AGENT_DIGEST_EMPTY_GENERATION' });
      }
    } catch (error) {
      degradedReason = safeReason(error);
      message = null;
      this.log('error', `agent digest slot ${fireKey} (${kind}) generation failed: ${degradedReason}`);
    }

    // INVARIANT 4.
    if (!message) {
      mode = 'fallback';
      try {
        message = await withTimeout(this.fallback({ fireKey, kind, now, reason: degradedReason }), this.fallbackTimeoutMs, this.setTimer, this.clearTimer);
        if (!message || typeof message.subject !== 'string' || typeof message.text !== 'string') {
          throw Object.assign(new Error('fallback produced no message'), { code: 'AGENT_DIGEST_EMPTY_FALLBACK' });
        }
      } catch (error) {
        const reason = safeReason(error);
        this.log('error', `agent digest slot ${fireKey} fallback failed: ${reason}`);
        return { fired: true, sent: false, mode, fireKey, kind, degradedReason, error: reason };
      }
    }

    try {
      // Delivery is part of the single-flight tick too. Bound it so a wedged
      // transport cannot leave _inFlight set and suppress every later slot.
      const result = await withTimeout(
        this.send(message),
        this.sendTimeoutMs,
        this.setTimer,
        this.clearTimer,
        'AGENT_DIGEST_SEND_TIMEOUT',
        'delivery'
      );
      return {
        fired: true, sent: true, mode, fireKey, kind, degradedReason,
        messageId: result && typeof result.id === 'string' ? result.id : null
      };
    } catch (error) {
      // A send failure is honest state, not a reason to retry into the owner's
      // inbox: the slot is already fired and will not be re-attempted.
      const reason = safeReason(error);
      this.log('error', `agent digest slot ${fireKey} send failed: ${reason}`);
      return { fired: true, sent: false, mode, fireKey, kind, degradedReason, error: reason };
    }
  }

  start() {
    if (this._interval) return this._interval;
    this._interval = setInterval(() => { void this.tick(); }, this.tickMs);
    return this._interval;
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }
}

module.exports = {
  AgentDigestService, DEFAULT_FALLBACK_TIMEOUT_MS, DEFAULT_SEND_TIMEOUT_MS, DEFAULT_TICK_MS, DEFAULT_TIMEOUT_MS, safeReason, withTimeout
};
