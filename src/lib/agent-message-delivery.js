'use strict';

const { loadSettings } = require('./settings');
const IDS = ['agent.message_delivery', 'agent.message_queue_seconds'];
const DEFAULT_DELIVERY = Object.freeze({ mode: 'end-of-turn', intervalMs: 30_000 });
function messageDelivery({ read = loadSettings } = {}) {
  const { values } = read({ ids: IDS });
  const mode = { Instant: 'instant', Timer: 'timer', 'End of turn': 'end-of-turn' }[values[IDS[0]]];
  const seconds = values[IDS[1]];
  return Object.freeze({ mode: mode || DEFAULT_DELIVERY.mode,
    intervalMs: Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds * 1000 : DEFAULT_DELIVERY.intervalMs });
}

module.exports = { messageDelivery, DEFAULT_DELIVERY };
