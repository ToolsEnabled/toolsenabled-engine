'use strict';
// Re-authenticates the dedicated browser profile through UCR CAS + Google SSO
// using vault credentials. This module is designed to run INSIDE the Playwright
// MCP server process (via browser.run_code with tools/ucr-sso-fill.snippet.js)
// so the password travels vault -> this process -> page form field and never
// appears in an agent transcript, tool argument, command line, or log.
//
// Duo MFA is intentionally never exposed as a generic bypass. Normally this
// helper prefers the enrolled Duo Desktop authenticator and waits for the
// provider/Windows owner-presence confirmation. A separately owner-requested,
// exact live proof may invoke only the fixed Duo Desktop Approve control after
// this helper has observed the matching UCR handoff; remembered-device and
// phone/manual choices remain available as fallbacks.
//
// When Duo needs the owner, onDuoDesktopPrompt() lets the caller use its
// configured owner-delivery channel. It is handed { code }, where `code` is a verified
// push / number-matching value ACTUALLY READ off the live Duo page, or null.
// null is the normal case for the Duo Desktop route -- that approval happens
// in Duo's own Windows app and exposes nothing readable -- and the caller must
// say "approve it in Duo Desktop" rather than implying a code is coming. The
// value is passed by argument only: it is never returned, stored, or pushed
// into `steps`, because `steps` is logged.

const { getSecret } = require('./runtime');

const DRIVE_URL = 'https://drive.google.com/drive/my-drive';
const SIGNED_IN_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'mail.google.com']);

// Duo's Universal Prompt renders the verified-push number in a dedicated
// element. Several class/id spellings are in the wild across tenant versions,
// so this tries the known ones and accepts ONLY a short run of digits. A miss
// yields null and the flow degrades to the honest "approve it in Duo Desktop"
// notice -- it never invents, guesses, or reuses a number.
const VERIFICATION_CODE_SELECTORS = Object.freeze([
  '.verification-code',
  '#verification-code',
  '[data-testid="verification-code"]',
  '.push-label .verification-code'
]);
const CODE_RE = /^\d{1,8}$/;

async function readDuoVerificationCode(page, selectors = VERIFICATION_CODE_SELECTORS) {
  let readFailure = null;
  for (const selector of selectors) {
    let text;
    try {
      const locator = page.locator(selector).first();
      if (!(await locator.isVisible())) continue;
      text = await locator.textContent({ timeout: 1000 });
    } catch (error) {
      readFailure ||= error;
      continue;
    }
    const candidate = String(text || '').replace(/\s+/g, '');
    if (CODE_RE.test(candidate)) return candidate;
  }
  if (readFailure) {
    const error = new Error('The Duo verification code could not be read; this is NOT claiming that no code is present.');
    error.code = 'DUO_VERIFICATION_CODE_READ_INDETERMINATE';
    throw error;
  }
  return null;
}

function host(page) {
  return new URL(page.url()).host;
}

function pushStep(steps, step) {
  if (steps[steps.length - 1] === step) return false;
  steps.push(step);
  return true;
}

function credentialReason(error, key) {
  if (error && error.code === 'CREDENTIAL_CAPTURE_CANCELLED') {
    return 'Credential entry was cancelled; the local vault was not changed.';
  }
  if (error && error.code === 'CREDENTIAL_INTERACTION_REQUIRED') {
    return 'An interactive Windows desktop is required to enter the requested credential.';
  }
  if (error && error.code === 'SECRET_NOT_CONFIGURED') {
    return `Vault key '${key}' is unavailable.`;
  }
  return `The vault could not determine whether key '${key}' is available; this is NOT claiming that the credential is absent.`;
}

function credentialFailure(error, key, steps) {
  const knownCode = error && [
    'CREDENTIAL_CAPTURE_CANCELLED',
    'CREDENTIAL_INTERACTION_REQUIRED',
    'SECRET_NOT_CONFIGURED'
  ].includes(error.code);
  return {
    ok: false,
    code: knownCode ? error.code : 'UCR_CREDENTIAL_READ_INDETERMINATE',
    steps,
    reason: credentialReason(error, key)
  };
}

async function visible(locator) {
  return locator.first().isVisible();
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
}

