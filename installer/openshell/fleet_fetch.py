#!/usr/bin/env python3
"""Release-specific Fleet host fetcher; render before use. Linux/WSL only.

Host Python >=3.9 and working Linux pidfds are provisional prerequisites until
the release's prerequisite review is approved. No live-host qualification is
implied by the synthetic tests. No remote exec, policy or provider operation.
"""
# BEGIN BOOTSTRAP CORE
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time


class FetchError(Exception):
    def __init__(self, phase, message, attempted=False):
        super().__init__(message)
        self.phase = phase
        self.attempted = attempted


def escaped(value, limit=2048):
    return json.dumps(str(value)[:limit], ensure_ascii=True)


class HostInterrupted(KeyboardInterrupt):
    def __init__(self, message, attempted=False):
        super().__init__(message)
        self.attempted = attempted


class Cancellation:
    def __init__(self):
        self.number = None

    def latch(self, number, _frame):
        self.number = self.number or number

    def checkpoint(self, attempted=False):
        if self.number is not None:
            raise HostInterrupted('Host signal ' + str(self.number), attempted=attempted)


_host_cancellation = None


def cancellation_checkpoint(attempted=False):
    if _host_cancellation is not None:
        _host_cancellation.checkpoint(attempted)


@contextlib.contextmanager
def host_signals():
    # Catchable cancellation must not interrupt Popen's return/assignment,
    # descriptor cleanup, or outcome recording. No mask reaches the child.
    global _host_cancellation
    if _host_cancellation is not None:
        yield _host_cancellation
        return
    cancellation, previous = Cancellation(), {}
    try:
        _host_cancellation = cancellation
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[number] = signal.signal(number, cancellation.latch)
        yield cancellation
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        _host_cancellation = None
    # Check after cleanup/handler restoration as well; preserve a primary
    # exception on exceptional exit. SIGKILL remains outside this contract.
    cancellation.checkpoint()


def require_pidfds():
    if sys.platform != 'linux' or sys.version_info < (3, 9):
        raise FetchError('PREFLIGHT', 'Linux/WSL with Python 3.9 or later is required')
    if not callable(getattr(os, 'pidfd_open', None)) or not callable(getattr(signal, 'pidfd_send_signal', None)):
        raise FetchError('PREFLIGHT', 'Python and kernel pidfd support is required')
    if not callable(getattr(os, 'waitid', None)) or not all(hasattr(os, name) for name in ('P_PID', 'WEXITED', 'WNOHANG', 'WNOWAIT')):
        raise FetchError('PREFLIGHT', 'Non-reaping child status observation is required')
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise FetchError('PREFLIGHT', 'Default SIGCHLD handling is required to retain child ownership')
    fd = None
    try:
        fd = os.pidfd_open(os.getpid())
        signal.pidfd_send_signal(fd, 0)
    except OSError as error:
        raise FetchError('PREFLIGHT', 'Working kernel pidfds are required; no PID-only fallback') from error
    finally:
        if fd is not None:
            os.close(fd)


def identity(pid):
    try:
        value = Path('/proc', str(pid), 'stat').read_text()
        fields = value[value.rindex(')') + 2:].split()
        return (int(fields[19]), int(fields[2]), int(fields[3]), fields[0])
    except FileNotFoundError:
        return None


def owned_members(pid, birth):
    result = {}
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            observed = identity(int(entry.name))
            if observed and observed[3] != 'Z' and observed[1:3] == (pid, pid):
                if observed[0] < birth:
                    raise FetchError('CLEANUP', 'Owned process-session identity changed')
                result[int(entry.name)] = observed
    return result


def signal_owned(pid, expected, sig):
    fd = None
    try:
        current = identity(pid)
        if current is None or current[:3] != expected[:3]:
            return
        fd = os.pidfd_open(pid)
        current = identity(pid)
        if current is None or current[:3] != expected[:3]:
            return
        signal.pidfd_send_signal(fd, sig)
    except ProcessLookupError:
        pass
    finally:
        if fd is not None:
            os.close(fd)


def cleanup_owned(child, birth):
    deadline = time.monotonic() + 20
    soft_until = time.monotonic() + 1
    while True:
        members = owned_members(child.pid, birth)
        if not members:
            child.wait(timeout=max(0.01, deadline - time.monotonic()))
            return
        if time.monotonic() >= deadline:
            raise FetchError('CLEANUP', 'Owned command children survived cleanup; local evidence retained')
        for pid, expected in members.items():
            signal_owned(pid, expected, signal.SIGTERM if time.monotonic() < soft_until else signal.SIGKILL)
        time.sleep(0.025)


