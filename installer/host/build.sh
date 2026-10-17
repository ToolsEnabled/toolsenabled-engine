#!/usr/bin/env bash
# Build the host edition from the same committed Fleet runtime as OpenShell.
set -euo pipefail
umask 077

cd "$(git rev-parse --show-toplevel)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf '%s\n' 'Commit source changes before building a release.' >&2
  exit 1
fi
output_dir="${1:-dist/host}"
mkdir -p -- "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd -P)
source_commit=$(git rev-parse HEAD)
source_epoch=$(git show -s --format=%ct HEAD)
build_tmp=$(mktemp -d)
trap 'rm -rf -- "$build_tmp"' EXIT
package_dir="$build_tmp/toolsenabled-installer"
engine_dir="$package_dir/payload/engine"
mkdir -p -- "$engine_dir"

mapfile -t release_paths < <(git show HEAD:installer/openshell/SOURCE-ALLOWLIST)
if ((${#release_paths[@]} == 0)); then
  printf '%s\n' 'The committed Fleet source list is empty.' >&2
  exit 1
fi
git archive HEAD "${release_paths[@]}" | tar -xf - -C "$engine_dir"
git show HEAD:installer/host/install.sh > "$package_dir/install.sh"
git show HEAD:installer/host/host_install.py > "$package_dir/host_install.py"
git show HEAD:installer/host/host_registration.py > "$package_dir/host_registration.py"
git show HEAD:installer/openshell/fleet_fs.py > "$package_dir/fleet_fs.py"
git show HEAD:installer/host/handoff_preflight.py > "$package_dir/handoff_preflight.py"
git show HEAD:installer/host/owner_handoff.py > "$package_dir/owner_handoff.py"
cat > "$package_dir/toolsenabled" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
# Follow a link to this wrapper (for example ~/.local/bin/toolsenabled).
script_dir=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd -P)
exec node "$script_dir/payload/engine/bin/toolsenabled-host.js" "$@"
WRAPPER
chmod 700 "$package_dir/install.sh" "$package_dir/toolsenabled"

node - "$package_dir" "$source_commit" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, commit] = process.argv.slice(2);
const engine = path.join(root, 'payload/engine');
const forbidden = ['npm', 'npx', 'node', '@openai/codex', '@anthropic-ai/claude-code'];
function inspect(directory) {
  if (path.basename(directory) === 'node_modules') {
    for (const name of forbidden) {
      try {
        fs.lstatSync(path.join(directory, name));
        throw new Error(`Unexpected bundled toolchain or provider: ${name}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) inspect(path.join(directory, entry.name));
  }
}
inspect(engine);
const pkg = JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  name: 'toolsenabled-host',
  mode: 'host',
  version: pkg.version,
  source_commit: commit,
  requirements: { node: pkg.engines.node, python: 'python3 >=3.11', providers: 'Separately installed Codex and/or Claude Code' },
  dependencies: pkg.dependencies
}, null, 2) + '\n');

// The filesystem helper materializes archive modes exactly. Remove group and
// other permissions before archiving so every installed copy is private,
// including callers whose umask would ordinarily expose newly-created files.
function makePrivate(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) makePrivate(filename);
    else if (entry.isFile()) fs.chmodSync(filename, (fs.statSync(filename).mode & 0o111) ? 0o700 : 0o600);
    else if (!entry.isSymbolicLink()) throw new Error(`Unexpected release file type: ${filename}`);
  }
  fs.chmodSync(directory, 0o700);
}
makePrivate(root);
NODE

release_version=$(node -p 'require(process.argv[1]).version' "$package_dir/manifest.json")
archive="toolsenabled-host-${release_version}-linux-x64.tar.gz"
tar --sort=name --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner \
  -cf - -C "$build_tmp" toolsenabled-installer | gzip -n > "$output_dir/$archive"
(cd -- "$output_dir" && sha256sum "$archive" > SHA256SUMS)
printf 'Built %s from %s\n' "$output_dir/$archive" "$source_commit"
