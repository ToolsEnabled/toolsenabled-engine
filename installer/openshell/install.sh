#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash toolsenabled-installer/install.sh [ABSOLUTE_INSTALL_DIR]'
  printf '%s\n' 'Installs or upgrades ToolsEnabled inside this OpenShell sandbox.'
}
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  -*) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
esac
if (( $# > 1 )); then
  printf '%s\n' 'Expected at most one absolute installation directory.' >&2
  exit 1
fi
installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
install_prefix="${1:-$HOME/.local/toolsenabled}"
if [[ $install_prefix != /* ]]; then
  printf 'Installation directory must be an absolute path: %s\n' "$install_prefix" >&2
  exit 1
fi

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
if [[ ! -f "$installer_dir/payload/engine/bin/toolsenabled-openshell.js" || ! -d "$installer_dir/payload/engine/node_modules" || ! -f "$installer_dir/manifest.json" ]]; then
  printf '%s\n' 'Incomplete ToolsEnabled package. Download and extract the release archive again.' >&2
  exit 1
fi
manifest_commit() {
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (manifest.name !== "toolsenabled-openshell" || !/^[a-f0-9]{40}$/.test(manifest.source_commit) || !manifest.version) process.exit(1);
    process.stdout.write(manifest.source_commit);
  ' "$1"
}
new_commit=$(manifest_commit "$installer_dir/manifest.json") || {
  printf '%s\n' 'Incomplete ToolsEnabled package: invalid manifest.' >&2
  exit 1
}
old_commit=''
if [[ -e $install_prefix || -L $install_prefix ]]; then
  if [[ -L $install_prefix || ! -d $install_prefix || ! -f $install_prefix/manifest.json || ! -f $install_prefix/bin/toolsenabled || ! -d $install_prefix/runtime/engine ]]; then
    printf 'Installation directory exists but is not a ToolsEnabled install: %s\n' "$install_prefix" >&2
    exit 1
  fi
  old_commit=$(manifest_commit "$install_prefix/manifest.json") || {
    printf 'Installation directory has an invalid ToolsEnabled manifest: %s\n' "$install_prefix" >&2
    exit 1
  }
fi
umask 077
mkdir -p -- "$(dirname -- "$install_prefix")"
install_tmp=$(mktemp -d -- "${install_prefix}.install-XXXXXXXX")
backup=''
cleanup() {
  if [[ -n $backup && -d $backup && ! -e $install_prefix ]]; then
    mv -T -- "$backup" "$install_prefix"
  fi
  rm -rf -- "$install_tmp"
}
trap cleanup EXIT
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
if [[ -n $old_commit ]]; then
  backup=$(mktemp -d -- "${install_prefix}.old-XXXXXXXX")
  rmdir -- "$backup"
  mv -T -- "$install_prefix" "$backup"
fi
mv -T --no-clobber -- "$install_tmp" "$install_prefix"
if [[ -d "$install_tmp" ]]; then
  printf 'Installation directory appeared during installation: %s\n' "$install_prefix" >&2
  exit 1
fi
trap - EXIT
if [[ -n $backup ]]; then rm -rf -- "$backup"; fi

if [[ -n $old_commit ]]; then
  printf 'ToolsEnabled upgraded in %s\nOld commit: %s\nNew commit: %s\n' "$install_prefix" "$old_commit" "$new_commit"
else
  printf 'ToolsEnabled installed in %s\nCommit: %s\n' "$install_prefix" "$new_commit"
fi
printf 'Next: source %q\n' "$install_prefix/env.sh"
printf '%s\n' 'Then: toolsenabled setup --agents --providers codex,claude --add'
printf '%s\n' 'Setup uses the Codex and/or Claude CLI already installed in your sandbox.'
printf 'Optional cleanup after installation: rm -rf -- %q %q\n' "$(dirname -- "$installer_dir")/toolsenabled-openshell-linux-x64.tar.gz" "$installer_dir"
