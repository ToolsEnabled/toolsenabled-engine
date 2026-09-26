# agent-engine

Engine-neutral interface plus per-engine adapters, so ToolsEnabled can drive
the Claude CLI and Codex as first-class engines instead of scraping a terminal.
Owner directives R1047, R1048, R1053, R1060; queue phase Q87.

## Generated protocol bindings are NOT checked in

`codex app-server` can emit its own JSON Schema and TypeScript bindings. Against
codex-cli 0.146.0 that is 275 schema files and 622 binding files, about 4.7 MB.
Those are build output, not source: checking them in would mean a version bump
lands as a thousand-file diff nobody reviews, and the schema on disk could
silently drift from the CLI actually installed.

Regenerate them instead, into a directory git ignores:

```
codex app-server generate-json-schema --out src/lib/agent-engine/.q87-codex-protocol-0.146.0
codex app-server generate-ts          --out src/lib/agent-engine/.q87-codex-types-0.146.0
```

Both subcommands are marked experimental by the CLI.

## The version pin is the mitigation

`codex app-server` is experimental and its protocol may change. The adapter is
pinned to the 0.146.x compatibility line and **fails closed** when pointed at a
different minor version rather than guessing that the protocol still matches.
When you bump the CLI: regenerate, re-run `node tests/agent-engine/codex-adapter.js`,
and move the pin deliberately.

## What the adapter covers

`CodexAdapter` covers streaming assembly, thread start/resume/fork, turn start
and interrupt, token usage, image attachments, and the full approval surface -
command execution, file change, and permission requests - including
`acceptForSession` and the execpolicy and network-policy amendment decisions.
Malformed engine messages fail closed rather than being trusted.

The adapter performs the required `initialize` handshake before using the live
server; the server rejects other methods until initialization succeeds.
`codex-process.js` provides `createCodexProcessTransport`, `detectCodexVersion`,
and `startCodexSession({cwd, clientInfo, threadOptions, onEvent})`, which
spawns a real `codex app-server` child process and returns
`{adapter, threadId, close()}`. Tests can still inject a fake transport.

`tests/agent-engine/codex-live-turn.js` spawns the actual server and drives a
real turn. It passes with `PASS codex-live-turn: thread <id> completed with
"PONG"`. Codex authentication needs no separate action: the child inherits
the user's credentials from their Codex home. The fake-transport suite passed
for the adapter's entire life while the real path was broken because the fake
did not enforce the handshake; the suite now does.

The Claude adapter implements the Agent Client Protocol shape via
`@agentclientprotocol/claude-agent-acp`: initialize, authenticate,
`session/new|load|fork|prompt|cancel`, `session/request_permission`, streaming,
image content blocks, and usage. Its full suite passes:
`node tests/agent-engine/claude-adapter.js` prints
`Claude ACP agent-engine adapter tests passed (initialize, auth, capabilities,
streaming, approvals, images, fail-closed).`

## Not here yet

No session manager lives inside this package; multi-session ownership currently
lives in the consuming app.

The Claude adapter has no process transport equivalent to `codex-process.js`:
nothing spawns an ACP agent subprocess yet, so the Claude engine is not
drivable end to end here.

This package is not registered in `config/packages.json`.
