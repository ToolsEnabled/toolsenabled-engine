'use strict';

const fs = require('node:fs');
const { killSwitchPath } = require('./policy');

const activationListeners = new Set();

function path() { return killSwitchPath(); }

function isMissing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

const UNATTRIBUTED = Object.freeze({ recorded: false, agent: null, actor: null,
  session: null, role: null, principal: null, request: null, activatedAt: null });

/* READ BACK WHAT activate() WROTE.
 *
 * The attribution lives in the marker body rather than a sidecar because the
 * marker is the record that is always written -- see activate(). That choice
 * costs this parser, and it buys one fewer file that can disagree with the
 * switch it describes: there is no state in which an attribution outlives the
 * activation it belongs to, because they are the same bytes.
 *
 * A marker written by hand, or by tools/kill.ps1, has no attribution lines and
 * reads as unrecorded -- which is the honest answer, not a defect. Never invent
 * an actor for a marker that names none. */
function parseAttribution(body) {
  if (typeof body !== 'string' || !body) return UNATTRIBUTED;
  const lines = body.split('\n');
  const activatedAt = /activated (\S+)\s*$/.exec(lines[0] || '');
  const field = (label) => {
    const hit = lines.find(line => line.startsWith(`${label}: `));
    if (!hit) return null;
    const value = hit.slice(label.length + 2).trim();
    return !value || value === '(not stated)' ? null : value;
  };
  const found = {
    agent: field('agent'), actor: field('actor'), session: field('session'),
    role: field('role'), principal: field('principal'), request: field('request')
  };
  const recorded = Object.values(found).some(value => value !== null);
  return Object.freeze({ ...UNATTRIBUTED, ...found, recorded,
    activatedAt: activatedAt ? activatedAt[1] : null });
}

/* Last observed state per marker path, so a switch that disappears without
 * going through deactivate() can be reported as what it is. In-memory and
 * per-process on purpose: this answers "did it clear while I was watching",
 * which is a question about this process's own view. */
const observed = new Map();
const deactivationListeners = new Set();

function notifyClearance(record) {
  for (const listener of [...deactivationListeners]) {
    try { listener(record); } catch { /* a listener must not keep the clearance from being reported to the rest */ }
  }
}

function statusAt(killFile, options = {}) {
  let body = null;
  let active;
  try {
    body = fs.readFileSync(killFile, 'utf8');
    active = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
    active = false;
  }
  if (active) {
    const attribution = parseAttribution(body);
    observed.set(killFile, { active: true, attribution });
    return { active: true, path: killFile, attribution };
  }
  const previous = observed.get(killFile);
  observed.set(killFile, { active: false, attribution: null });
  /* A CLEAR NOBODY ASKED FOR STILL HAPPENED. If this process saw the switch on
   * and now sees it gone, and deactivate() is not the one asking, the marker was
   * removed out of band -- a hand at the filesystem. It is reported with
   * clearedBy null rather than guessed at. */
  if (previous && previous.active === true && !options.clearance) {
    notifyClearance(Object.freeze({
      path: killFile,
      clearedAt: new Date().toISOString(),
      clearedBy: null,
      reason: null,
      outOfBand: true,
      previous: previous.attribution || UNATTRIBUTED
    }));
  }
  return { active: false, path: killFile, attribution: UNATTRIBUTED };
}

function status() { return statusAt(path()); }
function statusFor(killFile) { return statusAt(killFile); }
function onActivate(listener) {
  if (typeof listener !== 'function') throw new TypeError('kill-switch activation listener must be a function');
  activationListeners.add(listener);
  return () => activationListeners.delete(listener);
}

/* WHO PULLED THE BRAKE IS PART OF THE RECORD.
 *
 * The marker held a timestamp and nothing else. system.kill_switch_activate is
 * reachable from the LOWEST confined tier (confined-tool-surface.js lists it in
 * CONTAINED), takes no approval -- approvalEligible defaults to
 * effect === 'external-write' and this verb is 'local-write' -- and writes no
 * required durable intent for the same reason. The optional per-call summary in
 * auditInvocation is off by default (runtime-policy audit.activity defaults to
 * 'Off'), and recorded no agent identity even when on. So an agent that ingests
 * a poisoned page or repo file can refuse every outward operation on the owner's
 * machine, and the only evidence left behind is a time.
 *
 * With three agents running, "the brake was pulled and nobody knows by whom" is
 * exactly the state an incident response cannot start from. The marker is the
 * one record that is always written, whatever the audit policy says, so the
 * attribution belongs here as well as in the audit.
 *
 * Every value is caller-supplied, so each is flattened to a single line and
 * bounded before it is written: an agent id carrying a newline must not be able
 * to forge additional fields in this file.
 */
