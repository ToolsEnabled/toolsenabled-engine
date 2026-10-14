'use strict';

const { inventory } = require('./powershell');
const requirementContract = require('./requirements');

function missingItem(name) {
  return {
    name, present: false, readable: false, managed: false, state: 'missing',
    warnings: [], error: { code: 'SECRET_NOT_CONFIGURED', name }
  };
}

function blockingCode(items) {
  if (items.some(item => item.state === 'expired')) return 'SECRET_EXPIRED';
  if (items.some(item => item.state === 'unreadable')) return 'SECRET_UNREADABLE';
  if (items.some(item => item.state === 'conflict')) return 'SECRET_METADATA_CONFLICT';
  return 'SECRET_NOT_CONFIGURED';
}

function usable(item) {
  return item.present === true && item.readable === true &&
    !['expired', 'unreadable', 'conflict', 'removed', 'missing'].includes(item.state);
}

function evaluateIntegration(requirement, byName) {
  if (requirement.criticality === 'dynamic' && requirement.alternatives.length === 0) {
    return {
      id: requirement.id, label: requirement.label, criticality: requirement.criticality,
      state: 'not-configured', ready: true, selectedAlternative: null,
      requirements: [], warnings: [], error: null
    };
  }
  const alternatives = requirement.alternatives.map((names, index) => {
    const items = names.map(name => byName.get(name) || missingItem(name));
    const blocked = items.filter(item => !usable(item));
    return { index, names, items, blocked, ready: blocked.length === 0 };
  });
  const selected = alternatives.find(item => item.ready) || alternatives
    .slice().sort((left, right) => left.blocked.length - right.blocked.length)[0];
  const warnings = selected ? selected.items.flatMap(item => item.warnings || []) : [];
  const ready = Boolean(selected && selected.ready);

  /* NEVER CONFIGURED IS NOT THE SAME AS BROKEN.
   *
   * `criticality: 'required'` is assigned from the SOURCE SCAN below in
   * validate(): a provider file that calls getSecret() must declare its
   * secrets. So "required" means "code exists that would use this", which is
   * true of every integration shipped in the binary -- not "this machine
   * needs it". MEASURED 2026-09-03 on the owner's own installation: the
   * doctor reported ok:false with SIX required failures (instagram,
   * chrome-web-store, google-default, github, stripe, paddle), none of which
   * this machine has ever used. `ok` was therefore false on every run since
   * install, and agents that call system.doctor -- described to them as
   * "what is configured here" -- read "REQUIRED credential missing" and went
   * to the owner for an Instagram token he has no use for.
   *
   * The distinction is the one the rest of this file already draws between
   * 'missing' and 'unreadable': not there, versus there and wrong. An
   * integration with NOTHING present anywhere has not been set up. One with
   * SOME of its names present is half-configured, expired, or broken, and
   * that is a real failure of this installation -- it stays 'will-fail' and
   * still fails the run, which is the half of this that matters, because
   * that is the state that actually means something stopped working.
   *
   * The integration is still listed with its every credential and state, so
   * nothing is hidden; it is counted as "not set up" rather than "broken". */
  const untouched = !ready && alternatives.every(item => item.items.every(secret => secret.present !== true));

  let state = ready ? (warnings.length ? 'ready-with-warning' : 'ready') : 'will-fail';
  if (!ready && requirement.criticality === 'conditional') state = 'conditional-unavailable';
  if (!ready && requirement.criticality === 'self-managed') state = 'self-managed-uninitialized';
  if (untouched && requirement.criticality === 'required') state = 'not-configured';
  const error = ready ? null : {
    code: blockingCode(selected ? selected.blocked : []),
    names: selected ? selected.blocked.map(item => item.name) : []
  };
  return {
    id: requirement.id,
    label: requirement.label,
    criticality: requirement.criticality,
    state,
    ready,
    selectedAlternative: selected ? selected.index : null,
    requirements: alternatives.map(item => ({
      alternative: item.index,
      names: item.names,
      ready: item.ready,
      states: item.items.map(secret => ({ name: secret.name, state: secret.state }))
    })),
    warnings,
    error
  };
}

function doctor(options = {}) {
  const snapshot = inventory(options);
  const byName = new Map(snapshot.secrets.map(item => [item.name, item]));
  const requirements = requirementContract.requirements(options.root || require('./powershell').ROOT, [...byName.keys()]);
  const contract = requirementContract.validate(options.root || require('./powershell').ROOT, requirements);
  const integrations = requirements.map(requirement => evaluateIntegration(requirement, byName));
  /* A required integration in 'not-configured' is deliberately excluded: it
     is not a failure of this installation. 'will-fail' -- present but expired,
     unreadable, conflicting, or half-entered -- still counts. */
  const requiredFailures = integrations.filter(item => item.criticality === 'required' && item.state === 'will-fail');
  const notConfigured = integrations.filter(item => item.state === 'not-configured' && item.criticality === 'required');
  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    ok: contract.errors.length === 0 && requiredFailures.length === 0,
    inventory: {
      secretCount: snapshot.secrets.length,
      managedCount: snapshot.secrets.filter(item => item.managed).length,
      unreadableCount: snapshot.secrets.filter(item => item.state === 'unreadable').length,
      expiredCount: snapshot.secrets.filter(item => item.state === 'expired').length,
      expiringCount: snapshot.secrets.filter(item => item.state === 'expiring').length,
      staleCount: snapshot.secrets.filter(item => item.state === 'stale').length,
      secrets: snapshot.secrets
    },
    summary: {
      integrationCount: integrations.length,
      readyCount: integrations.filter(item => item.ready).length,
      requiredFailureCount: requiredFailures.length,
      requiredNotConfiguredCount: notConfigured.length,
      conditionalUnavailableCount: integrations.filter(item => item.state === 'conditional-unavailable').length,
      contractErrorCount: contract.errors.length
    },
    integrations,
    contract
  };
}

module.exports = { doctor, evaluateIntegration };
