'use strict';

// Durable "active outward request" marker (Q31).
//
// Root cause this closes: src/lib/egress-preflight.js#assertGatesMet() only
// ever ran when a caller happened to pass a requestId -- an agent (or a
// script) that simply omitted it silently skipped every owner-instruction
// gate check, and the resulting audit trail looked identical to a call that
// legitimately carries no gates. "Omitted the marker" and "there is no gate"
// were the same observable state. That is the exact shape of a failure that
// happened for real once: a deadline-pressured path that quietly stopped
// carrying a precondition forward.
//
// This module gives tool-registry.js's executeTool() a second, durable place
// to resolve the active ledger requestId from, so omitting the explicit
// context.requestId argument is no longer indistinguishable from a deliberate
// "this call has no ledger request behind it." See
// resolveActiveRequestId()/assertOutwardGate() in src/lib/tool-registry.js.
//
// This is NOT a security boundary by itself and does not claim to be full
// automatic binding -- nothing here infers which ledger request a given tool
// call belongs to. It is a best-effort marker that something with that
// knowledge (owner-capture.js when it files a new gated request, a future
// dashboard action, or an agent that already knows its own request id) can
// set before starting outward work, and that tool-registry.js consults when
// an explicit context.requestId is absent. An outward call made with neither
// an explicit requestId nor a live marker still proceeds -- there may
// genuinely be no ledger request behind it -- but it now leaves a distinct
// audited signal (mcp.tool.outward_ungated) rather than looking identical to
// a call whose gates were actually checked.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { rootPath } = require('./runtime');

const VERSION = 1;
const DEFAULT_FILE = rootPath('state', 'active-request.json');
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const SET_BY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,119}$/;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

// Same isolation shape as the other TOOLSENABLED_*_PATH env vars in
// tests/lib/isolated-environment.js: an explicit overrides.file always wins;
// otherwise an isolated test run redirects here without a code change at
// every call site, and production falls back to the real state/ file.
function resolveFile(overrides = {}) {
  if (overrides.file) return path.resolve(overrides.file);
  if (process.env.TOOLSENABLED_ACTIVE_REQUEST_PATH) return path.resolve(process.env.TOOLSENABLED_ACTIVE_REQUEST_PATH);
  return DEFAULT_FILE;
}

function readMarker(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // ENOENT establishes that there is no marker. Permission, I/O, and other
    // failures do not establish that fact and must remain observable.
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || parsed.version !== VERSION
    || typeof parsed.requestId !== 'string' || !REQUEST_ID_RE.test(parsed.requestId)
    || !Number.isSafeInteger(parsed.expiresAtMs)) {
    throw new Error(`Active request marker is invalid: ${file}`);
  }
  return parsed;
}

function writeMarker(marker, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* atomic rename already consumed it */ }
  }
}

/**
 * Bind the active outward ledger requestId durably, with a bounded TTL so a
 * forgotten marker cannot silently keep applying to calls made long after the
 * request it described was resolved one way or the other.
 */
function setActiveRequest(requestId, options = {}) {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    throw new TypeError('requestId must be a non-empty bounded identifier.');
  }
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new TypeError(`ttlMs must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS}.`);
  }
  const setBy = options.setBy === undefined ? 'unknown' : String(options.setBy);
  if (!SET_BY_RE.test(setBy)) throw new TypeError('setBy is invalid.');
  const file = resolveFile(options);
  const now = Date.now();
  const marker = { version: VERSION, requestId, setBy, setAtMs: now, expiresAtMs: now + ttlMs };
  writeMarker(marker, file);
  return Object.freeze({ ...marker });
}

/** The active requestId, or null if the marker is absent or expired. */
function getActiveRequest(options = {}) {
  const marker = readMarker(resolveFile(options));
  if (!marker) return null;
  if (marker.expiresAtMs <= Date.now()) return null;
  return marker.requestId;
}

/**
 * Clear a marker owned by requestId (e.g. once that request's outward work is
 * done). A missing requestId is an ownership-safe no-op for older callers.
 *
 * Accepting requestId in options as well as the first argument preserves the
 * existing options-object shape while allowing lifecycle code to pair
 * setActiveRequest(id) with clearActiveRequest(id).
 */
function clearActiveRequest(requestId, options = {}) {
  if (requestId && typeof requestId === 'object') {
    options = requestId;
    requestId = options.requestId;
  }
  if (requestId === undefined) return false;
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    throw new TypeError('requestId must be a non-empty bounded identifier.');
  }

  const file = resolveFile(options);
  const claimed = `${file}.${process.pid}.${crypto.randomUUID()}.clear`;
  try {
    // Atomically move the marker out of the well-known path before comparing
    // it. A newer set can then recreate file without this clear removing it.
    fs.renameSync(file, claimed);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }

  let owned = false;
  try {
    owned = readMarker(claimed).requestId === requestId;
    return owned;
  } finally {
    if (!owned) {
      try {
        // linkSync restores the claimed marker only if no newer marker has
        // appeared; unlike renameSync, it cannot overwrite that newer value.
        fs.linkSync(claimed, file);
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
      }
    }
    fs.rmSync(claimed, { force: true });
  }
}

module.exports = Object.freeze({
  VERSION, DEFAULT_FILE, MIN_TTL_MS, MAX_TTL_MS, DEFAULT_TTL_MS,
  setActiveRequest, getActiveRequest, clearActiveRequest
});
