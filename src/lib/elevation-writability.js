'use strict';

// Does anyone who is NOT an administrator have write access to a file that
// Windows will later execute WITH administrator rights?
//
// THE HOLE THIS DETECTS (SHIPMENT-PLAN B27, measured 2026-08-11).
// A scheduled task registered with RunLevel=Highest is a deliberate, owner
// sanctioned elevation door. It is only as strong as the NTFS permissions on
// the program it runs. If a non-administrator can rewrite that program, the
// task's own gates -- a per-boot token, a fixed operation allowlist, a kill
// switch, a signed audit trail -- protect nothing, because the attacker
// replaces the code that enforces them and then asks Windows to run it
// elevated. Measured on this machine, that was exactly the state: the
// elevation helper carried an inherited BUILTIN\Users:(M) ACE.
//
// WHY THIS IS A LIBRARY AND NOT A SCRIPT.
// The decision -- "is this principal allowed to hold this right on this file"
// -- is pure. It takes an access-control list already read from somewhere and
// returns findings. That keeps it testable without a Windows ACL, without a
// scheduled task, and without administrator rights, and it lets the same rule
// run over a synthetic fixture in CI and over the real machine in the CLI.
// tools/check-elevation-writability.js supplies the real ACLs.
//
// WHAT COUNTS AS "THE SAME PRINCIPAL AS THE TASK".
// Windows does not treat UAC as a security boundary between a user and their
// own elevated token, so the account the task already runs as is reported but
// does not fail the check. Every OTHER non-administrator principal does fail:
// a different local user, a sandbox principal, or an unresolvable SID from
// another machine are all boundaries that a privilege escalation would cross.
//
// PORTABILITY. Nothing here names a user, a path, a machine, or an SID from
// this deployment. The owner principal is supplied by the caller, which
// resolves it at runtime from the task registration.

// Rights that let a principal replace, truncate, or repoint the file, or grant
// itself the ability to. WriteAttributes and ReadPermissions are deliberately
// absent: neither changes what the elevated process will execute.
const DANGEROUS_RIGHTS = Object.freeze([
  'FullControl',
  'Modify',
  'Write',
  'WriteData',
  'CreateFiles',
  'AppendData',
  'CreateDirectories',
  'Delete',
  'DeleteSubdirectoriesAndFiles',
  'ChangePermissions',
  'TakeOwnership',
]);

// Well-known SIDs that are already administrator-equivalent. A principal in
// this set holding write access is not an escalation: it is already at or
// above the privilege the elevated task would confer.
const ADMIN_EQUIVALENT_SIDS = Object.freeze({
  'S-1-5-18': 'NT AUTHORITY\\SYSTEM',
  'S-1-5-32-544': 'BUILTIN\\Administrators',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464': 'NT SERVICE\\TrustedInstaller',
});

// Broad groups that almost certainly indicate an inherited ACE nobody intended
// on an elevation target. Named so the report can say WHY it is alarming
// rather than only that it is.
const BROAD_GROUP_SIDS = Object.freeze({
  'S-1-1-0': 'Everyone',
  'S-1-5-32-545': 'BUILTIN\\Users',
  'S-1-5-11': 'NT AUTHORITY\\Authenticated Users',
  'S-1-5-4': 'NT AUTHORITY\\INTERACTIVE',
  'S-1-5-32-546': 'BUILTIN\\Guests',
  'S-1-5-7': 'NT AUTHORITY\\ANONYMOUS LOGON',
});

const SID_RE = /^S-1-[0-9]+(-[0-9]+)+$/i;

function normalizeRights(rights) {
  if (Array.isArray(rights)) return rights.map((r) => String(r).trim()).filter(Boolean);
  if (typeof rights === 'string') return rights.split(',').map((r) => r.trim()).filter(Boolean);
  return [];
}

/** The subset of `rights` that would let the holder change what gets executed. */
function dangerousRightsIn(rights) {
  const held = new Set(normalizeRights(rights));
  return DANGEROUS_RIGHTS.filter((r) => held.has(r));
}

/**
 * Classify one principal relative to an elevation target.
 * Returns one of: 'admin-equivalent' | 'task-account' | 'broad-group' |
 * 'unresolved-sid' | 'other-principal'.
 */
function classifyPrincipal(principal = {}, options = {}) {
  const sid = principal.sid ? String(principal.sid).toUpperCase() : '';
  const name = principal.name ? String(principal.name) : '';
  const taskSid = options.taskAccountSid ? String(options.taskAccountSid).toUpperCase() : '';

  if (sid && Object.prototype.hasOwnProperty.call(ADMIN_EQUIVALENT_SIDS, sid)) return 'admin-equivalent';
  if (sid && taskSid && sid === taskSid) return 'task-account';
  if (sid && Object.prototype.hasOwnProperty.call(BROAD_GROUP_SIDS, sid)) return 'broad-group';

  // An identity reference that is still a raw SID string could not be resolved
  // to an account on this machine. On a tree that has been copied between
  // machines these accumulate, and each one is a principal nobody can name --
  // which means nobody can say whether it should hold this right.
  if (!name || SID_RE.test(name)) return 'unresolved-sid';

  return 'other-principal';
}

/** True when this classification must NOT hold write access to an elevated program. */
function classificationIsOffending(classification) {
  return classification !== 'admin-equivalent' && classification !== 'task-account';
}

