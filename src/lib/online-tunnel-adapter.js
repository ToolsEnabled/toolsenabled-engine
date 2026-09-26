'use strict';

// Q67's online Tunnel adapter is intentionally transport-agnostic.  It owns
// neither a listener nor a network client: callers must inject a bounded
// outbound transport, security-state readers, and a clock.  This keeps the
// adapter deterministic and prevents it from reaching the vault, credentials,
// or a live network.
const defaultContract = require('./online-tunnel-contract');

const REQUEST_KEYS = Object.freeze(['lease', 'policy']);
const CONNECTION_KEYS = Object.freeze(['close', 'peer']);
const MAX_REASON_LENGTH = 64;

class OnlineTunnelAdapterError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OnlineTunnelAdapterError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new OnlineTunnelAdapterError(code, message, cause);
}

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('ONLINE_TUNNEL_ADAPTER_INVALID_SHAPE', `${label} must be a plain record.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  plainRecord(value, label);
  const actual = Reflect.ownKeys(value).filter(key => typeof key === 'string').sort();
  const expected = [...keys].sort();
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail('ONLINE_TUNNEL_ADAPTER_INVALID_SHAPE', `${label} fields do not match the required shape.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('ONLINE_TUNNEL_ADAPTER_INVALID_SHAPE', `${label} fields must be enumerable data properties.`);
    }
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') {
    fail('ONLINE_TUNNEL_ADAPTER_DEPENDENCY_INVALID', `${label} must be a function.`);
  }
  return value;
}

function normalizeReason(reason) {
  if (reason === undefined) return 'explicit-close';
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > MAX_REASON_LENGTH
    || !/^[a-z0-9-]+$/.test(reason)) {
    fail('ONLINE_TUNNEL_ADAPTER_CLOSE_REASON_INVALID', 'session close reason is invalid.');
  }
  return reason;
}

function validateRevocations(revokedLeaseIds, maxRevocations) {
  if (!Array.isArray(revokedLeaseIds) || revokedLeaseIds.length > maxRevocations
    || revokedLeaseIds.some(value => typeof value !== 'string' || !/^lease_[A-Za-z0-9_-]{8,120}$/.test(value))
    || new Set(revokedLeaseIds).size !== revokedLeaseIds.length) {
    fail('ONLINE_TUNNEL_REVOCATION_INVALID', 'revoked lease state is malformed.');
  }
  return Object.freeze([...revokedLeaseIds]);
}

function validateConnection(connection) {
  exactKeys(connection, CONNECTION_KEYS, 'outbound transport connection');
  requireFunction(connection.close, 'outbound transport connection.close');
  return connection;
}

function requireContract(contract) {
  plainRecord(contract, 'online tunnel contract');
  for (const name of ['validatePolicy', 'authorizeOnlineTunnelSession', 'authorityKeyId']) {
    requireFunction(contract[name], `online tunnel contract.${name}`);
  }
  if (!Number.isSafeInteger(contract.MAX_REVOKED_LEASES) || contract.MAX_REVOKED_LEASES < 0) {
    fail('ONLINE_TUNNEL_ADAPTER_DEPENDENCY_INVALID', 'online tunnel contract.MAX_REVOKED_LEASES is invalid.');
  }
  return contract;
}

