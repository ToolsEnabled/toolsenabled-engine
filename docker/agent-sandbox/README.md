# ToolsEnabled agent Playwright sandbox image

This image is built only by `tools/build-agent-sandbox.ps1`. The script first
verifies a running Linux/amd64 Docker engine, builds from the pinned Microsoft
Playwright base digest, and records the resulting immutable local image ID in
ignored ToolsEnabled state. Runtime tools refuse an unlocked or stale image.

The image contains no ToolsEnabled source, host profile, credential, Docker
socket, or local-model endpoint. A sandbox receives only its dedicated empty
workspace bind mount and either no network or an internal fixture-only network.
