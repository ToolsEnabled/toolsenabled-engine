'use strict';

// SIGNING IN -- task T9 of docs/design/INSTALLER-EXPERIENCE.md section 7.
//
// This is step 6 of the flow and the design calls it "the irreducible wall": the
// product cannot conjure a paid account for anyone. What it CAN do, and did not
// do before this module existed, is get a person from "I have an account" to "the
// program can use it" without a terminal window, and tell them the truth when it
// cannot.
//
// WHAT THIS DELIBERATELY REFUSES TO BUILD, and it is the most important line in
// the file: there is no Claude.ai username-and-password form here, and there must
// never be one. Anthropic's terms bar a third-party product from taking a
// subscription login (SHIPMENT-PLAN.md finding 0.8, blocker B14). The only Claude
// routes are a key the person pastes, which is theirs and stays on their machine,
// and a deep link that hands them to Claude Code itself. A form that collected
// those credentials would work, would be easy, and would be a terms violation
// shipped under the owner's name.
//
// NOTHING HERE PRINTS A SECRET. A pasted key is validated by SHAPE, stored
// through the existing DPAPI vault, and thereafter referred to by a status word.
// The returned objects are safe to log, to serialise into a setup plan, and to
// show on screen -- which is why `verify()` returns `signedIn: true` and never the
// thing that proves it.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { SetupRefusal } = require('./machine-record');

const PROVIDERS = Object.freeze(['codex', 'claude']);

// Section 2.2: Guided "decides on the user's behalf the provider (Codex, because
// `codex login --device-auth` is the only compliant in-product subscription login
// and the choice is not one she can evaluate)".
const TIER_PROVIDERS = Object.freeze({
  guided: Object.freeze(['codex']),
  standard: Object.freeze(['codex', 'claude']),
  unrestricted: Object.freeze(['codex', 'claude'])
});

const CLAUDE_API_KEY_VAULT_KEY = 'anthropic_api_key';
const CLAUDE_DEEP_LINK = 'https://claude.ai/download';
const CODEX_SIGNUP_URL = 'https://chatgpt.com/';

// A device-authorization user code as OpenAI's CLI prints it. Matched loosely on
// purpose -- the shape is stable, the surrounding prose is not, and a strict
// match on the prose would silently stop finding the code after any CLI update
// and leave the user staring at a blank screen.
const USER_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const VERIFICATION_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/;

function runCommand(command, args, options, runner) {
  const result = runner(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    ...options
  });
  if (result.error) {
    return {
      available: false,
      missing: result.error.code === 'ENOENT',
      status: null,
      stdout: '',
      stderr: '',
      reason: result.error.code || result.error.message
    };
  }
  return {
    available: true,
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : ''
  };
}

function refuseUnmeasured(result, operation) {
  if ((!result.available && !result.missing) || (result.available && !Number.isInteger(result.status))) {
    throw new SetupRefusal(
      'SETUP_PROVIDER_PROBE_FAILED',
      `Setup could not establish ${operation}.`,
      { operation, reason: result.reason || 'the command ended without an exit status' }
    );
  }
}

function refuseFailedProbe(result, operation) {
  refuseUnmeasured(result, operation);
  if (result.available && result.status !== 0) {
    throw new SetupRefusal(
      'SETUP_PROVIDER_PROBE_FAILED',
      `Setup could not establish ${operation}.`,
      { operation, reason: `the probe exited with status ${result.status}` }
    );
  }
}

/**
 * Is the agent command line on this computer at all?
 *
 * A missing CLI and a signed-out CLI are DIFFERENT facts with different repairs,
 * and collapsing them is how a person ends up trying to sign in to a program they
 * have not installed.
 */