def run_owned(argv, env, cwd, timeout, max_stdout=262144, max_stderr=65536, sink=None):
    """Bound both streams independently, retain identity, and clean owned session.

    This supervises ordinary OpenShell/curl child sessions. It does not claim
    control of remote processes or of deliberately daemonized hostile children.
    """
    with host_signals() as cancellation:
        return _run_owned(argv, env, cwd, timeout, max_stdout, max_stderr, sink, cancellation)


def _run_owned(argv, env, cwd, timeout, max_stdout, max_stderr, sink, cancellation):
    child = None
    birth = None
    leader_fd = None
    streams = None
    members_settled = False
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    counts = {'stdout': 0, 'stderr': 0}
    deadline = time.monotonic() + timeout
    try:
        require_pidfds()
        cancellation.checkpoint()
        child = subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        # Keep the direct child unreaped until every owned-session check is
        # complete. Its zombie reserves the PID/session number after exit;
        # a pidfd alone does not reserve that numeric identity after reaping.
        leader_fd = os.pidfd_open(child.pid)
        observed = identity(child.pid)
        if not observed or observed[1:3] != (child.pid, child.pid):
            raise FetchError('PROCESS', 'Cannot bind launched command to its private session', attempted=True)
        birth = observed[0]
        cancellation.checkpoint(attempted=True)
        streams = selectors.DefaultSelector()
        for label, pipe in [('stdout', child.stdout), ('stderr', child.stderr)]:
            os.set_blocking(pipe.fileno(), False)
            streams.register(pipe, selectors.EVENT_READ, label)
        exited = False
        while True:
            cancellation.checkpoint(attempted=True)
            if not exited:
                observed_exit = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                exited = observed_exit is not None and observed_exit.si_pid == child.pid
            if exited and not streams.get_map():
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FetchError('TIMEOUT', 'Command deadline reached', attempted=True)
            for key, _ in streams.select(min(remaining, 0.05)):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                label = key.data
                counts[label] += len(chunk)
                if counts[label] > (max_stdout if label == 'stdout' else max_stderr):
                    raise FetchError('OUTPUT_LIMIT', 'Command output limit exceeded', attempted=True)
                if label == 'stdout' and sink is not None:
                    sink.write(chunk)
                else:
                    output[label].extend(chunk)
        if owned_members(child.pid, birth):
            raise FetchError('PROCESS', 'Command exited with owned children', attempted=True)
        members_settled = True
        status = child.wait(timeout=20)
        cancellation.checkpoint(attempted=True)
    except BaseException as error:
        try:
            if child is None:
                pass
            elif members_settled:
                # No session scans/signals may occur after the final reap.
                child.wait(timeout=20)
            elif birth is not None:
                cleanup_owned(child, birth)
            else:
                # The direct Popen child has not been polled/reaped; use its pidfd.
                if leader_fd is None:
                    leader_fd = os.pidfd_open(child.pid)
                signal.pidfd_send_signal(leader_fd, signal.SIGKILL)
                child.wait(timeout=20)
        except Exception as cleanup_error:
            raise FetchError('CLEANUP', 'Owned command cleanup was not verified', attempted=True) from cleanup_error
        if isinstance(error, KeyboardInterrupt):
            raise HostInterrupted(str(error), attempted=child is not None) from error
        if isinstance(error, (FetchError, KeyboardInterrupt, SystemExit)):
            raise
        raise FetchError('PROCESS', 'Command launch or I/O failed', attempted=child is not None) from error
    finally:
        closing = ([streams.close] if streams is not None else [])
        if leader_fd is not None:
            closing.append(lambda: os.close(leader_fd))
        if child is not None:
            closing.extend([child.stdout.close, child.stderr.close])
        close_error = None
        for close in closing:
            try:
                close()
            except BaseException as error:
                close_error = error
        if close_error is not None:
            raise FetchError('CLEANUP', 'Owned command descriptor cleanup failed', attempted=child is not None) from close_error
    cancellation.checkpoint(attempted=True)
    return status, bytes(output['stdout']), bytes(output['stderr'])


