#!/usr/bin/env python3
"""Exercise the built release with no package manager or provider CLI on PATH."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
args = parser.parse_args()

with tempfile.TemporaryDirectory(prefix='toolsenabled-package-test-') as directory:
    root = Path(directory)
    with tarfile.open(args.archive) as archive:
        for member in archive.getmembers():
            parts = Path(member.name).parts
            assert parts and parts[0] == 'toolsenabled-installer', member.name
            assert '..' not in parts, member.name
            assert member.isfile() or member.isdir() or member.issym(), member.name
            assert '/payload/node' not in member.name, member.name
            assert '/node_modules/npm/' not in member.name, member.name
            assert '/node_modules/@openai/codex/' not in member.name, member.name
            assert '/node_modules/@anthropic-ai/claude-code/' not in member.name, member.name
        archive.extractall(root, filter='data')
    package = root / 'toolsenabled-installer'
    assert {p.name for p in package.iterdir()} == {'README.md', 'install.sh', 'manifest.json', 'payload'}
    assert {p.name for p in (package / 'payload').iterdir()} == {'engine'}
    manifest = json.loads((package / 'manifest.json').read_text())
    assert len(manifest['source_commit']) == 40
    print('PASS archive contains only ToolsEnabled and its production libraries')

    # With a deliberately minimal PATH, an accidental npm/curl/docker/provider
    # invocation fails instead of silently reaching the host installation.
    commands = root / 'commands'
    commands.mkdir()
    for name in ['bash', 'dirname', 'uname', 'mkdir', 'mktemp', 'rm', 'cp', 'chmod', 'mv', 'ln', 'cat']:
        (commands / name).symlink_to(shutil.which(name))
    environment = {**os.environ, 'PATH': str(commands), 'OPENSHELL_SANDBOX': '1',
                   'TOOLSENABLED_STATE_ROOT': str(root / 'state')}
    destination = root / 'installed runtime'

    def install(target=destination, env=environment, ok=False):
        result = subprocess.run(['/bin/bash', str(package / 'install.sh'), str(target)],
                                env=env, text=True, capture_output=True)
        assert (result.returncode == 0) == ok, result.stdout + result.stderr
        return result.stdout + result.stderr

    assert 'Node.js 22.19.0' in install()
    assert not destination.exists()
    (commands / 'node').symlink_to(shutil.which('node'))
    assert 'inside your OpenShell sandbox' in install(env={**environment, 'OPENSHELL_SANDBOX': '0'})
    assert not destination.exists()
    broken = root / 'broken-link'
    broken.symlink_to(root / 'missing')
    assert 'already exists' in install(broken)
    assert broken.is_symlink()
    entry = package / 'payload/engine/bin/toolsenabled-openshell.js'
    entry.rename(entry.with_suffix('.saved'))
    assert 'Incomplete ToolsEnabled package' in install()
    assert not destination.exists()
    entry.with_suffix('.saved').rename(entry)
    print('PASS prerequisite, sandbox, incomplete-package and symlink refusals leave no installation')

    install(ok=True)
    assert {p.name for p in (destination / 'bin').iterdir()} == {'toolsenabled', 'toolsenabled-openshell'}
    assert {p.name for p in (destination / 'runtime').iterdir()} == {'engine'}
    assert not list(root.glob('*.install-*'))
    assert hashlib.sha256(entry.read_bytes()).digest() == hashlib.sha256(
        (destination / 'runtime/engine/bin/toolsenabled-openshell.js').read_bytes()).digest()
    assert 'already exists' in install()
    # Exercise the installed wrapper, including a prefix containing spaces.
    result = subprocess.run(['/bin/bash', '-c', 'source "$1"; command -v toolsenabled; toolsenabled status',
                             'test', str(destination / 'env.sh')],
                            env=environment, text=True, capture_output=True)
    assert str(destination / 'bin/toolsenabled') in result.stdout, result.stdout + result.stderr
    assert result.returncode == 0, result.stdout + result.stderr
    print('PASS offline installation, existing-install protection, PATH and installed status')
