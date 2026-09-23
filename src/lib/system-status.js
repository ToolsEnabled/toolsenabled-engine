'use strict';

const fs = require('node:fs');
const path = require('node:path');
const packageInfo = require('../../package.json');
const { ROOT, commandExists, findBrowser, listSecretKeys, rootPath } = require('./runtime');
const { httpConfiguration, killSwitchPath, loadPolicy, requiresApproval } = require('./policy');
const { DIAGNOSTIC_CREDENTIAL_KEYS } = require('./credential-metadata');
const { resolvePaddleEnvironment } = require('./paddle-environment');
const firebase = require('./providers/firebase');
const infrastructure = require('./providers/infrastructure');
const { SUPPORTED_SCHEDULED_ACTIONS } = require('./scheduled-actions');
const googleAccounts = require('./google-accounts');
const { readRepoSyncStatus } = require('./repo-sync-status');

const CREDENTIAL_KEYS = DIAGNOSTIC_CREDENTIAL_KEYS;

function killSwitchActive(policy = loadPolicy()) {
  return filePresence(killSwitchPath(policy));
}

function filePresence(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    // Permission and I/O failures do not establish that a file is absent.
    return null;
  }
}

// ENTITLEMENT, ASKED THROUGH A SEAM THAT NAMES NO LICENSING MODULE.
//
// This was a lazy, fail-soft require of the entitlement module. Lazy was right
// at runtime and is still enforced by tests/shipped-registry-boundary.test.js.
// But tools/pack-capability-layer.mjs walks require() calls as TEXT, not at
// runtime, so that one line staged the commercial tier table, the licence
// verifier and its signed revocation store into the open payload -- the three
// modules the owner ruled must not ship on 2026-08-11. No amount of laziness
// could have fixed that; only removing the specifier text could. See
// src/lib/entitlement-report.js for the full reasoning and for who registers
// the real reporter vendor-side.
//
// STILL FAIL-SOFT: a diagnostic must never be the thing that blocks an install.
// Fail-soft does not mean claiming that the failed check succeeded, however.
// Community is a valid successful result when the reporter says so; an absent
// or broken reporter is an unreadable result and must remain visibly failed in
// the returned health report.
function entitlementState(describe = () => require('./entitlement-report').describeEntitlement({ root: ROOT })) {
  try {
    return describe();
  } catch (error) {
    return {
      ok: false,
      tier: null,
      unlicensedInstall: null,
      reason: 'entitlement-unreadable',
      detail: String((error && error.message) || error)
    };
  }
}

function transactionalState() {
  try {
    const { getStateStore } = require('./state-store');
    return getStateStore().health();
  } catch (error) {
    return {
      ok: false,
      path: rootPath('state', 'toolsenabled.sqlite3'),
      error: {
        code: typeof error.code === 'string' ? error.code : 'STATE_UNAVAILABLE',
        message: String(error.message || error).slice(0, 1000)
      }
    };
  }
}

function auditState() {
  try {
    const audit = require('./audit');
    let current = audit.status();
    // This is a health READ on a timer, not the `audit.verify` tool. Taking the
    // cached verification keeps the answer identical while nothing has changed
    // and costs 2 ms instead of a 1.6 s signature walk of the whole ledger --
    // per poll, on the same single-writer ledger every tool call needs. See
    // audit.js verify()'s `cached` comment for why this decides nothing.
    let verification = audit.verify({ cached: true });
    // A tool-success event can be appended after status() observes the
    // canonical head but before the projection sinks catch up. That is a
    // transient projection race, not evidence of tampering. Reconcile once
    // through the canonical audit flusher, then verify the same fresh head;
    // persistent invalidity still remains fail-closed.
    //
    // The retry deliberately drops the cache: once something has reported
    // invalid, the cheap answer is no longer the one worth having, and a full
    // walk here is paid at most once per poll that already looks wrong.
    if (!verification.valid && ['projection-divergence', 'projection-malformed', 'emergency-backlog'].includes(verification.reason)) {
      try {
        audit.flush({ force: true });
        current = audit.status();
        verification = audit.verify();
      } catch { /* Preserve the original invalid evidence below. */ }
    }
    // How much the verifying itself cost this process, so a regression that
    // makes every call walk the whole ledger again is visible here rather than
    // only in a CPU profile. Counts only; never any ledger material.
    let verificationStats = null;
    try { verificationStats = audit.verificationStats(); } catch { /* counters are advisory */ }
    return { ...current, verification, verificationStats };
  } catch (error) {
    return {
      ok: false,
      path: rootPath('state', 'audit.sqlite3'),
      error: {
        code: typeof error.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE',
        message: String(error.message || error).slice(0, 1000)
      }
    };
  }
}

