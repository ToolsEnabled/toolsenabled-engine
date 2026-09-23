'use strict';

const RELAY_CLOSE_TIMEOUT_MS = 5_000;
const RELAY_CLOSE_UNCONFIRMED = 'RELAY_SHELL_CLOSE_UNCONFIRMED';

function closeUnconfirmed() {
  return Object.assign(new Error('Relay socket closure was not confirmed. This relay process must exit before another connection starts.'), {
    code: RELAY_CLOSE_UNCONFIRMED
  });
}

// WebSocket.close() requests a handshake; it is not proof that the socket
// closed. A black-holed TCP connection can otherwise strand the supervised
// machine process forever. Only the socket's own closed promise is success.
// A deadline is a terminal refusal: the CLI exits, and its supervisor must
// observe that exact process exit before starting another relay child.
function guardRelayClose(handle, { timeoutMs = RELAY_CLOSE_TIMEOUT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!handle || typeof handle.close !== 'function' || typeof handle.closed?.then !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('A relay close handle and positive finite deadline are required.');
  }
  let finished = false;
  let requested = false;
  let timer = null;
  let resolveClosed;
  let rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Closure can race a handshake await in the caller. Preserve its refusal
  // for that caller without creating an unhandled rejection in the meantime.
  closed.catch(() => {});
  function finish(error, receipt) {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (error) rejectClosed(error);
    else resolveClosed(receipt);
  }
  Promise.resolve(handle.closed).then(receipt => finish(null, receipt), () => finish(closeUnconfirmed()));
  return Object.freeze({
    closed,
    close() {
      if (finished || requested) return;
      requested = true;
      // Arm before calling close: a throwing close has not released the socket
      // either, and a second request must not move this deadline forward.
      timer = setTimer(() => finish(closeUnconfirmed()), timeoutMs);
      try { handle.close(); } catch { /* still await an actual close or refuse */ }
    }
  });
}

module.exports = Object.freeze({ guardRelayClose, RELAY_CLOSE_TIMEOUT_MS, RELAY_CLOSE_UNCONFIRMED });
