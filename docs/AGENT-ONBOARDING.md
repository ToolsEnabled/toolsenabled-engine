# Agent onboarding and role directions

ToolsEnabled gives each agent a normal role and a directions sheet when its
session starts. A role name is descriptive, not a grant of authority. The
role's base supplies its behavioral posture and learned operating rules; the
customer's role definition supplies its `owns`, `mustNot`, and `handoff`
directions. Declared `manages` relationships supply the reporting topology.

These pieces are intentionally independent:

- A manager-based custom role may coordinate only the descendants assigned to
  it by declared `manages` relationships.
- A role based on an observation role remains read-only even if it is given a
  misleading name or an invalid relationship.
- A custom role with no base inherits no mutating posture.
- Shadow Manager is an ordinary read-only advisory role. It reviews and
  reports; it is not a service, daemon, global supervisor, dispatcher, or
  fallback sweep actor.

Customers can edit role directions and relationships through the product's
role settings. The stored definitions are composed with the shipped role
library at launch, so a customer-defined role does not require a private build
or a special executable.

## Authoring defaults and functions

The default directions are plain JSON files in `src/lib/roles/`, one per role.
Edit `owns`, `mustNot`, and `handoff` for the editable sheet; `rules` contains
the additional operating guidance inherited by custom roles based on it.
`agent-roles.js` statically imports the files so onboarding, editable defaults,
and the shipped dependency closure use the same definitions. Installed overrides
are preserved; changing a shipped file does not replace customer wording.

Give dispatchers a usable assignment packet: current goal and user corrections,
working folder and relevant entry files, known findings, current task owners and
dependencies, exact artifact revisions, available functions, next action, and
required result/evidence. Include useful excerpts directly and reference bulky
history. Controllers keep tree context and route workloads; managers staff and
deliver a workload; workers execute focused assignments. Long implementation or
investigation should leave the accountable dispatcher able to process reports.

Functions have one implementation in `src/lib/tool-registry.js`. Add a named
`define(...)` entry with a closed input schema, explicit effect, and a handler
that calls the responsible implementation module. Reuse that entry for every
role that needs it; do not add a role-specific dispatch path. Follow adjacent
entries for permission and approval semantics, and test the real handler and
its refusals. `role-functions.js` projects the catalog directly from the registry,
including descriptions and input schemas, so the new function appears in the
workspace without another UI registration.

A role selects exact function IDs. `null` uses the normal installed surface;
`[]` selects none. Selection still intersects session permissions and role
capabilities. Unknown IDs are retained but inert. In the workspace, expand a
function for its inputs and call template. Exported role JSON can be edited in
a text editor and imported as a draft; it cannot install executable handlers.

Each editable directions field supports 6,000 characters and multiline text.
Project-hook packets reserve additional space for authored role sheets larger
than 4 KB, within a 96 KB role ceiling; unrelated context keeps its ordinary
budget. The packet's budget record reports the effective limit.
Provide enough relevant context to begin work, while keeping historical evidence
in referenced records. The host validates and passes the text into the first
turn; subsequent turns use their existing conversation. Restart sessions after
saving a role so they bind its new revision.

## Activate project onboarding

Project hooks run only for trusted repositories. Trust the checkout in the
client before relying on automatic onboarding, then restart the session from
that checkout. Ordinary agents should run non-elevated under the Windows
account that installed and uses ToolsEnabled. Elevation under that same
principal must remain pinned to the same installation owner and must not select
a second ToolsEnabled tree. Starting under a genuinely different Windows
account is a different identity and is refused by the account fence rather than
silently loading that account's settings or agent state.

The project hook configuration must invoke the repository-relative onboarding
entry point for both `SessionStart` and `SubagentStart`:

```text
node tools/agent-onboarding.js --hook
```

The checked-in hook command resolves the current repository root first; it
must not contain a customer-specific absolute path. In Codex, open Codex `/hooks`
and confirm that both events show the onboarding command. Other clients should
expose the equivalent project-hook inspection view.

For a bounded manual verification from the repository root, run:

```text
node tools/agent-onboarding.js --scope task --project .
```

The output must identify the selected role, its directions provenance, and the
current declared reporting relationships. A mutation-capable subagent launch
fails closed when the live role, collision, or settings sources cannot be read.

Raw interactive clients that ignore project hooks cannot be mechanically
covered. They must run the manual onboarding command before work, or be started
through a supported client that delivers `SessionStart` and `SubagentStart`.
