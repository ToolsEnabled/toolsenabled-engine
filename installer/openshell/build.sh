#!/usr/bin/env bash
# Build the runtime-only release from committed source.
set -euo pipefail
umask 077

cd "$(git rev-parse --show-toplevel)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf '%s\n' 'Commit source changes before building a release.' >&2
  exit 1
fi
output_dir="${1:-dist/openshell}"
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
git show HEAD:installer/openshell/install.sh > "$package_dir/install.sh"
git show HEAD:installer/openshell/README.md > "$package_dir/README.md"
chmod 755 "$package_dir/install.sh"
mkdir -p -- "$engine_dir/libexec"
for helper in fleet_fs.py fleet_install.py fleet_bootstrap.py fleet_upgrade.py fleet_uninstall.py fleet_legacy_inventory.json; do
  git show "HEAD:installer/openshell/$helper" > "$package_dir/$helper"
  cp -- "$package_dir/$helper" "$engine_dir/libexec/$helper"
done
node - "$package_dir" "$source_commit" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, commit] = process.argv.slice(2);
const engine = path.join(root, 'payload/engine');
for (const name of ['npm', 'npx', 'node', '@openai/codex', '@anthropic-ai/claude-code']) {
  if (fs.existsSync(path.join(engine, 'node_modules', name))) {
    throw new Error(`Unexpected bundled toolchain or provider: ${name}`);
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  name: 'toolsenabled-openshell',
  version: pkg.version,
  source_commit: commit,
  requirements: { node: pkg.engines.node, python: '/usr/bin/python3 >=3.9', providers: 'Separately installed Codex and/or Claude Code' },
  dependencies: pkg.dependencies
}, null, 2) + '\n');
NODE

release_version=$(node -p 'require(process.argv[1]).version' "$package_dir/manifest.json")
archive="toolsenabled-openshell-${release_version}-linux-x64.tar.gz"
tar --sort=name --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner --mode=go-w \
  -cf - -C "$build_tmp" toolsenabled-installer | gzip -n > "$output_dir/$archive"
(cd -- "$output_dir" && sha256sum "$archive" > SHA256SUMS)
printf 'Built %s from %s\n' "$output_dir/$archive" "$source_commit"
