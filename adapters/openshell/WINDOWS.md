# ToolsEnabled Fleet for OpenShell: Windows host (WSL 2)

ToolsEnabled Fleet for OpenShell runs inside a Linux OpenShell sandbox on a Windows host using WSL 2 and Docker Desktop's Linux engine. Fleet installs the Linux x64 release archive and the `toolsenabled` command inside that sandbox; this terminal build has no native Windows runtime installer. NVIDIA lists this Windows host combination as experimental, and Fleet's Windows qualification is still in progress.

## Qualification status (2026-09-30)

The [published Linux beta 2](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta2-20260930), Fleet version **1.4.1**, uses candidate 8. The Windows soak below tested this exact archive:

- Archive: `toolsenabled-openshell-linux-x64.tar.gz`
- SHA-256: `0fff72445daa33613702a76ee7c2d01b0cac0188329728e8a7301883b87f42b3`
- Development source: `3b7f5b1fe753a085d50c63e06ee115a2bcfb7212`
- Immutable public source snapshot: [`13a82410b89e3c371233ca3451fc3564e3fd19b0`](https://github.com/ToolsEnabled/toolsenabled-engine/tree/openshell-beta2-20260930)

**Windows scripted soak: passed.** The exact archive passed a Windows-hosted OpenShell 0.1.2 K1–K9 preflight and a continuous soak using the local model simulator: **60 complete K1–K9 rounds, 540 scenario passes, zero failures**. The same persistent MCP process was measured for **7,309.664 seconds**. The controller finished at **12:49:55 UTC** with exit code 0, and a separate observation confirmed that the controller, runner, and persistent process had exited. The full saved history and resource-growth checks passed, with all 24 pinned inputs unchanged. Audit was disabled. K1–K8 used fresh state each round; K9 retained the persistent MCP process and state. This result covers that scripted workload and duration.

**Linux hand tests: passed as a pair.** Runs 35 and 36 used the exact candidate 8 archive and passed the strict comparator and artifact check. Each run recorded **42 PASS, 0 FAIL, and 1 PENDING (HT-30)**. Separate real Codex and Claude Code turns supplied the Linux model-session coverage; HT-30 remains pending in the scripted results. These are Linux-hosted results. Candidate 7's rejected pairs remain in the earlier qualification record.

**Separate authentication fixture: passed.** A native Windows Node.js 22.14.0 client tested the OpenShell 0.1.2 Linux gateway under Docker Desktop using disposable certificates and five `ListSandboxes` cases. Trusted clients succeeded before and after the negative cases; missing client certificates, an unrelated CA, and plaintext were rejected. The client connections closed, the test process was reaped, and a separate teardown check found the fixture's containers, volumes, and network absent and both loopback ports free. This fixture did not create a sandbox or use provider credentials.

**Still open on Windows:** a full frozen hand-test pair hosted on Windows, authenticated OpenShell CLI access from WSL, and Windows-specific real-provider sessions. Follow the release notes for later results. The authentication fixture above does not establish those paths.

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

The [Linux image-recipe compatibility report](https://github.com/ToolsEnabled/toolsenabled-engine/blob/openshell-beta2-20260930/adapters/openshell/COMPATIBILITY.md) retains its historical scope. Each Windows release needs its own completed archive-specific parity evidence.

## Prerequisites

1. Install WSL 2 with a Linux distribution and Docker Desktop in Linux-container mode. Follow [NVIDIA's installation guide](https://docs.nvidia.com/openshell/latest/about/installation) and [Windows support matrix](https://docs.nvidia.com/openshell/latest/about/support-matrix).
2. Use OpenShell CLI and gateway **0.1.2** to match the setup under qualification. Run the CLI from your WSL terminal and verify that it can reach your authenticated gateway. Authenticated OpenShell CLI access from WSL remains an open qualification item; the separate native-client fixture above has narrower scope.
3. Create an OpenShell sandbox with Node.js **22.19.0 or newer** on `PATH`, Python 3 at `/usr/bin/python3`, and Codex and/or Claude Code installed separately. The Fleet archive contains its runtime and production JavaScript dependencies. The [runtime installation guide](https://github.com/ToolsEnabled/toolsenabled-engine/blob/openshell-beta2-20260930/installer/openshell/README.md) describes provider and worker-agent options.

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
