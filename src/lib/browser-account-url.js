'use strict';

// Google keeps multiple signed-in web identities in one browser profile.  The
// profile's cookie order is not a safe way to choose which identity a brokered
// navigation should use: it can change when a person signs into another Google
// service.  `authuser` is Google's supported per-navigation account selector;
// using it leaves every signed-in account and all session cookies intact.
const ACCOUNT_AWARE_GOOGLE_HOSTS = new Set([
  'accounts.google.com',
  'myaccount.google.com',
  'aistudio.google.com',
  'calendar.google.com',
  'cloud.google.com',
  'console.cloud.google.com',
  'console.firebase.google.com',
  'developers.google.com',
  'docs.google.com',
  'drive.google.com',
  'gemini.google.com',
  'mail.google.com',
  'sheets.google.com',
  'slides.google.com'
]);

function isAccountAwareGoogleUrl(value) {
  const parsed = new URL(value);
  return parsed.protocol === 'https:' && ACCOUNT_AWARE_GOOGLE_HOSTS.has(parsed.hostname.toLowerCase());
}

function applyGoogleAccount(value, email) {
  const parsed = new URL(value);
  if (!isAccountAwareGoogleUrl(parsed.href) || parsed.searchParams.has('authuser')) return parsed.href;
  if (typeof email !== 'string' || !email.includes('@')) throw new Error('A registered Google account email is required.');
  parsed.searchParams.set('authuser', email);
  return parsed.href;
}

module.exports = { ACCOUNT_AWARE_GOOGLE_HOSTS, isAccountAwareGoogleUrl, applyGoogleAccount };