def download(url, target, ceiling, curl, env, cwd, runner=run_owned):
    """Fresh bounded attempts; independently cap bodies without Content-Length."""
    deadline = time.monotonic() + 180
    for attempt in range(3):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchError('DOWNLOAD', 'Download deadline reached')
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created = os.fstat(fd)
        try:
            with os.fdopen(fd, 'wb') as sink:
                result = runner([curl, '-q', '--fail', '--silent', '--show-error', '--location',
                                 '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '3',
                                 '--connect-timeout', '15', '--max-time', str(max(1, math.ceil(remaining))),
                                 '--retry', '0', '--max-filesize', str(ceiling), '--url', url],
                                env, cwd, remaining, max_stdout=ceiling, sink=sink)
                sink.flush()
                os.fsync(sink.fileno())
            if result[0] == 0:
                return
            if result[0] not in (5, 6, 7, 18, 22, 28, 35, 52, 56) or attempt == 2:
                raise FetchError('DOWNLOAD', 'HTTPS download failed, exit ' + str(result[0]))
        except FetchError as error:
            if error.phase == 'CLEANUP':
                raise
            raise FetchError('DOWNLOAD', str(error)) from error
        current = os.lstat(target)
        if (current.st_dev, current.st_ino) != (created.st_dev, created.st_ino) or not stat.S_ISREG(current.st_mode):
            raise FetchError('INTEGRITY', 'Owned download file changed before retry')
        os.unlink(target)


def digest_file(path, ceiling):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > ceiling:
            raise FetchError('INTEGRITY', 'Downloaded file identity/type/size is invalid')
        digest = hashlib.sha256()
        size = 0
        with os.fdopen(os.dup(fd), 'rb') as source:
            for chunk in iter(lambda: source.read(65536), b''):
                size += len(chunk)
                if size > ceiling:
                    raise FetchError('INTEGRITY', 'Downloaded file exceeded byte limit')
                digest.update(chunk)
        return digest.hexdigest()
    finally:
        os.close(fd)
# END BOOTSTRAP CORE

import re
import secrets
import shlex
import shutil
import unicodedata
from urllib.parse import urlsplit

# Renderer replaces these exact assignments. Unrendered source is not runnable.
RELEASE = None  # RELEASE_PINS
SANDBOX_BOOTSTRAP = None  # SANDBOX_BOOTSTRAP_SOURCE


