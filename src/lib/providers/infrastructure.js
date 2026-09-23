'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ROOT, commandExists, run, setSecret } = require('../runtime');
const { assertActive } = require('../policy');
const audit = require('../audit');
const { record } = audit;
const googleAccounts = require('../google-accounts');

const GCLOUD_INSPECT_MAX_PROJECTS = 25;
const GCLOUD_INSPECT_MAX_STDOUT_BYTES = 512 * 1024;
const GCLOUD_INSPECT_MAX_STDERR_BYTES = 32 * 1024;
const GCLOUD_INSPECT_COMMAND_TIMEOUT_MS = 15 * 1000;
const GCLOUD_INSPECT_TOTAL_TIMEOUT_MS = 90 * 1000;
const SIMPLE_EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,125}[A-Za-z0-9])?$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ACCOUNT_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BILLING_ACCOUNT_RE = /^billingAccounts\/[A-Za-z0-9-]{3,80}$/;
const SAFE_ROLE_RE = /^(?:roles\/[A-Za-z0-9_.]{1,120}|(?:projects|organizations)\/[A-Za-z0-9-]{1,80}\/roles\/[A-Za-z0-9_.]{1,120})$/;
const VERTEX_ROLE_EVIDENCE = new Set([
  'roles/aiplatform.admin',
  'roles/aiplatform.user',
  'roles/aiplatform.viewer',
  'roles/editor',
  'roles/owner'
]);

