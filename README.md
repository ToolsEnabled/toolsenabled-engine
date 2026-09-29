# ToolsEnabled OpenShell preview

Manual installer for an existing minimal Ubuntu 24.04 OpenShell sandbox on Linux x86_64, using a local Docker gateway. This branch records the runtime source for `openshell-preview-20260929`.

The release bundles ToolsEnabled, Node 22.19.0 and npm 10.9.3. The person's install downloads Codex 0.158.0 and Claude Code 2.1.284 from their official npm packages.

## On the laptop

The laptop needs `openshell`, Docker, Python 3 and curl. Create or keep an empty Ubuntu 24.04 sandbox named `clean-shell`, then run:

```bash
curl -fL https://github.com/ToolsEnabled/toolsenabled-engine/releases/download/openshell-preview-20260929/prepare-clean-shell.py -o /tmp/toolsenabled-prepare.py
python3 /tmp/toolsenabled-prepare.py clean-shell
```

The helper builds Python prerequisites from Ubuntu packages, copies root-owned Python into the named sandbox, adds the npm and provider network endpoints, and uploads the checksum-verified release archive. It leaves ToolsEnabled uninstalled for the person to install inside the shell. Its network policy keeps OpenShell's default filesystem permissions. It refuses a sandbox with an existing network policy so that it cannot replace custom network rules accidentally.

The default Docker socket is `/var/run/docker.sock`. Use `--docker-host SOCKET` when the gateway uses another local Docker socket. This helper targets the default workspace and local Docker gateway.

## Inside clean-shell

```bash
cd /sandbox
tar -xzf toolsenabled-installer.tar.gz
bash toolsenabled-installer/install.sh
source ~/.local/toolsenabled/env.sh
toolsenabled setup --agents --providers codex,claude --add
toolsenabled status
```

Sign in with the official CLIs:

```bash
codex login --device-auth
claude auth login
```

Both provider logins belong to this sandbox. After setup, Codex and Claude each have their own ToolsEnabled MCP registration. Start the CLI you want as the root session; its ToolsEnabled tree can use both providers after their logins are ready.

Run `source ~/.local/toolsenabled/env.sh` when opening a new shell. The installer refuses to overwrite an existing ToolsEnabled directory and never copies laptop credentials into the sandbox.

## Validation and scope

Validated in a separate minimal OpenShell sandbox: Python prerequisites, official npm package installation, Codex and Claude version checks, both MCP registrations, the saved Codex MCP initialize/tools-list exchange, Claude MCP connection, and OpenShell agent process cleanup. Real model turns require the person's provider login and are not part of the install check.

The OpenShell agent tree uses its sandbox-compatible process-group handling. Separate features that use the general Linux pidfd helper remain subject to OpenShell's syscall restrictions. This is a preview of the OpenShell runtime, not a qualification of the desktop engine's entire feature set.

The runtime's MIT license, NOTICE and third-party notices are included. Node and npm notices are in the release payload. Provider CLIs are fetched from their own npm distributions during installation.