async function ensureUcrGoogleSession(page, {
  timeoutMs = 180000,
  preferDuoDesktop = true,
  onDuoDesktopPrompt,
  getSecretValue = getSecret,
  readVerificationCode = readDuoVerificationCode
} = {}) {
  const steps = [];
  // A code read must never be the thing that breaks a sign-in, but a failed
  // read must not masquerade as proof that the page contains no code.
  const readCode = async target => {
    try { return { code: await readVerificationCode(target) }; }
    catch {
      return {
        code: null,
        errorCode: 'DUO_VERIFICATION_CODE_READ_INDETERMINATE',
        errorReason: 'The Duo verification code could not be read; this is NOT claiming that no code is present.'
      };
    }
  };
  const deadline = Date.now() + timeoutMs;
  let navigatedToDrive = false;
  let duoOptionsOpened = false;
  let duoDesktopSelected = false;
  let duoDesktopPromptNotified = false;
  let netid;
  const notifyDuoDesktopPrompt = async route => {
    if (duoDesktopPromptNotified || typeof onDuoDesktopPrompt !== 'function') return;
    const codeRead = await readCode(page);
    // A successful observation is latched to avoid duplicate owner alerts. An
    // indeterminate read is deliberately retryable on the next provider poll.
    duoDesktopPromptNotified = !codeRead.errorCode;
    const relayCode = codeRead.code;
    if (relayCode !== null) pushStep(steps, 'duo-verification-code-relayed');
    // The callback is owned by tools/ucr-login.js.  It may return only this
    // narrow safe outcome after its internal Duo UIA actuator has observed the
    // exact live provider prompt; arbitrary browser/page data never becomes a
    // step or a result field.
    const outcome = await onDuoDesktopPrompt({ code: relayCode, route, ...codeRead });
    if (outcome && outcome.approval === 'invoked') {
      pushStep(steps, 'duo-desktop-approve-invoked');
    }
  };
  try {
    netid = getSecretValue('ucr_netid', { prompt: false });
  } catch (error) {
    return credentialFailure(error, 'ucr_netid', steps);
  }

  while (Date.now() < deadline) {
    const pageHost = host(page);

    if (SIGNED_IN_HOSTS.has(pageHost)) {
      return { ok: true, url: page.url(), steps };
    }

    if (pageHost === 'accounts.google.com') {
      const idBox = page.getByRole('textbox', { name: 'Email or phone' });
      if (await visible(idBox)) {
        await idBox.fill(`${netid}@ucr.edu`);
        // Google may begin the SAML redirect before its animated "Next"
        // control finishes the pointer action, which makes Playwright report a
        // detached/intercepted click after navigation already succeeded.
        // Submitting from the exact focused identifier field avoids that race.
        await idBox.press('Enter');
        pushStep(steps, 'google-identifier');
        await settle(page);
        continue;
      }
      const accountEntry = page.getByRole('link', { name: new RegExp(`${netid}@ucr\\.edu`) });
      if (await visible(accountEntry)) {
        await accountEntry.first().click();
        pushStep(steps, 'google-account-chooser');
        await settle(page);
        continue;
      }
      const speedbump = page.getByRole('button', { name: 'Continue' });
      if (await visible(speedbump)) {
        await speedbump.click();
        pushStep(steps, 'google-speedbump-continue');
        await settle(page);
        continue;
      }
    }

    if (pageHost === 'auth.ucr.edu') {
      const netBox = page.getByRole('textbox', { name: /UCR NetID/i });
      if (await visible(netBox)) {
        let password;
        try {
          password = getSecretValue('ucr_password', { prompt: false });
        } catch (error) {
          return credentialFailure(error, 'ucr_password', steps);
        }
        await netBox.fill(netid);
        await page.getByRole('textbox', { name: /Password/i }).fill(password);
        await page.getByRole('button', { name: 'Sign In' }).click();
        pushStep(steps, 'cas-signin');
        await settle(page);
        continue;
      }
    }

    if (/duosecurity\.com$/.test(pageHost)) {
      const trustButton = page.getByRole('button', { name: 'Yes, this is my device' });
      if (await visible(trustButton)) {
        await trustButton.click();
        pushStep(steps, 'duo-trust-device');
        await settle(page);
        continue;
      }

      const desktopPending = page.getByText(/Check Duo Desktop for a login request/i);
      if (await visible(desktopPending)) {
        pushStep(steps, 'duo-desktop-authentication-pending-owner-presence');
        await notifyDuoDesktopPrompt('duo_desktop');
        await page.waitForTimeout(1000);
        continue;
      }

      if (preferDuoDesktop && !duoDesktopSelected) {
        const desktopChoice = page.getByRole('button', { name: /Duo Desktop/i });
        if (await visible(desktopChoice)) {
          await desktopChoice.click();
          duoDesktopSelected = true;
          pushStep(steps, 'duo-desktop-selected');
          await settle(page);
          continue;
        }

        if (!duoOptionsOpened) {
          const otherOptions = page.getByRole('link', { name: /Other options/i });
          const otherOptionsButton = page.getByRole('button', { name: /Other options/i });
          const optionsControl = await visible(otherOptions) ? otherOptions : otherOptionsButton;
          if (await visible(optionsControl)) {
            await optionsControl.click();
            duoOptionsOpened = true;
            pushStep(steps, 'duo-other-options-opened');
            await settle(page);
            continue;
          }
        }
      }

      if (duoDesktopSelected) {
        pushStep(steps, 'duo-desktop-authentication-pending-owner-presence');
        await notifyDuoDesktopPrompt('duo_desktop');
        await page.waitForTimeout(1000);
        continue;
      }

      pushStep(steps, preferDuoDesktop
        ? 'duo-desktop-unavailable-fallback-waiting-for-operator'
        : 'duo-challenge-waiting-for-operator');
      // The non-Desktop wait is where a verified-push number is most likely to
      // be on screen, and where the owner is most likely to be away from this
      // machine. Notify once, with a code only if one was really read.
      await notifyDuoDesktopPrompt('duo_other');
      await page.waitForTimeout(3000);
      continue;
    }

    if (!navigatedToDrive) {
      navigatedToDrive = true;
      await page.goto(DRIVE_URL);
      pushStep(steps, 'navigate-drive');
      await settle(page);
      continue;
    }

    await page.waitForTimeout(1000);
  }

  return {
    ok: false,
    url: page.url(),
    steps,
    reason: 'Timed out before reaching Google Drive. If the steps show a Duo waiting state, complete the provider-owned confirmation and retry; the phone/manual route remains available under Other options.'
  };
}

module.exports = { CODE_RE, VERIFICATION_CODE_SELECTORS, ensureUcrGoogleSession, readDuoVerificationCode };