const attributionScalar = (value, limit = 200) =>
  String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, limit);

/* A PRINCIPAL IS AN OBJECT, NOT A STRING.
 *
 * Every real caller passes one: owner-host.js builds
 * Object.freeze({ kind, sessionId, agentId, provider, roleId, ... }), and
 * job-runner and both bridges do the same. String() on that yields
 * "[object Object]", so the field that is supposed to say WHO pulled the brake
 * said nothing at all. The first version of this recorded exactly that, and the
 * injection case did not catch it because it passed a string -- a test that
 * exercises only the shape the author had in mind cannot see the shape the
 * callers actually send. Caught in review.
 *
 * Rendered as its identifying fields, each flattened and bounded exactly like a
 * scalar, so an object cannot smuggle newlines in through a nested value either.
 */
const PRINCIPAL_FIELDS = Object.freeze(['kind', 'agentId', 'sessionId', 'provider', 'roleId']);

function renderAttribution(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object') return attributionScalar(value) || null;
  if (Array.isArray(value)) return null;
  const parts = [];
  for (const field of PRINCIPAL_FIELDS) {
    const held = value[field];
    if (held === undefined || held === null || held === '') continue;
    if (typeof held === 'object') continue;
    const rendered = attributionScalar(held, 120);
    if (rendered) parts.push(`${field}=${rendered}`);
  }
  return parts.length ? parts.join(' ') : null;
}

function attributionLine(label, value) {
  const rendered = renderAttribution(value);
  return `${label}: ${rendered === null ? '(not stated)' : rendered}\n`;
}

function activate(attribution = {}) {
  const killFile = path();
  const who = attribution && typeof attribution === 'object' ? attribution : {};
  const record = `ToolsEnabled kill switch activated ${new Date().toISOString()}\n`
    + attributionLine('agent', who.agentId)
    + attributionLine('actor', who.agentActor)
    + attributionLine('session', who.agentSessionId)
    + attributionLine('role', who.agentRole)
    + attributionLine('principal', who.agentPrincipal)
    + attributionLine('request', who.requestId);
  fs.writeFileSync(killFile, record, { encoding: 'utf8', flag: 'w' });
  for (const listener of [...activationListeners]) {
    try { listener(Object.freeze({ path: killFile })); } catch { /* marker activation must not be defeated by a revocation callback */ }
  }
  return statusAt(killFile);
}
/* A CLEAR IS AN EVENT, AND IT HAD AN ACTOR TOO.
 *
 * This removed the marker, told nobody, and returned. An agent clearing the
 * brake and a person clearing it by hand left exactly the same evidence: none.
 * The activation attribution cannot answer this, because clearing DELETES the
 * marker that holds it -- so the clear is reported through listeners, carrying
 * the attribution the switch had while it was on.
 *
 * outOfBand is false here because this path was asked; a marker that simply
 * vanishes is noticed by statusAt() and reported with outOfBand true and
 * clearedBy null. */
function deactivate(options = {}) {
  const killFile = path();
  const before = statusAt(killFile);
  const wasActive = before.active === true;
  const previous = wasActive ? before.attribution : null;
  try { fs.unlinkSync(killFile); } catch (error) { if (!isMissing(error)) throw error; }
  const result = statusAt(killFile, { clearance: true });
  if (wasActive) {
    notifyClearance(Object.freeze({
      path: killFile,
      clearedAt: new Date().toISOString(),
      clearedBy: attributionScalar(options.actor, 128) || null,
      reason: attributionScalar(options.reason, 512) || null,
      outOfBand: false,
      previous: previous || UNATTRIBUTED
    }));
  }
  return result;
}

function onDeactivate(listener) {
  if (typeof listener !== 'function') throw new TypeError('kill-switch deactivation listener must be a function');
  deactivationListeners.add(listener);
  return () => deactivationListeners.delete(listener);
}

module.exports = { status, statusFor, activate, deactivate, onActivate, onDeactivate, UNATTRIBUTED };
