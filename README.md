# ToolsEnabled Fleet for OpenShell — beta 3

This is the public source snapshot for ToolsEnabled Fleet for OpenShell 1.4.2. The matching release is [openshell-beta3-20261001](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta3-20261001).

Fleet installs a terminal MCP server and optional agent tree into an existing Linux x86-64 OpenShell sandbox. Windows hosts use WSL 2 and Docker Desktop's Linux engine; there is no native Windows runtime installer.

Use the release's verified archive and `SHA256SUMS` for an exact install. The [installer guide](installer/openshell/README.md) describes the two-command flow, upgrades, recovery, and uninstall. The [OpenShell guide](adapters/openshell/README.md) covers sandbox setup and prerequisites. The release notes give the current qualification status; dated source guides may describe earlier candidates.

This source snapshot maps to the published archive file by file, but rebuilding it creates a different archive checksum because the build records the export commit and its timestamp. See the release's source mapping report for the exact byte comparison. The runtime includes locked production JavaScript dependencies, while Node.js, Python, OpenShell, Codex and Claude Code are installed separately.

ToolsEnabled Fleet is MIT licensed. See [LICENSE](LICENSE), [NOTICE](NOTICE), [third-party notices](THIRD-PARTY-LICENSES.md), and [security reporting](SECURITY.md).
