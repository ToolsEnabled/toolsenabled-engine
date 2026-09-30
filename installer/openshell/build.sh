#!/usr/bin/env bash
# Build the runtime-only release from committed source. npm is a build tool.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [[ -n $(git status --porcelain) ]]; then
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

git archive HEAD LICENSE NOTICE THIRD-PARTY-LICENSES.md package.json package-lock.json registry.json \
  bin config schemas src tools packages sidecars adapters | tar -xf - -C "$engine_dir"
rm -rf -- "$engine_dir/adapters/openshell/soak"
git show HEAD:installer/openshell/install.sh > "$package_dir/install.sh"
git show HEAD:installer/openshell/README.md > "$package_dir/README.md"
chmod 755 "$package_dir/install.sh"
(cd -- "$engine_dir" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

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
  requirements: { node: pkg.engines.node, python: '/usr/bin/python3', providers: 'Separately installed Codex and/or Claude Code' },
  dependencies: pkg.dependencies
}, null, 2) + '\n');
NODE

archive=toolsenabled-openshell-linux-x64.tar.gz
tar --sort=name --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner \
  -cf - -C "$build_tmp" toolsenabled-installer | gzip -n > "$output_dir/$archive"
(cd -- "$output_dir" && sha256sum "$archive" > SHA256SUMS)
printf 'Built %s from %s\n' "$output_dir/$archive" "$source_commit"
