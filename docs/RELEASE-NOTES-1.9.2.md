# ToolsEnabled Fleet 1.9.2

Fleet 1.9.2 is the standalone MCP server built from 1.9.1 plus four fixes. The first is the reason
for the release: a lead started from Claude's native installer was not recognised, so every worker
it started ran at level 2 and could not write files. Its version numbers are its own: the
ToolsEnabled Fleet plugin for Claude Code is a separate product with separate release numbers.

## Workers get their lead's level when the lead is Claude's versioned binary

Claude's native installer runs a file named after its version, for example
`~/.local/share/claude/versions/2.1.302`. Fleet identified the lead by the last part of that path,
saw `2.1.302`, did not recognise an agent, and fell back to **level 2**. At level 2 every file write
in a headless worker raises a confirmation that nobody can answer. It times out, the worker reports
"tool cancelled", and it carries on without writing anything. On 2026-10-20, 42 workers ran for five
hours in that state and wrote nothing to disk.

Fleet now treats `<command>/versions/<major.minor.patch>` as `<command>`, and looks through Claude's
own session and pseudo-terminal launch processes to the lead. What does not change:

- **The level still comes only from the lead's own flags.** A Claude lead started with
  `--permission-mode bypassPermissions` or `--dangerously-skip-permissions` is level 4; one started in
  `acceptEdits` or `auto` mode is level 3; `plan` is level 1.
- **Nothing new is trusted.** A file whose name is not a numeric version, or a version file under a
  directory not named `versions`, is still not an agent.
- **An unknown parent is still level 2**, and `TOOLSENABLED_LEVEL_CAP` still only lowers a level.

An agent's own background launchers are declared in its descriptor, not in Fleet's code: the new
optional `permissions.leadPlumbing` field lists the subcommands that are launchers (Claude's
`bg-pty-host` and `daemon run`) and the flag that marks a versioned binary as the image started for
a session (`--session-id`). It is strictly checked, and a malformed one refuses the descriptor by
name. An agent that declares none is never looked through.

If you start Fleet from a script or a program that is not an agent CLI, Fleet still cannot see the
lead and still uses level 2. Start the Fleet host from the lead's own shell instead.

To check a running tree, look at each worker's `permissionContext`: `source: ancestor-cli` and the
level you expect means Fleet found the lead; `source: unknown-parent-fallback` means it did not.

## Other fixes since 1.9.1

- **A standalone worker accepts a node recorded through a link.** Setup records the `node` it finds
  on `PATH`, which may be a link to the binary (for example `/usr/local/bin/node`). The generic-worker
  entry compared it literally with the resolved binary and refused every run with
  `HOST_CONFIG_MISMATCH`. It now compares real paths; a link to any other program still refuses.
- **An effort refusal with no choices says so.** A model with no effort choices was refused with
  "It accepts: none.", which reads as a value named `none`. It now says the model offers no effort
  choices.
- **Daybreak Blue is a Codex worker choice.** `gpt-daybreak-blue-latest` is now the choice `daybreak`,
  premium class, with reasoning depths low through ultra. The other choices are unchanged.

## Unchanged from 1.9.1

Workers still run until they answer: there is no round cap, token budget, deadline or continuation
turn cap. Liveness is the only stop: a model request or tool call that gives no answer at all for 30
minutes ends the assignment, and it re-arms on every request and tool call. See the
[1.9.1 release notes](RELEASE-NOTES-1.9.1.md) for everything else, including known limits.
