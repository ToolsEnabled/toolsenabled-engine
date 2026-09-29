#!/usr/bin/env bash
set -euo pipefail

installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
install_prefix="${1:-$HOME/.local/toolsenabled}"

if [[ ${OPENSHELL_SANDBOX:-} != 1 ]]; then
  printf '%s\n' 'Run this installer inside your OpenShell sandbox.' >&2
  exit 1
fi
if [[ ! -x /usr/bin/python3 ]]; then
  printf '%s\n' 'System Python is missing. Run the supplied prerequisite command on the laptop first.' >&2
  exit 1
fi
if [[ -e "$install_prefix" ]]; then
  printf 'Installation directory already exists: %s\n' "$install_prefix" >&2
  exit 1
fi
umask 077
mkdir -p -- "$(dirname -- "$install_prefix")"
install_tmp="${install_prefix}.install-$$"
trap 'rm -rf -- "$install_tmp"' EXIT
mkdir -p -- "$install_tmp/bin"
cp -a -- "$installer_dir/payload" "$install_tmp/runtime"

printf '%s\n' 'Installing Codex and Claude from their official npm packages…'
PATH="$install_tmp/runtime/node/bin:$PATH" "$install_tmp/runtime/node/bin/node" \
  "$install_tmp/runtime/node/lib/node_modules/npm/bin/npm-cli.js" install \
  --global --prefix "$install_tmp/runtime/node" --no-audit --no-fund \
  @openai/codex@0.158.0 @anthropic-ai/claude-code@2.1.284

ln -s ../runtime/node/bin/node "$install_tmp/bin/node"
ln -s ../runtime/node/lib/node_modules/npm/bin/npm-cli.js "$install_tmp/bin/npm"
ln -s ../runtime/node/lib/node_modules/npm/bin/npx-cli.js "$install_tmp/bin/npx"
ln -s ../runtime/node/lib/node_modules/@openai/codex/bin/codex.js "$install_tmp/bin/codex"
ln -s ../runtime/node/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe "$install_tmp/bin/claude"
ln -s /usr/bin/python3 "$install_tmp/bin/python3"

cat > "$install_tmp/bin/toolsenabled" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
toolsenabled_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec "$toolsenabled_root/runtime/node/bin/node" "$toolsenabled_root/runtime/engine/bin/toolsenabled-openshell.js" "$@"
WRAPPER
chmod 755 "$install_tmp/bin/toolsenabled"
ln -s toolsenabled "$install_tmp/bin/toolsenabled-openshell"
printf 'export PATH=%q:"$PATH"\n' "$install_prefix/bin" > "$install_tmp/env.sh"
mv -- "$install_tmp" "$install_prefix"
trap - EXIT

printf 'ToolsEnabled installed in %s\n' "$install_prefix"
printf 'Next: source %q\n' "$install_prefix/env.sh"
printf '%s\n' 'Then: toolsenabled setup --agents --providers codex,claude --add'
printf '%s\n' 'This installer does not sign in, start an agent, or change the sandbox policy.'
