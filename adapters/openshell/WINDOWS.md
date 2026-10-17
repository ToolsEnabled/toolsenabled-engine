# Windows host with WSL 2

ToolsEnabled Fleet for OpenShell is a Linux x86-64 runtime. On Windows, run the
OpenShell CLI and Fleet sandbox workflow from WSL 2 against a Linux container
engine. There is no native Windows Fleet installer in this release.

Use the exact archive, checksum and host transfer command in the release notes.
The [OpenShell installer guide](../../installer/openshell/README.md) describes
setup, upgrade, recovery and uninstall inside the sandbox. The
[OpenShell guide](README.md) describes the sandbox policy and provider setup.
Release notes record which Windows, WSL, container-engine and OpenShell
combinations were actually qualified; this guide does not extend that scope.

Before transfer, verify the release archive checksum on the Windows host and
again from WSL if the file crossed the WSL filesystem boundary. The WSL
OpenShell CLI must connect to an authenticated gateway. Keep the gateway's
credentials and provider sign-in in their own managed stores; neither the
archive nor the development image recipe supplies them.

Inside a new sandbox, confirm that the installed manifest names the intended
release commit and that `toolsenabled --version` and `toolsenabled status`
identify the same installation. Restart Codex and Claude Code after Fleet
setup or upgrade so they load the new MCP registration. Use the release's
frozen hand-test and soak results to judge qualification rather than treating
an ordinary `docker run` as an OpenShell sandbox test.

The optional [development image recipe](image/Dockerfile) builds from committed
source and installs separate provider CLIs. It is not the signed or verified
Fleet release archive. Building it does not sign in to a provider or qualify
an OpenShell gateway.
