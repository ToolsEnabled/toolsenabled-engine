#!/usr/bin/env python3
"""Exercise the built release with no package manager or provider CLI on PATH."""
import argparse
import hashlib
import json
import os
import pwd
import re
import stat
import sys
import time
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

def legacy_install_check(archive_path):
    with tempfile.TemporaryDirectory(prefix='toolsenabled-package-test-') as directory:
        root = Path(directory)
        with tarfile.open(archive_path) as archive:
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


BETA3_VERSION = '1.4.2'
HELPERS = ('fleet_fs.py', 'fleet_install.py', 'fleet_bootstrap.py', 'fleet_upgrade.py',
           'fleet_uninstall.py', 'fleet_legacy_inventory.json')


class GateError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise GateError(message)


def sha256_file(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def inspect_release(archive_path, pin):
    # Verify a supplied external pin before interpreting any archive contents.
    if pin is not None:
        require(re.fullmatch(r'[a-f0-9]{64}', pin) is not None,
                'An independently supplied SHA-256 must be 64 lowercase hexadecimal characters')
        require(sha256_file(archive_path) == pin, 'Archive differs from independently supplied SHA-256')
    with tarfile.open(archive_path) as archive:
        entries = [entry for entry in archive.getmembers()
                   if entry.name.rstrip('/') == 'toolsenabled-installer/manifest.json']
        require(len(entries) == 1 and entries[0].isfile() and entries[0].size <= 65536,
                'Expected exactly one bounded regular release manifest')
        manifest = json.load(archive.extractfile(entries[0]))
    require(isinstance(manifest, dict) and manifest.get('version') in ('1.4.0', '1.4.1', BETA3_VERSION),
            'No reviewed installer contract for this archive version')
    require(manifest.get('name') == 'toolsenabled-openshell'
            and re.fullmatch(r'[a-f0-9]{40}', manifest.get('source_commit', '')) is not None,
            'Invalid release identity')
    if manifest['version'] == BETA3_VERSION:
        require(pin is not None, 'Beta3 requires an independently supplied SHA-256; use TOOLSENABLED_CANDIDATE_SHA256')
    return manifest


def require_dedicated_scope(environment):
    require(sys.platform == 'linux' and environment.get('TOOLSENABLED_CANDIDATE_ISOLATED') == '1',
            'Beta3 requires a dedicated sandbox/test user; set TOOLSENABLED_CANDIDATE_ISOLATED=1 only there')
    uid = os.getuid()
    require(uid != 0 and os.geteuid() == uid,
            'Beta3 artifact gate requires a real non-root UID without an effective-UID override')
    account_home = Path(pwd.getpwuid(uid).pw_dir)
    require(environment.get('TOOLSENABLED_CANDIDATE_EXPECT_UID') == str(uid)
            and environment.get('TOOLSENABLED_CANDIDATE_EXPECT_ACCOUNT_HOME') == str(account_home)
            and account_home.is_absolute() and account_home.resolve() == account_home,
            'Actual UID/account home differ from the declared dedicated sandbox/test user')
    require(environment.get('OPENSHELL_SANDBOX') == '1', 'Beta3 artifact gate requires an OpenShell sandbox')
    require(environment.get('TOOLSENABLED_TEST_ISOLATED') == '1', 'Run the beta3 gate through tests/run-isolated.js')
    require(not os.path.lexists(account_home / 'work'),
            'Dedicated account work directory already exists; use a new disposable account for each gate')
    return account_home


def extract_beta3(archive_path, root, manifest):
    with tarfile.open(archive_path) as archive:
        seen = set()
        for entry in archive.getmembers():
            parts = Path(entry.name).parts
            require(parts and parts[0] == 'toolsenabled-installer' and '..' not in parts
                    and not entry.name.startswith('/') and entry.name not in seen
                    and (entry.isfile() or entry.isdir() or entry.issym()), 'Unsafe or duplicate archive member')
            seen.add(entry.name)
            require(not any(part in entry.name for part in ('/payload/node', '/node_modules/npm/',
                    '/node_modules/@openai/codex/', '/node_modules/@anthropic-ai/claude-code/')),
                    'Bundled toolchain/provider is outside the runtime release contract')
        archive.extractall(root, filter='data')
    package = root / 'toolsenabled-installer'
    require({entry.name for entry in package.iterdir()} == {'README.md', 'install.sh', 'manifest.json', 'payload', *HELPERS},
            'Beta3 package files differ from the reviewed layout')
    require({entry.name for entry in (package / 'payload').iterdir()} == {'engine'}, 'Unexpected payload layout')
    require(json.loads((package / 'manifest.json').read_text()) == manifest, 'Extracted release identity differs')
    require(not (package / 'payload/engine/adapters/openshell/soak').exists(), 'Release contains soak harness')
    for name in HELPERS:
        require((package / name).read_bytes() == (package / 'payload/engine/libexec' / name).read_bytes(),
                'Packaged and installed lifecycle helper bytes differ: ' + name)
    readme = (package / 'README.md').read_text()
    require(readme.startswith('# ToolsEnabled Fleet for OpenShell: runtime') and '1.4.2' in readme
            and 'two commands' in readme and 'uninstall --keep-state --archive' in readme,
            'Release README does not describe the reviewed beta3 lifecycle')
    return package


def registration_stub(root, provider):
    # Qualified response shapes; synthetic providers never connect or execute a
    # registered command. Keep registrations in the selected scratch profiles.
    script = r'''#!/usr/bin/python3
import json, os, pathlib, sys
p = PROVIDER
a = sys.argv[1:]
home = pathlib.Path(os.environ['HOME'])
profile = pathlib.Path(os.environ['CODEX_HOME' if p == 'codex' else 'CLAUDE_CONFIG_DIR'])
record = profile / ('config.toml' if p == 'codex' else '.claude.json')
with (home.parent / 'provider-calls.jsonl').open('a') as log: log.write(json.dumps([p, *a]) + '\n')
if a == ['--version']:
    print('codex-cli 0.158.0' if p == 'codex' else '2.1.284 (Claude Code)'); sys.exit(0)
if p == 'codex' and a in (['mcp','get','toolsenabled'], ['mcp','get','toolsenabled','--json']):
    if not record.exists():
        sys.stderr.write("Error: No MCP server named 'toolsenabled' found.\n"); sys.exit(1)
    # This stub owns a one-line JSON record. Fleet may add its reviewed
    # [features] setting to config.toml after registration; the suffix is not
    # part of the stub's metadata response.
    value = json.loads(record.read_text().partition('\n')[0])
    print(json.dumps({'name':'toolsenabled','enabled':True,'disabled_reason':None,
        'transport':{'type':'stdio','command':value['command'],'args':value['args'],'env':value.get('env'), 'env_vars':[], 'cwd':None},
        'enabled_tools':None,'disabled_tools':None,'startup_timeout_sec':None,'tool_timeout_sec':None})); sys.exit(0)
if p == 'codex' and a[:3] == ['mcp','add','toolsenabled'] and '--' in a:
    split = a.index('--'); extra = a[3:split]; environment = {}
    if len(extra) % 2 or len(a) < split + 2: sys.exit(93)
    for i in range(0, len(extra), 2):
        if extra[i] != '--env' or '=' not in extra[i + 1]: sys.exit(93)
        key, value = extra[i + 1].split('=', 1); environment[key] = value
    value = {'command':a[split+1], 'args':a[split+2:], 'env':environment}
elif p == 'claude' and a[:5] == ['mcp','add-json','--scope','user','toolsenabled'] and len(a) == 6:
    value = json.loads(a[5])
elif a == (['mcp','remove','toolsenabled'] if p == 'codex' else ['mcp','remove','--scope','user','toolsenabled']):
    if record.exists(): record.unlink(); sys.exit(0)
    if p == 'claude':
        sys.stderr.write('No MCP server named "toolsenabled" in user scope\n'); sys.exit(1)
    sys.exit(0)
else:
    sys.stderr.write('FIXTURE REFUSED unexpected provider invocation\n'); sys.exit(93)
profile.mkdir(parents=True, exist_ok=True)
record.write_text(json.dumps(value))
'''.replace('PROVIDER', repr(provider))
    target = root / 'commands' / provider
    target.write_text(script)
    target.chmod(0o700)


def beta3_environment(root, node):
    directories = ('home', 'commands', 'temporary', 'services', 'xdg-config', 'xdg-data', 'xdg-state', 'xdg-cache')
    for name in directories:
        (root / name).mkdir(mode=0o700)
    for name, target in (('node', node), ('bash', '/bin/bash'), ('dirname', '/usr/bin/dirname')):
        (root / 'commands' / name).symlink_to(target)
    for provider in ('codex', 'claude'):
        registration_stub(root, provider)
    return {'HOME': str(root / 'home'), 'PATH': str(root / 'commands'), 'USER': 'fleet-artifact-fixture',
            'LANG': 'C', 'LC_ALL': 'C', 'OPENSHELL_SANDBOX': '1', 'TMPDIR': str(root / 'temporary'),
            'CODEX_HOME': str(root / 'codex'), 'CLAUDE_CONFIG_DIR': str(root / 'claude'),
            'TOOLSENABLED_STATE_ROOT': str(root / 'state'), 'LOCALAPPDATA': str(root / 'services'),
            'XDG_CONFIG_HOME': str(root / 'xdg-config'), 'XDG_DATA_HOME': str(root / 'xdg-data'),
            'XDG_STATE_HOME': str(root / 'xdg-state'), 'XDG_CACHE_HOME': str(root / 'xdg-cache'),
            'PYTHONDONTWRITEBYTECODE': '1'}


def snapshot(paths):
    result = {}
    for root in paths:
        entries = [root, *sorted(root.rglob('*'))] if root.exists() else [root]
        for path in entries:
            if not os.path.lexists(path):
                result[str(path)] = ('absent',)
                continue
            info = path.lstat()
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISLNK(info.st_mode):
                result[str(path)] = ('link', mode, os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):
                result[str(path)] = ('directory', mode)
            elif stat.S_ISREG(info.st_mode):
                result[str(path)] = ('file', mode, sha256_file(path))
            else:
                raise GateError('Unexpected special file in owned scratch state')
    return result


def without_fleet_authority(snapshot_value, state_root):
    # A runtime-only upgrade creates its next independently bound ownership
    # record in Fleet state. Preserve the exact comparison for all user state.
    authority = str(state_root / '.fleet-installations')
    return {path: value for path, value in snapshot_value.items()
            if path != authority and not path.startswith(authority + os.sep)}


def require_one_new_fleet_record(before, after, state_root):
    authority = str(state_root / '.fleet-installations')
    previous = {path: value for path, value in before.items()
                if path == authority or path.startswith(authority + os.sep)}
    current = {path: value for path, value in after.items()
               if path == authority or path.startswith(authority + os.sep)}
    require(previous.get(authority) == ('directory', 0o700)
            and all(current.get(path) == value for path, value in previous.items()),
            'Upgrade changed an existing Fleet ownership record')
    added = set(current) - set(previous)
    require(len(added) == 1, 'Upgrade did not add exactly one Fleet ownership record')
    name = Path(added.pop())
    require(str(name.parent) == authority and name.suffix == '.json'
            and current[str(name)][:2] == ('file', 0o600),
            'Upgrade added an unexpected Fleet ownership entry')


def beta3_command(argv, environment, *, expected=0, input_text=None):
    # The strict outer launcher owns descendant custody. On uncertainty retain
    # all scratch and the product's recovery barrier; never infer child cleanup
    # from a direct-child timeout or recursively remove its working directories.
    started = time.monotonic()
    print('COMMAND ' + json.dumps([str(value) for value in argv]), flush=True)
    result = subprocess.run([str(value) for value in argv], env=environment, cwd=environment['HOME'],
                            input=input_text, capture_output=True, text=True, timeout=240)
    print('COMMAND_RESULT ' + json.dumps({'returncode': result.returncode,
          'seconds': round(time.monotonic() - started, 3), 'stdout': result.stdout[-12000:],
          'stderr': result.stderr[-12000:]}), flush=True)
    require(result.returncode == expected,
            f'Artifact command exited {result.returncode}, expected {expected}: {result.stdout[-3000:]} {result.stderr[-3000:]}')
    return result.stdout + result.stderr


def exercise_beta3(package, archive_path, pin, manifest, root, account_home, environment, *, run=beta3_command):
    prefix = root / "Fleet 'quoted' $runtime"
    cli = prefix / 'bin/toolsenabled'
    pins = ['--archive', str(archive_path), '--sha256', pin]
    installer = ['/bin/bash', str(package / 'install.sh')]
    setup = [*installer, '--setup', str(prefix), *pins, '--tier', 'guided', '--providers', 'codex,claude']
    require('Usage:' in run([*installer, '--help'], environment), 'Install help was not readable')
    require('INTEGRITY' in run([*installer, str(prefix)], environment, expected=1), 'Legacy positional setup was accepted')
    installed = run(setup, environment)
    require('COMMITTED' in installed and 'ToolsEnabled Fleet' in installed, 'Setup did not commit')
    require({entry.name for entry in (prefix / 'bin').iterdir()} == {'toolsenabled', 'toolsenabled-openshell'}, 'Installed wrappers differ')
    require((prefix / 'runtime/engine/bin/toolsenabled-openshell.js').read_bytes()
            == (package / 'payload/engine/bin/toolsenabled-openshell.js').read_bytes(), 'Installed entry differs from archive')
    records = list((root / 'services').rglob('machine.json'))
    require(len(records) == 1, 'Expected one real setup machine record')
    machine = json.loads(records[0].read_text())
    require(machine.get('tier') == 'guided' and machine.get('workspaceRoots') == [str(account_home / 'work')],
            'Setup lost explicit tier or dedicated account workspace')
    expected_server = str(prefix / 'runtime/engine/src/mcp-server.js')
    for provider, name in (('codex', 'config.toml'), ('claude', '.claude.json')):
        text = (root / provider / name).read_text()
        registration = json.loads(text.partition('\n')[0] if provider == 'codex' else text)
        require(registration.get('args') == [expected_server], 'Setup did not register the exact installed server')
    require(f"ToolsEnabled Fleet {manifest['version']} ({manifest['source_commit']})" in run([cli, '--version'], environment),
            'Installed version/source identity differs')
    status = run(['/bin/bash', '--noprofile', '--norc', '-c',
                  'source "$1"; command -v toolsenabled; toolsenabled status', 'artifact-check', str(prefix / 'env.sh')], environment)
    require(str(cli) in status and 'Permission level   guided' in status, 'PATH/status did not retain explicit guided setup')
    state = root / 'state'
    state.mkdir(exist_ok=True)
    (state / 'keep.txt').write_text('owned artifact gate state survives\n')
    protected = [state, root / 'services', root / 'codex', root / 'claude', account_home / 'work']
    before = snapshot(protected)
    calls = (root / 'provider-calls.jsonl').read_bytes()
    previous_inode = prefix.stat().st_ino
    upgraded = run([cli, 'upgrade', *pins, '--previous-archive', str(archive_path), '--previous-sha256', pin], environment)
    require('COMMITTED' in upgraded and prefix.stat().st_ino != previous_inode, 'Same-release upgrade did not replace the runtime generation')
    after = snapshot(protected)
    require_one_new_fleet_record(before, after, state)
    require(without_fleet_authority(after, state)
            == without_fleet_authority(before, state),
            'Upgrade changed state, profiles or workspace outside Fleet ownership records')
    require((root / 'provider-calls.jsonl').read_bytes() == calls, 'Runtime-only upgrade invoked a provider')
    require(f"ToolsEnabled Fleet {manifest['version']} ({manifest['source_commit']})" in run([cli, '--version'], environment),
            'Upgraded version/source identity differs')
    before = after
    refused = run([cli, 'uninstall', *pins], environment, expected=1, input_text='yes\n')
    require('Exclusive ownership' in refused and prefix.is_dir(), 'Unproven state purge was not refused')
    require(snapshot(protected) == before and (root / 'provider-calls.jsonl').read_bytes() == calls,
            'Purge refusal mutated state or registrations')
    retained = [state, root / 'services', account_home / 'work']
    before_retained = snapshot(retained)
    run([cli, 'uninstall', '--keep-state', *pins], environment)
    require(not os.path.lexists(prefix) and snapshot(retained) == before_retained, 'Uninstall did not remove only the runtime')
    require(not (root / 'codex/config.toml').exists() and not (root / 'claude/.claude.json').exists(), 'Uninstall kept a selected registration')
    calls_after = (root / 'provider-calls.jsonl').read_bytes()
    refusal = run(setup, environment, expected=1)
    require('SCOPE_EXISTS' in refusal and not os.path.lexists(prefix), 'Retained scope allowed a fresh setup')
    require(snapshot(retained) == before_retained and (root / 'provider-calls.jsonl').read_bytes() == calls_after,
            'Fresh-scope refusal mutated retained state or called providers')
    return {'setup': 'guided/both synthetic registration providers', 'upgrade': 'same exact archive, new runtime generation',
            'uninstall': 'pinned keep-state; selected registrations removed', 'retainedFreshSetup': 'SCOPE_EXISTS',
            'realProviderQualification': False}


def beta3_install_check(archive_path, pin, manifest):
    account_home = require_dedicated_scope(os.environ)
    inherited_umask = os.umask(0o077)
    os.umask(inherited_umask)
    node = shutil.which('node')
    require(node is not None, 'Node is required before this exact artifact gate')
    root = Path(tempfile.mkdtemp(prefix='toolsenabled-beta3-artifact-', dir='/tmp'))
    report = {'archive': str(archive_path), 'sha256': pin, 'manifest': manifest, 'passed': False,
              'uid': os.getuid(), 'euid': os.geteuid(), 'umask': f'{inherited_umask:04o}',
              'retainedScratch': str(root), 'retainedWorkspace': str(account_home / 'work')}
    try:
        package = extract_beta3(archive_path, root, manifest)
        original = snapshot([package])
        environment = beta3_environment(root, node)
        report['coverage'] = exercise_beta3(package, archive_path, pin, manifest, root, account_home, environment)
        require(snapshot([package]) == original and sha256_file(archive_path) == pin,
                'Gate changed archive or extracted source bytes')
        report['passed'] = True
        print('PASS offline installation: beta3 pinned setup, same-release upgrade, PATH/status, keep-state uninstall and SCOPE_EXISTS')
    finally:
        # A separate disposable sandbox/account is required for every run. Even
        # success retains evidence/workspace; no pathname deletion of account data.
        (root / 'artifact-gate-report.json').write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        print('ARTIFACT_GATE ' + json.dumps(report, sort_keys=True), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog='''Beta3 coordinator gate: use a NEW disposable Linux OpenShell sandbox/test account with no accountHome/work.
Set TOOLSENABLED_CANDIDATE_ARCHIVE=/absolute/candidate-9/archive.tar.gz,
TOOLSENABLED_CANDIDATE_SHA256=<independently published pin>, TOOLSENABLED_CANDIDATE_ISOLATED=1,
TOOLSENABLED_CANDIDATE_EXPECT_UID=<actual dedicated UID>, TOOLSENABLED_CANDIDATE_EXPECT_ACCOUNT_HOME=<actual canonical account home>,
and TOOLSENABLED_TEST_STRICT=1, then run: node tests/run-isolated.js --timeout-ms 900000 --summary /owned/evidence/installer.json tests/openshell-candidate-install.test.js.
This runs real per-UID lifecycle locking. Never run it in the owner/current agent account.
Use a separate disposable account for the real-provider gate. Preserve reported scratch/workspace and any pending barrier on failure.
For the umask regression, invoke this gate under umask 0022, 0002 and 0077, each in a separate fresh disposable sandbox/account.
The ARTIFACT_GATE receipt records the actual non-root UID and inherited umask; extraction uses the same Python data filter as the soak.
The source contract suite uses mocks; it does not qualify a release. Legacy archives retain their historical checks.''')
    parser.add_argument('archive', type=Path)
    parser.add_argument('--sha256', default=os.environ.get('TOOLSENABLED_CANDIDATE_SHA256'))
    args = parser.parse_args(argv)
    archive_path = args.archive.resolve(strict=True)
    manifest = inspect_release(archive_path, args.sha256)
    if manifest['version'] == BETA3_VERSION:
        beta3_install_check(archive_path, args.sha256, manifest)
    else:
        legacy_install_check(archive_path)


if __name__ == '__main__':
    try:
        main()
    except (GateError, OSError, ValueError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
