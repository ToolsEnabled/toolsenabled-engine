'use strict';

// C10, carried unanimously by the 2026-08-03 council: the fabric cutover is the
// one step in this migration that cannot be undone by a toggle.  After it, the
// fabric is the only general send surface and the old board is read-only, and
// the migration document says in its own words that restoring arbitrary old
// writes "requires a new migration, not a rollback toggle".
//
// Its failure mode is the reason the gate is mechanical rather than a paragraph
// of guidance.  An agent still reading the old board after cutover does not get
// an error; it gets quiet.  It waits on a channel nobody writes to any more and
// starves without ever learning why.  A silent failure that strands live agents
// is exactly the class of action that should not happen while the owner is
// asleep on some coordinator's judgement call.
//
// So: the cutover requires an explicit owner authorization, and this module
// refuses by default.  Coordinator judgement, deadline pressure, unanimous
// agent agreement and a passing test suite are all insufficient inputs here.
// Only the owner's recorded authorization opens it.

const REFUSAL = Object.freeze({
  NO_AUTHORIZATION: 'CUTOVER_OWNER_AUTHORIZATION_ABSENT',
  NOT_OWNER: 'CUTOVER_AUTHORIZATION_NOT_FROM_OWNER',
  WRONG_MIGRATION: 'CUTOVER_AUTHORIZATION_FOR_DIFFERENT_MIGRATION',
  UNVERIFIED: 'CUTOVER_AUTHORIZATION_UNVERIFIED',
  READERS_UNKNOWN: 'CUTOVER_LEGACY_READERS_UNSURVEYED',
  READERS_LIVE: 'CUTOVER_LEGACY_READERS_STILL_ACTIVE'
});

const DECISION = Object.freeze({
  PERMITTED: 'PERMITTED',
  REFUSED: 'REFUSED'
});

function refuse(reason, detail, extra = {}) {
  return Object.freeze({
    decision: DECISION.REFUSED,
    reason,
    detail,
    ...extra
  });
}

// The survey is a separate precondition from the authorization, deliberately.
// The owner can only meaningfully authorize stranding old readers if somebody
// has established which readers exist; an authorization granted over an
// unsurveyed fleet is consent to something nobody characterised.
function evaluateCutover({ authorization, migrationVersion, legacyReaderSurvey, verifyOwnerAuthorization } = {}) {
  if (typeof migrationVersion !== 'string' || migrationVersion.length === 0) {
    return refuse(REFUSAL.WRONG_MIGRATION, 'No migration version was supplied to gate against.');
  }

  if (!authorization) {
    return refuse(
      REFUSAL.NO_AUTHORIZATION,
      'The fabric cutover strands any agent still reading the old board, silently, and cannot be rolled back with a toggle. It requires the owner\'s explicit authorization; coordinator judgement is not a substitute.'
    );
  }

  if (typeof verifyOwnerAuthorization !== 'function') {
    // Absent a real verifier the gate refuses rather than trusting the shape of
    // the object it was handed.  Anything in this process can fabricate a
    // plausible-looking authorization; only an injected verifier binds it to
    // the owner.
    return refuse(
      REFUSAL.UNVERIFIED,
      'No owner-authorization verifier was injected, so the authorization cannot be distinguished from one an agent wrote itself.'
    );
  }

  let verdict;
  try {
    verdict = verifyOwnerAuthorization(authorization);
  } catch (error) {
    return refuse(REFUSAL.UNVERIFIED, `The owner-authorization verifier failed: ${error.message}`);
  }

  if (!verdict || verdict.verified !== true) {
    return refuse(REFUSAL.UNVERIFIED, 'The owner-authorization verifier did not affirm this authorization.');
  }
  if (verdict.actorKind !== 'owner') {
    return refuse(REFUSAL.NOT_OWNER, `The authorization was attributed to ${verdict.actorKind || 'an unnamed actor'}, not the owner.`);
  }
  if (verdict.migrationVersion !== migrationVersion) {
    // An authorization for an earlier revision of the migration is not consent
    // to whatever the plan has become since.
    return refuse(
      REFUSAL.WRONG_MIGRATION,
      `The authorization names migration ${verdict.migrationVersion || '(none)'}, but the cutover being attempted is ${migrationVersion}.`
    );
  }

  if (!legacyReaderSurvey || typeof legacyReaderSurvey !== 'object') {
    return refuse(
      REFUSAL.READERS_UNKNOWN,
      'No survey of legacy board readers was supplied. The owner cannot consent to stranding readers nobody has enumerated.'
    );
  }
  if (legacyReaderSurvey.surveyed !== true) {
    return refuse(REFUSAL.READERS_UNKNOWN, 'The legacy reader survey did not complete, so the blast radius is unknown.');
  }

  const active = Array.isArray(legacyReaderSurvey.activeReaders) ? legacyReaderSurvey.activeReaders : null;
  if (active === null) {
    return refuse(REFUSAL.READERS_UNKNOWN, 'The legacy reader survey did not report an active-reader list.');
  }
  if (active.length > 0 && verdict.acknowledgedStrandedReaders !== true) {
    // Live readers plus an authorization that never mentioned them is the
    // stranding case in its purest form: the owner said yes to a migration, not
    // to cutting off these specific running agents.
    return refuse(
      REFUSAL.READERS_LIVE,
      `${active.length} agent(s) are still reading the legacy board and the authorization does not acknowledge stranding them.`,
      { activeReaders: Object.freeze([...active]) }
    );
  }

  return Object.freeze({
    decision: DECISION.PERMITTED,
    migrationVersion,
    authorizedBy: 'owner',
    strandedReaders: Object.freeze([...active])
  });
}

module.exports = { DECISION, REFUSAL, evaluateCutover };
