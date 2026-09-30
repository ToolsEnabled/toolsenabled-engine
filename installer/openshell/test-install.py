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
    readme = (package / 'README.md').read_text()
    assert readme.startswith(('# ToolsEnabled Fleet for OpenShell: runtime', '# ToolsEnabled OpenShell preview')), 'package must include the OpenShell install README'
    brand = 'ToolsEnabled Fleet' if readme.startswith('# ToolsEnabled Fleet ') else 'ToolsEnabled'
    if brand == 'ToolsEnabled Fleet':
        assert 'Fleet installs the `toolsenabled` command.' in readme
    assert 'bash toolsenabled-installer/install.sh' in readme
    assert 'toolsenabled uninstall' in readme
    assert 'To limit agent-tree workers to one provider' in readme
    assert 'Use `--providers codex` or `--providers claude` if you use only one provider.' not in readme
    assert {p.name for p in (package / 'payload').iterdir()} == {'engine'}
    manifest = json.loads((package / 'manifest.json').read_text())
    assert len(manifest['source_commit']) == 40
    assert manifest['version'] in ('1.4.0', '1.4.1'), 'No reviewed uninstall contract for this archive version'
    retains_unproven_state = manifest['version'] == '1.4.1'
    assert not (package / 'payload/engine/adapters/openshell/soak').exists()
    print('PASS archive contains only ToolsEnabled and its production libraries')

    # With a deliberately minimal PATH, an accidental npm/curl/docker/provider
    # invocation fails instead of silently reaching the host installation.
    commands = root / 'commands'
    commands.mkdir()
    for name in ['bash', 'dirname', 'uname', 'mkdir', 'mktemp', 'rm', 'cp', 'chmod', 'mv', 'ln', 'cat', 'readlink', 'rmdir']:
        (commands / name).symlink_to(shutil.which(name))
    home = root / 'home'
    home.mkdir()
    environment = {**os.environ, 'HOME': str(home), 'PATH': str(commands), 'OPENSHELL_SANDBOX': '1',
                   'TOOLSENABLED_STATE_ROOT': str(root / 'state'),
                   'CODEX_HOME': str(home / 'selected codex'),
                   'CLAUDE_CONFIG_DIR': str(home / 'selected claude')}
    destination = root / 'installed runtime'

    def install(target=destination, env=environment, ok=False):
        result = subprocess.run(['/bin/bash', str(package / 'install.sh'), str(target)],
                                env=env, text=True, capture_output=True)
        assert (result.returncode == 0) == ok, result.stdout + result.stderr
        return result.stdout + result.stderr

    for option in ['--help', '-h']:
        result = subprocess.run(['/bin/bash', str(package / 'install.sh'), option],
                                env={**environment, 'OPENSHELL_SANDBOX': '0'}, text=True, capture_output=True)
        assert result.returncode == 0 and 'Usage:' in result.stdout, result.stdout + result.stderr
    assert 'Unknown option' in install('--surprise')
    assert not (root / 'state').exists()
    assert 'absolute' in install('relative-prefix')
    assert not (root / 'relative-prefix').exists()

    assert 'Node.js 22.19.0' in install()
    assert not destination.exists()
    (commands / 'node').symlink_to(shutil.which('node'))
    assert 'inside your OpenShell sandbox' in install(env={**environment, 'OPENSHELL_SANDBOX': '0'})
    assert not destination.exists()
    broken = root / 'broken-link'
    broken.symlink_to(root / 'missing')
    assert f'not a {brand} install' in install(broken)
    assert broken.is_symlink()
    entry = package / 'payload/engine/bin/toolsenabled-openshell.js'
    entry.rename(entry.with_suffix('.saved'))
    assert f'Incomplete {brand} package' in install()
    assert not destination.exists()
    entry.with_suffix('.saved').rename(entry)
    print('PASS prerequisite, sandbox, incomplete-package and symlink refusals leave no installation')

    installed = install(ok=True)
    assert 'Optional cleanup after installation: rm -rf -- ' in installed
    assert str(package) in installed and str(root / 'toolsenabled-openshell-linux-x64.tar.gz') in installed
    assert {p.name for p in (destination / 'bin').iterdir()} == {'toolsenabled', 'toolsenabled-openshell'}
    assert {p.name for p in (destination / 'runtime').iterdir()} == {'engine'}
    assert not list(root.glob('*.install-*'))
    assert hashlib.sha256(entry.read_bytes()).digest() == hashlib.sha256(
        (destination / 'runtime/engine/bin/toolsenabled-openshell.js').read_bytes()).digest()
    state = root / 'state'
    state.mkdir()
    (state / 'keep.txt').write_text('state survives upgrade\n')
    old_commit = manifest['source_commit']
    new_commit = 'f' * 40 if old_commit != 'f' * 40 else 'e' * 40
    (package / 'manifest.json').write_text(json.dumps({**manifest, 'source_commit': new_commit}))
    upgraded = install(ok=True)
    assert old_commit in upgraded and new_commit in upgraded, upgraded
    assert (state / 'keep.txt').read_text() == 'state survives upgrade\n'
    # Exercise the installed wrapper, including a prefix containing spaces.
    result = subprocess.run(['/bin/bash', '-c', 'cd /; source "$1"; command -v toolsenabled; toolsenabled status',
                             'test', str(destination / 'env.sh')],
                            env=environment, text=True, capture_output=True)
    assert str(destination / 'bin/toolsenabled') in result.stdout, result.stdout + result.stderr
    assert result.returncode == 0, result.stdout + result.stderr
    for script in [destination / 'bin/toolsenabled', destination / 'bin/toolsenabled-openshell']:
        version = subprocess.run([str(script), '--version'], env={**environment, 'PATH': str(commands) + os.pathsep + str(destination / 'bin')},
                                 text=True, capture_output=True)
        assert version.returncode == 0 and version.stdout.startswith(f"{brand} {manifest['version']} ") and new_commit in version.stdout, version.stdout + version.stderr
    print('PASS offline installation, in-place upgrade, PATH and installed status')

    cli_log = root / 'removed-clis.txt'
    def removal_stub(name):
        variable = 'CODEX_HOME' if name == 'codex' else 'CLAUDE_CONFIG_DIR'
        return ('#!/bin/bash\nprintf "%s %s\\n" "' + name + '" "$*" >> "' + str(cli_log) + '"\n'
                + 'printf "%s\\n" "$' + variable + '" > "$HOME/' + name + '-profile-seen"\n')

    for name in ['claude', 'codex']:
        stub = commands / name
        stub.write_text(removal_stub(name))
        stub.chmod(0o755)
    (commands / 'codex').write_text('#!/bin/bash\necho "registration store unavailable" >&2\nexit 2\n')
    refused = subprocess.run([str(destination / 'bin/toolsenabled'), 'uninstall', '--keep-state'],
                             env=environment, text=True, capture_output=True)
    assert refused.returncode != 0 and 'runtime was kept for retry' in refused.stderr
    assert destination.exists() and (state / 'keep.txt').exists()
    (commands / 'codex').write_text(removal_stub('codex'))
    removed = subprocess.run([str(destination / 'bin/toolsenabled'), 'uninstall', '--keep-state'],
                             env=environment, text=True, capture_output=True)
    assert removed.returncode == 0, removed.stdout + removed.stderr
    assert not destination.exists() and (state / 'keep.txt').exists()
    log = cli_log.read_text()
    assert 'claude mcp remove --scope user toolsenabled' in log and 'codex mcp remove toolsenabled' in log, log
    assert (home / 'claude-profile-seen').read_text().strip() == environment['CLAUDE_CONFIG_DIR'], 'uninstall lost selected Claude profile'
    assert (home / 'codex-profile-seen').read_text().strip() == environment['CODEX_HOME'], 'uninstall lost selected Codex profile'

    install(ok=True)
    removed = subprocess.run([str(destination / 'bin/toolsenabled'), 'uninstall'], input='no\n',
                             env=environment, text=True, capture_output=True)
    assert removed.returncode == 0 and f'Delete {brand} state' in removed.stdout, removed.stdout + removed.stderr
    assert not destination.exists() and (state / 'keep.txt').exists()
    install(ok=True)
    calls_before = cli_log.read_text()
    removed = subprocess.run([str(destination / 'bin/toolsenabled'), 'uninstall'], input='yes\n',
                             env=environment, text=True, capture_output=True)
    if retains_unproven_state:
        assert removed.returncode != 0 and 'Exclusive ownership' in removed.stderr, removed.stdout + removed.stderr
        assert destination.is_dir() and (state / 'keep.txt').read_text() == 'state survives upgrade\n'
        assert cli_log.read_text() == calls_before, 'purge refusal ran a CLI removal'
        kept = subprocess.run([str(destination / 'bin/toolsenabled'), 'uninstall', '--keep-state'],
                              env=environment, text=True, capture_output=True)
        assert kept.returncode == 0 and not destination.exists() and state.is_dir(), kept.stdout + kept.stderr
        print('PASS version, selected CLI removals, retained state and pre-mutation refusal of unproven purge')
    else:
        # Historical 1.4.0 behavior is evidence, not the beta2 deletion contract.
        assert removed.returncode == 0, removed.stdout + removed.stderr
        assert not destination.exists() and not state.exists()
        print('PASS historical 1.4.0 version, CLI removals and confirmed state-deleting uninstall')
