#!/usr/bin/env python3
"""Stage a reviewed Fleet public-source snapshot from one committed tree."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'public-source/ALLOWLIST.txt'
RUNTIME = 'installer/openshell/SOURCE-ALLOWLIST'
PRIVATE_REF = re.compile(rb'\b[RTAP][0-9]{3,}(?:\.[0-9]+)*\b|\bc[0-9]{1,2}\b|'
                         rb'\b(?:Q3\d|R8\d|B(?:[1-9]|[1-2]\d)|O\d|G\d|H\d|T[5-9]|P\d\.\d|(?:AUDIT|CRED|AE)-F-?\d{1,2})\b', re.I)
GENERATED = {'.gitattributes': b'* -text\n',
             '.gitignore': b'dist/\nnode_modules/\n__pycache__/\n*.pyc\n.venv/\n'}
HOST_WRAPPER = b'''#!/usr/bin/env bash
set -euo pipefail
# Follow a link to this wrapper (for example ~/.local/bin/toolsenabled).
script_dir=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd -P)
exec node "$script_dir/payload/engine/bin/toolsenabled-host.js" "$@"
'''


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def manifest_at(commit, name):
    data = git('show', f'{commit}:{name}').decode().splitlines()
    if not data or data != sorted(set(data)) or any(not row or row.startswith('/') or '..' in Path(row).parts for row in data):
        raise ValueError(f'{name} must be a sorted, unique, relative file list')
    return data


def selected_blobs(commit, names):
    raw = git('archive', '--format=tar', commit, *names)
    found = {}
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for item in archive:
            if item.isdir():
                continue
            if not item.isfile() or item.name not in names or item.name in found:
                raise ValueError(f'Unreviewed or unsafe export entry: {item.name}')
            found[item.name] = (archive.extractfile(item).read(), item.mode)
    if set(found) != set(names):
        raise ValueError(f'Export list differs from committed files: {sorted(set(names) ^ set(found))[:8]}')
    return found


def public_content(name, content):
    if name == 'docs/HOST-MODE.md':
        start = b'## Local headless tests\n'
        end = b'## macOS feasibility\n'
        if start not in content and content.count(end) == 1 and b'tests/host-integration.test.js' not in content:
            return content
        if content.count(start) != 1 or content.count(end) != 1:
            raise ValueError('Host guide test section changed; review the export transform')
        head, remaining = content.split(start, 1)
        _, tail = remaining.split(end, 1)
        return head + end + tail
    return content


def verify_archive(archive_path, commit, runtime, blobs, edition, version):
    with tarfile.open(archive_path, 'r:gz') as archive:
        base = 'toolsenabled-installer/'
        helpers = ['fleet_fs.py'] if edition == 'host' else [
            'fleet_fs.py', 'fleet_install.py', 'fleet_bootstrap.py',
            'fleet_upgrade.py', 'fleet_uninstall.py', 'fleet_legacy_inventory.json']
        expected = {base + 'manifest.json', base + 'install.sh',
                    *(base + 'payload/engine/' + name for name in runtime),
                    *(base + name for name in helpers)}
        if edition == 'host':
            expected.update({base + 'toolsenabled', base + 'host_install.py', base + 'host_registration.py',
                             base + 'handoff_preflight.py', base + 'owner_handoff.py'})
        else:
            expected.add(base + 'README.md')
            expected.update(base + 'payload/engine/libexec/' + name for name in helpers)
        actual = [item.name for item in archive if item.isfile()]
        if len(actual) != len(set(actual)) or set(actual) != expected:
            raise ValueError(f'Archive file list differs from public source mapping: {sorted(set(actual) ^ expected)[:8]}')
        if any(not item.isfile() and not item.isdir() for item in archive):
            raise ValueError('Archive contains a special entry')
        def content(name):
            item = archive.getmember(name)
            if not item.isfile():
                raise ValueError(f'Archive member is not a file: {name}')
            return archive.extractfile(item).read()
        identity = json.loads(content(base + 'manifest.json'))
        if identity['source_commit'] != commit or identity['version'] != version:
            raise ValueError('Archive source or version differs from reviewed export')
        if identity.get('mode', 'openshell') != edition:
            raise ValueError('Wrong archive edition')
        for name in runtime:
            if content(base + 'payload/engine/' + name) != blobs[name][0]:
                raise ValueError(f'Archive source bytes differ: {name}')
        prefix = 'installer/host/' if edition == 'host' else 'installer/openshell/'
        compared_helpers = ['install.sh', *helpers]
        if edition == 'host':
            compared_helpers += ['host_install.py', 'host_registration.py', 'handoff_preflight.py', 'owner_handoff.py']
        for name in compared_helpers:
            source = 'installer/openshell/fleet_fs.py' if edition == 'host' and name == 'fleet_fs.py' else prefix + name
            if content(base + name) != blobs[source][0]:
                raise ValueError(f'Archive helper differs: {source}')
        if edition == 'host' and content(base + 'toolsenabled') != HOST_WRAPPER:
            raise ValueError('Archive launcher differs from canonical host wrapper')
        if edition == 'openshell' and content(base + 'README.md') != blobs['installer/openshell/README.md'][0]:
            raise ValueError('Archive installer guide differs')
    return hashlib.sha256(archive_path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True, help='exact reviewed 40-hex source commit')
    parser.add_argument('--output', required=True, type=Path, help='new public-source directory')
    parser.add_argument('--openshell-archive', type=Path)
    parser.add_argument('--host-archive', type=Path)
    args = parser.parse_args()
    commit = args.commit
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or git('rev-parse', commit + '^{commit}').decode().strip() != commit:
        raise ValueError('Commit must be an exact existing commit')
    names = manifest_at(commit, MANIFEST)
    runtime = manifest_at(commit, RUNTIME)
    if not set(runtime).issubset(names) or not {MANIFEST, RUNTIME, 'public-source/build.py'}.issubset(names):
        raise ValueError('Public export must contain the exact runtime and its reviewed file lists')
    if any(name.startswith(('.git/', '.github/', '.githooks/', 'handtest/')) for name in names):
        raise ValueError('Internal scaffolding cannot enter the public export')
    blobs = selected_blobs(commit, names)
    # The release version is the one the reviewed commit's package.json names.
    version = json.loads(git('show', f'{commit}:package.json'))['version']
    for name, (content, _) in blobs.items():
        if name != 'installer/openshell/fleet_legacy_inventory.json' and PRIVATE_REF.search(content):
            raise ValueError(f'Private work reference in public file: {name}')
    archive_hashes = {
        'openshellArchiveSha256': verify_archive(args.openshell_archive, commit, runtime, blobs, 'openshell', version) if args.openshell_archive else None,
        'hostArchiveSha256': verify_archive(args.host_archive, commit, runtime, blobs, 'host', version) if args.host_archive else None,
    }
    output = args.output.resolve()
    output.mkdir(mode=0o755)
    for name, (content, mode) in blobs.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(public_content(name, content))
        target.chmod(0o755 if mode & 0o111 else 0o644)
    readme = (f'# ToolsEnabled Fleet source\n\n'
              f'This is the reviewed source for Fleet {version}, development commit `{commit}`. '
              'This release is published on [toolsenabled.ai](https://toolsenabled.ai); '
              'use its release assets and checksums for installation. '
              f'See the [{version} release notes](docs/RELEASE-NOTES-{version}.md).\n\n'
              'The [OpenShell installer](installer/openshell/README.md) and '
              '[host guide](docs/HOST-MODE.md) describe the two modes. '
              'Fleet is licensed under the [MIT License](LICENSE); see '
              '[NOTICE](NOTICE) and [security reporting](SECURITY.md).\n')
    for name, content in {**GENERATED, 'README.md': readme.encode()}.items():
        (output / name).write_bytes(content)
    result = {'sourceCommit': commit, 'files': len(blobs) + len(GENERATED) + 1, **archive_hashes}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
