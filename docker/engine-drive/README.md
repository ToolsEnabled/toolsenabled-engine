# ToolsEnabled engine drive bench

The image and mount strategy for running an **end-to-end drive of the engine
inside a Linux container**, driven by `tools/docker-drive.js`.

This is **not** `docker/agent-sandbox/`. That image is a confinement boundary an
agent is placed inside, and it deliberately contains no ToolsEnabled source.
This one is the opposite: a test bench that the engine source is handed to at
run time.

## Why it exists

`tools/lib/tool-surface-runner.js` has named four surfaces since it was
written — `SURFACES = ['desktop-here', 'docker', 'web', 'mobile']` — but
`tools/tool-surface-runner.js`'s `adaptersFor` can only construct one of them
(`desktop-here`), and fills the rest from an `--adapter-config` file that
nothing in this repository produced. Every `docker` cell in the cross-surface
matrix therefore read **NOT MEASURED** — not because anyone looked and found
nothing, but because nothing ever looked.

`tools/docker-drive.js --drive tool-surface` supplies that adapter.

## Commands

```
node tools/docker-drive.js --list             what can and cannot be driven, with reasons
node tools/docker-drive.js --doctor           Docker preconditions, or a named refusal
node tools/docker-drive.js --build            build the image
node tools/docker-drive.js --drive <id>       run a catalogued drive
```

The catalogue lives in `DRIVES` in `tools/docker-drive.js` and is enforced by
`tests/docker-drive-catalogue.test.js`. `--list` prints it; this README does not
duplicate the entries, because a second copy of a list is a copy that goes
stale.

## The image

Pinned by digest to `node:22-bookworm`, because a drive whose base silently
changed between two runs cannot support a comparison — and comparing two drives
is the whole point of running one.

The image owns **only the dependency layer**: `package.json`,
`package-lock.json`, and `npm ci --ignore-scripts`. The engine source is never
baked in. Nine lanes hold uncommitted work in the checkout this bench drives; a
`COPY` of the tree would freeze one lane's half-finished edit into a layer and
then report numbers for a tree that never existed.

`--ignore-scripts` skips the Playwright browser download. That is a deliberate
capability boundary, not a speed-up: browser-backed drives belong to the pinned
Playwright image under `docker/agent-sandbox/`, and the catalogue lists
`browser-surface` as not drivable here for exactly that reason.

The drive runs as uid 10002, not root. Root would make every
filesystem-permission assertion in the engine vacuously true — a test proving
"the product refuses to read an unreadable file" passes for the wrong reason
when the reader is root.

## Mount strategy

| Path | Mode | Why |
| --- | --- | --- |
| `/src` | **read-only** bind of the checkout | The container physically cannot write into the tree other lanes are editing. Verified by observation, not by intent: `touch /src/...` inside the container returns `Read-only file system`. |
| `/repo` | writable, populated at start | The drive genuinely needs a writable tree. `drive-entrypoint.sh` copies `/src` into it, excluding `.git`, `node_modules` (the host's are win32 binaries), and `state/test-runs` (the ledger other lanes poll). |
| `/evidence` | writable bind, **outside the source tree** | Collecting a result must not dirty the checkout either. |

`TOOLSENABLED_TEST_RUN_OUTPUT_DIR=/evidence` is set in the image rather than
left to the caller. `tools/test-run.js` defaults its output to
`state/test-runs/`, and its own comment records why that is dangerous: on
2026-08-10 a live poller read a transient dev-run record for about a minute
because a non-production invocation overwrote the `latest.json` other lanes
treat as authoritative. A drive is a non-production invocation by definition.

## The tool-surface adapter

`tools/tool-surface-runner.js`'s `commandAdapter` protocol: one JSON request on
stdin, one JSON object carrying `ok: true` on stdout.

The adapter **execs into a container that is already running** rather than
starting one per call. The runner spawns the adapter once per operation and the
registry holds hundreds of tools; a container per tool would spend the drive
creating containers and copying the tree. `--drive tool-surface` starts one
container, points the adapter at it by name, and removes it afterwards.

Two deliberate choices inside the adapter:

- **It injects the unattended permission session.** `desktopAdapter` resolves
  an unattended ceiling and puts it in every invoke; `commandAdapter` does not.
  Without the injection the docker column would run every tool under a
  *different* permission posture than the column it is compared against, and
  any difference in the matrix would be unattributable.
- **It refuses the reversible lifecycle by name.**
  `DRIVE_ADAPTER_NO_REVERSIBLE_LIFECYCLE`. Neither this adapter nor
  `tools/tool-surface-runner-worker.js` implements write/assert/restore/
  re-read/assert. Forwarding the request would surface the worker's
  `"Worker request operation is invalid."` stack trace, which reads to a person
  as *the product broke*. It did not; this harness has not been built that far,
  and the matrix records that as `NOT MEASURED` with `origin: 'runner'`.

## What a container cannot settle

The vault is the one to understand. `src/lib/vault-platform.js` sets
`SUPPORTED_VAULT_PLATFORM = 'win32'` and `assertVaultPlatform` throws
`SECRET_VAULT_PLATFORM_UNSUPPORTED` anywhere else. The DPAPI vault and every
audit path needing its signing material are **genuinely absent on Linux**. That
is an owner decision — port the vault, or declare Linux a partial surface — and
no harness change moves it. A drive that turned those refusals into passes
would be the defect, not the fix.
