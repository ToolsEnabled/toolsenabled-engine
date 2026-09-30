# ToolsEnabled Fleet for OpenShell: Windows host (WSL 2)

ToolsEnabled Fleet for OpenShell runs inside a Linux OpenShell sandbox on a Windows host using WSL 2 and Docker Desktop's Linux engine. Fleet installs the Linux x64 release archive and the `toolsenabled` command inside that sandbox; this terminal build has no native Windows runtime installer. NVIDIA lists this Windows host combination as experimental, and Fleet's Windows qualification is still in progress.

## Qualification status (2026-09-30)

The [published Linux beta](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta-20260930) uses candidate 7. The Windows testing described here uses this exact archive:

- Archive: `toolsenabled-openshell-linux-x64.tar.gz`
- SHA-256: `edc9e4bc76a738b56f037587ed9438458a4a0e7f06a08ab305aa5de57e356eed`
- Development source: `2d77e45e70b37b2911a2da342dda8ff23b583030`
- Immutable public source snapshot: [`546fc62faeadeaedb3562ccf784a2d8d66e62279`](https://github.com/ToolsEnabled/toolsenabled-engine/tree/openshell-beta-20260930)

The exact archive passed a Windows-hosted OpenShell 0.1.2 K1–K9 preflight and was **soak-tested with a scripted workload** using the local model simulator for two continuous hours: **58 complete K1–K9 rounds, zero failures**, with the same persistent process measured for **7,272.106 seconds**. The run reached its duration stop cleanly on 2026-09-30 at 08:39:51 UTC with exit code 0; a separate observation confirmed that the controller, runner, and persistent process had exited. Audit was disabled during this run. Full frozen hand-test qualification, authenticated Windows gateway access, and Windows-specific real-provider session coverage remain open. Follow the release notes for later results.

Two exact-archive hand-test pairs on Linux (runs 29/30 and 31/32) were rejected because their HT-14b policy-rejection outcomes differed. The gateway replaced an agent proposal with its own draft before the test acted on it. A test-harness correction is under review; both failed pairs remain part of the qualification record.

## Tested setup

Tested on **Windows 10 Pro 22H2 + WSL 2 + Docker Desktop**. This describes the setup used for the completed checks above; Windows qualification remains incomplete. These are observed versions, not minimum-version requirements or evidence for other configurations.

| Component | Observed version |
| --- | --- |
| Windows | Windows 10 Pro 22H2, build 19045.6466 |
| WSL package | 3.0.1.0, using WSL 2 |
| Linux kernel reported by Docker | 6.18.40.1-microsoft-standard-WSL2 |
| Docker Desktop | Installed product version 4.88.1.237512 |
| Docker Engine | 29.7.2, Linux x86_64 |
| OpenShell CLI / gateway image tag | 0.1.2 / 0.1.2 |
| Node.js inside the sandbox | 22.19.0 |
| Python inside the sandbox | 3.12.3 |
| Codex CLI inside the sandbox | 0.158.0 |
| Claude Code inside the sandbox | 2.1.284 |

The [Linux image-recipe compatibility report](https://github.com/ToolsEnabled/toolsenabled-engine/blob/openshell-beta-20260930/adapters/openshell/COMPATIBILITY.md) retains its historical scope. Each Windows release needs its own completed archive-specific parity evidence.

## Prerequisites

1. Install WSL 2 with a Linux distribution and Docker Desktop in Linux-container mode. Follow [NVIDIA's installation guide](https://docs.nvidia.com/openshell/latest/about/installation) and [Windows support matrix](https://docs.nvidia.com/openshell/latest/about/support-matrix).
2. Use OpenShell CLI and gateway **0.1.2** to match the setup under qualification. Run the CLI from your WSL terminal and verify that it can reach your authenticated gateway. Authenticated gateway operation on this Windows setup remains an open qualification item.
3. Create an OpenShell sandbox with Node.js **22.19.0 or newer** on `PATH`, Python 3 at `/usr/bin/python3`, and Codex and/or Claude Code installed separately. The Fleet archive contains its runtime and production JavaScript dependencies. The [runtime installation guide](https://github.com/ToolsEnabled/toolsenabled-engine/blob/openshell-beta-20260930/installer/openshell/README.md) describes provider and worker-agent options.

## Install the archive

### 1. In your WSL terminal: verify and upload

Download the archive and its matching `SHA256SUMS` from the beta release linked above. In WSL, change to the directory containing both files. Replace `YOUR_SANDBOX` below with the name of your existing OpenShell sandbox. Run the following Bash commands in WSL:

```bash
sha256sum -c SHA256SUMS &&
openshell sandbox upload --no-git-ignore YOUR_SANDBOX toolsenabled-openshell-linux-x64.tar.gz /sandbox/ &&
openshell sandbox exec -n YOUR_SANDBOX --tty -- bash
```

The last command opens a shell inside the sandbox. If checksum verification fails, obtain the matching archive and checksum file before uploading or installing.

WSL must be able to read the downloaded files and any policy file. Use `/mnt/c/` when that mount is available. Otherwise, copy the files into your WSL distribution through `\\wsl.localhost\<distro>\home\<user>\...` in Windows File Explorer or PowerShell, then verify their SHA-256 again in WSL. Use Linux paths in OpenShell CLI arguments.

### 2. Inside the sandbox: install and register

Run these commands in the sandbox shell opened above:

```bash
cd /sandbox &&
tar -xzf toolsenabled-openshell-linux-x64.tar.gz &&
bash toolsenabled-installer/install.sh &&
source ~/.local/toolsenabled/env.sh &&
toolsenabled setup --add &&
toolsenabled --version &&
toolsenabled status
```

The default installation directory is `~/.local/toolsenabled`. Source its `env.sh` in each new sandbox shell. Confirm that `toolsenabled --version` and every configured MCP registration identify the chosen installation; a sandbox image may already contain an older runtime. The runtime installation guide above covers a different installation directory, worker-agent options, upgrades and uninstall.

Use each provider CLI's own sign-in flow. OpenShell controls sandbox policy and provider access. Fleet's installer runs offline and does not install prerequisites or change that policy.

## Qualify a Windows candidate

Use a fresh scratch sandbox and bind every result to the archive checksum and source commit. Run installation/refusal checks, both CLI connections, the frozen hand-test pair, the continuous soak, and worker cleanup. Keep the authenticated gateway and real-provider checks in the qualification record. Source-tree tests and ordinary Docker container tests have narrower scope than behavior inside OpenShell.
