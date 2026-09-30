# Windows host (WSL 2)

OpenShell runs ToolsEnabled Fleet for OpenShell in a **Linux sandbox**. On Windows x86-64, use WSL 2 and Docker Desktop's Linux engine. NVIDIA lists this host combination as experimental. The release unit is the Linux x64 runtime-only archive built by `installer/openshell/build.sh` and installed inside that sandbox. `image/build.ps1` builds a development image from committed source without sending local untracked files or credentials to Docker; the image is not the release artifact.

## Qualification status (2026-09-30)

The [published Linux beta1](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta-20260930) uses candidate 7. At the 08:14 UTC observation, Windows WSL 2 qualification was in progress. The tested archive was `toolsenabled-openshell-linux-x64.tar.gz`, SHA-256 `edc9e4bc76a738b56f037587ed9438458a4a0e7f06a08ab305aa5de57e356eed`, built from source `2d77e45e70b37b2911a2da342dda8ff23b583030`. See the [beta1 public source mapping](../../installer/openshell/README.md#public-source-and-archive-identity). Beta2 version 1.4.1 was still in development when this status was recorded; candidate 7 results do not qualify it.

The exact candidate 7 archive passed the Windows-hosted OpenShell 0.1.2 K1–K9 preflight. At the 08:14 UTC observation, its continuous soak had completed 45 K1–K9 iterations without failures, but the required two-hour duration was still incomplete. Full frozen hand-test qualification, authenticated Windows gateway access, and Windows-specific real-provider session coverage remain open. Follow the release notes for later results.

Two exact-archive hand-test pairs on Linux (runs 29/30 and 31/32) were rejected by the strict comparator because their HT-14b policy-rejection outcomes differed. The gateway proposal-supersede race led to a prospective beta2 harness fix, which still needs review and a valid live pair. Both failed pairs remain part of the qualification record.

The observed test host uses Windows 10 Pro 22H2, build 19045.6466; WSL 3.0.1.0 with kernel 6.18.40.1-microsoft-standard-WSL2; Docker Desktop 4.88.1.237512 with Docker Engine 29.7.2; and OpenShell CLI/gateway 0.1.2. These observations cover that setup only. The Linux image-recipe report in [COMPATIBILITY.md](COMPATIBILITY.md) retains its original scope.

## Prerequisites

1. Install WSL 2 with a Linux distribution and Docker Desktop in Linux-container mode. Enable Docker Desktop host networking for the Compose gateway described below.
2. Confirm `docker info` works in PowerShell. Docker Desktop's WSL integration is needed only if you intend to run Docker commands from WSL; this recipe can build and start the gateway from PowerShell.
3. Install NVIDIA OpenShell **0.1.2** in WSL and confirm `openshell --version` and `openshell status`. Follow [NVIDIA's installation guide](https://docs.nvidia.com/openshell/latest/about/installation) and [Windows support matrix](https://docs.nvidia.com/openshell/latest/about/support-matrix). The WSL CLI can use a gateway running under Docker Desktop even when Docker's WSL CLI integration is unavailable.

Run Docker and gateway commands from PowerShell, and OpenShell CLI commands from WSL. Keep the OpenShell CLI and gateway on the 0.1.2 compatibility line used by [this recipe](README.md). If you run the gateway through NVIDIA's Compose example, configure its gateway JWT keys and a supervisor callback address reachable from host-networked containers; `http://127.0.0.1:8080` worked on the Windows test host. Use authenticated gateway access for a release installation. The local development gateway used for the smoke test accepted unauthenticated user calls on a loopback-published port and is not a release configuration; it was stopped after testing.

## Test a release candidate

Fetch the exact candidate archive, its `SHA256SUMS`, and its build record onto the Windows host. Verify the archive hash before using it. The WSL CLI must be able to read the archive: use `/mnt/c/` when mounted, or copy it into WSL through `\\wsl.localhost\<distro>\home\<user>\...` from PowerShell. Verify the same SHA-256 in WSL. On the test host, copying the policy YAML through that WSL path preserved its SHA-256 when `/mnt/c/` was unavailable.

Create a fresh OpenShell sandbox with Node.js 22.19.0 or newer and Python 3 at `/usr/bin/python3`. The candidate does not contain Node, Claude Code, or Codex. Use `openshell sandbox upload` to place the verified archive in the sandbox, extract it there, and run its `install.sh` into an unused scratch prefix. Source that prefix's `env.sh` before every check. Confirm `command -v toolsenabled`, the installed `manifest.json` source commit, and both MCP registrations refer to the candidate installation. An image that already contains an older ToolsEnabled runtime can otherwise give a misleading pass.

Run the candidate's offline install and refusal checks, the frozen hand tests, and soak K1–K9 against the installed prefix. Record tool counts, CLI health, worker cleanup, and any Windows differences in a parity report bound to the candidate's hash. Keep all state and profiles in scratch paths and remove the test sandbox afterward. A source-tree test or ordinary `docker run` does not prove candidate behavior inside OpenShell.

## Build a development image on Windows

In PowerShell, from this checkout:

```powershell
.\adapters\openshell\image\build.ps1
```

The script tags the image `toolsenabled-openshell:windows-<commit>` and prints the exact source commit. It archives `HEAD`, so commit a change before building the image you intend to test or distribute. It does not include working-tree edits. To choose a tag:

```powershell
.\adapters\openshell\image\build.ps1 -Tag toolsenabled-openshell:local
```

Check that the development image starts without attaching credentials or a provider:

```powershell
docker run --rm --entrypoint toolsenabled-openshell toolsenabled-openshell:local
```

That command should print the terminal usage. It verifies image construction and the CLI entry point; it does not verify OpenShell policy or provider access.

## Create and check a sandbox

In WSL, use the image tag you built and follow [the Linux quickstart](README.md#quickstart) for the provider, policy, and sandbox commands. The `--policy` path must be a Linux path. Use a path under `/mnt/c/` when the Windows drive is mounted there; otherwise copy `adapters/openshell/policy/cli-sign-in.yaml` into your WSL home and use that copy. Run `toolsenabled setup --agents --add`, `toolsenabled status`, and the hand tests **inside** the sandbox. Do not treat an ordinary `docker run` as an OpenShell sandbox.

The earlier development-image smoke built committed source, ran 192 focused engine tests in a Linux container, and created a real OpenShell 0.1.2 sandbox from that image. Inside it, setup registered both CLI MCP servers, Claude reported the MCP server connected, the policy advisor became available, and a ledger task was created, read, completed and cleared. Current archive qualification is recorded in the [dated status above](#qualification-status-2026-09-30).