function probeProvider(provider, { runner = spawnSync, env = process.env } = {}) {
  if (!PROVIDERS.includes(provider)) {
    throw new SetupRefusal('SETUP_PROVIDER_UNKNOWN', `${provider} is not a provider this setup knows about.`, { provider });
  }
  if (provider === 'claude') {
    const present = runCommand('claude', ['--version'], { env }, runner);
    refuseFailedProbe(present, 'whether the Claude assistant program is installed');
    const configuredKey = typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim() !== '';
    return Object.freeze({
      provider,
      installed: present.available && present.status === 0,
      signedIn: configuredKey,
      // Deliberately not "no key found" -- a signed-in Claude Code session is a
      // perfectly good state this probe cannot see, and reporting its absence as
      // a fault would be a false negative shown to the user.
      detail: configuredKey ? 'a key is configured for this computer' : 'no key is configured on this computer yet'
    });
  }
  const present = runCommand('codex', ['--version'], { env }, runner);
  refuseFailedProbe(present, 'whether the Codex assistant program is installed');
  if (present.missing) {
    return Object.freeze({ provider, installed: false, signedIn: false, detail: 'the assistant program is not on this computer yet' });
  }
  const status = runCommand('codex', ['login', 'status'], { env }, runner);
  refuseUnmeasured(status, 'whether Codex is signed in');
  return Object.freeze({
    provider,
    installed: true,
    signedIn: status.available && status.status === 0,
    detail: status.available && status.status === 0 ? 'already signed in on this computer' : 'not signed in yet'
  });
}

function providersForTier(tier) {
  const allowed = TIER_PROVIDERS[tier];
  if (!allowed) throw new SetupRefusal('SETUP_TIER_UNKNOWN', `${tier} is not a tier this setup knows about.`, { tier });
  return allowed;
}

/**
 * Start the device-authorization sign-in and return the code to put on screen.
 *
 * The person reads a short code here and types it into a browser they already
 * trust. No password crosses this program, which is the property that makes this
 * the only compliant in-product subscription login of the two.
 *
 * Returns `{ started: false, ... }` rather than throwing when Codex is absent or
 * refuses: a sign-in that cannot start is an ordinary situation with a next step,
 * and section 5 requires it be reported as such.
 */
function startCodexDeviceLogin({ runner = spawnSync, env = process.env, timeoutMs = 20_000 } = {}) {
  const present = runCommand('codex', ['--version'], { env }, runner);
  refuseFailedProbe(present, 'whether the Codex assistant program is installed');
  if (present.missing) {
    return Object.freeze({
      started: false,
      code: 'SETUP_PROVIDER_CLI_MISSING',
      message: 'The assistant program is not on this computer yet. Setup will get it before you sign in.',
      signupUrl: CODEX_SIGNUP_URL
    });
  }
  const attempt = runCommand('codex', ['login', '--device-auth'], { env, timeout: timeoutMs }, runner);
  const text = `${attempt.stdout}\n${attempt.stderr}`;
  const codeMatch = USER_CODE_PATTERN.exec(text);
  const urlMatch = VERIFICATION_URL_PATTERN.exec(text);
  if (!codeMatch) {
    return Object.freeze({
      started: false,
      code: 'SETUP_PROVIDER_CODE_NOT_SHOWN',
      message: 'Signing in could not be started on this computer. You can sign in from the assistant program directly and come back.',
      signupUrl: CODEX_SIGNUP_URL
    });
  }
  return Object.freeze({
    started: true,
    userCode: codeMatch[1],
    verificationUrl: urlMatch ? urlMatch[0] : null,
    message: 'Open the page shown and enter this code. Come back here when the page says you are signed in.'
  });
}

/**
 * Did the sign-in actually take? Verified by asking, never by assuming, which is
 * the whole point of T9's test: "with a signed-in one, verification returns true
 * without prompting".
 */
function verifyCodexSignIn({ runner = spawnSync, env = process.env } = {}) {
  const status = runCommand('codex', ['login', 'status'], { env }, runner);
  refuseUnmeasured(status, 'whether Codex is signed in');
  if (status.missing) {
    return Object.freeze({ signedIn: false, reason: 'the assistant program is not on this computer yet' });
  }
  return status.status === 0
    ? Object.freeze({ signedIn: true })
    : Object.freeze({ signedIn: false, reason: 'not signed in yet' });
}

// --- the Claude routes, neither of which is a login form ---------------------

