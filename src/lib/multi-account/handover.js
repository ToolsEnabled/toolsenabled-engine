'use strict';

// Report limits on each session’s current account. Account choice belongs to the person.
const { spentWindow } = require('./usage-windows.js');
const HANDOVER = Object.freeze({
  HELD_LIMIT: 'HANDOVER_HELD_LIMIT',
  UNKNOWN_ACCOUNT_NOT_READ: 'HANDOVER_UNKNOWN_ACCOUNT_NOT_READ',
  UNKNOWN_NOTHING_READ: 'HANDOVER_UNKNOWN_NOTHING_READ'
});
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.length > 0;

function handoverReport({ usage = null, sessions = [] } = {}) {
  const live = (Array.isArray(sessions) ? sessions : []).filter(plainObject).map(session => ({
    sessionId: nonEmptyString(session.sessionId) ? session.sessionId : session.id,
    agentId: nonEmptyString(session.agentId) ? session.agentId : null,
    account: session.account, provider: nonEmptyString(session.provider) ? session.provider : null
  })).filter(session => nonEmptyString(session.sessionId) && nonEmptyString(session.account));
  const measured = plainObject(usage) && usage.ok === true && Array.isArray(usage.accounts);
  const rows = measured ? usage.accounts.filter(plainObject) : [];
  const held = [], unknown = [];
  for (const session of live) {
    const row = rows.find(row => row.provider === session.provider && row.name === session.account);
    const detail = { sessionId: session.sessionId, agentId: session.agentId, provider: session.provider, from: session.account };
    if (!row || row.canServe !== true && String(row.status).toLowerCase() !== 'exhausted') {
      unknown.push(Object.freeze({ ...detail, why: measured ? HANDOVER.UNKNOWN_ACCOUNT_NOT_READ : HANDOVER.UNKNOWN_NOTHING_READ }));
    } else if (String(row.status).toLowerCase() === 'exhausted' || spentWindow(row.windows, { hourlyLimit: 100, weeklyLimit: 100 })) {
      held.push(Object.freeze({ ...detail, why: HANDOVER.HELD_LIMIT }));
    }
  }
  return Object.freeze({ ok: measured, code: measured ? null : HANDOVER.UNKNOWN_NOTHING_READ,
    readAt: measured ? usage.readAt ?? null : null,
    providers: Object.freeze([...new Set(live.map(session => session.provider).filter(Boolean))]),
    held: Object.freeze(held), unknown: Object.freeze(unknown) });
}

module.exports = Object.freeze({ HANDOVER, handoverReport });