class UploadSnapshot:
    """Pinned private upload input, kept open through the transport decision.

    OpenShell accepts a pathname, not a supplied descriptor. The trusted,
    quiescent host boundary still applies; this is not same-uid attacker
    exclusion. Revalidate the retained file and path immediately before use.
    """
    def __init__(self, root, source, pins):
        self.root, self.path = Path(root), Path(root) / 'upload' / pins['archive']
        self.name, self.pins = pins['archive'], pins
        self.root_fd = self.dir_fd = self.fd = None
        try:
            self.root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.root_info = os.fstat(self.root_fd)
            os.mkdir('upload', 0o700, dir_fd=self.root_fd)
            self.dir_fd = os.open('upload', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.root_fd)
            self.dir_info = os.fstat(self.dir_fd)
            source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                info = os.fstat(source_fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_size > pins['max_archive_bytes']:
                    raise FetchError('INTEGRITY', 'Archive download cannot become an owned snapshot')
                writer = os.open(self.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400, dir_fd=self.dir_fd)
                try:
                    size = 0
                    while True:
                        cancellation_checkpoint()
                        chunk = os.read(source_fd, 65536)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > pins['max_archive_bytes']:
                            raise FetchError('INTEGRITY', 'Upload snapshot exceeds the archive ceiling')
                        view = memoryview(chunk)
                        while view:
                            written = os.write(writer, view)
                            if written <= 0:
                                raise FetchError('INTEGRITY', 'Upload snapshot copy did not progress')
                            view = view[written:]
                    os.fsync(writer)
                    self.info = os.fstat(writer)
                finally:
                    os.close(writer)
            finally:
                os.close(source_fd)
            self.fd = os.open(self.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.dir_fd)
            self.verify()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def file_identity(info):
        return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def verify_paths(self):
        for current, held, expected in ((os.lstat(self.root), os.fstat(self.root_fd), self.root_info),
                (os.stat('upload', dir_fd=self.root_fd, follow_symlinks=False), os.fstat(self.dir_fd), self.dir_info)):
            for info in (current, held):
                if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700
                        or (info.st_dev, info.st_ino) != (expected.st_dev, expected.st_ino)):
                    raise FetchError('INTEGRITY', 'Private upload snapshot directory changed')
        for info in (os.fstat(self.fd), os.stat(self.name, dir_fd=self.dir_fd, follow_symlinks=False)):
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o400 or info.st_uid != os.getuid()
                    or info.st_nlink != 1 or self.file_identity(info) != self.file_identity(self.info)):
                raise FetchError('INTEGRITY', 'Upload snapshot identity, mode or size changed')

    def verify(self):
        try:
            self.verify_paths()
            os.lseek(self.fd, 0, os.SEEK_SET)
            digest, size = hashlib.sha256(), 0
            while True:
                cancellation_checkpoint()
                chunk = os.read(self.fd, 65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > self.pins['max_archive_bytes']:
                    raise FetchError('INTEGRITY', 'Upload snapshot exceeds archive ceiling')
                digest.update(chunk)
            self.verify_paths()
            if size != self.info.st_size or digest.hexdigest() != self.pins['sha256']:
                raise FetchError('INTEGRITY', 'Upload snapshot bytes do not equal the embedded release pin')
        except OSError as error:
            raise FetchError('INTEGRITY', 'Upload snapshot path or descriptor is unavailable') from error

    def remove(self):
        self.verify_paths()
        if os.listdir(self.dir_fd) != [self.name]:
            raise FetchError('CLEANUP', 'Unexpected snapshot entries; local evidence retained')
        os.unlink(self.name, dir_fd=self.dir_fd)
        os.rmdir('upload', dir_fd=self.root_fd)

    def close(self):
        error = None
        for name in ('fd', 'dir_fd', 'root_fd'):
            fd = getattr(self, name)
            if fd is not None:
                setattr(self, name, None)
                try:
                    os.close(fd)
                except OSError as problem:
                    error = problem
        if error is not None:
            raise FetchError('CLEANUP', 'Upload snapshot descriptor cleanup failed') from error


def validate_release(pins):
    required = {'base_url', 'tag', 'archive', 'sha256', 'source', 'version', 'max_archive_bytes', 'max_checksums_bytes'}
    if not isinstance(pins, dict) or set(pins) != required:
        raise FetchError('PREFLIGHT', 'Use a reviewed release-specific rendered helper')
    if not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+', pins['base_url']):
        raise FetchError('PREFLIGHT', 'Release URL must be a fixed public GitHub release')
    if pins['base_url'].rsplit('/', 1)[-1] != pins['tag'] or pins['tag'].lower() in ('latest', 'main', 'master', 'head'):
        raise FetchError('PREFLIGHT', 'Release tag is not a fixed reviewed tag')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.tar\.gz', pins['archive']):
        raise FetchError('PREFLIGHT', 'Invalid pinned archive basename')
    if not re.fullmatch(r'[a-f0-9]{64}', pins['sha256']) or not re.fullmatch(r'[a-f0-9]{40}', pins['source']):
        raise FetchError('PREFLIGHT', 'Invalid release digest or source pin')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', pins['version']):
        raise FetchError('PREFLIGHT', 'Invalid release version')
    for name, ceiling in [('max_archive_bytes', 256 * 1024 * 1024), ('max_checksums_bytes', 65536)]:
        if type(pins[name]) is not int or not 1 <= pins[name] <= ceiling:
            raise FetchError('PREFLIGHT', 'Invalid release byte ceiling')


def parse_arguments(argv):
    values = {'workspace': 'default', 'prefix': None, 'tier': 'unrestricted', 'providers': 'codex,claude', 'upgrade': False}
    seen = set()
    while argv:
        flag, *argv = argv
        if flag not in ('--gateway', '--sandbox', '--workspace', '--prefix', '--tier', '--providers', '--upgrade') or flag in seen:
            raise FetchError('USAGE', 'Unknown or repeated option')
        seen.add(flag)
        name = flag[2:]
        if flag == '--upgrade':
            values[name] = True
            continue
        if not argv or not argv[0] or argv[0].startswith('-'):
            raise FetchError('USAGE', 'Missing option value')
        value, *argv = argv
        if len(value) > 4096 or any(unicodedata.category(char).startswith('C') for char in value):
            raise FetchError('USAGE', 'Invalid option value')
        values[name] = value
    for name in ('gateway', 'sandbox', 'workspace'):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', values.get(name, '')):
            raise FetchError('USAGE', 'Explicit bounded gateway, workspace and sandbox names are required')
    if values['prefix'] is not None and (not values['prefix'].startswith('/') or any(piece in ('.', '..') for piece in values['prefix'].split('/'))):
        raise FetchError('USAGE', 'Prefix must be an absolute sandbox path without dot components')
    if values['tier'] not in ('unrestricted', 'standard', 'guided') or values['providers'] not in ('codex,claude', 'codex', 'claude'):
        raise FetchError('USAGE', 'Invalid tier or providers')
    if values['upgrade'] and seen.intersection({'--tier', '--providers'}):
        raise FetchError('USAGE', 'Tier and providers apply only to fresh installs')
    return values


def cli_environment(base):
    # Preserve only ordinary local CLI context; never pass routing/insecure
    # overrides or model/provider credentials, and never forward env remotely.
    names = ('HOME', 'PATH', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR')
    return {**{name: base[name] for name in names if name in base}, 'LANG': 'C', 'LC_ALL': 'C', 'NO_COLOR': '1'}


def curl_environment(base):
    return {'PATH': base.get('PATH', ''), 'LANG': 'C', 'LC_ALL': 'C'}


def strict_json(data):
    def pairs(entries):
        value = {}
        for key, item in entries:
            if key in value:
                raise ValueError('duplicate key')
            value[key] = item
        return value
    try:
        value = json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                           parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite number')))
        if not isinstance(value, dict):
            raise ValueError('not an object')
        return value
    except (UnicodeError, ValueError, RecursionError) as error:
        raise FetchError('TARGET', 'Target metadata is not a bounded unique-key JSON object') from error


def target_identity(status_data, sandbox_data, choices):
    status, sandbox = strict_json(status_data), strict_json(sandbox_data)
    endpoint = status.get('server')
    if not isinstance(endpoint, str) or len(endpoint) > 2048 or any(ord(c) <= 32 or ord(c) >= 127 for c in endpoint):
        raise FetchError('TARGET', 'Gateway endpoint metadata is invalid')
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError as error:
        raise FetchError('TARGET', 'Gateway port is invalid') from error
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or parsed.path not in ('', '/') or port == 0:
        raise FetchError('TARGET', 'A verified unambiguous HTTPS gateway endpoint is required')
    auth = status.get('authentication')
    if status.get('gateway') != choices['gateway'] or status.get('status') != 'connected' or not isinstance(auth, dict) or auth.get('status') != 'authenticated':
        raise FetchError('TARGET', 'Gateway identity, connectivity or authentication is unverified')
    identity_value = sandbox.get('id')
    if not isinstance(identity_value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', identity_value):
        raise FetchError('TARGET', 'Sandbox identity is missing or invalid')
    if sandbox.get('name') != choices['sandbox'] or sandbox.get('workspace') != choices['workspace'] or sandbox.get('phase') != 'Ready':
        raise FetchError('TARGET', 'Exact target is missing, outside the namespace or not Ready')
    return {'gateway': choices['gateway'], 'endpoint': endpoint, 'workspace': choices['workspace'],
            'sandbox': choices['sandbox'], 'id': identity_value, 'phase': 'Ready'}


def checksums_match(data, basename, expected):
    try:
        lines = data.decode('ascii').splitlines()
    except UnicodeError as error:
        raise FetchError('INTEGRITY', 'Checksum list is not ASCII') from error
    entries = {}
    for line in lines:
        match = re.fullmatch(r'([a-f0-9]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]{0,127})', line)
        if not match or match[2] in entries or match[2] in ('.', '..'):
            raise FetchError('INTEGRITY', 'Malformed, duplicate or path-bearing checksum entry')
        entries[match[2]] = match[1]
    if entries.get(basename) != expected:
        raise FetchError('INTEGRITY', 'Release checksum does not equal the embedded archive pin')


def sandbox_command(choices, remote_archive, pins, bootstrap):
    if not isinstance(bootstrap, str) or not bootstrap.strip():
        raise FetchError('PREFLIGHT', 'Reviewed sandbox bootstrap source was not embedded')
    prefix = shlex.quote(choices['prefix']) if choices['prefix'] else '"${HOME:?HOME is required}/.local/toolsenabled"'
    args = ['python3', '-I', '-c', bootstrap, '--archive', remote_archive, '--sha256', pins['sha256'],
            '--source', pins['source'], '--version', pins['version'], '--mode', 'upgrade' if choices['upgrade'] else 'fresh']
    if not choices['upgrade']:
        args.extend(['--tier', choices['tier'], '--providers', choices['providers']])
    # Function-local variables do not pollute the user's shell; source executes
    # within that same Bash function/shell, so the installed PATH remains set.
    return ('function _fleet_verified_install() { local fleet_install_prefix=' + prefix + '; '
            + shlex.join(args) + ' --prefix "$fleet_install_prefix" && source "$fleet_install_prefix/env.sh"; }; '
            + 'if [ -n "${BASH_VERSION:-}" ]; then _fleet_verified_install; else printf "%s\\n" "Run this command in Bash" >&2; false; fi')


def inspect_target(openshell, choices, env, cwd, runner):
    base = [openshell, '--gateway', choices['gateway'], '--workspace', choices['workspace'], '--color', 'never']
    results = []
    for args in (['status', '-o', 'json'], ['sandbox', 'get', choices['sandbox'], '-o', 'json']):
        try:
            code, stdout, _ = runner(base + args, env, cwd, 30)
        except (FetchError, OSError) as error:
            raise FetchError('TARGET', 'Bounded metadata lookup failed') from error
        if code != 0:
            raise FetchError('TARGET', 'Metadata command failed; target not verified')
        results.append(stdout)
    return target_identity(*results, choices)


def execute(choices, pins, bootstrap, base_env=None, runner=run_owned, downloader=download):
    validate_release(pins)
    require_pidfds()
    if not isinstance(bootstrap, str) or not bootstrap:
        raise FetchError('PREFLIGHT', 'Use the complete rendered release helper')
    base_env = dict(os.environ if base_env is None else base_env)
    paths = {}
    for name in ('openshell', 'curl', 'bash', 'sha256sum', 'mktemp'):
        value = shutil.which(name, path=base_env.get('PATH', ''))
        if not value:
            raise FetchError('PREFLIGHT', 'Required host program is unavailable: ' + name)
        paths[name] = os.path.abspath(value)
    env, curl_env = cli_environment(base_env), curl_environment(base_env)
    owned = Path(tempfile.mkdtemp(prefix='fleet-fetch-', dir='/tmp'))
    os.chmod(owned, 0o700)
    root_identity = os.lstat(owned)
    transferred = False
    remote = None
    target = None
    snapshot = None
    try:
        code, version, _ = runner([paths['openshell'], '--version'], env, str(owned), 30, max_stdout=4096)
        if code != 0 or version != b'openshell 0.1.2\n':
            raise FetchError('PREFLIGHT', 'Only the reviewed OpenShell 0.1.2 metadata/transport contract is qualified')
        target = inspect_target(paths['openshell'], choices, env, str(owned), runner)
        print('Target: ' + json.dumps(target, ensure_ascii=True, sort_keys=True), flush=True)
        if not choices['upgrade']:
            print('Fresh install: agents on; tier=' + choices['tier'] + '; workers=' + choices['providers']
                  + '. Setup --add registers every installed supported CLI. Audit is not enabled.', flush=True)
        sums = owned / 'SHA256SUMS'
        archive = owned / pins['archive']
        downloader(pins['base_url'] + '/SHA256SUMS', sums, pins['max_checksums_bytes'], paths['curl'], curl_env, str(owned), runner=runner)
        checksums_match(sums.read_bytes(), pins['archive'], pins['sha256'])
        downloader(pins['base_url'] + '/' + pins['archive'], archive, pins['max_archive_bytes'], paths['curl'], curl_env, str(owned), runner=runner)
        snapshot = UploadSnapshot(owned, archive, pins)
        known = {sums.name: os.lstat(sums), archive.name: os.lstat(archive)}
        # Generate a new independent destination on every helper invocation.
        destination = '/sandbox/.toolsenabled-fetch-' + secrets.token_hex(16) + '/'
        remote = destination + pins['archive']
        command = sandbox_command(choices, remote, pins, bootstrap)
        if inspect_target(paths['openshell'], choices, env, str(owned), runner) != target:
            raise FetchError('TARGET', 'Target identity changed immediately before upload')
        snapshot.verify()
        upload = [paths['openshell'], '--gateway', choices['gateway'], '--workspace', choices['workspace'], '--color', 'never',
                  'sandbox', 'upload', '--no-git-ignore', choices['sandbox'], str(snapshot.path), destination]
        try:
            cancellation_checkpoint()
            code, stdout, stderr = runner(upload, env, str(owned), 180)
            cancellation_checkpoint(attempted=True)
        except OSError as error:
            raise FetchError('UPLOAD_FAILED', 'Upload process could not start') from error
        except FetchError as error:
            attempted = error.attempted or error.phase == 'CLEANUP'
            raise FetchError('UPLOAD_OUTCOME_UNCERTAIN' if attempted else 'UPLOAD_FAILED',
                             'Upload did not complete; destination will not be reused. ' + str(error), attempted=attempted) from error
        except KeyboardInterrupt as error:
            attempted = getattr(error, 'attempted', False)
            raise FetchError('UPLOAD_OUTCOME_UNCERTAIN' if attempted else 'UPLOAD_FAILED',
                             'Upload interrupted; destination will not be reused', attempted=attempted) from error
        if code < 0:
            raise FetchError('UPLOAD_OUTCOME_UNCERTAIN', 'Upload process ended by signal; completion is unknown and destination will not be reused', attempted=True)
        if code != 0:
            raise FetchError('UPLOAD_FAILED', 'Upload returned exit ' + str(code) + '; remote partial data may remain; destination will not be reused')
        transferred = True
        if stdout or stderr:
            print('Upload diagnostics (untrusted): ' + escaped((stdout + stderr).decode('utf-8', 'replace')))
        print('Transfer completed; installation has not run. Archive: ' + remote)
        print('SHA-256: ' + pins['sha256'] + '; source: ' + pins['source'] + '; version: ' + pins['version'])
        print('Run this exact command in the trusted target\'s Bash shell:\n' + command)
        # Only our two regular downloads may be removed; unexpected entries
        # or substitutions retain local evidence instead of recursive deletion.
        if set(os.listdir(owned)) != set(known) | {'upload'} or (os.lstat(owned).st_dev, os.lstat(owned).st_ino) != (root_identity.st_dev, root_identity.st_ino):
            raise FetchError('CLEANUP', 'Local evidence changed; retained after completed upload')
        for name, info in known.items():
            current = os.lstat(owned / name)
            if not stat.S_ISREG(current.st_mode) or current.st_uid != os.getuid() or current.st_nlink != 1 or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise FetchError('CLEANUP', 'Owned local file changed; retained after completed upload')
        snapshot.remove()
        for name in known:
            os.unlink(owned / name)
        os.rmdir(owned)
        return 0
    except BaseException as error:
        phase = error.phase if isinstance(error, FetchError) else 'INTERRUPTED' if isinstance(error, KeyboardInterrupt) else 'HOST'
        record = {'phase': phase, 'transferCompleted': transferred, 'remoteArchive': remote, 'target': target,
                  'archiveSha256': pins['sha256'], 'source': pins['source'], 'version': pins['version']}
        try:
            with open(owned / 'outcome.json', 'x', encoding='utf-8') as stream:
                json.dump(record, stream, indent=2)
                stream.write('\n')
        except OSError:
            pass
        print('Owned local evidence retained at ' + escaped(owned), file=sys.stderr)
        if remote:
            print('Remote archive path (not removed or reused): ' + escaped(remote), file=sys.stderr)
        raise
    finally:
        if snapshot is not None:
            snapshot.close()


def _main(argv=None):
    os.umask(0o077)
    try:
        with host_signals():
            choices = parse_arguments(list(sys.argv[1:] if argv is None else argv))
            return execute(choices, RELEASE, SANDBOX_BOOTSTRAP)
    except FetchError as error:
        print(error.phase + ': ' + escaped(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('INTERRUPTED: local evidence retained; inspect the recorded transfer phase', file=sys.stderr)
        return 130
    except Exception as error:
        print('HOST: ' + escaped(type(error).__name__), file=sys.stderr)
        return 1


def main(argv=None):
    return _main(argv)


if __name__ == '__main__':
    sys.exit(main())