/**
 * Evaluate one target.
 * target: { path, reason, aces: [{ principal: {sid, name}, rights, type, inherited }] }
 * Only 'Allow' entries are considered; a Deny entry cannot grant access.
 */
function evaluateTarget(target = {}, options = {}) {
  const validTarget = target !== null && typeof target === 'object' && !Array.isArray(target);
  const path = validTarget && target.path ? String(target.path) : '';
  const hasAces = validTarget && Array.isArray(target.aces);
  const aces = hasAces ? target.aces : [];
  const offenders = [];

  for (const ace of aces) {
    const type = ace && ace.type ? String(ace.type) : 'Allow';
    if (type.toLowerCase() !== 'allow') continue;

    const granted = dangerousRightsIn(ace && ace.rights);
    if (granted.length === 0) continue;

    const principal = (ace && ace.principal) || {};
    const classification = classifyPrincipal(principal, options);
    if (!classificationIsOffending(classification)) continue;

    offenders.push({
      path,
      principal: principal.name || principal.sid || '<unknown>',
      sid: principal.sid || '',
      classification,
      rights: granted,
      inherited: Boolean(ace && ace.inherited),
    });
  }

  return {
    path,
    reason: validTarget && target.reason ? String(target.reason) : '',
    // An absent or malformed ACL is not evidence that nobody can write the
    // target. Refuse a clean verdict instead of letting an empty fallback make
    // the offender check vacuously pass.
    ok: hasAces && offenders.length === 0,
    unknown: !hasAces,
    offenders,
  };
}

/**
 * Evaluate every elevation target.
 * Returns { ok, checked, offenderCount, results, offenders }.
 * ok is true only when no target has a single offending ACE. A run with zero
 * targets is NOT ok: it means the caller found no elevation door to check,
 * which is a discovery failure, not a clean bill of health.
 */
function evaluateElevationWritability(input = {}) {
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const options = { taskAccountSid: input.taskAccountSid };

  const results = targets.map((t) => evaluateTarget(t, {
    taskAccountSid: (t && t.taskAccountSid) || options.taskAccountSid,
  }));
  const offenders = results.reduce((acc, r) => acc.concat(r.offenders), []);
  const unknownCount = results.filter((r) => r.unknown).length;

  return {
    ok: targets.length > 0 && unknownCount === 0 && offenders.length === 0,
    empty: targets.length === 0,
    checked: targets.length,
    unknownCount,
    offenderCount: offenders.length,
    results,
    offenders,
  };
}

function describeClassification(classification) {
  switch (classification) {
    case 'broad-group':
      return 'a broad group that includes non-administrators';
    case 'unresolved-sid':
      return 'an SID that does not resolve to any account on this machine';
    case 'other-principal':
      return 'a principal that is neither an administrator nor the account the task runs as';
    default:
      return classification;
  }
}

/**
 * Human-readable report. Returns a string; never throws on partial input.
 * options.onlyFailures lists the offending targets and counts the clean ones,
 * so a host with many elevated tasks still produces a report a person reads.
 */
function formatReport(evaluation = {}, options = {}) {
  const lines = [];
  const all = Array.isArray(evaluation.results) ? evaluation.results : [];
  const onlyFailures = Boolean(options.onlyFailures);
  const results = onlyFailures ? all.filter((r) => !r.ok) : all;
  const hidden = all.length - results.length;

  if (evaluation.empty) {
    lines.push('NO ELEVATION TARGETS FOUND.');
    lines.push('Nothing was checked, so this is not a pass. Either this host registers no');
    lines.push('elevated task, or discovery failed. Investigate before treating it as clean.');
    return lines.join('\n');
  }

  for (const r of results) {
    lines.push(`${r.unknown ? 'UNKNOWN' : (r.ok ? 'OK  ' : 'FAIL')}  ${r.path}`);
    if (r.unknown) lines.push('        access-control entries were not supplied; writability was not measured');
    if (r.reason) lines.push(`        runs elevated because: ${r.reason}`);
    for (const o of r.offenders) {
      lines.push(`        ${o.principal} holds ${o.rights.join(',')}${o.inherited ? ' (inherited)' : ''}`);
      lines.push(`          -> ${describeClassification(o.classification)}`);
    }
  }

  if (hidden > 0) lines.push(`(${hidden} target(s) passed and are not listed)`);

  lines.push('');
  if (evaluation.ok) {
    lines.push(`PASS: ${evaluation.checked} elevation target(s); no non-administrator can rewrite any of them.`);
  } else {
    lines.push(`FAIL: ${evaluation.offenderCount} offending grant(s) across ${evaluation.checked} elevation target(s).`);
    if (evaluation.unknownCount > 0) {
      lines.push(`UNKNOWN: ${evaluation.unknownCount} target(s) had no measurable access-control list.`);
    }
    lines.push('Each one lets its holder replace a program Windows will run with administrator');
    lines.push('rights. The elevated program\'s own token, allowlist, kill switch and audit do');
    lines.push('not apply: an attacker replaces the code that enforces them.');
  }
  return lines.join('\n');
}

module.exports = {
  ADMIN_EQUIVALENT_SIDS,
  BROAD_GROUP_SIDS,
  DANGEROUS_RIGHTS,
  classifyPrincipal,
  classificationIsOffending,
  dangerousRightsIn,
  describeClassification,
  evaluateElevationWritability,
  evaluateTarget,
  formatReport,
};
