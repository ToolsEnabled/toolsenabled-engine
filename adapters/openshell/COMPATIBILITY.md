# ToolsEnabled for OpenShell: compatibility

Result so far: **pass** on the setup below. Each probe passed in two full runs
on identical scripts, and each was also run with its condition deliberately
broken to show that it fails when it should.

## Tested setup (2026-09-29)

| Item | Value |
|---|---|
| OpenShell | 0.1.2, official installer; local gateway with mTLS |
| Compute driver | Docker Engine 29.8.0, rootful; cgroup v2 |
| Host | Ubuntu, Linux 7.0, x86-64 |
| Landlock | kernel ABI 8; OpenShell applies its ruleset at ABI 3 with `hard_requirement` |
| Image | `toolsenabled-openshell` built from this recipe (Node 22.19.0, Claude Code 2.1.284, Codex 0.158.0) |

## Probes

| Probe | What it checks | Two runs | Broken on purpose |
|---|---|---|---|
| Detection | The workload sees `OPENSHELL_SANDBOX=1` and no gateway endpoint, token or address; no new privileges, seccomp on, no capabilities; Landlock required, with every policy path applied | pass, pass | fails when the policy lists a missing path |
| Network closed by default | Public hosts, provider hosts and raw IP addresses are refused until a rule allows them | pass, pass | fails when a host is allowed |
| Grandchild confinement | A process started by a process started by the agent can write only `/sandbox` and `/tmp`, including where file modes would allow more | pass, pass | fails when another path is made writable |
| Placeholder credentials | The sandbox holds only `openshell:resolve:…` placeholders; the real value appears only on the wire to the provider's bound host | pass, pass | fails when no provider is attached |
| Proposal lifecycle | A proposal filed from inside cannot be approved from inside (every approve route answers 404); after the person approves it, exactly the proposed method and path work and nothing wider; removing it takes effect live | pass, pass | fails when a whole host is proposed instead |
| Stop and start | Workspace files and policy changes survive `sandbox stop` and `start` | pass, pass | fails when the sandbox is recreated instead |
| Label isolation | Creating, changing, stopping and deleting labelled objects leaves another person's unlabelled sandbox, provider, policy and settings unchanged | pass, pass | fails when an unlabelled object is changed |
| Policy reload | Requests keep working while the policy is reloaded repeatedly, given one retry | pass, pass | fails without the retry |

## Measured

- **Idle cost:** one sandbox's supervisor used about 13% of one CPU and 16 MiB
  while the sandbox sat idle (136 s sample).
- **Policy changes** reach a running sandbox about every 10 seconds, so
  `openshell policy update --wait` takes about that long. Turning on
  `agent_policy_proposals_enabled` reached a running sandbox in about 10
  seconds, with no restart.
- **During a reload,** a few requests in about 140 were cut
  ("policy changed") in each run. One retry after 0.2 s brought that to none.
- **Right after an approval,** the first request to the newly allowed host can
  still fail once. Retry it.
- **A placeholder sent to a host its provider is not bound to** is refused by
  the proxy (`credential_endpoint_mismatch`), not passed through.

## Not tested

Other OpenShell versions, rootless Docker, Podman, Docker Desktop, Kubernetes,
the MicroVM driver, arm64, macOS and Windows.