function gcloudAvailable() { return commandExists('gcloud'); }
function terraformAvailable() { return commandExists('terraform'); }
// The code names which CLI is absent (GCLOUD_CLI_MISSING / TERRAFORM_CLI_
// MISSING): installing it is an owner action, which is what MISSING tells the
// shared taxonomy. `name` is always one of this module's two fixed literals.
function requireCommand(available, name) {
  if (!available()) {
    const error = new Error(name === 'terraform'
      ? 'terraform is unavailable. Install it before using this adapter; authentication depends on the project providers and backend.'
      : `${name} is unavailable. Install it and authenticate before using this adapter.`);
    error.code = `${name.toUpperCase()}_CLI_MISSING`;
    throw error;
  }
}
function projectId(value) {
  if (!PROJECT_ID_RE.test(value || '')) throw new Error('projectId is not a valid Google Cloud project ID.');
  return value;
}
function validateServiceAccountId(value) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value || '')) throw new Error('serviceAccountId is not a valid Google service-account ID.');
  return value;
}
function serviceAccountEmail(project, account) { return `${validateServiceAccountId(account)}@${projectId(project)}.iam.gserviceaccount.com`; }
function directory(cwd) {
  const resolved = path.resolve(cwd || ROOT);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Directory does not exist: ${resolved}`);
  return resolved;
}
function resultOrThrow(result, action) {
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${action} failed.`);
  return result;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${label} contains fields that are not allowed: ${extra.join(', ')}.`);
}

function safeText(value, maximum) {
  return audit.scrubText(typeof value === 'string' ? value : '', maximum)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

function inspectDependencies(overrides = {}) {
  return {
    run: overrides.run || run,
    gcloudAvailable: overrides.gcloudAvailable || gcloudAvailable,
    assertActive: overrides.assertActive || assertActive,
    record: overrides.record || audit.record,
    accountRegistry: overrides.accountRegistry || googleAccounts,
    now: overrides.now || Date.now
  };
}

function resolveSelectedAccount(selector, accountRegistry) {
  if (typeof selector !== 'string' || selector.length < 1 || selector.length > 254) {
    throw new Error('account must be an exact registered Google account alias or email.');
  }
  const requested = selector.trim();
  if (requested !== selector || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,253}$/.test(requested)) {
    throw new Error('account must be an exact registered Google account alias or email.');
  }

  const alias = accountRegistry.resolve(requested);
  if (typeof alias !== 'string' || !ACCOUNT_ALIAS_RE.test(alias)) {
    throw new Error('The selected Google account registry entry is invalid.');
  }
  const loaded = accountRegistry.load();
  const metadata = loaded && plainObject(loaded.accounts) ? loaded.accounts[alias] : null;
  const listed = accountRegistry.list();
  const matches = Array.isArray(listed) ? listed.filter(item => item && item.alias === alias) : [];
  if (!plainObject(metadata) || matches.length !== 1) {
    throw new Error('The selected Google account is not an exact registered account.');
  }
  const email = typeof metadata.email === 'string' ? metadata.email.trim() : '';
  if (!SIMPLE_EMAIL_RE.test(email) || String(matches[0].email || '').toLowerCase() !== email.toLowerCase()) {
    throw new Error('The selected Google account has an invalid or inconsistent registered email.');
  }
  const normalized = requested.toLowerCase();
  if (normalized !== alias.toLowerCase() && normalized !== email.toLowerCase()) {
    throw new Error('The selected Google account does not exactly match the requested alias or email.');
  }
  if (normalized === email.toLowerCase()) {
    const duplicateEmails = Object.entries(loaded.accounts)
      .filter(([, entry]) => String(entry && entry.email || '').trim().toLowerCase() === normalized);
    if (duplicateEmails.length !== 1) {
      throw new Error('The selected Google account email is ambiguous in the account registry.');
    }
  }
  if (matches[0].authorized !== true) {
    const error = new Error(`Google account '${alias}' is registered but not authorized.`);
    error.code = 'GOOGLE_ACCOUNT_NOT_AUTHORIZED';
    throw error;
  }
  return Object.freeze({ alias, email });
}

function commandFailureReason(result) {
  if (result && (result.timedOut === true || result.signal === 'SIGTERM')) return 'timeout';
  const detail = String(result && result.stderr || '');
  if (/permission[_ ]denied|does not have permission|forbidden|not authorized/i.test(detail)) return 'permission_denied';
  if (/not logged in|no credentialed accounts|invalid_grant|reauthentication|login required/i.test(detail)) return 'not_authenticated';
  if (/not found|unknown command|invalid choice|is not a .* command/i.test(detail)) return 'command_unavailable';
  return 'command_failed';
}

function runJson(args, dependencies, deadlineMs) {
  const remaining = deadlineMs - dependencies.now();
  if (remaining <= 0) return { ok: false, reason: 'inspection_deadline_exceeded' };
  let result;
  try {
    result = dependencies.run('gcloud', args, {
      timeout: Math.max(1, Math.min(GCLOUD_INSPECT_COMMAND_TIMEOUT_MS, remaining)),
      env: {
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: '1'
      }
    });
  } catch (error) {
    return {
      ok: false,
      reason: error && (error.code === 'ETIMEDOUT' || error.code === 'ESPAWN_TIMEOUT')
        ? 'timeout' : 'command_failed'
    };
  }
  if (!plainObject(result)) return { ok: false, reason: 'malformed_command_result' };
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (Buffer.byteLength(stdout, 'utf8') > GCLOUD_INSPECT_MAX_STDOUT_BYTES
    || Buffer.byteLength(stderr, 'utf8') > GCLOUD_INSPECT_MAX_STDERR_BYTES) {
    return { ok: false, reason: 'command_output_too_large' };
  }
  if (result.status !== 0) return { ok: false, reason: commandFailureReason(result) };
  let value;
  try { value = JSON.parse(stdout || 'null'); }
  catch { return { ok: false, reason: 'malformed_json' }; }
  return { ok: true, value };
}

function unavailable(reason) {
  return { status: 'unknown', reason };
}

function parseAuth(value, expectedEmail) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const accounts = [];
  for (const entry of value) {
    if (!plainObject(entry) || typeof entry.account !== 'string') return null;
    const account = entry.account.trim();
    // Real gcloud JSON represents an inactive credential with either an empty
    // string or an omitted status field. Normalize only those two documented
    // forms; any other non-ACTIVE status still fails closed.
    const rawStatus = entry.status;
    const status = rawStatus === undefined || rawStatus === null || String(rawStatus).trim() === ''
      ? 'INACTIVE' : String(rawStatus).trim().toUpperCase();
    if (!SIMPLE_EMAIL_RE.test(account) || !['ACTIVE', 'INACTIVE'].includes(status)) return null;
    accounts.push({ account, status });
  }
  const selected = accounts.find(entry => entry.account.toLowerCase() === expectedEmail.toLowerCase());
  return selected
    ? { status: 'matched', credentialPresent: true, globallyActive: selected.status === 'ACTIVE', reason: null }
    : { status: 'mismatch', credentialPresent: false, globallyActive: false, reason: 'selected_account_not_in_gcloud_auth' };
}

function parseProjects(value) {
  if (!Array.isArray(value)) return null;
  const byId = new Map();
  for (const entry of value.slice(0, GCLOUD_INSPECT_MAX_PROJECTS + 1)) {
    if (!plainObject(entry) || !PROJECT_ID_RE.test(entry.projectId || '')) return null;
    const lifecycleState = typeof entry.lifecycleState === 'string'
      && /^[A-Z_]{1,40}$/.test(entry.lifecycleState.trim().toUpperCase())
      ? entry.lifecycleState.trim().toUpperCase() : 'UNKNOWN';
    byId.set(entry.projectId, {
      projectId: entry.projectId,
      name: safeText(entry.name, 256),
      lifecycleState
    });
  }
  const rows = [...byId.values()];
  return {
    projects: rows.slice(0, GCLOUD_INSPECT_MAX_PROJECTS),
    truncated: value.length > GCLOUD_INSPECT_MAX_PROJECTS || rows.length > GCLOUD_INSPECT_MAX_PROJECTS
  };
}

function billingState(command, expectedProjectId) {
  if (!command.ok) return unavailable(command.reason);
  const value = command.value;
  if (!plainObject(value)) return unavailable('malformed_billing_output');
  if (value.projectId !== undefined && value.projectId !== expectedProjectId) {
    return unavailable('billing_project_mismatch');
  }
  const accountName = typeof value.billingAccountName === 'string' ? value.billingAccountName.trim() : '';
  if (accountName && !BILLING_ACCOUNT_RE.test(accountName)) return unavailable('malformed_billing_output');
  const enabled = typeof value.billingEnabled === 'boolean' ? value.billingEnabled : null;
  return {
    status: enabled === null ? 'partial' : 'available',
    linked: Boolean(accountName),
    enabled,
    reason: enabled === null ? 'billing_enabled_field_unavailable' : null
  };
}

function vertexServiceState(command) {
  if (!command.ok) return unavailable(command.reason);
  if (!Array.isArray(command.value) || command.value.length > 100) {
    return unavailable('malformed_service_output');
  }
  let enabled = false;
  for (const entry of command.value) {
    if (!plainObject(entry)) return unavailable('malformed_service_output');
    const name = entry.config && entry.config.name;
    const state = typeof entry.state === 'string' ? entry.state.toUpperCase() : '';
    if (name === 'aiplatform.googleapis.com' && state === 'ENABLED') enabled = true;
  }
  return { status: 'available', enabled, reason: null };
}

function vertexIamState(command, expectedEmail) {
  if (!command.ok) return unavailable(command.reason);
  if (!plainObject(command.value) || !Array.isArray(command.value.bindings)) {
    return unavailable('malformed_iam_output');
  }
  const member = `user:${expectedEmail}`.toLowerCase();
  const roles = [];
  for (const binding of command.value.bindings.slice(0, 500)) {
    if (!plainObject(binding) || typeof binding.role !== 'string' || !Array.isArray(binding.members)) {
      return unavailable('malformed_iam_output');
    }
    const role = binding.role.trim();
    if (!SAFE_ROLE_RE.test(role)) continue;
    if (binding.members.some(value => typeof value === 'string' && value.trim().toLowerCase() === member)) {
      roles.push(role);
    }
  }
  const directRoleEvidence = [...new Set(roles)].filter(role => VERTEX_ROLE_EVIDENCE.has(role)).slice(0, 32);
  return {
    status: 'available',
    directRoleEvidence,
    effectivePermissionStatus: directRoleEvidence.length ? 'evidence_present' : 'unknown',
    reason: directRoleEvidence.length
      ? 'direct_project_role_evidence_only_not_an_effective_permission_test'
      : 'no_direct_vertex_role_evidence_effective_permissions_not_tested'
  };
}

function vertexReadiness(billing, service, iam) {
  if (billing.status !== 'unknown' && billing.enabled === false) {
    return { status: 'not_ready', reason: 'billing_not_enabled' };
  }
  if (service.status === 'available' && service.enabled === false) {
    return { status: 'not_ready', reason: 'vertex_service_not_enabled' };
  }
  if (billing.enabled === true && service.enabled === true && iam.effectivePermissionStatus === 'evidence_present') {
    return { status: 'unknown', reason: 'effective_vertex_permissions_not_tested_direct_role_evidence_present' };
  }
  return { status: 'unknown', reason: 'insufficient_read_only_cli_evidence' };
}

function doctor() {
  // `null` means authentication could not be measured. In particular, a
  // missing CLI, a failed auth command, and malformed command output must not
  // be collapsed into the definite claim that no account is authenticated.
  let gcloudAuthenticated = null;
  if (gcloudAvailable()) {
    try {
      const result = run('gcloud', ['auth', 'list', '--format=json']);
      if (result && result.status === 0 && typeof result.stdout === 'string') {
        const accounts = JSON.parse(result.stdout);
        if (Array.isArray(accounts)) {
          gcloudAuthenticated = accounts.some(account => account && account.status === 'ACTIVE');
        }
      }
    } catch { /* Surface CLI availability without leaking account data. */ }
  }
  return {
    gcloud: gcloudAvailable(), terraform: terraformAvailable(),
    gcloudAuthenticated
  };
}

function gcloudAccountInspect(input = {}, overrides = {}) {
  exactKeys(input, ['account'], 'gcloud.account_inspect input');
  const dependencies = inspectDependencies(overrides);
  const selected = resolveSelectedAccount(input.account, dependencies.accountRegistry);
  dependencies.assertActive('gcloud.account.inspect', { provider: 'googleCloud' });
  const startedAt = dependencies.now();
  const deadline = startedAt + GCLOUD_INSPECT_TOTAL_TIMEOUT_MS;
  const base = {
    account: {
      alias: selected.alias,
      email: selected.email,
      registered: true,
      authorized: true
    },
    gcloud: {
      available: dependencies.gcloudAvailable(),
      identity: unavailable('not_inspected')
    },
    projectDiscovery: {
      status: 'unknown',
      reason: 'not_inspected',
      returned: 0,
      truncated: false
    },
    projects: [],
    cloudCredit: unavailable('gcloud_cli_does_not_expose_credit_balance_trial_eligibility_or_expiry'),
    geminiSeat: unavailable('this_read_only_gcloud_inspector_does_not_enumerate_commerce_license_assignments'),
    readOnly: true,
    activeConfigChanged: false,
    contentTrust: 'untrusted',
    grantsAuthority: false
  };
  const finish = output => {
    dependencies.record('gcloud.account.inspect', 'selected-account', {
      gcloudAvailable: output.gcloud.available,
      identityStatus: output.gcloud.identity.status,
      projectDiscoveryStatus: output.projectDiscovery.status,
      projectCount: output.projects.length,
      truncated: output.projectDiscovery.truncated === true,
      durationMs: Math.max(0, dependencies.now() - startedAt)
    });
    return output;
  };

  if (!base.gcloud.available) {
    base.gcloud.identity = unavailable('gcloud_unavailable');
    base.projectDiscovery.reason = 'gcloud_unavailable';
    return finish(base);
  }

  const authCommand = runJson(
    ['auth', 'list', '--format=json'],
    dependencies,
    deadline
  );
  if (!authCommand.ok) {
    base.gcloud.identity = unavailable(authCommand.reason);
    base.projectDiscovery.reason = 'gcloud_identity_unavailable';
    return finish(base);
  }
  const identity = parseAuth(authCommand.value, selected.email);
  if (!identity) {
    base.gcloud.identity = unavailable('malformed_auth_output');
    base.projectDiscovery.reason = 'gcloud_identity_unavailable';
    return finish(base);
  }
  base.gcloud.identity = identity;
  if (identity.status !== 'matched') {
    base.projectDiscovery.reason = 'selected_account_not_in_gcloud_auth';
    return finish(base);
  }

  const accountFlag = `--account=${selected.email}`;
  const projectsCommand = runJson([
    'projects', 'list',
    accountFlag,
    `--limit=${GCLOUD_INSPECT_MAX_PROJECTS + 1}`,
    '--sort-by=projectId',
    '--format=json'
  ], dependencies, deadline);
  if (!projectsCommand.ok) {
    base.projectDiscovery.reason = projectsCommand.reason;
    return finish(base);
  }
  const discovered = parseProjects(projectsCommand.value);
  if (!discovered) {
    base.projectDiscovery.reason = 'malformed_projects_output';
    return finish(base);
  }

  base.projectDiscovery = {
    status: 'available',
    reason: null,
    returned: discovered.projects.length,
    truncated: discovered.truncated
  };
  for (const project of discovered.projects) {
    if (dependencies.now() >= deadline) {
      base.projects.push({
        ...project,
        billing: unavailable('inspection_deadline_exceeded'),
        vertex: {
          service: unavailable('inspection_deadline_exceeded'),
          iam: unavailable('inspection_deadline_exceeded'),
          readiness: unavailable('inspection_deadline_exceeded')
        }
      });
      continue;
    }

    const projectFlag = `--project=${project.projectId}`;
    const billing = billingState(runJson([
      'billing', 'projects', 'describe', project.projectId,
      accountFlag,
      '--format=json'
    ], dependencies, deadline), project.projectId);
    const service = vertexServiceState(runJson([
      'services', 'list', '--enabled',
      projectFlag,
      accountFlag,
      '--filter=name:aiplatform.googleapis.com',
      '--format=json'
    ], dependencies, deadline));
    const iam = vertexIamState(runJson([
      'projects', 'get-iam-policy', project.projectId,
      accountFlag,
      '--format=json'
    ], dependencies, deadline), selected.email);
    base.projects.push({
      ...project,
      billing,
      vertex: {
        service,
        iam,
        readiness: vertexReadiness(billing, service, iam)
      }
    });
  }
  return finish(base);
}

function gcloudProjectCreate({ projectId: id, name = '' }) {
  assertActive('gcloud.project.create');
  requireCommand(gcloudAvailable, 'gcloud');
  const args = ['projects', 'create', projectId(id)];
  if (name) args.push('--name', String(name));
  const result = resultOrThrow(run('gcloud', args, { timeout: 10 * 60 * 1000 }), 'gcloud projects create');
  record('gcloud.project.create', id, { name });
  return result;
}

function gcloudEnableServices({ projectId: id, services }) {
  assertActive('gcloud.services.enable');
  requireCommand(gcloudAvailable, 'gcloud');
  if (!Array.isArray(services) || services.length === 0 || services.some(service => !/^[a-z0-9.-]+\.googleapis\.com$/.test(service))) {
    throw new Error('services must be a non-empty list of Google API service names ending in .googleapis.com.');
  }
  const result = resultOrThrow(run('gcloud', ['services', 'enable', ...services, '--project', projectId(id)], { timeout: 10 * 60 * 1000 }), 'gcloud services enable');
  record('gcloud.services.enable', id, { services });
  return result;
}

function gcloudServiceAccountCreate({ projectId: id, serviceAccountId: rawAccountId, displayName = '' }) {
  assertActive('gcloud.serviceAccount.create');
  requireCommand(gcloudAvailable, 'gcloud');
  const project = projectId(id); const account = validateServiceAccountId(rawAccountId);
  const args = ['iam', 'service-accounts', 'create', account, '--project', project];
  if (displayName) args.push('--display-name', String(displayName));
  const result = resultOrThrow(run('gcloud', args, { timeout: 10 * 60 * 1000 }), 'gcloud iam service-accounts create');
  const email = serviceAccountEmail(project, account);
  record('gcloud.serviceAccount.create', email, { projectId: project, displayName });
  return { ...result, serviceAccountEmail: email };
}

function gcloudServiceAccountKeyToVault({ projectId: id, serviceAccountId: rawAccountId, vaultKey = 'gcp_service_account_key' }) {
  assertActive('gcloud.serviceAccount.keyToVault');
  requireCommand(gcloudAvailable, 'gcloud');
  const project = projectId(id); const email = serviceAccountEmail(project, rawAccountId);
  if (!/^[A-Za-z0-9_.-]+$/.test(vaultKey)) throw new Error('vaultKey is invalid.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-gcp-key-'));
  const keyFile = path.join(temporary, 'key.json');
  try {
    const result = resultOrThrow(run('gcloud', ['iam', 'service-accounts', 'keys', 'create', keyFile, '--iam-account', email, '--project', project], { timeout: 10 * 60 * 1000 }), 'gcloud iam service-accounts keys create');
    const keyJson = fs.readFileSync(keyFile, 'utf8');
    JSON.parse(keyJson);
    setSecret(vaultKey, keyJson);
    record('gcloud.serviceAccount.keyToVault', email, { projectId: project, vaultKey });
    return { command: result.command, status: result.status, serviceAccountEmail: email, vaultKey, stored: true };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function terraformInit({ cwd = ROOT, upgrade = false }) {
  assertActive('terraform.init');
  requireCommand(terraformAvailable, 'terraform');
  const target = directory(cwd);
  const result = resultOrThrow(run('terraform', ['init', ...(upgrade ? ['-upgrade'] : []), '-input=false'], { cwd: target, timeout: 15 * 60 * 1000 }), 'terraform init');
  record('terraform.init', target, { upgrade });
  return result;
}

function terraformValidate({ cwd = ROOT }) {
  assertActive('terraform.validate', { outward: false });
  requireCommand(terraformAvailable, 'terraform');
  const target = directory(cwd);
  const result = resultOrThrow(run('terraform', ['validate', '-no-color'], { cwd: target, timeout: 5 * 60 * 1000 }), 'terraform validate');
  record('terraform.validate', target, { valid: true });
  return result;
}

function terraformPlan({ cwd = ROOT, planFile = 'toolsenabled.tfplan' }) {
  assertActive('terraform.plan');
  requireCommand(terraformAvailable, 'terraform');
  const target = directory(cwd);
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(planFile)) throw new Error('planFile must be a simple filename.');
  const result = resultOrThrow(run('terraform', ['plan', '-input=false', `-out=${planFile}`], { cwd: target, timeout: 15 * 60 * 1000 }), 'terraform plan');
  record('terraform.plan', target, { planFile });
  return { ...result, planPath: path.join(target, planFile) };
}

function terraformApply({ cwd = ROOT, planFile = 'toolsenabled.tfplan' }) {
  assertActive('terraform.apply');
  requireCommand(terraformAvailable, 'terraform');
  const target = directory(cwd);
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(planFile)) throw new Error('planFile must be a simple filename.');
  const fullPlan = path.join(target, planFile);
  if (!fs.existsSync(fullPlan)) {
    throw Object.assign(new Error(`Terraform plan does not exist: ${fullPlan}. Run terraform.plan first.`), {
      code: 'TERRAFORM_PLAN_REQUIRED'
    });
  }
  const result = resultOrThrow(run('terraform', ['apply', '-input=false', '-auto-approve', planFile], { cwd: target, timeout: 30 * 60 * 1000 }), 'terraform apply');
  record('terraform.apply', target, { planFile });
  return result;
}

module.exports = {
  doctor,
  gcloudAccountInspect,
  gcloudProjectCreate,
  gcloudEnableServices,
  gcloudServiceAccountCreate,
  gcloudServiceAccountKeyToVault,
  terraformInit,
  terraformValidate,
  terraformPlan,
  terraformApply,
  _testing: {
    GCLOUD_INSPECT_MAX_PROJECTS,
    GCLOUD_INSPECT_MAX_STDOUT_BYTES,
    GCLOUD_INSPECT_TOTAL_TIMEOUT_MS,
    resolveSelectedAccount
  }
};
