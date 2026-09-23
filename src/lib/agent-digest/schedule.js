'use strict';

// WHEN the agentic-workflow digest emails the owner.
//
// This is a deliberate port of Portfolio Dashboard's app/services/report_schedule.py.
// That grid has already survived real incidents on this laptop; the four invariants
// below are the reason it is copied rather than reinvented.
//
// Semantics:
//   * A 7-day x 48-half-hour-slot grid. Each cell is OFF, "digest" (the full
//     agentic-workflow read) or "pulse" (the compact hourly update). Both ALWAYS
//     send when their slot fires -- rich when generation succeeded, else a
//     data-only snapshot -- so the pulse never goes dark.
//   * Times are host-local, like every other schedule on this machine.
//   * A 00:00 cell belongs to the calendar day of its column: Monday 00:00 is
//     Sunday night's final.
//   * At-most-once per slot: the fired slot key (YYYY-MM-DD|HH:MM) is persisted
//     BEFORE the report runs, so a crash mid-generation loses that slot rather
//     than double-sending, and a restart inside the same slot cannot re-fire it.
//     `markFired` is the caller's first action; see agent-digest/service.js.
//   * A slot fires only within GRACE_S of its boundary -- a machine that was down
//     for hours does not replay the whole day's schedule on boot.

const fs = require('node:fs');
const path = require('node:path');

const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']); // JS getDay() is Sun=0; see dayKey()
const KINDS = Object.freeze(['digest', 'pulse']);
const KIND_SET = new Set(KINDS);
const SLOTS_PER_DAY = 48;

// Fire up to this long after the slot boundary (restarts, a busy loop, a slow
// audit verification). ToolsEnabled shares this laptop with heavy local model,
// browser, and CLI work, so a tight window silently DROPS digests. 20 min gives
// real headroom while staying (a) well under "hours", so a machine down all
// morning still cannot replay the day, and (b) under the 30-min minimum slot
// spacing, so at most one slot is ever in-grace at a time.
const GRACE_S = 1200;
// A laptop waking shortly after a scheduled slot should deliver the single
// freshest missed report, not silently skip it. Deliberately bounded, and it
// never replays a backlog: catchupDue() returns exactly ONE slot, the newest.
const CATCHUP_GRACE_S = 2 * 3600;

const GRID_KEY = 'agent_digest_grid';
const LAST_KEY = 'agent_digest_last_fired';
const TIME_RE = /^([01]\d|2[0-3]):(00|30)$/;
const FIRE_KEY_RE = /^\d{4}-\d\d-\d\d\|([01]\d|2[0-3]):(00|30)$/;

