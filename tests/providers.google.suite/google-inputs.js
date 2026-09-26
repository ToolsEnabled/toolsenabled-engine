'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const google = require('../../src/lib/providers/google');
const googleAccounts = require('../../src/lib/google-accounts');
const { readJson } = require('../../src/lib/runtime');

async function rejectsBeforeAuthentication(call, pattern) {
  await assert.rejects(call, error => {
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /Secret 'google_|OAuth|HTTP /);
    return true;
  });
}

(async () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'google-input-profile-'));
  try {
    const profilePath = path.join(profileRoot, 'config', 'google-accounts.profile.json');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, `${JSON.stringify({
      defaultAccount: 'fixture-default',
      cwsLoginAccount: 'fixture-default',
      duoAccount: 'fixture-duo',
      accounts: {
        'fixture-default': { email: 'default@example.test', label: 'Fixture default' },
        'fixture-duo': { email: 'duo@example.test', label: 'Fixture Duo' }
      }
    }, null, 2)}\n`, 'utf8');
    const profile = readJson(profilePath, null);
    assert.deepEqual(googleAccounts.validateCwsLoginConfig(profile), {
      alias: 'fixture-default', email: 'default@example.test'
    });
    assert.deepEqual(googleAccounts.validateDuoAccountConfig(profile), {
      alias: 'fixture-duo', email: 'duo@example.test'
    });
    assert.throws(() => googleAccounts.validateDuoAccountConfig({
      ...profile,
      accounts: { ...profile.accounts, 'fixture-duo': { email: 'not-an-email' } }
    }), /not registered with a valid email/);

    const malformedProfilePath = path.join(profileRoot, 'config', 'malformed-google-accounts.profile.json');
    fs.writeFileSync(malformedProfilePath, '{"accounts":', 'utf8');
    assert.throws(() => readJson(malformedProfilePath, {}), /Unable to read JSON/,
      'a present malformed Google profile must not be treated as an empty account roster');
  } finally {
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }

  const gmailBase = { to: 'one@example.com, two@example.org', subject: 'Status', text: 'Body' };
  // Rich agent-digest mail is still a safe multipart/alternative message: the
  // complete text part remains present, the HTML part is isolated by a random
  // boundary, and both bodies are encoded as UTF-8.
  const richRaw = google.buildMimeEmail({
    ...gmailBase,
    html: '<!doctype html><html><body><strong>Metric</strong></body></html>'
  });
  const richMessage = Buffer.from(richRaw, 'base64url').toString('utf8');
  assert.match(richMessage, /Content-Type: multipart\/alternative; boundary="=_toolsenabled_[a-f0-9]+"/);
  assert.match(richMessage, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(richMessage, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(richMessage, /\r\nBody\r\n/);
  assert.match(richMessage, /<strong>Metric<\/strong>/);
  const plainRaw = google.buildMimeEmail(gmailBase);
  const plainMessage = Buffer.from(plainRaw, 'base64url').toString('utf8');
  assert.match(plainMessage, /Content-Type: text\/plain; charset=UTF-8/);
  assert.doesNotMatch(plainMessage, /multipart\/alternative/);
  await rejectsBeforeAuthentication(
    () => google.gmailSend({ ...gmailBase, to: 'one@example.com\r\nBcc: attacker@example.com' }),
    /to must not contain CR or LF/
  );
  await rejectsBeforeAuthentication(
    () => google.gmailSend({ ...gmailBase, cc: 'one@example.com\nX-Test: injected' }),
    /cc must not contain CR or LF/
  );
  await rejectsBeforeAuthentication(
    () => google.gmailSend({ ...gmailBase, bcc: 'one@example.com\rX-Test: injected' }),
    /bcc must not contain CR or LF/
  );
  await rejectsBeforeAuthentication(
    () => google.gmailSend({ ...gmailBase, subject: 'Status\r\nBcc: attacker@example.com' }),
    /subject must not contain CR or LF/
  );
  await rejectsBeforeAuthentication(
    () => google.gmailSend({ ...gmailBase, to: 'not-an-address' }),
    /to must be a comma-separated list of basic email addresses/
  );
  await rejectsBeforeAuthentication(
    () => google.gmailSend({ ...gmailBase, cc: 'valid@example.com, bad address@example.com' }),
    /cc must be a comma-separated list of basic email addresses/
  );
  await rejectsBeforeAuthentication(
    () => google.gmailSend({ ...gmailBase, bcc: 'valid@example.com,' }),
    /bcc must be a comma-separated list of basic email addresses/
  );
  await rejectsBeforeAuthentication(
    () => google.gmailSend({ ...gmailBase, subject: '   ' }),
    /subject is required/
  );

  const calendarBase = {
    summary: 'Planning',
    start: '2026-07-21T10:00:00-07:00',
    end: '2026-07-21T11:00:00-07:00',
    attendees: ['one@example.com', 'two@example.org']
  };
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({ ...calendarBase, start: '2026-07-21T10:00:00' }),
    /start must be an RFC3339 timestamp with a timezone/
  );
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({ ...calendarBase, start: '2026-02-30T10:00:00Z' }),
    /start must be a valid RFC3339 timestamp/
  );
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({ ...calendarBase, end: calendarBase.start }),
    /end must be later than start/
  );
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({ ...calendarBase, end: '2026-07-21T09:59:59-07:00' }),
    /end must be later than start/
  );
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({ ...calendarBase, attendees: ['valid@example.com', 'invalid'] }),
    /attendees\[1\] must be a basic email address/
  );
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({ ...calendarBase, attendees: 'one@example.com' }),
    /attendees must be an array of email addresses/
  );
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({ ...calendarBase, attendees: ['one@example.com\r\nX-Test: injected'] }),
    /attendees\[0\] must be a basic email address/
  );

  // Preserve RFC3339 ordering below JavaScript's ordinary millisecond precision.
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({
      ...calendarBase,
      start: '2026-07-21T10:00:00.000000001Z',
      end: '2026-07-21T10:00:00.000000002Z',
      attendees: ['invalid']
    }),
    /attendees\[0\] must be a basic email address/
  );
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({
      ...calendarBase,
      start: '2026-07-21T10:00:00.000000002Z',
      end: '2026-07-21T10:00:00.000000001Z'
    }),
    /end must be later than start/
  );

  await rejectsBeforeAuthentication(
    () => google.calendarList({ timeMin: '2026-07-21T10:00:00', timeMax: '2026-07-21T11:00:00Z' }),
    /timeMin must be an RFC3339 timestamp with a timezone/
  );
  await rejectsBeforeAuthentication(
    () => google.calendarList({ timeMin: '2026-07-21T12:00:00Z', timeMax: '2026-07-21T11:00:00Z' }),
    /timeMax must be later than timeMin/
  );

  // Ordering compares instants, not merely the local timestamp text.
  await rejectsBeforeAuthentication(
    () => google.calendarCreate({
      ...calendarBase,
      start: '2026-07-21T10:00:00-07:00',
      end: '2026-07-21T12:00:00-05:00'
    }),
    /end must be later than start/
  );

console.log('Google input hardening tests passed.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
