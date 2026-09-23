'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolvePaddleEnvironment } = require('../paddle-environment');

const CONSUMER_RE = /\b(?:[A-Za-z_$][\w$]*\.)?(?:getSecret|secretExists|getOrCreateSecret)\s*\(/;
const EXCLUDED_CONSUMERS = Object.freeze({
  // The retired telegram bridge no longer has a secret consumer to exclude.
  // The file was deleted with the connector, so there is no longer a
  // getSecret consumer to exclude. Removed rather than left: this map is scanned
  // against real files, and an entry naming a file that does not exist is an
  // exclusion that can never be reviewed.
  'providers/agent-comms.js': 'DEFERRED_PROGRAM_PHASE_7'
});

const BASE_REQUIREMENTS = Object.freeze([
  {
    id: 'fal-video', label: 'Seedance video generation (fal)', criticality: 'conditional',
    alternatives: [['fal_api_key']], sources: ['providers/video.js']
  },
  {
    id: 'instagram', label: 'Instagram', criticality: 'required',
    alternatives: [['ig_access_token', 'ig_user_id']],
    sources: ['providers/instagram.js']
  },
  {
    id: 'chrome-web-store', label: 'Chrome Web Store', criticality: 'required',
    alternatives: [
      ['cws_access_token', 'cws_publisher_id'],
      ['cws_refresh_token', 'cws_client_id', 'cws_client_secret', 'cws_publisher_id']
    ],
    sources: ['providers/chrome-web-store.js', 'providers/chrome-web-store-oauth.js']
  },
  {
    id: 'google-default', label: 'Google default account', criticality: 'required',
    alternatives: [
      ['google_access_token'],
      ['google_refresh_token', 'google_client_id', 'google_client_secret']
    ],
    sources: ['google-oauth.js', 'google-accounts.js']
  },
  {
    id: 'github', label: 'GitHub', criticality: 'required',
    alternatives: [['github_pat']], sources: ['providers/github.js']
  },
  {
    id: 'stripe', label: 'Stripe', criticality: 'required',
    alternatives: [['stripe_restricted_key'], ['stripe_secret_key']],
    sources: ['providers/stripe.js', 'providers/billing.js']
  },
  {
    // WHICH PAIR IS REQUIRED DEPENDS ON THE RECORDED ENVIRONMENT, so the pair
    // below is only the fail-closed starting point; requirements() replaces it.
    // Declaring both pairs instead would tell every sandbox installation it was
    // missing two live credentials it must never hold, and a requirement that
    // is always unmet is a requirement nobody reads.
    id: 'paddle', label: 'Paddle (sandbox)', criticality: 'required',
    alternatives: [['paddle_sandbox_api_key', 'paddle_sandbox_webhook_secret']],
    sources: ['providers/paddle.js', 'paddle-environment.js']
  },
  {
    id: 'vercel', label: 'Vercel', criticality: 'conditional',
    alternatives: [['vercel_token']], sources: ['providers/deployment.js']
  },
  {
    id: 'cloudflare', label: 'Cloudflare', criticality: 'conditional',
    alternatives: [['cloudflare_api_token', 'cloudflare_account_id']], sources: ['providers/deployment.js']
  },
  {
    id: 'tavily', label: 'Tavily web search', criticality: 'conditional',
    alternatives: [['tavily_api_key']], sources: ['providers/web.js']
  },
  {
    id: 'ucr-browser-helper', label: 'UCR browser helper', criticality: 'conditional',
    alternatives: [['ucr_netid', 'ucr_password']], sources: ['ucr-sso.js']
  },
  {
    id: 'internal-audit', label: 'Audit signing', criticality: 'self-managed',
    alternatives: [['toolsenabled_audit_signing_key_v1', 'toolsenabled_audit_head_v1']], sources: ['audit.js']
  },
  {
    id: 'internal-license', label: 'License signing', criticality: 'self-managed',
    alternatives: [['toolsenabled_license_signing_key_v1']], sources: ['providers/license.js']
  },
  {
    id: 'internal-sandbox', label: 'Sandbox profile encryption', criticality: 'self-managed',
    alternatives: [['sandbox_auth_profile_encryption_key_v1']], sources: ['providers/agent-sandbox.js']
  },
  {
    /* THIS MACHINE'S OWN CONNECTIVITY IDENTITY. Self-managed like the audit and
     * licence keys above: nothing provisions these and no interactive prompt asks for
     * them. The Ed25519 identity is minted on first use and its private half
     * never leaves this machine -- which is the property that lets a compromise
     * of the account database RECOGNISE a machine and never impersonate it to
     * its peer. The credential is what a claimed machine collects at the end of
     * the claim flow: its device row, its certificate, and its own standing at
     * the account API. Both are absent on a machine that has never connected,
     * and that absence IS the "not connected" state rather than an error. */
    id: 'online-fra-device', label: 'Connectivity device identity', criticality: 'self-managed',
    alternatives: [['custom.online_fra_device_identity_v1', 'custom.online_fra_device_credential_v1']],
    sources: ['online-fra-device-identity.js', 'online-fra-device-claim.js', 'online-fra-relay-shell.js']
  },
  {
    id: 'payment-method', label: 'Default payment method', criticality: 'conditional',
    alternatives: [['payment_card_default']], sources: ['tool-registry.js']
  },
  {
    id: 'http-vault-bindings', label: 'Policy-bound HTTP credentials', criticality: 'dynamic',
    alternatives: [], sources: ['providers/http-request.js']
  }
]);

function listJavaScriptFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  }
  visit(root);
  return files;
}

