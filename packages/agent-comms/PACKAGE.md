# `agent-comms` package charter

## Purpose

Owns the local agent-to-agent messaging fabric: channel contracts, delivery,
transport adapters/relay, and the durable comms provider surface.

## Public API

`src/lib/agent-comms/` (broker, channel-contract, claims, compat-bridge,
control-plane, cutover-gate, delivery, fabric, history, home-node,
local-runtime, read-position, transport-adapter, transport-relay),
`src/lib/providers/agent-comms.js`; tools: `tools/agent-msg.js`.

## Allowed dependencies

Q46-observed: `fleet`, `fra`, `kernel.runtime`, `kernel.state`, `providers.misc`.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not deliver a message across the machine boundary outside the declared
transport adapter, and do not treat an unread message as authority.

## Verification

`node tests/agent-comms/broker.js`; `node tests/agent-comms/provider.js`;
`node tests/package-charters.js`.
