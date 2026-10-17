# Fleet tree view v1

`toolsenabled tree --json` prints one read-only snapshot. `toolsenabled tree --watch` redraws the human view when it changes. `toolsenabled tree --watch --json-lines` prints one compact JSON object per changed public snapshot, starting with the current snapshot. These commands work in OpenShell and host mode. Stop a watch with Ctrl-C.

The top-level object has `schema: "ai.toolsenabled/fleet-tree/v1"` and a `trees` array. Each readable tree has a bounded `treeKey`, `live` boolean, `reportsReady` count and `nodes` array. `reportsReady` counts undelivered worker reports for the lead, capped at 256; a status line can say "worker reports ready, say continue" when it is above zero. The count contains no report text. If a private tree cannot be read, it has `unavailable: true` and an empty `nodes` array. At most 32 trees and 256 workers per tree are shown in one snapshot.

Each node contains:

| Field | Meaning |
| --- | --- |
| `nodeId` | Stable identifier within this tree. The lead is `root`. |
| `displayName` | Short public label. |
| `parent` | Parent node ID, or `null` for the lead. |
| `provider` | An agent id from `toolsenabled agents` (for example `claude`, `codex`, `gemini` or `opencode`), or `generic` for a direct model connection. |
| `model` | Short model identifier, or `null`. |
| `role` | `lead` or `worker`. |
| `state` | `running`, `waiting`, `idle`, `done` or `failed`. |
| `level` | Workers only: the permission level the worker last started at, `1` (read only) to `4` (everything), or `null` before its first start. |
| `startedAt` | UTC ISO timestamp, or `null`. |
| `lastTurn` | `null`, or `{ "status": "completed|failed|interrupted|cancelled|unknown", "completedAt": timestamp|null }`. |

`waiting` means a running worker has a recorded approval wait. `done` means the worker or tree has stopped, or its last turn has finished. The lead is `idle` while its tree is live and `done` afterward. A renderer should tolerate unknown optional fields in later revisions and select behavior by `schema`.

The view is an explicit projection of private tree records. It admits only short validated labels, IDs, model names and timestamps. It excludes briefs, prompts, replies, errors, process IDs, credentials and paths. Watch mode uses the same projection and emits only when its public JSON changes; it does not send data to a network service.