function relativeSource(libRoot, file) { return path.relative(libRoot, file).replace(/\\/g, '/'); }

function discoverConsumerFiles(libRoot) {
  return listJavaScriptFiles(libRoot)
    .filter(file => relativeSource(libRoot, file) !== 'runtime.js')
    .filter(file => {
      const executableText = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return CONSUMER_RE.test(executableText);
    })
    .map(file => relativeSource(libRoot, file))
    .sort();
}

function googleAccountRequirements(inventoryNames) {
  const aliases = new Set();
  for (const name of inventoryNames || []) {
    const match = /^google_(?:access_token|refresh_token|client_id|client_secret)__([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(name);
    if (match) aliases.add(match[1]);
  }
  return [...aliases].sort().map(alias => ({
    id: `google-account:${alias}`,
    label: `Google account ${alias}`,
    criticality: 'conditional',
    alternatives: [
      [`google_access_token__${alias}`],
      [`google_refresh_token__${alias}`, `google_client_id__${alias}`, `google_client_secret__${alias}`]
    ],
    sources: ['google-oauth.js', 'google-accounts.js'],
    dynamic: true
  }));
}

function httpPolicyRequirements(root) {
  const policyPath = path.join(root, 'config', 'toolsenabled.policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const bindings = policy && policy.http && policy.http.vaultKeys;
  if (bindings === undefined) return [];
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError(`Invalid http.vaultKeys in ${policyPath}: expected an object`);
  }
  const keys = Object.entries(bindings).map(([name, binding]) => {
    const key = binding && binding.vaultKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new TypeError(`Invalid http.vaultKeys.${name}.vaultKey in ${policyPath}`);
    }
    return key;
  });
  return [...new Set(keys)].sort();
}

function requirements(root, inventoryNames = []) {
  const all = BASE_REQUIREMENTS.map(item => ({
    ...item,
    alternatives: item.alternatives.map(group => [...group]),
    sources: [...item.sources]
  }));
  const dynamicHttp = all.find(item => item.id === 'http-vault-bindings');
  const httpKeys = httpPolicyRequirements(root);
  dynamicHttp.alternatives = httpKeys.length ? [httpKeys] : [];

  // THE PADDLE REQUIREMENT FOLLOWS THE RECORDED ENVIRONMENT, resolved from the
  // same `root` the rest of this function reads, so a doctor run against a
  // temporary tree reports that tree's choice rather than this machine's. The
  // label carries the environment because "Paddle: missing" is unactionable
  // when there are two accounts it could mean.
  const paddleProfile = resolvePaddleEnvironment({ root }).profile;
  const paddle = all.find(item => item.id === 'paddle');
  paddle.label = `Paddle (${paddleProfile.environment})`;
  paddle.alternatives = [[paddleProfile.apiVaultKey, paddleProfile.webhookVaultKey]];
  return [...all, ...googleAccountRequirements(inventoryNames)];
}

function validate(root, integrations) {
  const libRoot = path.join(root, 'src', 'lib');
  const errors = [];
  const covered = new Set();
  for (const integration of integrations) {
    for (const relative of integration.sources) covered.add(relative);
    for (const relative of integration.sources) {
      if (!fs.existsSync(path.join(libRoot, relative))) {
        errors.push({ code: 'SECRET_REQUIREMENT_SOURCE_MISSING', integration: integration.id, source: relative });
      }
    }
    if (integration.dynamic) continue;
    const sourceText = integration.sources
      .filter(relative => fs.existsSync(path.join(libRoot, relative)))
      .map(relative => fs.readFileSync(path.join(libRoot, relative), 'utf8'))
      .join('\n');
    for (const key of new Set(integration.alternatives.flat())) {
      if (!sourceText.includes(key)) {
        errors.push({ code: 'SECRET_REQUIREMENT_KEY_UNPROVEN', integration: integration.id, name: key });
      }
    }
  }
  const exclusions = [];
  for (const relative of discoverConsumerFiles(libRoot)) {
    if (covered.has(relative)) continue;
    if (EXCLUDED_CONSUMERS[relative]) {
      exclusions.push({ source: relative, code: EXCLUDED_CONSUMERS[relative] });
    } else {
      errors.push({ code: 'SECRET_REQUIREMENTS_UNMAPPED', source: relative });
    }
  }
  return { errors, exclusions, consumerFiles: discoverConsumerFiles(libRoot) };
}

module.exports = { BASE_REQUIREMENTS, EXCLUDED_CONSUMERS, discoverConsumerFiles, requirements, validate };
