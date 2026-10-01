#!/usr/bin/env bash
# Run only from an independently verified, privately extracted release.
set -euo pipefail
usage() {
  printf '%s\n' 'ToolsEnabled Fleet verified local lifecycle'
  printf '%s\n' 'Usage: bash install.sh --setup [ABSOLUTE_PREFIX] --archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256 [--tier TIER --providers PROVIDERS]'
  printf '%s\n' '       bash install.sh --upgrade ABSOLUTE_PREFIX --archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256'
  printf '%s\n' '       bash install.sh --recover ABSOLUTE_JOURNAL --archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256'
  printf '%s\n' 'Use the release-pinned host command and its printed sandbox command for a fresh installation.'
}
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --setup|--upgrade|--recover) ;;
  *) printf '%s\n' 'INTEGRITY: a verified archive, explicit lifecycle mode and release SHA-256 are required.' >&2; usage >&2; exit 1 ;;
esac
if [[ ${OPENSHELL_SANDBOX:-} != 1 ]]; then
  printf '%s\n' 'TARGET: run this command inside your OpenShell sandbox.' >&2
  exit 1
fi
if [[ ! -x /usr/bin/python3 ]]; then
  printf '%s\n' 'INSTALL: Python 3.9 or newer is required at /usr/bin/python3.' >&2
  exit 1
fi
installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec /usr/bin/python3 -B "$installer_dir/fleet_install.py" "$@"
