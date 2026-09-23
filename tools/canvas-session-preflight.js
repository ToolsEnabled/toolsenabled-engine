#!/usr/bin/env node
'use strict';

// Canvas / Duo session preflight for the ToolsEnabled-owned browser.
//
// The problem this solves: an agent only discovers the SSO session has lapsed
// at the moment it tries to submit something, which is the worst possible time
// -- mid-upload, often against a deadline, and it costs the owner an
// interactive Duo push right then. This checks session health CHEAPLY and
// AHEAD OF TIME, so a lapse is known before work starts rather than during it.
//
// Deliberate non-goals, and they are security boundaries, not laziness:
//   * It NEVER reads, prints, exports, or stores a cookie VALUE. It reports
//     presence, domain, and expiry only. A remembered-device cookie is a
//     bearer credential; this tool must remain useless to anyone who reads
//     its output or its logs.
//   * It does NOT bypass, replay, pre-answer, or automate a Duo prompt. MFA
//     is an anti-abuse control and the owner answers it. What this reduces is
//     the number of times he is ASKED, by making sure a still-valid session is
//     actually used and by surfacing an impending expiry while there is still
//     time to act deliberately.
//   * It does not clone the profile or open a second browser -- it attaches to
//     the single owned generation ToolsEnabled already tracks.

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_CDP = 'http://127.0.0.1:46911';
const CANVAS_HOST = 'https://elearn.ucr.edu';
// Duo's remembered-device state lives on these; presence + expiry is all we look at.
const DUO_DOMAINS = ['duosecurity.com', 'duo.com'];

function loadPlaywright() {
  const root = path.resolve(__dirname, '..');
  return require(path.join(root, 'node_modules', 'playwright-core'));
}

async function preflight({ cdpEndpoint = DEFAULT_CDP, canvasHost = CANVAS_HOST } = {}) {
  const playwrightPath = path.resolve(__dirname, '..', 'node_modules', 'playwright-core');
  if (!fs.existsSync(playwrightPath)) {
    return {
      ok: false,
      state: 'dependency-unavailable',
      reason: 'The required playwright-core dependency is not installed. Install product dependencies before checking the browser session.'
    };
  }
  const { chromium } = loadPlaywright();
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpEndpoint);
  } catch (error) {
    return {
      ok: false,
      state: 'browser-unavailable',
      reason: 'No owned browser is reachable at its CDP endpoint. Start one with browser.start before relying on an authenticated session.',
      cdpEndpoint
    };
  }
  try {
    const context = browser.contexts()[0];
    if (!context) return { ok: false, state: 'no-context', reason: 'The owned browser has no browser context.' };

    const nowSec = Math.floor(Date.now() / 1000);
    const cookies = await context.cookies();

    // Presence and expiry only. Values are never touched.
    const duo = cookies
      .filter(c => DUO_DOMAINS.some(d => (c.domain || '').includes(d)))
      .map(c => ({
        domain: c.domain,
        name: c.name,
        expiresAtSec: c.expires && c.expires > 0 ? Math.floor(c.expires) : null,
        daysRemaining: c.expires && c.expires > 0 ? Math.round(((c.expires - nowSec) / 86400) * 10) / 10 : null,
        session: !c.expires || c.expires <= 0
      }))
      .sort((a, b) => (b.daysRemaining ?? -1) - (a.daysRemaining ?? -1));

    // The authoritative check is not a cookie -- it is whether Canvas still
    // answers as the signed-in user. A cookie can exist and still be dead.
    let page = context.pages().find(p => p.url().includes(new URL(canvasHost).host));
    let openedPage = false;
    if (!page) { page = await context.newPage(); openedPage = true; }

    let identity;
    try {
      identity = await page.evaluate(async host => {
        const res = await fetch(`${host}/api/v1/users/self`, { credentials: 'include', headers: { Accept: 'application/json' } });
        const text = (await res.text()).replace(/^while\(1\);/, '');
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            return { status: res.status, authenticated: false };
          }
          return { status: res.status, authenticated: null, error: 'canvas-http-failed' };
        }
        try {
          const parsed = JSON.parse(text);
          return { status: res.status, authenticated: true, id: parsed.id, name: parsed.name };
        } catch {
          // A non-JSON response might be a login page, but it might also be a
          // proxy or truncated response. It cannot establish session state.
          return { status: res.status, authenticated: null, error: 'canvas-response-invalid' };
        }
      }, canvasHost);
    } catch (error) {
      identity = { status: null, authenticated: false, error: 'evaluate-failed' };
    } finally {
      if (openedPage) await page.close().catch(() => {});
    }

    if (identity.error) {
      return {
        ok: false,
        state: 'canvas-unavailable',
        reason: 'Canvas could not be reached or checked from the owned browser, so authentication status is unknown.',
        canvas: { host: canvasHost, httpStatus: null }
      };
    }

    const rememberedDevice = duo.reduce((soonest, cookie) => {
      if (cookie.daysRemaining === null || cookie.daysRemaining <= 0) return soonest;
      if (!soonest || cookie.daysRemaining < soonest.daysRemaining) return cookie;
      return soonest;
    }, null);
    const soonestExpiryDays = rememberedDevice ? rememberedDevice.daysRemaining : null;

    return {
      ok: Boolean(identity && identity.authenticated),
      state: identity && identity.authenticated ? 'authenticated' : 'sign-in-required',
      canvas: {
        host: canvasHost,
        httpStatus: identity ? identity.status : null,
        userId: identity && identity.authenticated ? identity.id : null,
        userName: identity && identity.authenticated ? identity.name : null
      },
      duo: {
        cookieCount: duo.length,
        hasRememberedDevice: Boolean(rememberedDevice),
        soonestExpiryDays,
        // names/domains/expiry only -- never values
        cookies: duo
      },
      guidance: identity && identity.authenticated
        ? (rememberedDevice
          ? `Session is live and Duo has a remembered device with about ${soonestExpiryDays} day(s) left. Re-authenticate deliberately before it lapses rather than mid-task.`
          : 'Session is live but Duo has no remembered-device cookie, so the next sign-in will prompt. If UCR policy allows it, tick "Remember me" at the next real prompt to cut future interruptions.')
        : 'Not authenticated. An owner-interactive sign-in (including the Duo prompt) is required before any Canvas work is attempted. Do not start a submission until this reports authenticated.'
    };
  } catch (error) {
    return {
      ok: false,
      state: 'preflight-unavailable',
      reason: 'The owned browser session could not be inspected, so Canvas authentication status is unknown.'
    };
  } finally {
    // Deliberately NOT browser.close(): this Browser came from
    // connectOverCDP, and Playwright's close() clears every context belonging
    // to the OWNED shared browser -- destroying the authenticated Canvas
    // session and the ~400-day Duo remembered-device state that this
    // read-only check exists to protect, and that no agent can recreate.
    // Only the page opened above is ours, and it was already closed. Dropping
    // the reference releases the CDP connection when the process exits.
    browser = null;
  }
}

async function main() {
  const cdpArgIndex = process.argv.indexOf('--cdp');
  const cdpEndpoint = cdpArgIndex > -1 ? process.argv[cdpArgIndex + 1] : DEFAULT_CDP;
  const result = await preflight({ cdpEndpoint });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { preflight, DUO_DOMAINS, DEFAULT_CDP, CANVAS_HOST };