function httpState(policy) {
  try {
    const configured = httpConfiguration(policy);
    return {
      configured: Boolean(policy && policy.http),
      allowedHosts: configured.allowedHosts,
      vaultKeys: Object.entries(configured.vaultKeys).map(([name, binding]) => ({
        name, hosts: binding.hosts, authStyle: binding.authStyle
      }))
    };
  } catch (error) {
    return {
      configured: Boolean(policy && policy.http),
      error: {
        code: typeof error.code === 'string' ? error.code : 'HTTP_POLICY_INVALID',
        message: String(error.message || error).slice(0, 500)
      }
    };
  }
}

// Generic OAuth keys remain visible in `credentials` for legacy diagnostics,
// but Google providers now store refresh tokens in per-account vault keys.
// Surface only registered aliases and authorization booleans here—never vault
// keys, token values, or account emails.
function googleAccountReadiness(accountRegistry = googleAccounts) {
  try {
    const accounts = accountRegistry.list().map(account => ({
      alias: account.alias,
      isDefault: account.isDefault === true,
      authorized: account.authorized === true
    }));
    const defaultAccount = accounts.find(account => account.isDefault) || null;
    const authorizedAccounts = accounts.filter(account => account.authorized).map(account => account.alias);
    return {
      configured: accounts.length > 0,
      accountCount: accounts.length,
      defaultAccount: defaultAccount ? defaultAccount.alias : null,
      defaultAuthorized: Boolean(defaultAccount && defaultAccount.authorized),
      anyAuthorized: authorizedAccounts.length > 0,
      authorizedAccounts,
      accounts
    };
  } catch (error) {
    return {
      configured: null,
      accountCount: null,
      defaultAccount: null,
      defaultAuthorized: null,
      anyAuthorized: null,
      authorizedAccounts: null,
      accounts: null,
      error: {
        code: typeof error.code === 'string' ? error.code : 'GOOGLE_ACCOUNTS_UNREADABLE',
        message: String(error.message || error).slice(0, 500)
      }
    };
  }
}

// telegramPairingReadiness() AND telegramCredentialReadiness() WERE REMOVED
// 2026-08-23. They answered "is the Telegram bridge paired and credentialled",
// by calling telegram-bridge.js#bridgeStatus(); that module is deleted with the
// rest of the connector. The `telegram` key they fed in the readiness object
// below is gone too -- a readiness flag for a provider the product does not
// have is worse than no flag, because an operator reads `telegram: false` as
// "set it up" rather than "it is not a thing any more".
//
// The two vault keys are NOT reported as missing either: they were taken out of
// DIAGNOSTIC_CREDENTIAL_KEYS in src/lib/credential-metadata.js, where they are
// relabelled "no longer used; remove it" and stay visible to an owner who
// stored one.

function mcpToolSurfaceStatus() {
  try {
    // Deliberately lazy: tool-registry imports this module to register
    // system.status/system.doctor, while the status read needs the current
    // advertised surface rather than a guessed source-file tool count.
    const { listTools } = require('./tool-registry');
    return require('./mcp-tool-surface').status({ tools: listTools() });
  } catch {
    return {
      schemaVersion: 1,
      state: 'unavailable',
      reason: 'MCP_TOOL_SURFACE_STATUS_UNAVAILABLE',
      nextAction: 'repair the local MCP surface observer before relying on it',
      counts: null,
      directSessionScopeUnverified: null
    };
  }
}

/* A name no registered tool carries lets status ask the real gate for the
 * external-write class without accidentally taking a by-name exemption. */
