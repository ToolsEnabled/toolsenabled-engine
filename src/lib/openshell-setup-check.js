'use strict';

// A plain-words report of what is missing for ToolsEnabled running inside an
// OpenShell sandbox to reach a given provider through the advisor. Covers
// four gaps: no sandbox, the
// advisor off, no network rule for the provider, and a gateway-global
// policy suppressing provider rules. Each finding is `{ id, level, message }`
// with `level` one of 'ok' | 'missing' | 'unknown' -- 'unknown' is used
// whenever the documented interfaces do not give this workload enough to
// tell a real gap from a transient problem, rather than guessing either way.

const { describeSandboxDetection, PolicyLocalClient, PolicyAdvisorError, hasProviderRule, policyMentionsHostForProvider } = require('./openshell-inside');

function finding(id, level, message, extra = {}) {
  return Object.freeze({ id, level, message, ...extra });
}

/**
 * @param {object} options
 * @param {object} [options.env] - defaults to process.env
 * @param {{id: string, host: string, attached?: boolean}} [options.provider] -
 *   the provider the agent intends to use. `attached` should be true only when
 *   the caller knows a provider instance with this id was attached to the
 *   sandbox (ToolsEnabled's own settings or state say so) -- it is what lets finding
 *   4 distinguish "not attached" from "attached but suppressed."
 * @param {string} [options.sandboxName] - shown in messages only.
 * @param {PolicyLocalClient} [options.client] - injected for tests; built
 *   lazily from `options.clientOptions` otherwise.
 * @param {object} [options.clientOptions]
 */
async function runSetupCheck({ env = process.env, provider = null, sandboxName = '<sandbox-name>', client, clientOptions } = {}) {
  const findings = [];
  const sandbox = describeSandboxDetection(env);

  if (!sandbox.insideSandbox) {
    findings.push(
      finding(
        'sandbox_detected',
        'missing',
        'No OpenShell sandbox was detected (the OPENSHELL_SANDBOX environment marker is not set to "1"). ' +
          'Nothing ToolsEnabled does here is enforced by OpenShell.',
        { rawValue: sandbox.rawValue }
      )
    );
    return Object.freeze({ findings, insideSandbox: false });
  }
  findings.push(finding('sandbox_detected', 'ok', `An OpenShell sandbox was detected (OPENSHELL_SANDBOX=${sandbox.rawValue}).`));

  const policyClient = client || new PolicyLocalClient(clientOptions);
  let policyText = null;
  try {
    policyText = await policyClient.getCurrentPolicy();
    findings.push(finding('advisor_enabled', 'ok', 'The policy advisor is on for this sandbox: policy.local answered with the effective policy.'));
  } catch (error) {
    if (error instanceof PolicyAdvisorError && error.code === 'ADVISOR_DISABLED') {
      findings.push(
        finding(
          'advisor_enabled',
          'missing',
          'The policy advisor is off for this sandbox, so this workload cannot read its own policy or propose rule changes. ' +
            `Ask the person to run: openshell settings set ${sandboxName} --key agent_policy_proposals_enabled --value true`
        )
      );
    } else {
      const detail = error instanceof PolicyAdvisorError ? error.message : String(error && error.message);
      findings.push(
        finding(
          'advisor_enabled',
          'unknown',
          `Could not tell whether the policy advisor is on: policy.local did not answer as documented (${detail}). ` +
            'This can also mean policy.local itself is briefly unavailable, not that the advisor is off.'
        )
      );
    }
    return Object.freeze({ findings, insideSandbox: true, advisorEnabled: false });
  }

  if (!provider || !provider.id || !provider.host) {
    return Object.freeze({ findings, insideSandbox: true, advisorEnabled: true, policyText });
  }

  const hasRule = hasProviderRule(policyText, provider.id) || policyMentionsHostForProvider(policyText, provider.host);

  if (hasRule) {
    findings.push(finding('provider_network_rule', 'ok', `A network rule reaching ${provider.host} for "${provider.id}" is present in the effective policy.`));
    return Object.freeze({ findings, insideSandbox: true, advisorEnabled: true, policyText });
  }

  if (provider.attached) {
    findings.push(
      finding(
        'global_policy_suspected',
        'unknown',
        `The provider "${provider.id}" is attached, but no network rule for it (a "_provider_${provider.id.replace(/-/g, '_')}" entry, ` +
          `or any rule mentioning ${provider.host}) appears in the effective policy. An attached provider always contributes its rule ` +
          'unless a gateway-wide global policy is active, which replaces the sandbox\'s own policy and suppresses provider-contributed ' +
          `rules. Ask the person to check from outside the sandbox: openshell policy get --global --full`
      )
    );
    return Object.freeze({ findings, insideSandbox: true, advisorEnabled: true, policyText });
  }

  findings.push(
    finding(
      'provider_network_rule',
      'missing',
      `No network rule for "${provider.id}" (reaching ${provider.host}) was found in the effective policy. ` +
        `Ask the person to attach a provider for it, or add a rule: see openshell policy update ${sandboxName} --add-endpoint ${provider.host}:443:read-only:rest:enforce`
    )
  );
  return Object.freeze({ findings, insideSandbox: true, advisorEnabled: true, policyText });
}

module.exports = Object.freeze({ runSetupCheck });
