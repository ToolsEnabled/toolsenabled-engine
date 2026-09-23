'use strict';

// Standalone browser-session refresher for the BROWSER FALLBACK path (sites with
// no API). Re-establishes the UCR CAS + Google SSO session in the SAME persistent
// Chrome profile the ToolsEnabled Playwright MCP uses, filling NetID + password
// from the DPAPI vault so no secret ever appears in an agent transcript.
//
// Prerequisite (one-time):  npm i playwright   (installs the driver + Chromium)
// Run it only when the MCP browser is NOT running (they share one profile lock):
//   node tools/ucr-login.js
//
// It prefers the enrolled Duo Desktop authenticator when UCR issues a live
// challenge. The normal route leaves its provider-owned confirmation to the
// owner; the separate exact-owner-requested route can invoke only the one
// visible signed Duo Desktop Approve control for the matching live UCR flow.
// Remembered-device and phone/manual choices remain available as fallbacks.
//
// NOTE: the primary, recommended path for Drive/Gmail/Calendar is the OAuth API
// (tools/google-oauth-login.js) which needs no browser and never re-prompts MFA.
// This script is only for authenticated sites that expose no API.

const path = require('path');
const { getSecret, withCredentialPrompt } = require('../src/lib/runtime');
const { ensureUcrGoogleSession } = require('../src/lib/ucr-sso');
const desktop = require('../src/lib/desktop');
const duoRelay = require('../src/lib/duo-owner-relay');
const duoApproval = require('../src/lib/providers/duo-desktop-approval');
// R1162 seccouncil Stage 1b item 3: this CLI never called policy.assertActive
// anywhere in its call chain (it, ensureUcrGoogleSession, desktop.notify, and
// the Duo relay/approval helpers all skip it), so an active KILLSWITCH did
// not stop it from prompting for the vault password, launching a real
// browser, and driving a live Duo approval flow. Route it through the same
// real, mediated policy path every other first-party provider uses.
const { assertActive } = require('../src/lib/policy');

const PROFILE_DIR = process.env.TOOLSENABLED_BROWSER_PROFILE_PATH
  || path.join(__dirname, '..', 'profiles', 'chrome');

const UCR_CREDENTIAL_REQUEST = Object.freeze({
  requester: 'toolsenabled',
  requestContext: Object.freeze({
    purpose: 'Start the owner-requested UCR browser sign-in',
    scope: 'UCR CAS and Google SSO in the ToolsEnabled browser profile',
    lifetime: 'Until owner replacement or UCR account change'
  })
});

function timeoutMs() {
  const configured = process.env.TOOLSENABLED_UCR_LOGIN_TIMEOUT_MS;
  if (configured === undefined) return 180000;
  if (!/^\d+$/.test(configured)) throw new Error('TOOLSENABLED_UCR_LOGIN_TIMEOUT_MS is invalid.');
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 60000 || parsed > 900000) {
    throw new Error('TOOLSENABLED_UCR_LOGIN_TIMEOUT_MS must be from 60000 through 900000.');
  }
  return parsed;
}

async function main() {
  // Fail fast, before touching the vault or a browser, if the kill switch is
  // active or policy mode is not autonomous. No provider option is passed:
  // this is a browser-automation fallback, not one of policy.json's named API
  // providers, so only the kill-switch/mode gate applies (matches the actual
  // exposure — a live browser session and Duo approval, not a provider call).
  assertActive('ucr.login');

  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch {
    console.error('Playwright is not installed. Run once:  npm i playwright');
    process.exit(2);
  }
  // Resolve both owner-only fields before opening the browser. Exactly one
  // missing field can be queued per run; rerunning after completion advances
  // to the next field without an unattributed prompt from the exported SSO
  // helper itself.
  try {
    for (const key of ['ucr_netid', 'ucr_password']) {
      withCredentialPrompt(
        () => getSecret(key, { prompt: true }),
        UCR_CREDENTIAL_REQUEST
      );
    }
  }
  catch (error) { console.error(`UCR credential setup stopped: ${error.message}`); process.exit(2); }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', headless: false });
  try {
    const page = context.pages()[0] || await context.newPage();
    // The fixed provider sets this only for an explicit exact handoff. This
    // helper has no command-line approval switch or general approval route.
    const exactAgentApproval = process.env.TOOLSENABLED_DUO_AUTO_APPROVE_EXACT === '1';
    const result = await withCredentialPrompt(() => ensureUcrGoogleSession(page, {
      timeoutMs: timeoutMs(),
      preferDuoDesktop: true,
      // Two notifications, on purpose, and they are not duplicates: the
      // desktop toast is for when he is at this machine (where the Duo Desktop
      // approval happens), and the owner-delivery notice is the remote half.
      //
      // `code` is a verified-push number genuinely read off the live Duo page,
      // or null. It is passed straight through to the relay and is never
      // printed, logged, or written to the result below.
      onDuoDesktopPrompt: async ({ code = null, route = 'duo_desktop' } = {}) => {
        let approval = { status: 'not_requested', invoked: false };
        if (exactAgentApproval && route === 'duo_desktop') {
          // A failed probe cannot establish that the provider control was not
          // invoked. Refuse the handoff rather than collapsing that uncertainty
          // into `invoked: false` and continuing down the ordinary relay path.
          approval = await duoApproval.approveExactPendingPrompt({ timeoutMs: 20_000 });
          if (approval.status === 'unavailable') {
            throw new Error('Duo Desktop approval status could not be established.');
          }
        }
        desktop.notify({
          title: 'UCR sign-in — Duo',
          message: approval.invoked
            ? 'ToolsEnabled invoked the exact Duo Desktop Approve control for this UCR sign-in. It will resume only if the provider accepts the handoff.'
            : code
            ? 'Duo sent a verification number to your phone; it was relayed to you over the configured owner-delivery channel.'
            : 'Duo Desktop is waiting for its provider-owned Windows confirmation. Complete that prompt; ToolsEnabled will resume automatically.',
          durationSeconds: 15
        });
        desktop.soundPlay({ sound: 'generic-ramp' });
        // An exact visible provider button was already invoked for the
        // owner-requested handoff, so no remote owner action is needed. Do
        // not send an unnecessary owner notice; all other outcomes retain
        // the ordinary safe relay path.
        const relay = approval.invoked
          ? { relayed: 'not_needed', channel: null, delivered: true, failureCode: null }
          : await duoRelay.notifyOwnerOfDuoPrompt({ code, route });
        const approvalOutcome = approval.invoked ? 'invoked' : 'not_invoked';
        // Report only WHETHER a code was relayed and whether delivery worked.
        console.error(`duo relay: ${relay.relayed} via ${relay.channel || 'unresolved'} — ${relay.delivered ? 'delivered' : `NOT delivered (${relay.failureCode})`}`);
        return { approval: approvalOutcome };
      }
    }), UCR_CREDENTIAL_REQUEST);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await context.close();
  }
}

main().catch(e => { console.error('Login error:', e.message); process.exit(1); });