function pad2(value) { return String(value).padStart(2, '0'); }
function dateKey(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
function timeKey(date) { return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`; }
// datetime.weekday() is Mon=0..Sun=6; JavaScript getDay() is Sun=0..Sat=6.
function dayKey(date) { return DAYS[(date.getDay() + 6) % 7]; }
function fireKeyFor(date) { return `${dateKey(date)}|${timeKey(date)}`; }

function slotStart(date) {
  const start = new Date(date.getTime());
  start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
  return start;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The owner asked for the same cadence as the stock account: a routine hourly
// update while work is happening, plus a full read at the start and end of the
// day. Every cell is editable through setGrid().
function defaultGrid() {
  const pulseHours = ['09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '21'];
  const day = {
    '08:00': 'digest',
    '22:00': 'digest',
    ...Object.fromEntries(pulseHours.map(hour => [`${hour}:00`, 'pulse']))
  };
  return Object.fromEntries(DAYS.map(name => [name, { ...day }]));
}

// A minimal settings store so the slot state is trivially injectable in tests
// and never reaches for a production database. Values are strings, like the
// key/value settings table the Python original uses.
class JsonSettingsStore {
  constructor(file) {
    this.file = file;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return isObject(parsed) ? parsed : {};
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      // A corrupt slot file must not silently reset the fired-key history into
      // "nothing has ever fired", which would re-send the current slot. Treat
      // it as unreadable and let the caller decide; seedIfMissing() re-seeds.
      throw error;
    }
  }

  getSetting(key) {
    const value = this._read()[key];
    return typeof value === 'string' ? value : null;
  }

  setSetting(key, value) {
    const data = this._read();
    data[key] = String(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.file);
  }
}

class MemorySettingsStore {
  constructor(initial = {}) { this.data = new Map(Object.entries(initial)); }
  getSetting(key) { const value = this.data.get(key); return typeof value === 'string' ? value : null; }
  setSetting(key, value) { this.data.set(key, String(value)); }
}

class DigestSchedule {
  constructor({ store, defaults } = {}) {
    if (!store || typeof store.getSetting !== 'function' || typeof store.setSetting !== 'function') {
      throw new TypeError('DigestSchedule requires a settings store with getSetting/setSetting.');
    }
    this.store = store;
    this.defaults = isObject(defaults) ? normalizeGrid(defaults) : defaultGrid();
  }

  getGrid() {
    const raw = this.store.getSetting(GRID_KEY);
    if (raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // SyntaxError is the one result that proves the persisted value is
        // corrupt. Any other failure means we could not inspect it; it does
        // NOT claim that the stored schedule is absent or invalid.
        if (!(error instanceof SyntaxError)) {
          const unreadable = new Error('Could not inspect the stored agent digest grid; this does NOT claim that it is absent.', { cause: error });
          unreadable.code = 'AGENT_DIGEST_GRID_COULD_NOT_TELL';
          throw unreadable;
        }
      }
      if (isObject(parsed)) {
        try {
          return normalizeGrid(parsed);
        } catch { /* a semantically corrupt stored grid falls back to the configured default */ }
      }
    }
    return this.defaults;
  }

  setGrid(grid) {
    const clean = normalizeGrid(grid);
    this.store.setSetting(GRID_KEY, JSON.stringify(clean));
    return clean;
  }

  lastFired() {
    const fireKey = this.store.getSetting(LAST_KEY);
    if (fireKey === null) return '';
    if (!FIRE_KEY_RE.test(fireKey)) {
      throw new Error(`Stored fire key '${fireKey}' is invalid.`);
    }
    return fireKey;
  }

  markFired(fireKey) {
    if (typeof fireKey !== 'string' || !FIRE_KEY_RE.test(fireKey)) {
      throw new TypeError(`Invalid fire key '${fireKey}'.`);
    }
    this.store.setSetting(LAST_KEY, fireKey);
    return fireKey;
  }

  // Do not retroactively fire a slot whose boundary passed before this service
  // existed: on first seed, mark the CURRENT slot as already-fired so only
  // FUTURE boundaries send. A genuine later restart keeps a real fired-key
  // history, so the grace window still catches a slot the machine was briefly
  // down for; this only suppresses the install-moment surprise email.
  seedIfMissing(now = new Date()) {
    if (this.store.getSetting(LAST_KEY)) return false;
    this.store.setSetting(LAST_KEY, fireKeyFor(slotStart(now)));
    return true;
  }

  summary(grid = this.getGrid()) {
    const counts = Object.fromEntries(KINDS.map(kind => [kind, 0]));
    const perDay = {};
    let activeDays = 0;
    for (const day of DAYS) {
      const dayCounts = Object.fromEntries(KINDS.map(kind => [kind, 0]));
      const slots = isObject(grid) ? grid[day] : null;
      if (isObject(slots)) {
        for (const kind of Object.values(slots)) {
          if (KIND_SET.has(kind)) { dayCounts[kind] += 1; counts[kind] += 1; }
        }
      }
      const total = KINDS.reduce((sum, kind) => sum + dayCounts[kind], 0);
      if (total) activeDays += 1;
      perDay[day] = { ...dayCounts, total };
    }
    const total = KINDS.reduce((sum, kind) => sum + counts[kind], 0);
    return { ...counts, total, activeDays, offSlots: DAYS.length * SLOTS_PER_DAY - total, perDay };
  }

  // An unfired current slot inside the normal busy-loop grace, or null.
  due(now = new Date(), grid = this.getGrid()) {
    const start = slotStart(now);
    if ((now.getTime() - start.getTime()) / 1000 > GRACE_S) return null;
    const kind = slotKind(grid, start);
    if (!kind) return null;
    const fireKey = fireKeyFor(start);
    if (fireKey <= this.lastFired()) return null;
    return { fireKey, kind };
  }

  // The newest normal-or-post-wake slot that is safe to send, or null.
  //
  // The normal path is preserved exactly. If it is too late after a short
  // sleep/crash, scan only BACKWARDS through a bounded window and choose ONE
  // newest unfired slot: that is what stops a machine that was off for hours
  // from replaying the day. Persisted lexicographic keys also block a duplicate
  // send if Windows corrects its wall clock backwards after a send.
  catchupDue(now = new Date(), grid = this.getGrid()) {
    const current = this.due(now, grid);
    if (current) return current;
    const lastFired = this.lastFired();
    const start = slotStart(now);
    const maxSlots = Math.floor(CATCHUP_GRACE_S / (30 * 60));
    const seen = new Set();
    for (let offset = 0; offset <= maxSlots; offset += 1) {
      const candidate = slotStart(new Date(start.getTime() - offset * 30 * 60 * 1000));
      const fireKey = fireKeyFor(candidate);
      if (seen.has(fireKey)) continue; // a DST fold can repeat a wall-clock slot
      seen.add(fireKey);
      if ((now.getTime() - candidate.getTime()) / 1000 > CATCHUP_GRACE_S) break;
      const kind = slotKind(grid, candidate);
      if (!kind) continue;
      if (fireKey > lastFired) return { fireKey, kind };
    }
    return null;
  }

  // The next slot the scheduler can still fire, including a due current slot.
  // Shares GRACE_S and the persisted fired key with due(), so an operator view
  // never advertises a slot that has already been sent or is now too late.
  nextSlot(now = new Date(), grid = this.getGrid()) {
    const catchup = this.catchupDue(now, grid);
    if (catchup) {
      const at = parseFireKey(catchup.fireKey);
      return { ...catchup, at: at.getTime(), localIso: localIso(at), day: dayKey(at), time: timeKey(at), secondsUntil: 0, dueNow: true };
    }
    const lastFired = this.lastFired();
    const current = slotStart(now);
    // `<=` is deliberate, not an off-by-one: offset 336 is the CURRENT grid
    // cell one week later. When the only enabled slot is the current one and
    // it has already fired (or its grace passed), offsets 0..335 all miss and
    // that next-week occurrence is the genuine "next slot" — a `<` bound
    // would return null and an operator view would claim no slot exists.
    for (let offset = 0; offset <= DAYS.length * SLOTS_PER_DAY; offset += 1) {
      const candidate = slotStart(new Date(current.getTime() + offset * 30 * 60 * 1000));
      const kind = slotKind(grid, candidate);
      if (!kind) continue;
      const fireKey = fireKeyFor(candidate);
      if (fireKey <= lastFired) continue;
      if (offset === 0 && (now.getTime() - candidate.getTime()) / 1000 > GRACE_S) continue;
      const secondsUntil = Math.max(0, Math.round((candidate.getTime() - now.getTime()) / 1000));
      return { fireKey, kind, at: candidate.getTime(), localIso: localIso(candidate), day: dayKey(candidate), time: timeKey(candidate), secondsUntil, dueNow: secondsUntil === 0 };
    }
    return null;
  }
}

function slotKind(grid, date) {
  const slots = isObject(grid) ? grid[dayKey(date)] : null;
  const kind = isObject(slots) ? slots[timeKey(date)] : null;
  return KIND_SET.has(kind) ? kind : null;
}

function parseFireKey(fireKey) {
  const [day, time] = String(fireKey).split('|');
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year, month - 1, date, hour, minute, 0, 0);
}

function localIso(date) {
  return `${dateKey(date)}T${timeKey(date)}`;
}

// Validate + normalize a grid. Empty/off cells may arrive as "", "off", or null
// and are simply dropped.
function normalizeGrid(grid) {
  if (!isObject(grid)) throw new TypeError('schedule must be an object of day -> {time: kind}');
  const clean = {};
  for (const [day, slots] of Object.entries(grid)) {
    if (!DAYS.includes(day)) throw new Error(`unknown day '${day}' (expected ${DAYS.join('/')})`);
    if (!isObject(slots)) throw new Error(`'${day}' must map HH:MM -> kind`);
    const cleanDay = {};
    for (const [time, kind] of Object.entries(slots)) {
      if (!TIME_RE.test(String(time))) throw new Error(`bad time '${time}' -- HH:MM on a :00/:30 boundary`);
      if (kind === null || kind === '' || kind === 'off') continue;
      if (!KIND_SET.has(kind)) throw new Error(`bad kind '${kind}' (expected ${KINDS.join(' or ')})`);
      cleanDay[time] = kind;
    }
    if (Object.keys(cleanDay).length) clean[day] = cleanDay;
  }
  return clean;
}

module.exports = {
  CATCHUP_GRACE_S, DAYS, GRACE_S, GRID_KEY, KINDS, LAST_KEY, SLOTS_PER_DAY,
  DigestSchedule, JsonSettingsStore, MemorySettingsStore,
  dayKey, defaultGrid, fireKeyFor, normalizeGrid, parseFireKey, slotStart, timeKey
};