const EXTERNAL_WRITE_PROBE = 'system.external_write_probe';

/* Report the decision requiresApproval() will make. Reading policy.approvals
 * field by field drifted from the owner's agent.tool_approvals setting and
 * made status say ON after the effective gate was OFF. Keep the declared
 * policy beside the effective answer so the reason remains diagnosable. */
function approvalState(policy = loadPolicy()) {
  const approvals = (policy && policy.approvals) || {};
  const declared = Array.isArray(approvals.actions) ? approvals.actions : [];
  const actions = declared.filter(action => requiresApproval(action, 'local-write', policy));
  const externalWrites = requiresApproval(EXTERNAL_WRITE_PROBE, 'external-write', policy);
  return {
    enabled: actions.length > 0 || externalWrites,
    externalWrites,
    actions,
    autoApproveBrowserStart: Boolean(approvals.autoApproveBrowserStart),
    allowScheduledActions: Boolean(approvals.allowScheduledActions),
    timeoutSeconds: approvals.timeoutSeconds,
    declaredActions: declared,
    policyFileEnabled: Boolean(approvals.enabled)
  };
}

function status(options = {}) {
  const policy = loadPolicy();
  const google = googleAccountReadiness();
  const surface = options.mcpToolSurface || mcpToolSurfaceStatus();
  const repoSync = options.repoSyncStatus || readRepoSyncStatus(options.repoSync);
  return {
    name: 'ToolsEnabled',
    version: packageInfo.version,
    root: ROOT,
    mode: policy.mode,
    killSwitchActive: killSwitchActive(policy),
    approvals: approvalState(policy),
    http: httpState(policy),
    providers: policy.providers,
    googleAccounts: google,
    supportedScheduledActions: SUPPORTED_SCHEDULED_ACTIONS,
    transports: ['stdio-mcp'],
    mcpToolSurface: surface,
    repoSync,
    state: transactionalState(),
    audit: auditState(),
    browser: { path: findBrowser() }
  };
}