function createOnlineTunnelAdapter({
  contract = defaultContract,
  transport,
  trustedAuthorityPublicKeyPem,
  clock = () => Date.now(),
  isPolicyEnabled = () => false,
  isKillSwitchActive = () => true,
  getRevokedLeaseIds = () => []
} = {}) {
  const safeContract = requireContract(contract);
  plainRecord(transport, 'outbound transport');
  requireFunction(transport.connectOutbound, 'outbound transport.connectOutbound');
  requireFunction(clock, 'clock');
  requireFunction(isPolicyEnabled, 'isPolicyEnabled');
  requireFunction(isKillSwitchActive, 'isKillSwitchActive');
  requireFunction(getRevokedLeaseIds, 'getRevokedLeaseIds');

  // Validate this once before a transport connection can be attempted.  The
  // contract owns all public-key parsing and makes no vault lookup.
  safeContract.authorityKeyId(trustedAuthorityPublicKeyPem);

  let nextSessionId = 1;
  const active = new Map();

  async function snapshotSecurityState() {
    let policyEnabled;
    let killSwitchActive;
    let revokedLeaseIds;
    let now;
    try {
      [policyEnabled, killSwitchActive, revokedLeaseIds, now] = await Promise.all([
        isPolicyEnabled(),
        isKillSwitchActive(),
        getRevokedLeaseIds(),
        clock()
      ]);
    } catch (error) {
      fail('ONLINE_TUNNEL_SECURITY_STATE_UNAVAILABLE', 'online tunnel security state is unavailable.', error);
    }
    if (policyEnabled === false) {
      fail('ONLINE_TUNNEL_POLICY_DISABLED', 'online tunnel policy is disabled by default.');
    }
    if (policyEnabled !== true) {
      fail('ONLINE_TUNNEL_POLICY_UNKNOWN',
        'online tunnel policy state is unavailable; this does not claim the policy is disabled.');
    }
    if (killSwitchActive === true) {
      fail('ONLINE_TUNNEL_KILLSWITCH_ACTIVE', 'online tunnel is disabled by the kill switch.');
    }
    if (killSwitchActive !== false) {
      fail('ONLINE_TUNNEL_KILLSWITCH_UNKNOWN', 'online tunnel kill-switch state is unavailable.');
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      fail('ONLINE_TUNNEL_ADAPTER_CLOCK_INVALID', 'online tunnel clock is invalid.');
    }
    return Object.freeze({
      policyEnabled,
      killSwitchActive,
      revokedLeaseIds: validateRevocations(revokedLeaseIds, safeContract.MAX_REVOKED_LEASES),
      now
    });
  }

  async function closeRecord(record, reason) {
    const safeReason = normalizeReason(reason);
    if (record.closed) return;
    if (record.closePromise) return record.closePromise;
    record.closePromise = (async () => {
      try {
        await record.connection.close(safeReason);
      } catch (error) {
        record.closePromise = null;
        fail('ONLINE_TUNNEL_CLOSE_FAILED', 'outbound tunnel session did not close.', error);
      }
      record.closed = true;
      active.delete(record.sessionId);
    })();
    return record.closePromise;
  }

  async function closeAll(reason = 'explicit-close') {
    const records = [...active.values()];
    for (const record of records) {
      await closeRecord(record, reason);
    }
    return Object.freeze({ closedSessionCount: records.length, activeSessionCount: active.size });
  }

  async function open(request) {
    exactKeys(request, REQUEST_KEYS, 'online tunnel adapter request');
    const policy = safeContract.validatePolicy(request.policy);

    // Read refusal state before dialing.  This is deliberately prior to the
    // injected transport so disabled, killed, and unknown state cannot create
    // even a provisional outbound session.
    await snapshotSecurityState();

    let connection;
    try {
      connection = validateConnection(await transport.connectOutbound(Object.freeze({
        direction: 'outbound-only',
        privateOverlay: true,
        serverName: policy.serverName,
        endpointPort: policy.endpointPort,
        tlsVersion: policy.tlsVersion,
        alpn: policy.alpn,
        mutualTls: true
      })));
    } catch (error) {
      if (error instanceof OnlineTunnelAdapterError) throw error;
      fail('ONLINE_TUNNEL_TRANSPORT_CONNECT_FAILED', 'outbound tunnel transport failed to connect.', error);
    }

    let state;
    let authorization;
    try {
      // Re-read every volatile control after the handshake.  A state change
      // during connection must fail closed and close the provisional session.
      state = await snapshotSecurityState();
      authorization = safeContract.authorizeOnlineTunnelSession({
        policy,
        policyEnabled: state.policyEnabled,
        lease: request.lease,
        peer: connection.peer,
        revokedLeaseIds: state.revokedLeaseIds,
        killSwitchActive: state.killSwitchActive,
        now: state.now,
        sessionStartedAtMs: state.now
      }, { trustedAuthorityPublicKeyPem });
    } catch (error) {
      try {
        await connection.close('authorization-rejected');
      } catch (closeError) {
        fail('ONLINE_TUNNEL_CLOSE_FAILED', 'rejected outbound tunnel session did not close.', closeError);
      }
      throw error;
    }

    const sessionId = `online-tunnel-session-${nextSessionId}`;
    nextSessionId += 1;
    const record = {
      sessionId,
      connection,
      authorization,
      closed: false,
      closePromise: null
    };
    active.set(sessionId, record);
    return Object.freeze({
      sessionId,
      authorization,
      close: reason => closeRecord(record, reason)
    });
  }

  async function reconcile() {
    let state;
    try {
      state = await snapshotSecurityState();
    } catch (error) {
      // Any unavailable, disabled, killed, or malformed security source makes
      // existing sessions unsafe too.  Closing is attempted before surfacing
      // the refusal; a close failure remains explicit rather than successful.
      await closeAll('security-state-rejected');
      throw error;
    }
    const records = [...active.values()];
    let closedSessionCount = 0;
    for (const record of records) {
      const expired = state.now >= record.authorization.sessionExpiresAtMs;
      const revoked = state.revokedLeaseIds.includes(record.authorization.leaseId);
      if (expired || revoked) {
        await closeRecord(record, expired ? 'session-expired' : 'lease-revoked');
        closedSessionCount += 1;
      }
    }
    return Object.freeze({ closedSessionCount, activeSessionCount: active.size });
  }

  return Object.freeze({
    closeAll,
    getActiveSessionCount: () => active.size,
    open,
    reconcile
  });
}

module.exports = Object.freeze({
  OnlineTunnelAdapterError,
  createOnlineTunnelAdapter
});
