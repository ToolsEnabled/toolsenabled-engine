#!/usr/bin/env bash
set -euo pipefail

installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
install_prefix="${1:-$HOME/.local/toolsenabled}"

if [[ ${OPENSHELL_SANDBOX:-} != 1 ]]; then
  printf '%s\n' 'Run this installer inside your OpenShell sandbox.' >&2
  exit 1
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf '%s\n' 'This package supports Linux x86_64.' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1);
'; then
  printf '%s\n' 'Node.js 22.19.0 or newer is required on PATH. Install it in your sandbox image first.' >&2
  exit 1
fi
if [[ ! -x /usr/bin/python3 ]]; then
  printf '%s\n' 'Python 3 is required at /usr/bin/python3. Install it in your sandbox image first.' >&2
  exit 1
fi
if [[ -e "$install_prefix" || -L "$install_prefix" ]]; then
  printf 'Installation directory already exists: %s\n' "$install_prefix" >&2
  exit 1
fi
if [[ ! -f "$installer_dir/payload/engine/bin/toolsenabled-openshell.js" || ! -d "$installer_dir/payload/engine/node_modules" ]]; then
  printf '%s\n' 'Incomplete ToolsEnabled package. Download and extract the release archive again.' >&2
  exit 1
fi
umask 077
mkdir -p -- "$(dirname -- "$install_prefix")"
install_tmp=$(mktemp -d -- "${install_prefix}.install-XXXXXXXX")
trap 'rm -rf -- "$install_tmp"' EXIT
mkdir -p -- "$install_tmp/bin"
mkdir -p -- "$install_tmp/runtime"
cp -a -- "$installer_dir/payload/engine" "$install_tmp/runtime/engine"
cp -- "$installer_dir/manifest.json" "$install_tmp/manifest.json"

cat > "$install_tmp/bin/toolsenabled" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
toolsenabled_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec node "$toolsenabled_root/runtime/engine/bin/toolsenabled-openshell.js" "$@"
WRAPPER
chmod 755 "$install_tmp/bin/toolsenabled"
ln -s toolsenabled "$install_tmp/bin/toolsenabled-openshell"
printf 'export PATH=%q:"$PATH"\n' "$install_prefix/bin" > "$install_tmp/env.sh"
mv -T --no-clobber -- "$install_tmp" "$install_prefix"
if [[ -d "$install_tmp" ]]; then
  printf 'Installation directory appeared during installation: %s\n' "$install_prefix" >&2
  exit 1
fi
trap - EXIT

printf 'ToolsEnabled installed in %s\n' "$install_prefix"
printf 'Next: source %q\n' "$install_prefix/env.sh"
printf '%s\n' 'Then: toolsenabled setup --agents --providers codex,claude --add'
printf '%s\n' 'Setup uses the Codex and/or Claude CLI already installed in your sandbox.'