function doctor() {
  const policy = loadPolicy();
  const browserPath = findBrowser();
  const browserName = browserPath ? path.basename(browserPath).toLowerCase() : '';
  let availableSecretKeys;
  let credentialVault = { state: 'readable' };
  try {
    availableSecretKeys = new Set(listSecretKeys());
  } catch (error) {
    // A failed inventory says nothing about which credentials are present. Keep
    // doctor usable, but preserve that distinction instead of turning an
    // unreadable vault into an authoritative list of missing credentials.
    credentialVault = {
      state: 'unreadable',
      error: {
        code: typeof error.code === 'string' ? error.code : 'VAULT_UNREADABLE',
        message: String(error.message || error).slice(0, 500)
      }
    };
  }
  const credentials = Object.fromEntries(CREDENTIAL_KEYS.map(name => [
    name,
    availableSecretKeys ? availableSecretKeys.has(name) : null
  ]));
  const google = googleAccountReadiness();
  const surface = mcpToolSurfaceStatus();
  // Resolved once per doctor run, so the readiness boolean below and the
  // environment reported next to it cannot describe different environments.
  const paddle = resolvePaddleEnvironment();
  const genericGoogleReady = availableSecretKeys
    ? Boolean(credentials.google_access_token
      || (credentials.google_refresh_token && credentials.google_client_id && credentials.google_client_secret))
    : null;
  const executables = {
    node: commandExists('node'),
    npm: commandExists('npm'),
    firebase: commandExists('firebase'),
    gcloud: commandExists('gcloud'),
    terraform: commandExists('terraform'),
    'chrome.exe': browserName === 'chrome.exe' || commandExists('chrome.exe'),
    'msedge.exe': browserName === 'msedge.exe' || commandExists('msedge.exe'),
    'schtasks.exe': commandExists('schtasks.exe')
  };
  const policyFile = rootPath('config', 'toolsenabled.policy.json');
  const serverFile = rootPath('src', 'mcp-server.js');
  return {
    node: process.version,
    root: ROOT,
    cwd: ROOT,
    policy: filePresence(policyFile),
    mcpServer: filePresence(serverFile),
    executables,
    firebaseCli: executables.firebase,
    gcloudCli: executables.gcloud,
    terraformCli: executables.terraform,
    browser: browserPath,
    taskScheduler: executables['schtasks.exe'],
    state: transactionalState(),
    audit: auditState(),
    killSwitchActive: killSwitchActive(policy),
    credentialVault,
    credentials,
    credentialsPresent: availableSecretKeys ? CREDENTIAL_KEYS.filter(name => credentials[name]) : null,
    credentialReadiness: {
      instagram: availableSecretKeys ? Boolean(credentials.ig_access_token && credentials.ig_user_id) : null,
      chromeWebStore: availableSecretKeys
        ? Boolean(credentials.cws_access_token || (credentials.cws_refresh_token && credentials.cws_client_id && credentials.cws_client_secret))
        : null,
      // `google` is effective provider readiness. The generic legacy flags
      // remain available above and the two source-specific booleans below make
      // the distinction explicit for operators.
      google: google.defaultAuthorized === true || genericGoogleReady === true
        ? true
        : (google.defaultAuthorized === null || genericGoogleReady === null ? null : false),
      googleGeneric: genericGoogleReady,
      googleDefaultAccount: google.defaultAuthorized,
      googleAnyRegisteredAccount: google.anyAuthorized,
      github: credentials.github_pat,
      stripe: availableSecretKeys ? Boolean(credentials.stripe_restricted_key || credentials.stripe_secret_key) : null,
      // READINESS IS ASKED OF THE ENVIRONMENT THIS INSTALLATION RECORDS.
      // Hardcoding the sandbox key names here meant an operator who had put
      // live credentials in the vault was told Paddle was NOT ready, while an
      // operator who had only sandbox credentials and had recorded `live` was
      // told it WAS -- readiness reported against an account the product would
      // never call. `paddleEnvironment` is reported alongside so the boolean is
      // readable: "ready" is meaningless without saying ready for what.
      paddle: availableSecretKeys
        ? Boolean(credentials[paddle.profile.apiVaultKey] && credentials[paddle.profile.webhookVaultKey])
        : null,
      paddleEnvironment: paddle.environment,
      paddleEnvironmentRecorded: paddle.recorded,
      vercel: credentials.vercel_token,
      cloudflare: availableSecretKeys
        ? Boolean(credentials.cloudflare_api_token && credentials.cloudflare_account_id)
        : null
    },
    authentication: {
      firebase: firebase.doctor().authenticatedFirebase,
      gcloud: infrastructure.doctor().gcloudAuthenticated,
      github: credentials.github_pat
    },
    googleAccounts: google,
    mcpToolSurface: surface,
    // ENTITLEMENT. What this installation is entitled to, asked through the seam
    // in src/lib/entitlement-report.js so that naming a licensing module here
    // cannot drag the commercial tier table back into the open payload.
    //
    // THIS COMMENT USED TO SAY that every doctor run resolves a licence and so
    // makes the licence verifier something the running product actually calls.
    // That is no longer true and saying it would be worse than saying nothing:
    // in the free build there is no verifier to call, and a reader trusting the
    // old sentence would conclude this diagnostic still exercises code that is
    // not there. It resolves a real licence only where a reporter is registered,
    // which is the vendor side (src/lib/tool-packs/vendor-license-issuance.js).
    //
    // It is reported and NEVER failed on, in either build. An unlicensed
    // installation is the intended, supported majority state -- and after the
    // payload split it is the ONLY state the shipped product has -- so
    // `entitlement.ok` is true for it, and the exit-code conditions in
    // src/doctor.js deliberately do not read this block. Painting a community
    // install red would be this repo's absence-as-emptiness defect wearing a
    // billing hat.
    entitlement: entitlementState(),
    runtime: status({ mcpToolSurface: surface })
  };
}

module.exports = {
  CREDENTIAL_KEYS,
  approvalState,
  auditState,
  doctor,
  entitlementState,
  googleAccountReadiness,
  httpState,
  mcpToolSurfaceStatus,
  status,
  transactionalState
};
