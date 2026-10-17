#!/usr/bin/env python3
"""Explicit host lifecycle. Uses the same pinned, descriptor-bound archive engine.

The entire package is immutable in the installation prefix. Mutable state and
the nonsecret recovery receipt live separately. Never execute an old runtime
during uninstall and never derive deletion authority from that receipt.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
try:
    import fleet_fs as fs
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'openshell'))
    import fleet_fs as fs


class HostError(RuntimeError):
    pass


@contextmanager
def deferred_signals():
    """Finish the current journaled operation before reporting an interrupt."""
    pending, previous = [], {}
    def latch(number, _frame):
        pending.append(number)
    try:
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[number] = signal.signal(number, latch)
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    if pending:
        raise HostError('Host operation was interrupted after its receipt reached a stable state; inspect the receipt before retrying.')


@dataclass
class Options:
    mode: str
    prefix: Path
    archive: Path
    sha256: str
    state_root: Path
    workspace: Path
    workers: bool = False
    tier: str = 'unrestricted'
    pass_env: str | None = None


def absolute(value):
    value = os.fspath(value)
    if (not value.startswith('/') or value == '/' or value.endswith('/') or '//' in value
            or len(value) > 4096 or any(part in ('.', '..') for part in value.split('/'))
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise HostError('Expected an absolute path without dot components or control characters.')
    return Path(value)


def overlaps(a, b):
    return a == b or a in b.parents or b in a.parents


def protected_paths(options):
    # The runtime tree must not overlap state or the workspace. A global
    # workspace is the account home itself, which the tree guard already
    # protects as a home (the tree can never contain it); the runtime then
    # lives under a hidden entry that is outside that workspace.
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=True)
    if options.workspace == account_home:
        return (str(options.state_root),)
    return (str(options.state_root), str(options.workspace))


def validate(options):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise HostError('Host mode currently requires Linux x86_64 (including WSL 2).')
    if os.environ.get('OPENSHELL_SANDBOX') == '1':
        raise HostError('Host mode is a separate install; use the OpenShell edition inside OpenShell.')
    for key in ('prefix', 'archive', 'state_root', 'workspace'):
        setattr(options, key, absolute(getattr(options, key)))
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=True)
    for candidate in (options.workspace, options.workspace.resolve(strict=False)):
        try:
            relative = candidate.relative_to(account_home)
        except ValueError:
            continue
        if relative.parts and relative.parts[0].startswith('.'):
            raise HostError('Choose a project workspace outside the top-level dot folders of your account home.')
    if not re.fullmatch('[a-f0-9]{64}', options.sha256):
        raise HostError('Supply the independently obtained release SHA-256.')
    if options.tier not in ('unrestricted', 'standard', 'guided'):
        raise HostError('Unknown permission level.')
    # A global workspace is the account home minus its hidden top-level entries
    # (the engine's workspace boundary), so a runtime or state folder under a
    # hidden entry such as ~/.local does not overlap it.
    def overlaps_workspace(value):
        if options.workspace == account_home:
            try:
                relative = value.relative_to(account_home)
            except ValueError:
                return overlaps(value, options.workspace)
            return not (relative.parts and relative.parts[0].startswith('.'))
        return overlaps(value, options.workspace)
    if (any(overlaps(options.prefix, value) for value in (options.state_root, options.archive))
            or overlaps_workspace(options.prefix) or overlaps_workspace(options.archive)):
        raise HostError('Runtime, state, workspace and archive paths must not overlap.')
    if overlaps(options.state_root, options.workspace) and overlaps_workspace(options.state_root):
        raise HostError('State and workspace must not overlap.')
    fs.assert_target_safe(str(options.prefix), protected_paths=protected_paths(options),
                          allow_shared_ancestors=True)


def private_directory(path, *, require_private=True):
    """Create owned directories using retained no-follow parents, never chmod old data."""
    path = absolute(path)
    missing, ancestor = [], path
    while not os.path.lexists(ancestor):
        missing.append(ancestor.name)
        ancestor = ancestor.parent
    with fs.SafeDirectory.open(str(ancestor)) as parent:
        parent.revalidate()
    for leaf in reversed(missing):
        with fs.SafeDirectory.open(str(ancestor)) as parent, fs.create_directory(parent, leaf) as created:
            os.fchmod(created.fd, 0o700)
        ancestor = ancestor / leaf
    with fs.SafeDirectory.open(str(path)) as directory:
        value = os.fstat(directory.fd)
        if value.st_uid != os.getuid() or (require_private and stat.S_IMODE(value.st_mode) != 0o700):
            raise HostError('Existing private directory must be owned by you and mode 0700.')
    return path


def read_record(directory, name):
    directory.revalidate()
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory.fd)
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_nlink != 1
                or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > 65536):
            raise HostError('Lifecycle record must be a bounded owned 0600 regular file.')
        data = os.read(fd, 65537)
        if len(data) != st.st_size:
            raise HostError('Lifecycle record changed while reading.')
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise HostError('Duplicate lifecycle record key.')
                result[key] = value
            return result
        result = json.loads(data, object_pairs_hook=pairs)
        directory.revalidate()
        if fs.identity(os.stat(name, dir_fd=directory.fd, follow_symlinks=False)) != fs.identity(st):
            raise HostError('Lifecycle record was substituted.')
        return result
    finally:
        os.close(fd)


def write_record(directory, name, value):
    directory.revalidate()
    data = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    if len(data) > 65536:
        raise HostError('Lifecycle record exceeds its limit.')
    # Validate an existing destination before replacement.
    if name in os.listdir(directory.fd):
        read_record(directory, name)
    temporary = '.' + name + '-' + os.urandom(12).hex()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory.fd)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)
    directory.revalidate()
    os.replace(temporary, name, src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
    os.fsync(directory.fd)


@contextmanager
def locked_state(root, *, create):
    if create:
        private_directory(root)
    with fs.SafeDirectory.open(str(root)) as directory:
        value = os.fstat(directory.fd)
        if value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) != 0o700:
            raise HostError('State must be an owned 0700 directory.')
        fd = os.open('.install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory.fd)
        try:
            value = os.fstat(fd)
            if (not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid()
                    or value.st_nlink != 1 or stat.S_IMODE(value.st_mode) != 0o600):
                raise HostError('Unsafe host lifecycle lock.')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield directory
        finally:
            os.close(fd)


def checked_archive(options):
    archive = fs.VerifiedArchive.open(str(options.archive), options.sha256)
    try:
        manifest = json.loads(archive.read_bytes('toolsenabled-installer/manifest.json'))
        if manifest.get('name') != 'toolsenabled-host' or manifest.get('mode') != 'host':
            raise HostError('This is not an explicit host-mode archive.')
        for name, entry in archive.package_inventory.entries.items():
            if entry.kind == 'dir' and entry.mode != 0o700:
                raise HostError('Host archive directories must be private (0700).')
            if entry.kind == 'file' and entry.mode not in (0o600, 0o700):
                raise HostError('Host archive files must be private (0600 or executable 0700).')
        return archive
    except BaseException:
        archive.close()
        raise


def runtime_config(options, node):
    return dict(schemaVersion=1, mode='host', workers=options.workers, tier=options.tier,
                workspace=str(options.workspace), stateRoot=str(options.state_root),
                installRoot=str(options.prefix / 'toolsenabled-installer/payload/engine'), nodePath=node)


def initialize_runtime(config, pass_env=()):
    result = subprocess.run([config['nodePath'], str(Path(config['installRoot']) / 'bin/toolsenabled-host.js'),
                             'setup', '--state-root', config['stateRoot'], '--pass-env', ','.join(pass_env)],
                            env={**os.environ, 'TOOLSENABLED_RUNTIME_MODE': 'host'},
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
    if result.returncode:
        if b'LINUX_PROCESS_NATIVE_UNAVAILABLE:' in result.stderr:
            raise HostError(WORKER_NATIVE_REFUSAL)
        raise HostError('Host runtime initialization failed; retained runtime and receipt for inspection.')
    sys.stdout.write(result.stdout.decode('utf-8'))


WORKER_NATIVE_REFUSAL = ('LINUX_PROCESS_NATIVE_UNAVAILABLE: Host workers need Linux 5.3+ with pidfd_open; '
                         'this system lacks or blocks the required native process support.')


def check_worker_native():
    # This is the verified staging package's helper, checked before creating
    # runtime/state or changing a provider registration. It admits no command.
    helper = Path(__file__).resolve().parent / 'payload/engine/src/lib/linux-process-supervisor.py'
    try:
        result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-B', str(helper), '--probe'],
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=5)
        if result.returncode == 0 and result.stdout == b'{"available":true,"backend":"linux-subreaper-pidfd-v2"}\n':
            return
    except (OSError, subprocess.SubprocessError):
        pass
    raise HostError(WORKER_NATIVE_REFUSAL)


def check_node(node):
    result = subprocess.run([node, '--version'], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, timeout=10)
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)\s*', result.stdout)
    if result.returncode or not match or tuple(map(int, match.groups())) < (22, 19, 0):
        raise HostError('Install Node.js 22.19.0 or newer first.')


def install(options, *, registration=None, initialize=initialize_runtime, node=None):
    with deferred_signals():
        return _install(options, registration=registration, initialize=initialize, node=node)


def _install(options, *, registration=None, initialize=initialize_runtime, node=None):
    validate(options)
    if registration is None:
        import host_registration as registration
    if hasattr(registration, 'set_registry_root'):
        registration.set_registry_root(str(options.state_root / 'capability'))
    node = node or shutil.which('node')
    if not node:
        raise HostError('Install Node.js 22.19.0 or newer first.')
    node = str(absolute(node))
    check_node(node)
    names = registration.pass_env_names(options.pass_env or '') if hasattr(registration, 'pass_env_names') else []
    providers = registration.discover()
    if not providers:
        raise HostError('Install an agent CLI described in config/agents first.')
    with checked_archive(options) as archive:
        if os.path.lexists(options.prefix):
            raise HostError('The host runtime prefix already exists; retain it and inspect before reinstalling.')
        if options.workers:
            check_worker_native()
        config = runtime_config(options, node)
        records = []
        for provider in providers:
            args = [str(Path(config['installRoot']) / 'bin/toolsenabled-host.js'), 'serve',
                    '--state-root', config['stateRoot'], '--actor', provider]
            record = registration.make_record(provider, node, args, **({'pass_env': names} if hasattr(registration, 'pass_env_names') else {}))
            if overlaps(absolute(record['configPath']), options.prefix) or overlaps(absolute(record['configPath']), options.state_root):
                raise HostError('CLI configuration cannot overlap runtime or host state.')
            if registration.preflight(record) != 'absent':
                raise HostError('A Fleet host registration already exists; no configuration was replaced.')
            records.append(record)
        # Archive and all provider collisions are checked before any mutation.
        private_directory(options.prefix.parent, require_private=False)
        with locked_state(options.state_root, create=True) as state:
            if 'install-receipt.json' in os.listdir(state.fd):
                previous = read_record(state, 'install-receipt.json')
                if previous.get('status') != 'uninstalled':
                    raise HostError('Previous host lifecycle is unfinished; retain its receipt and runtime.')
            receipt = dict(schemaVersion=1, mode='host', status='materializing', prefix=str(options.prefix),
                           stateRoot=str(options.state_root), workspace=str(options.workspace),
                           sha256=options.sha256, registrations=records, outcomes={})
            write_record(state, 'install-receipt.json', receipt)
            with fs.SafeDirectory.open(str(options.prefix.parent)) as parent, fs.create_directory(parent, options.prefix.name) as target:
                receipt['rootIdentity'] = dict(target.identity)
                write_record(state, 'install-receipt.json', receipt)
                fs.extract_archive(archive, target, allow_shared_ancestors=True)
                write_record(state, 'host-mode.json', config)
                receipt['status'] = 'runtime-ready'
                write_record(state, 'install-receipt.json', receipt)
                if initialize is initialize_runtime:
                    initialize(config, names)
                else:
                    initialize(config)
                fs.verify_tree(target, archive.package_inventory, allow_shared_ancestors=True)
                for record in records:
                    receipt['status'] = 'registration-pending'
                    receipt['outcomes'][record['provider']] = 'unknown'
                    write_record(state, 'install-receipt.json', receipt)
                    receipt['outcomes'][record['provider']] = registration.register(record)
                    write_record(state, 'install-receipt.json', receipt)
                receipt['status'] = 'installed'
                write_record(state, 'install-receipt.json', receipt)
                return receipt


def uninstall(options, *, registration=None):
    with deferred_signals():
        return _uninstall(options, registration=registration)


def _uninstall(options, *, registration=None):
    validate(options)
    if registration is None:
        import host_registration as registration
    if hasattr(registration, 'set_registry_root'):
        registration.set_registry_root(str(options.state_root / 'capability'))
    with checked_archive(options) as archive, locked_state(options.state_root, create=False) as state:
        receipt = read_record(state, 'install-receipt.json')
        fields = {'schemaVersion', 'mode', 'status', 'prefix', 'stateRoot', 'workspace',
                  'sha256', 'registrations', 'outcomes', 'rootIdentity'}
        if (not isinstance(receipt, dict) or set(receipt) != fields
                or type(receipt['schemaVersion']) is not int or receipt['schemaVersion'] != 1
                or receipt['status'] not in ('runtime-ready', 'registration-pending', 'installed',
                                            'removal-pending', 'cleanup-pending', 'uninstalled')):
            raise HostError('Invalid or incomplete host installation receipt; retain files for inspection.')
        if (receipt.get('mode') != 'host' or receipt.get('prefix') != str(options.prefix)
                or receipt.get('stateRoot') != str(options.state_root) or receipt.get('sha256') != options.sha256
                or receipt.get('workspace') != str(options.workspace)):
            raise HostError('Receipt does not match this host installation and pinned archive.')
        config = read_record(state, 'host-mode.json')
        node = shutil.which('node')
        if (not isinstance(config, dict) or not isinstance(config.get('nodePath'), str) or not node
                or os.path.realpath(config['nodePath']) != os.path.realpath(node)):
            raise HostError('Use the original Node executable when removing this host installation.')
        expected_config = runtime_config(options, config.get('nodePath'))
        # State is retained user data, not permission to operate on arbitrary
        # provider files. Derive the entry again from the requested installation
        # and this invocation's explicit HOME / provider profile selection.
        if (config.get('mode') != 'host' or any(config.get(key) != expected_config[key]
                for key in ('stateRoot', 'installRoot', 'workspace'))):
            raise HostError('Host configuration does not match the runtime being removed.')
        registrations = receipt.get('registrations')
        if not isinstance(registrations, list) or not 1 <= len(registrations) <= 64:
            raise HostError('Invalid registration history.')
        seen = set()
        for record in registrations:
            if not isinstance(record, dict):
                raise HostError('Invalid registration ownership record.')
            provider = record.get('provider')
            if not isinstance(provider, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', provider) or provider in seen:
                raise HostError('Invalid registration provider history.')
            seen.add(provider)
            args = [str(Path(expected_config['installRoot']) / 'bin/toolsenabled-host.js'), 'serve',
                    '--state-root', str(options.state_root), '--actor', provider]
            expected = registration.make_record(provider, config['nodePath'], args, **({'pass_env': record.get('passEnv')} if hasattr(registration, 'pass_env_names') else {}))
            if record != expected:
                raise HostError('Registration receipt does not match this runtime and current provider profiles.')
        outcomes = receipt.get('outcomes')
        if (not isinstance(outcomes, dict) or not set(outcomes) <= seen
                or any(value not in ('unknown', 'added', 'present', 'removed', 'absent') for value in outcomes.values())):
            raise HostError('Invalid registration progress history.')
        if receipt['status'] == 'uninstalled':
            if os.path.lexists(options.prefix) or any(registration.inspect(record) != 'absent' for record in registrations):
                raise HostError('A previously removed runtime or registration reappeared; retain it for inspection.')
            return receipt
        if receipt['status'] == 'cleanup-pending' and not os.path.lexists(options.prefix):
            if any(registration.inspect(record) != 'absent' for record in registrations):
                raise HostError('Runtime is absent but a selected registration remains; retain the cleanup receipt.')
            receipt['status'] = 'uninstalled'
            write_record(state, 'install-receipt.json', receipt)
            return receipt
        with fs.SafeDirectory.open(str(options.prefix.parent)) as parent, fs.RetainedTree(
                parent, options.prefix.name, archive.package_inventory, receipt.get('rootIdentity'),
                protected_paths=protected_paths(options), allow_shared_ancestors=True) as held:
            # Terminal setup may have added a newly installed described agent
            # since this receipt was created. Prove those entries too before
            # deleting the runtime; a changed or uninspectable entry retains it.
            if hasattr(registration, 'current_records'):
                receipt['registrations'] = registration.current_records(receipt['registrations'], str(options.state_root), config['installRoot'], config['nodePath'])
                seen = {record['provider'] for record in receipt['registrations']}
            if hasattr(registration, 'descriptors'):
                for provider, agent in registration.descriptors().items():
                    if provider in seen or agent['register']['kind'] == 'none':
                        continue
                    args = [str(Path(expected_config['installRoot']) / 'bin/toolsenabled-host.js'), 'serve',
                            '--state-root', str(options.state_root), '--actor', provider]
                    additional = registration.make_record(provider, config['nodePath'], args)
                    if overlaps(absolute(additional['configPath']), options.prefix) or overlaps(absolute(additional['configPath']), options.state_root):
                        raise HostError('CLI configuration cannot overlap runtime or host state.')
                    if registration.inspect(additional) == 'present':
                        receipt['registrations'].append(additional)
                        seen.add(provider)
                write_record(state, 'install-receipt.json', receipt)
            for record in receipt['registrations']:
                registration.inspect(record)
            for record in receipt['registrations']:
                held.revalidate()
                receipt['status'] = 'removal-pending'
                receipt['outcomes'][record['provider']] = 'unknown'
                write_record(state, 'install-receipt.json', receipt)
                receipt['outcomes'][record['provider']] = registration.remove(record)
                write_record(state, 'install-receipt.json', receipt)
            held.revalidate()
            receipt['status'] = 'cleanup-pending'
            write_record(state, 'install-receipt.json', receipt)
            result = held.remove()
            if not result.complete:
                raise HostError('Runtime cleanup was incomplete; state and the remaining runtime were retained.')
            receipt['status'] = 'uninstalled'
            write_record(state, 'install-receipt.json', receipt)
            return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description='ToolsEnabled Fleet explicit host installation (stdio MCP).')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--host', action='store_true')
    mode.add_argument('--uninstall', action='store_true')
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--prefix', default=str(Path.home() / '.local/toolsenabled-host'))
    parser.add_argument('--state-root', default=str(Path.home() / '.toolsenabled-host'))
    parser.add_argument('--workspace', default=str(Path.home() / 'work'))
    parser.add_argument('--enable-workers', action='store_true', help='Experimental workers require Linux 5.3+ with pidfd_open. Workers inherit how you started your agent, minus role limits; the optional tier only narrows Fleet tools.')
    parser.add_argument('--pass-env', default=None, help='Comma-separated environment names the lead may forward to Fleet; values are never saved.')
    parser.add_argument('--tier', choices=('unrestricted', 'standard', 'guided'), default='unrestricted', help="Optional: narrow Fleet tools further; unrestricted adds no cap.")
    args = parser.parse_args(argv)
    options = Options('host' if args.host else 'uninstall', Path(args.prefix), Path(args.archive),
                      args.sha256, Path(args.state_root), Path(args.workspace), args.enable_workers, args.tier, args.pass_env)
    os.umask(0o077)
    validate(options)
    # The command itself must come from the independently verified extraction.
    with checked_archive(options) as archive, fs.SafeDirectory.open(str(Path(__file__).resolve().parent.parent)) as stage:
        if Path(__file__).resolve().parent.name != 'toolsenabled-installer':
            raise HostError('Run the host entry from a privately extracted verified release archive.')
        fs.verify_extracted_package(stage, archive, allow_shared_ancestors=True)
    if args.enable_workers:
        print("WARNING: Experimental host workers run as your user. Workers inherit how you started your agent, minus role limits; the optional tier only narrows Fleet tools. Linux 5.3+ with pidfd_open is required. Fleet does not hold CLI credentials.", file=sys.stderr)
    result = install(options) if args.host else uninstall(options)
    print('ToolsEnabled Fleet host mode: ' + result['status'] + '.')
    print('State retained at ' + str(options.state_root))
    if args.host:
        print('Command: ' + str(options.prefix / 'toolsenabled-installer/toolsenabled'))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, fs.FleetFSError, OSError, ValueError, subprocess.SubprocessError) as error:
        print('HOST: ' + str(error), file=sys.stderr)
        sys.exit(1)