/**
 * Shape-check a pasted key WITHOUT contacting anyone and without echoing it.
 * A key is rejected for its shape only; whether it works is a question for the
 * first turn, not for a setup screen that would have to send it somewhere to ask.
 */
function checkClaudeApiKeyShape(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, code: 'SETUP_CLAUDE_KEY_MISSING', message: 'Paste the key from your Anthropic account.' };
  }
  const value = candidate.trim();
  if (/\s/.test(value)) {
    return { ok: false, code: 'SETUP_CLAUDE_KEY_MALFORMED', message: 'That does not look like a key -- it contains spaces. Copy it again.' };
  }
  if (!value.startsWith('sk-ant-') || value.length < 24) {
    return { ok: false, code: 'SETUP_CLAUDE_KEY_MALFORMED', message: 'That does not look like an Anthropic key. They begin with sk-ant-.' };
  }
  return { ok: true };
}

/**
 * Store a pasted key in the vault this installation already uses.
 *
 * The value is passed straight to the DPAPI-backed store and is never returned,
 * logged, or included in any object this module hands back.
 */
function storeClaudeApiKey(candidate, { setSecret = null } = {}) {
  const shape = checkClaudeApiKeyShape(candidate);
  if (!shape.ok) throw new SetupRefusal(shape.code, shape.message);
  // Required lazily: loading the runtime opens the vault, which a caller only
  // doing shape validation has no reason to touch.
  const writer = typeof setSecret === 'function' ? setSecret : require('../runtime').setSecret;
  writer(CLAUDE_API_KEY_VAULT_KEY, candidate.trim());
  return Object.freeze({ stored: true, vaultKey: CLAUDE_API_KEY_VAULT_KEY });
}

/**
 * The deep-link route: hand the person to Claude Code itself rather than asking
 * them for a password we are not allowed to receive.
 */
function claudeHandoff() {
  return Object.freeze({
    route: 'deep-link',
    url: CLAUDE_DEEP_LINK,
    message: 'Sign in inside the Claude CLI itself, then come back here. This program never asks for that password.'
  });
}

/**
 * What a setup screen should show for a tier, resolved from what is actually on
 * this computer. Safe to serialise: contains no secret and no personal data.
 */
function providerOptionsForTier(tier, { runner = spawnSync, env = process.env } = {}) {
  const allowed = providersForTier(tier);
  const options = allowed.map(provider => probeProvider(provider, { runner, env }));
  const routes = [];
  for (const option of options) {
    if (option.provider === 'codex') routes.push({ provider: 'codex', route: 'device-code', signedIn: option.signedIn });
    if (option.provider === 'claude') {
      routes.push({ provider: 'claude', route: 'paste-key', signedIn: option.signedIn });
      routes.push({ provider: 'claude', route: 'deep-link', signedIn: option.signedIn });
    }
  }
  return Object.freeze({
    tier,
    providers: Object.freeze(options),
    routes: Object.freeze(routes),
    anySignedIn: options.some(option => option.signedIn === true)
  });
}

// The helper handoff of step 6b: a resumable code so a third party can complete
// the account step. The code carries the CHOICES made so far and never a
// credential, so it is safe to send to whoever is helping.
function helperHandoffCode({ tier, workspace, random = null }) {
  const bytes = random || require('node:crypto').randomBytes(5);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return Object.freeze({
    code: `TE-${code.slice(0, 5)}`,
    resumes: Object.freeze({ tier, workspaceLeaf: typeof workspace === 'string' ? path.basename(workspace) : null }),
    carriesCredential: false
  });
}

module.exports = Object.freeze({
  PROVIDERS,
  TIER_PROVIDERS,
  CLAUDE_API_KEY_VAULT_KEY,
  CLAUDE_DEEP_LINK,
  CODEX_SIGNUP_URL,
  probeProvider,
  providersForTier,
  providerOptionsForTier,
  startCodexDeviceLogin,
  verifyCodexSignIn,
  checkClaudeApiKeyShape,
  storeClaudeApiKey,
  claudeHandoff,
  helperHandoffCode
});
