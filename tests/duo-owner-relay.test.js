/*
 * Mutation check: changed CODE_RE from /^\d{1,8}$/ to /^\d{1,9}$/ in the module.
 * The edit landed (the mutated declaration was found before running the test).
 * This file went red: the nine-digit rejection assertion failed with exit code 1.
 */
'use strict';

const assert = require('node:assert/strict');

const {
  CODE_RE,
  DUO_DESKTOP_NOTICE,
  notifyOwnerOfDuoPrompt,
  renderDuoMessage
} = require('../src/lib/duo-owner-relay');

async function main() {
  assert.equal(CODE_RE.test('12345678'), true);
  assert.equal(CODE_RE.test('123456789'), false);
  assert.equal(CODE_RE.test('12a'), false);

  const codeMessage = renderDuoMessage({
    code: ' 042 ', account: 'student@example.edu', route: 'duo_mobile'
  });
  assert.deepEqual(codeMessage, {
    relayed: 'code',
    text: 'Duo verification code: 042\n'
      + 'Enter this number in the Duo push notification on your phone to approve the UCR sign-in (student@example.edu).\n'
      + 'It expires in about a minute. Nobody should ever ask you for it — if you did not start a sign-in, deny it.'
  });

  const desktopMessage = renderDuoMessage({ code: 'not-a-code', account: 'netid' });
  assert.deepEqual(desktopMessage, {
    relayed: 'notice',
    text: `${DUO_DESKTOP_NOTICE} Sign-in (netid).`
  });

  const mobileMessage = renderDuoMessage({ route: 'duo_mobile' });
  assert.equal(mobileMessage.relayed, 'notice');
  assert.match(mobileMessage.text, /no code was shown on the page/);

  const calls = { sent: [], recorded: [] };
  const delivery = {
    resolveChannel(options) {
      assert.deepEqual(options, { profile: 'owner' });
      return { channel: 'email', config: { emailAccount: 'primary' } };
    },
    async sendEmailToOwner(payload) { calls.sent.push(payload); },
    recordDelivery(payload) { calls.recorded.push(payload); },
    safeCode(error) { return error.code || 'UNKNOWN'; }
  };
  const delivered = await notifyOwnerOfDuoPrompt(
    { code: '731', account: 'netid' },
    { delivery, channelOptions: { profile: 'owner' } }
  );
  assert.deepEqual(delivered, {
    delivered: true, channel: 'email', relayed: 'code', failureCode: null
  });
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.sent[0], {
    subject: 'Duo verification code',
    text: renderDuoMessage({ code: '731', account: 'netid' }).text,
    account: 'primary'
  });
  assert.deepEqual(calls.recorded, [{
    purpose: 'duo-code', channel: 'email', ok: true, rendered: 'text',
    characters: calls.sent[0].text.length
  }]);
  assert.equal(JSON.stringify(calls.recorded).includes('731'), false);

  const failedRecords = [];
  const failed = await notifyOwnerOfDuoPrompt({}, {
    delivery: {
      resolveChannel() { throw Object.assign(new Error('missing'), { code: 'NO_CHANNEL' }); },
      safeCode(error) { return error.code; },
      recordDelivery(payload) { failedRecords.push(payload); }
    }
  });
  assert.deepEqual(failed, {
    delivered: false, channel: null, relayed: 'notice', failureCode: 'NO_CHANNEL'
  });
  assert.deepEqual(failedRecords, [{
    purpose: 'duo-notice', channel: 'unknown', ok: false, code: 'NO_CHANNEL'
  }]);

  console.log('duo-owner-relay behaviour tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
