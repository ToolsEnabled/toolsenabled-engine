'use strict';

const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  // Keep the real delegation policy, with installation settings replaced only
  // inside this child process. No CLI test reads or changes the owner's values.
  if (request === './settings' && require('node:path').basename(parent?.filename || '') === 'agent-delegation-policy.js') {
    return { loadSettings: () => JSON.parse(process.env.AGENT_MSG_TEST_SETTINGS || '{"values":{},"rejected":[]}') };
  }
  if (request.endsWith('/src/lib/agent-comms/local-runtime') || request === '../src/lib/agent-comms/local-runtime') {
    return {
      normalizeAgentId(value) {
        if (value === 'explode') throw new Error('stub explosion');
        return value;
      },
      createLocalAgentCommsRuntime() {
        if (process.env.AGENT_MSG_TEST_REFUSE_RUNTIME === '1') {
          throw Object.assign(new Error('Runtime preparation was reached.'), { code: 'TEST_RUNTIME_REACHED' });
        }
        const identity = id => Object.freeze({ id });
        return {
          identity,
          ownerActor: Object.freeze({ identity: identity('owner') }),
          fabric: {
            send: async message => message.body === 'refuse' ? null : ({ accepted: true }),
            sendChannel: async message => message.body === 'refuse' ? null : ({ accepted: true }),
            markRead: async input => input.messageId === 'refuse' ? null : ({ accepted: true }),
            position: () => ({ cursor: 0 }),
            read: () => ({ nextCursor: 0 }),
            ownerProjection: () => ({ journal: { nextCursor: 0 } }),
            listChannels: () => [],
            createChannel: () => ({ accepted: true }),
            joinChannel: () => ({ accepted: true }),
            leaveChannel: () => ({ accepted: true }),
            designateOwnerAgent: () => ({ accepted: true }),
            revokeOwnerAgent: () => ({ accepted: true })
          }
        };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
