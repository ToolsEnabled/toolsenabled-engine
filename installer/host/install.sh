#!/usr/bin/env bash
# Deliberate host entry. The OpenShell install.sh remains separate.
set -euo pipefail
umask 077
if [[ ${OPENSHELL_SANDBOX:-} == 1 ]]; then
  printf '%s\n' 'HOST: use the OpenShell installer inside your OpenShell sandbox.' >&2
  exit 1
fi
host_installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || {
  printf '%s\n' 'HOST: Python 3.11 or newer is required.' >&2
  exit 1
}
exec python3 -B "$host_installer_dir/host_install.py" "$@"
