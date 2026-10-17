"""Fleet host registration, restricted to its own selected user-scope entry.

No credential/sign-in file is opened and no connecting MCP inspection is run.
Codex edits preserve bytes outside our exact block; sealed terminal setup
history also permits removing its CLI-written table after parsed ownership
checks. Claude edits only the selected JSON member's span. No external CLI
rewrites live configuration in this installer.
Both use one advisory lock per provider-config identity and a private recovery
transaction. Existing generations are exchanged, never silently discarded.

Close other CLI sessions and editors during setup, uninstall and recovery.
Neither a Fleet advisory lock nor renameat2 exchange is conditional-inode CAS:
uncoordinated writers can still race comparisons. Recovery checks both saved
and current generations, retains uncertain evidence, and never blindly copies
an old snapshot over a changed file. Receipts/logs contain no config snapshots.
"""
from __future__ import annotations

import datetime
import ctypes
from contextlib import contextmanager
import decimal
import fcntl
import hashlib
import json
import math
import re
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
from functools import lru_cache
import tomllib

NAME = 'toolsenabled-fleet-host'
LIMIT = 2 * 1024 * 1024
BEGIN = '# BEGIN ToolsEnabled Fleet host: toolsenabled-fleet-host'
END = '# END ToolsEnabled Fleet host: toolsenabled-fleet-host'
REGISTRY_ROOT = None


class RegistrationError(RuntimeError):
    code = 'HOST_REGISTRATION_REFUSED'


def refuse(message):
    raise RegistrationError(message)


def absolute(value):
    if (not isinstance(value, str) or not value.startswith('/') or value == '/'
            or len(value.encode('utf8', errors='replace')) > 4096
            or value.endswith('/') or '//' in value or '\\' in value
            or any(part in ('.', '..') for part in value.split('/'))
            or any(ord(char) < 32 or ord(char) == 127 or 0xd800 <= ord(char) <= 0xdfff for char in value)):
        refuse('Registration requires a bounded absolute path without traversal.')
    return value


def _overlaps(left, right):
    return left == right or left.startswith(right + '/') or right.startswith(left + '/')


def set_registry_root(root):
    # The installer selects this from its validated host state path, never
    # from a receipt or another agent's configuration.
    global REGISTRY_ROOT
    REGISTRY_ROOT = absolute(root)


def descriptors(env=None):
    selected = os.environ if env is None else env
    return _descriptors(REGISTRY_ROOT or selected.get('TOOLSENABLED_STATE_ROOT'), selected.get('HOME'))


@lru_cache(maxsize=64)
def _descriptors(state_root, home):
    """Use Fleet's strict Node registry, including the person's descriptors."""
    env = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'LC_ALL') if key in os.environ}
    if state_root is not None:
        env['TOOLSENABLED_STATE_ROOT'] = state_root
    else:
        env.pop('TOOLSENABLED_STATE_ROOT', None)
    if home is not None:
        env['HOME'] = home
    roots = [Path(__file__).resolve().parents[2], Path(__file__).resolve().parent / 'payload/engine']
    root = next((root for root in roots if (root / 'src/lib/agents/registry.js').is_file()), None)
    node = shutil.which('node')
    if root is None or node is None:
        refuse('The Fleet agent registry or Node executable is unavailable.')
    result = subprocess.run([node, '-e', "process.stdout.write(JSON.stringify(require(process.argv[1]).loadRegistry().agents))",
                             str(root / 'src/lib/agents/registry.js')], env=env, capture_output=True, timeout=10)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        refuse('Agent descriptors could not be validated.')
    return {agent['id']: agent for agent in json.loads(result.stdout)}


def discover(env=None):
    env = os.environ if env is None else env
    return [key for key, agent in descriptors(env).items()
            if agent['register']['kind'] != 'none' and shutil.which(agent['command'], path=env.get('PATH', ''))]


def metadata(provider, env=None):
    agent = descriptors(env).get(provider)
    if agent is None or 'config' not in agent['register']:
        refuse('This agent has no described MCP configuration writer.')
    return agent['register']


def config_metadata(record):
    return metadata(record['provider'])['config']


def pass_env_names(value=()):
    names = ([] if value == '' else value.split(',')) if isinstance(value, str) else value
    if (not isinstance(names, (list, tuple)) or len(names) > 256
            or any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,255}', name) for name in names)):
        refuse('--pass-env needs comma-separated environment variable names, or an empty value to clear them.')
    return sorted(set(names))


def default_forward_env_names(env=None):
    # Each agent's profile variable and its related folder variables (register.profile.relatedEnv),
    # the same list as src/lib/agents/registry.js defaultForwardEnvNames.
    profiles = [agent['register'].get('profile', {}) for agent in descriptors(env).values()]
    names = {profile.get('env') for profile in profiles} | {name for profile in profiles for name in profile.get('relatedEnv', [])}
    return sorted(names.difference({None}) | {'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
                                             'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'})


def make_record(provider, command, args, env=None, protected_roots=(), pass_env=()):
    env = os.environ if env is None else env
    spec = metadata(provider, env)['profile']
    home = absolute(env.get('HOME'))
    # Some agents have no profile variable; their profile is always the default.
    name = spec.get('env')
    selected = env.get(name) if name is not None and name in env else None
    if selected is not None and spec.get('envSubdir'):
        selected = selected.rstrip('/') + '/' + spec['envSubdir']
    profile = absolute(selected) if selected is not None else (None if spec.get('defaultFile') else absolute(home + '/' + spec['default']))
    file = (home + '/' + spec['defaultFile']) if profile is None else profile + '/' + spec['file']
    command = absolute(command)
    if (not isinstance(args, list) or len(args) > 100
            or any(not isinstance(value, str) or len(value) > 8192
                   or any(ord(char) < 32 or ord(char) == 127 or 0xd800 <= ord(char) <= 0xdfff for char in value)
                   for value in args)):
        refuse('Registration arguments are not bounded plain strings.')
    protected = [absolute(os.fspath(root)) for root in protected_roots]
    if any(_overlaps(file, root) for root in protected):
        refuse('Registration configuration overlaps protected runtime or state.')
    entry = {'command': command, 'args': list(args)}
    # The descriptor's exposure settings for Fleet's own entry (never one marked
    # sandboxOnly, which would change the agent for every session).
    if metadata(provider, env)['config']['format'] == 'toml':
        for setting in metadata(provider, env).get('settings', []):
            if setting['table'] == ['mcp_servers', '{name}'] and not setting.get('sandboxOnly'):
                entry[setting['key']] = setting['value']
    kind = metadata(provider, env)['config']['entryType']
    if kind == 'stdio':
        entry.update(type='stdio', env={})
    elif kind == 'local':
        entry = dict(type='local', command=[command, *args], environment={}, enabled=True, timeout=30000)
    if pass_env is not None:
        names = pass_env_names(pass_env)
        forwarding = metadata(provider, env).get('forwardEnv', {})
        if forwarding.get('kind') == 'toml-list':
            entry[forwarding['key']] = sorted(set(default_forward_env_names(env)) | set(names))
        elif forwarding.get('kind') == 'entry-env-reference' and names:
            entry['env'] = {name: forwarding['syntax'].replace('NAME', name) for name in names}
    return {**({'passEnv': names} if pass_env is not None else {}), 'provider': provider, 'name': NAME, 'home': home, 'profile': profile,
            'configPath': file, 'command': command, 'args': list(args), 'entry': entry,
            'protectedRoots': protected}


def _validate(record):
    if not isinstance(record, dict):
        refuse('Invalid registration ownership record.')
    try:
        env = {'HOME': record['home']}
        if record['profile'] is not None:
            spec = metadata(record['provider'])['profile']
            profile_env, subdir = spec.get('env'), spec.get('envSubdir')
            if profile_env:
                # With envSubdir the variable names the home holding the profile.
                suffix = '/' + subdir if subdir else ''
                if suffix and not record['profile'].endswith(suffix):
                    refuse('Registration ownership record changed or has unknown fields.')
                env[profile_env] = record['profile'][:-len(suffix)] if suffix else record['profile']
        expected = make_record(record['provider'], record['command'], record['args'], env,
                               record['protectedRoots'], pass_env=record.get('passEnv'))
        if record.get('terminalCli') is True and metadata(record['provider'])['config']['format'] == 'toml':
            expected['terminalCli'] = True
        if _canonical(record) != _canonical(expected):
            refuse('Registration ownership record changed or has unknown fields.')
    except (KeyError, TypeError, ValueError):
        refuse('Invalid registration ownership record.')
    return record


def _canonical(value):
    # TOML permits timestamps and non-finite floats in unrelated user settings.
    # Include types so JSON true and 1 cannot mask an unrelated CLI mutation.
    if value is None:
        return ('null',)
    if type(value) in (bool, int, str):
        return (type(value).__name__, value)
    if type(value) is float:
        return ('float', 'nan' if math.isnan(value) else value)
    if isinstance(value, decimal.Decimal):
        return ('decimal', value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return (type(value).__name__, value.isoformat())
    if isinstance(value, list):
        return ('list', tuple(_canonical(item) for item in value))
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return ('dict', tuple((key, _canonical(value[key])) for key in sorted(value)))
    refuse('Registration data has an unsupported value type.')


def _directory_identity(info):
    return info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode


def _fingerprint(info):
    return (_directory_identity(info), info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class _Config:
    """Retain every ancestor descriptor and refuse links and unsafe ownership."""
    def __init__(self, file, *, create=False):
        self.file = absolute(file)
        self.leaf = Path(file).name
        self.chain = []
        self.missing = None
        try:
            self.chain.append((os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW), '', None))
            self.chain[0] = (self.chain[0][0], '', _directory_identity(os.fstat(self.chain[0][0])))
            parts = str(Path(file).parent).strip('/').split('/')
            for name in parts:
                if not name:
                    continue
                parent = self.chain[-1][0]
                try:
                    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                except FileNotFoundError:
                    if not create:
                        self.missing = name
                        break
                    os.mkdir(name, 0o700, dir_fd=parent)
                    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                info = os.fstat(descriptor)
                self.chain.append((descriptor, name, _directory_identity(info)))
                sticky = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
                if info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022 and not sticky:
                    refuse('Registration configuration has an unsafe directory ancestor.')
            self.fd = self.chain[-1][0]
            owner = os.fstat(self.fd)
            key = hashlib.sha256(f'{owner.st_dev}:{owner.st_ino}:{self.leaf}'.encode()).hexdigest()[:24]
            self.lock_name = '.fleet-host-lock-' + key
            self.transaction_name = '.fleet-host-tx-' + key
            self.revalidate()
        except BaseException as error:
            self.close()
            if isinstance(error, OSError):
                refuse('Registration configuration directory could not be opened safely.')
            raise

    def revalidate(self):
        for index, (descriptor, name, identity) in enumerate(self.chain):
            if _directory_identity(os.fstat(descriptor)) != identity:
                refuse('Registration configuration directory changed.')
            if index:
                current = os.stat(name, dir_fd=self.chain[index - 1][0], follow_symlinks=False)
                if not stat.S_ISDIR(current.st_mode) or _directory_identity(current) != identity:
                    refuse('Registration configuration ancestor was substituted.')
        if self.missing is not None:
            try:
                os.stat(self.missing, dir_fd=self.fd, follow_symlinks=False)
            except FileNotFoundError:
                return
            refuse('Registration configuration directory appeared during inspection.')

    def read(self, *, directory=None, name=None):
        self.revalidate()
        if self.missing is not None:
            return b'', None
        directory = self.fd if directory is None else directory
        name = self.leaf if name is None else name
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return b'', None
        except OSError:
            refuse('Registration configuration file could not be opened safely.')
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                    or info.st_mode & 0o7022 or info.st_size > LIMIT):
                refuse('Registration configuration is not a bounded owned regular file.')
            try:
                if os.listxattr(descriptor):
                    refuse('Registration refuses unsupported access metadata or ACLs before mutation.')
            except OSError:
                refuse('Registration access metadata could not be verified.')
            chunks, size = [], 0
            while True:
                data = os.read(descriptor, min(65536, LIMIT + 1 - size))
                if not data:
                    break
                chunks.append(data)
                size += len(data)
                if size > LIMIT:
                    refuse('Registration configuration exceeds its size limit.')
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (_fingerprint(os.fstat(descriptor)) != _fingerprint(info)
                    or _fingerprint(current) != _fingerprint(info) or size != info.st_size):
                refuse('Registration configuration changed during inspection.')
            self.revalidate()
            return b''.join(chunks), _fingerprint(info)
        finally:
            os.close(descriptor)

    def recovery_path(self):
        return str(Path(self.file).parent / self.transaction_name)

    def assert_no_recovery(self):
        if self.missing is not None:
            return
        self.revalidate()
        try:
            os.stat(self.transaction_name, dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        refuse('Registration recovery is pending at ' + self.recovery_path()
               + '; close configuration writers and recover the exact validated registration record.')

    @contextmanager
    def lock(self):
        self.revalidate()
        if self.missing is not None:
            refuse('Registration lock needs an existing selected profile directory.')
        descriptor = os.open(self.lock_name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                             0o600, dir_fd=self.fd)
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != 0 or os.listxattr(descriptor)):
                refuse('Registration advisory lock is unsafe.')
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                refuse('Configuration is busy with another Fleet transaction; retry after it finishes.')
            self.revalidate()
            if _directory_identity(os.stat(self.lock_name, dir_fd=self.fd, follow_symlinks=False)) != _directory_identity(info):
                refuse('Registration advisory lock was substituted.')
            yield
        finally:
            os.close(descriptor)  # Keep the stable lock inode for every Fleet installation.

    def write(self, before, after):
        _writable(before)
        if self.missing is not None or len(after) > LIMIT:
            refuse('Registration write target is unavailable or too large.')
        self.assert_no_recovery()
        _rename_api()  # Fail before preparation when Linux exchange is unavailable.
        transaction = _Transaction(self, create=True)
        try:
            transaction.prepare(before, after)
            _transaction_checkpoint('prepared')
            _transaction_checkpoint('before-commit')
            # Fingerprint includes inode, size, mtime, ctime, metadata and bytes.
            if self.read() != before:
                refuse('Registration configuration changed immediately before commit.')
            transaction.revalidate()
            _rename(transaction.fd, 'candidate', self.fd, self.leaf, exchange=before[1] is not None)
            if before[1] is not None:
                transaction.journal['displaced'] = _generation(self.read(directory=transaction.fd, name='candidate'))
            transaction.journal['phase'] = 'committed'
            transaction.save()
            _transaction_checkpoint('committed')
            os.fsync(self.fd)
            os.fsync(transaction.fd)
            if _generation(self.read()) != transaction.journal['after']:
                refuse('Registration configuration changed after commit.')
            if before[1] is not None and transaction.journal['displaced'] != transaction.journal['before']:
                refuse('A concurrent configuration edit was captured during commit.')
            _transaction_checkpoint('validated')
            transaction.cleanup(transaction.journal['displaced'], live_expected=transaction.journal['after'], outcome='committed')
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            if transaction.removed:
                refuse('Registration commit completed, but final cleanup durability could not be confirmed; inspect registration before retrying.')
            try:
                outcome = transaction.rollback()
            except BaseException:
                if transaction.removed:
                    refuse('Registration transaction settled, but final cleanup durability could not be confirmed; inspect registration before retrying.')
                refuse('Registration recovery is pending at ' + self.recovery_path()
                       + '; current edits were preserved. Close configuration writers before reviewed recovery.')
            if outcome == 'committed':
                refuse('Registration commit completed; an initial cleanup failure was finalized. Inspect registration before retrying.')
            refuse('Registration transaction failed; the prior configuration was restored or left unchanged.')
        finally:
            transaction.close()

    def close(self):
        for descriptor, _, _ in reversed(self.chain):
            os.close(descriptor)
        self.chain = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def _writable(snapshot):
    if snapshot[1] is not None and not snapshot[1][0][4] & stat.S_IWUSR:
        refuse('Registration configuration is read-only; its permissions were not changed.')


def _generation(snapshot):
    data, fingerprint = snapshot
    if fingerprint is None:
        return None
    (device, inode, uid, gid, mode), links, size, modified, _changed = fingerprint
    return dict(device=device, inode=inode, uid=uid, gid=gid, mode=mode, links=links,
                size=size, modified=modified, sha256=hashlib.sha256(data).hexdigest())


def _rename_api():
    library = ctypes.CDLL(None, use_errno=True)
    rename = getattr(library, 'renameat2', None)
    if rename is None:
        refuse('Linux renameat2 is required for recoverable registration transactions.')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    return rename


def _rename(source_fd, source, target_fd, target, *, exchange):
    # RENAME_EXCHANGE preserves the generation actually displaced. New files
    # use RENAME_NOREPLACE; a file appearing late is never silently overwritten.
    if _rename_api()(source_fd, os.fsencode(source), target_fd, os.fsencode(target), 2 if exchange else 1):
        error = ctypes.get_errno()
        raise OSError(error, 'Recoverable registration rename was refused')


def _transaction_checkpoint(_phase):
    """Deterministic fault-injection seam; production performs no operation."""


def _write_all(descriptor, data):
    remaining = memoryview(data)
    while remaining:
        count = os.write(descriptor, remaining)
        if count <= 0:
            refuse('Registration write made no progress.')
        remaining = remaining[count:]


def _strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                refuse('Registration JSON contains duplicate keys.')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs, parse_float=decimal.Decimal,
                      parse_constant=lambda _value: refuse('Registration JSON contains a non-finite constant.'))


class _Transaction:
    def __init__(self, config, *, create=False):
        self.config, self.fd, self.journal = config, None, None
        self.removed = False
        config.revalidate()
        if create:
            os.mkdir(config.transaction_name, 0o700, dir_fd=config.fd)
        self.fd = os.open(config.transaction_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=config.fd)
        try:
            info = os.fstat(self.fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or os.listxattr(self.fd):
                refuse('Recovery directory must be owned, private and free of unsupported ACL metadata.')
            self.identity = _directory_identity(info)
            self.revalidate()
            if not create:
                # A crash between final journal removal and directory removal
                # leaves an empty barrier. Removing only that empty directory
                # cannot modify live configuration or discard a saved file.
                if not os.listdir(self.fd):
                    return
                raw, fingerprint = config.read(directory=self.fd, name='journal')
                if fingerprint is None or len(raw) > 32768 or stat.S_IMODE(fingerprint[0][4]) != 0o600:
                    refuse('Recovery journal is unavailable or unsafe; retain the transaction for review.')
                self.journal = _strict_json(raw)
                required = {'schema', 'leaf', 'before', 'after', 'displaced', 'phase', 'cleanupLive', 'cleanupCandidate', 'cleanupOutcome'}
                if (not isinstance(self.journal, dict) or set(self.journal) != required
                        or self.journal['schema'] != 1 or self.journal['leaf'] != config.leaf
                        or self.journal['phase'] not in ('prepared', 'committed', 'cleanup')
                        or self.journal['cleanupOutcome'] not in (None, 'unchanged', 'restored', 'committed')
                        or self.journal['phase'] == 'cleanup' and self.journal['cleanupOutcome'] is None):
                    refuse('Recovery journal does not describe this configuration.')
                for name in ('before', 'after', 'displaced', 'cleanupLive', 'cleanupCandidate'):
                    value = self.journal[name]
                    if value is not None and (not isinstance(value, dict) or set(value) != {
                            'device', 'inode', 'uid', 'gid', 'mode', 'links', 'size', 'modified', 'sha256'}
                            or any(type(value[key]) is not int for key in value if key != 'sha256')
                            or not isinstance(value['sha256'], str) or len(value['sha256']) != 64):
                        refuse('Recovery generation metadata is invalid.')
                if self.journal['after'] is None:
                    refuse('Recovery journal lacks the intended generation.')
        except BaseException:
            self.close()
            raise

    def revalidate(self):
        self.config.revalidate()
        info = os.stat(self.config.transaction_name, dir_fd=self.config.fd, follow_symlinks=False)
        if _directory_identity(info) != self.identity or _directory_identity(os.fstat(self.fd)) != self.identity:
            refuse('Registration recovery directory was substituted.')

    def prepare(self, before, after):
        self.revalidate()
        descriptor = os.open('candidate', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=self.fd)
        try:
            _write_all(descriptor, after)
            if before[1] is None:
                uid, gid, mode = os.getuid(), os.fstat(descriptor).st_gid, 0o600
            else:
                _, _, uid, gid, full_mode = before[1][0]
                mode = stat.S_IMODE(full_mode)
            os.fchown(descriptor, uid, gid)
            os.fchmod(descriptor, mode)
            if os.listxattr(descriptor):
                refuse('Replacement would inherit unsupported access metadata or ACLs.')
            info = os.fstat(descriptor)
            if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (uid, gid, mode):
                refuse('Replacement ownership and permissions could not be preserved.')
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        candidate = self.config.read(directory=self.fd, name='candidate')
        self.journal = dict(schema=1, leaf=self.config.leaf, before=_generation(before), after=_generation(candidate),
                            displaced=None, phase='prepared', cleanupLive=None, cleanupCandidate=None, cleanupOutcome=None)
        self.save()
        os.fsync(self.config.fd)

    def save(self):
        self.revalidate()
        raw = (json.dumps(self.journal, sort_keys=True, separators=(',', ':')) + '\n').encode()
        if len(raw) > 32768:
            refuse('Recovery journal exceeds its bounded metadata limit.')
        temporary = '.journal-' + secrets.token_hex(12)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=self.fd)
        try:
            os.fchmod(descriptor, 0o600)
            if os.listxattr(descriptor):
                refuse('Recovery journal inherited unsupported access metadata.')
            _write_all(descriptor, raw)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        self.revalidate()
        os.replace(temporary, 'journal', src_dir_fd=self.fd, dst_dir_fd=self.fd)
        os.fsync(self.fd)

    def cleanup(self, expected, *, live_expected, outcome, finalizing=False):
        self.revalidate()
        if _generation(self.config.read()) != live_expected:
            refuse('Configuration changed before cleanup; recovery evidence was retained.')
        if not finalizing:
            self.journal['phase'] = 'cleanup'
            self.journal['cleanupLive'] = live_expected
            self.journal['cleanupCandidate'] = expected
            self.journal['cleanupOutcome'] = outcome
            self.save()
        if _generation(self.config.read()) != self.journal['cleanupLive']:
            refuse('Configuration changed after cleanup began; recovery evidence was retained.')
        names = set(os.listdir(self.fd))
        if not names <= {'candidate', 'journal'}:
            refuse('Unexpected recovery entries were retained for review.')
        if 'candidate' in names:
            if _generation(self.config.read(directory=self.fd, name='candidate')) != expected:
                refuse('Saved recovery generation changed; it was retained.')
            os.unlink('candidate', dir_fd=self.fd)
            os.fsync(self.fd)
        _transaction_checkpoint('cleanup')
        self.revalidate()
        if _generation(self.config.read()) != self.journal['cleanupLive']:
            refuse('Configuration changed during cleanup; recovery evidence was retained.')
        if 'journal' in os.listdir(self.fd):
            os.unlink('journal', dir_fd=self.fd)
            os.fsync(self.fd)
        os.rmdir(self.config.transaction_name, dir_fd=self.config.fd)
        self.removed = True
        os.fsync(self.config.fd)

    def rollback(self):
        if self.removed:
            refuse('The commit completed but cleanup durability is uncertain.')
        self.revalidate()
        if self.journal is None:
            if not os.listdir(self.fd):
                os.rmdir(self.config.transaction_name, dir_fd=self.config.fd)
                self.removed = True
                os.fsync(self.config.fd)
                return 'unchanged'
            refuse('Incomplete recovery preparation was retained for review.')
        if self.journal['phase'] == 'cleanup':
            outcome = self.journal['cleanupOutcome']
            self.cleanup(self.journal['cleanupCandidate'], live_expected=self.journal['cleanupLive'], outcome=outcome, finalizing=True)
            return outcome
        current = self.config.read()
        saved = self.config.read(directory=self.fd, name='candidate')
        live, candidate = _generation(current), _generation(saved)
        before, after = self.journal['before'], self.journal['after']
        if candidate == after:
            # No exchange took place (or rollback completed). A newer live
            # edit is left alone; only our unused candidate is removed.
            self.cleanup(after, live_expected=live, outcome='unchanged')
            return 'unchanged'
        if live != after:
            refuse('Current configuration differs from the failed transaction; it was not overwritten.')
        if before is None:
            if candidate is not None:
                refuse('Unexpected saved generation blocks restoring original absence.')
            if self.config.read() != current:
                refuse('Current configuration changed before rollback.')
            _rename(self.config.fd, self.config.leaf, self.fd, 'candidate', exchange=False)
            moved = _generation(self.config.read(directory=self.fd, name='candidate'))
            if moved != after:
                # NOREPLACE safely returns an unexpected late writer's file
                # only if the live name remains absent. Otherwise retain it.
                _rename(self.fd, 'candidate', self.config.fd, self.config.leaf, exchange=False)
                refuse('Configuration changed during rollback; the newer generation was preserved.')
            self.cleanup(after, live_expected=None, outcome='restored')
            return 'restored'
        if candidate is None:
            refuse('Saved configuration is missing; recovery cannot restore it.')
        expected = self.journal['displaced'] or candidate
        # After a crash immediately following EXCHANGE, the journal may still
        # say prepared. Its private candidate is the displaced generation.
        if candidate != expected or self.config.read() != current:
            refuse('A recovery generation changed before rollback.')
        self.journal['displaced'] = candidate
        self.save()
        _rename(self.fd, 'candidate', self.config.fd, self.config.leaf, exchange=True)
        restored = self.config.read()
        displaced = self.config.read(directory=self.fd, name='candidate')
        if _generation(restored) == candidate and _generation(displaced) != after:
            # A writer can race the final check and EXCHANGE. Return its actual
            # displaced generation when both files still match our observations.
            # This bounded reversal is also not CAS: another racing writer keeps
            # both generations for review, with no subsequent destructive cleanup.
            if (self.config.read() == restored
                    and self.config.read(directory=self.fd, name='candidate') == displaced):
                _rename(self.fd, 'candidate', self.config.fd, self.config.leaf, exchange=True)
                os.fsync(self.config.fd)
                os.fsync(self.fd)
            refuse('A writer raced conditional rollback; both generations were retained for review.')
        if _generation(restored) != candidate or _generation(displaced) != after:
            refuse('A writer raced conditional rollback; both generations were retained for review.')
        os.fsync(self.config.fd)
        os.fsync(self.fd)
        self.cleanup(after, live_expected=candidate, outcome='restored')
        return 'restored'

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def _parse(record, data):
    try:
        text = data.decode('utf8')
        if config_metadata(record)['format'] == 'toml':
            value = tomllib.loads(text)
        else:
            value = _strict_json(text) if data else {}
        if not isinstance(value, dict):
            refuse('Registration configuration root must be an object.')
        servers = value.get(config_metadata(record)['container'], {})
        if not isinstance(servers, dict):
            refuse('Registration MCP configuration must be a table.')
        return value, servers
    except (ValueError, UnicodeError, RecursionError):
        refuse('Registration configuration is invalid; no contents were logged.')


def _block(record):
    # JSON's one-line quoted strings are also TOML basic strings here.
    encode = lambda value: json.dumps(value, ensure_ascii=False, **({'separators': (',', ':')} if 'passEnv' in record else {}))
    items = sorted(record['entry'].items()) if 'passEnv' in record else record['entry'].items()
    extra = ''.join(key + ' = ' + encode(value) + '\n'
                    for key, value in items if key not in ('command', 'args'))
    return ('\n' + BEGIN + '\n[mcp_servers.' + NAME + ']\ncommand = '
            + encode(record['command']) + '\nargs = '
            + encode(record['args']) + '\n' + extra + END + '\n').encode('utf8')


def _entry_equal(record, actual):
    if config_metadata(record)['entryType'] == 'stdio' and isinstance(actual, dict) and 'env' not in actual:
        actual = {**actual, 'env': {}}
    return _canonical(actual) == _canonical(record['entry'])


def _inspect(record, data):
    _, servers = _parse(record, data)
    present = NAME in servers
    if present and not _entry_equal(record, servers[NAME]):
        refuse('The Fleet host registration points to a different or changed entry.')
    if config_metadata(record)['format'] == 'toml' and not record.get('terminalCli'):
        block = _block(record)
        has_markers = BEGIN.encode() in data or END.encode() in data
        if present:
            if data.count(block) != 1 or data.count(BEGIN.encode()) != 1 or data.count(END.encode()) != 1:
                refuse('The exact owned MCP registration block cannot be proven.')
            # Prove removing the block removes precisely this parsed entry,
            # including tricky surrounding multiline-string/table contexts.
            remainder = data.replace(block, b'', 1)
            _, rest_servers = _parse(record, remainder)
            if NAME in rest_servers or _canonical(_without_entry(record, remainder)) != _canonical(_without_entry(record, data)):
                refuse('The owned MCP block does not contain exactly the Fleet entry.')
        elif has_markers:
            refuse('MCP ownership markers exist without the expected registration.')
    return 'present' if present else 'absent'


def _without_entry(record, data):
    value, servers = _parse(record, data)
    key = config_metadata(record)['container']
    servers.pop(NAME, None)
    if not servers:
        value.pop(key, None)
    return value


def inspect(record):
    _validate(record)
    with _Config(record['configPath']) as config:
        config.assert_no_recovery()
        return _inspect(record, config.read()[0])


def preflight(record):
    return inspect(record)


def current_records(records, state_root, install_root, node):
    """Use the verified package's reader for terminal setup's sealed history."""
    roots = [Path(__file__).resolve().parents[2], Path(__file__).resolve().parent / 'payload/engine']
    root = next((root for root in roots if (root / 'src/lib/setup/machine-record.js').is_file()), None)
    if root is None:
        refuse('The setup record reader is unavailable.')
    script = "const r=require(process.argv[1]);const s=process.argv[2];const v=r.readMachineRecord({servicesRoot:s,adopt:false});if(v&&!r.verifyMachineRecordIntegrity(v,{servicesRoot:s}).ok)process.exit(1);process.stdout.write(JSON.stringify(v?.hostRegistrations?.providers||{}))"
    result = subprocess.run([node, '-e', script, str(root / 'src/lib/setup/machine-record.js'), str(Path(state_root) / 'services')],
                            env={key: os.environ[key] for key in ('HOME', 'PATH') if key in os.environ}, capture_output=True, timeout=10)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        refuse('The sealed setup registration history could not be verified.')
    saved = json.loads(result.stdout)
    rows = {record['provider']: record for record in records}
    for provider, row in saved.items():
        if row.get('status') != 'configured':
            continue
        entry = row['entry']
        args = [str(Path(install_root) / 'bin/toolsenabled-host.js'), 'serve', '--state-root', str(state_root), '--actor', provider]
        expected = make_record(provider, node, args, pass_env=entry.get('passEnv'))
        if (row['installRoot'] != install_root or row['homeRoot'] != expected['home']
                or row['profileRoot'] != (expected['profile'] or expected['home'] + '/' + metadata(provider)['profile']['default'])
                or row['profileMode'] != ('explicit' if metadata(provider)['profile'].get('env') in os.environ else 'default')
                or entry['command'] != node or entry['args'] != args or entry['env'] != {}):
            refuse('The sealed setup registration history differs from this installation.')
        # Terminal setup uses the agent's own add command, which rewrites the
        # installer block. Only this sealed history permits table removal below;
        # installer-only records still require their exact original block.
        if metadata(provider)['config']['format'] == 'toml':
            expected['terminalCli'] = True
        rows[provider] = expected
    return list(rows.values())


def _json_members(text, start):
    """Locate object members after full strict parsing; never rewrite others."""
    decoder = json.JSONDecoder()
    def whitespace(position):
        while position < len(text) and text[position] in ' \t\r\n':
            position += 1
        return position
    if text[start] != '{':
        refuse('Fleet JSON container is not an object.')
    position, separator, result = whitespace(start + 1), None, []
    while text[position] != '}':
        key_start = position
        key, end = decoder.raw_decode(text, position)
        position = whitespace(end)
        if not isinstance(key, str) or text[position] != ':':
            refuse('Invalid JSON object member.')
        value_start = whitespace(position + 1)
        _value, value_end = decoder.raw_decode(text, value_start)
        result.append(dict(key=key, start=key_start, value_start=value_start, end=value_end, separator=separator))
        position = whitespace(value_end)
        if text[position] == '}':
            break
        if text[position] != ',':
            refuse('Invalid JSON object separator.')
        separator, position = position, whitespace(position + 1)
    return result, position


def _json_bytes(record, before, operation):
    text = before.decode('utf8') if before else '{}\n'
    start = len(text) - len(text.lstrip(' \t\r\n'))
    members, root_end = _json_members(text, start)
    container = next((member for member in members if member['key'] == config_metadata(record)['container']), None)
    encoded = json.dumps(record['entry'], ensure_ascii=False, separators=(',', ':'))
    if container is None:
        if operation != 'add':
            refuse('Missing Fleet JSON container.')
        insertion = (',' if members else '') + json.dumps(config_metadata(record)['container']) + ':{' + json.dumps(NAME) + ':' + encoded + '}'
        return (text[:root_end] + insertion + text[root_end:]).encode('utf8')
    servers, end = _json_members(text, container['value_start'])
    own = next((member for member in servers if member['key'] == NAME), None)
    if operation == 'add':
        if own is not None:
            refuse('Fleet entry appeared during preparation.')
        insertion = (',' if servers else '') + json.dumps(NAME) + ':' + encoded
        return (text[:end] + insertion + text[end:]).encode('utf8')
    if own is None:
        refuse('Fleet entry disappeared during preparation.')
    left, right = own['start'], own['end']
    if own['separator'] is not None:
        left = own['separator']
    elif len(servers) > 1:
        right = servers[1]['separator'] + 1
    # Keep an empty existing mcpServers object; unrelated formatting stays
    # byte-exact. A newly created empty container may remain after uninstall.
    return (text[:left] + text[right:]).encode('utf8')


def _mutate(record, operation, env):
    _validate(record)
    # Inspection is read-only. New parents are created only for a registration.
    state = inspect(record)
    desired = 'present' if operation == 'add' else 'absent'
    if state == desired:
        return desired
    with _Config(record['configPath'], create=operation == 'add') as config:
        _writable(config.read())
        with config.lock():
            return _mutate_locked(config, record, operation, state, desired)


def _remove_terminal_table(record, data):
    """Remove a CLI-written table only after exact parsed ownership is proven."""
    lines = data.decode('utf8').splitlines(keepends=True)
    # Agent add emits ordinary tables. Other layouts refuse through the parsed
    # before/after checks; no general-purpose TOML reserialization is needed.
    header = re.compile(r'^\s*\[')
    own = re.compile(r'^\s*\[mcp_servers\.(?:' + re.escape(NAME) + r'|"' + re.escape(NAME)
                     + r'")(?:\.[A-Za-z0-9_-]+)?\]\s*(?:#.*)?$')
    spans = []
    for start, line in enumerate(lines):
        if own.fullmatch(line.rstrip('\r\n')):
            end = next((at for at in range(start + 1, len(lines)) if header.match(lines[at])), len(lines))
            while end > start + 1 and (not lines[end - 1].strip() or lines[end - 1].lstrip().startswith('#')):
                end -= 1
            spans.append((start, end))
    for start, end in reversed(spans):
        del lines[start:end]
    return ''.join(lines).encode('utf8')


def _mutate_locked(config, record, operation, state, desired):
    config.assert_no_recovery()
    before = config.read()
    if _inspect(record, before[0]) != state:
        refuse('Registration changed between preflight and mutation.')
    if config_metadata(record)['format'] == 'toml':
        after = (before[0] + _block(record) if operation == 'add' else
                 _remove_terminal_table(record, before[0]) if record.get('terminalCli') else
                 before[0].replace(_block(record), b'', 1))
        if (_inspect(record, after) != desired
                or _canonical(_without_entry(record, before[0])) != _canonical(_without_entry(record, after))):
            refuse('MCP table mutation would change unrelated configuration.')
    else:
        after = _json_bytes(record, before[0], operation)
        if _inspect(record, after) != desired:
            refuse('MCP JSON candidate does not contain the expected Fleet registration.')
        if _canonical(_without_entry(record, after)) != _canonical(_without_entry(record, before[0])):
            refuse('MCP JSON candidate would change unrelated configuration.')
    config.write(before, after)
    return 'added' if operation == 'add' else 'removed'


def register(record, env=None):
    # Explicit creation modes are still masked by a caller's umask. Set and
    # restore this before creating a selected profile, even for umask 0777.
    previous = os.umask(0o077)
    try:
        return _mutate(record, 'add', env)
    finally:
        os.umask(previous)


def remove(record, env=None):
    previous = os.umask(0o077)
    try:
        return _mutate(record, 'remove', env)
    finally:
        os.umask(previous)


def recover(record, env=None):
    """Reviewed recovery of one lifecycle-validated record after writers close.

    This API never selects a profile from recovery data. The caller must first
    reconstruct and validate the original record exactly as uninstall does.
    Unknown live/saved generations retain the private transaction and refuse.
    Returns unchanged, restored, or committed for the settled generation. An
    empty, owned private barrier left after journal cleanup is removed without
    touching configuration and returns unchanged. Nonempty incomplete journals
    require reviewed manual recovery; this API never discards their contents.
    """
    _validate(record)
    previous = os.umask(0o077)
    try:
        with _Config(record['configPath']) as config:
            if config.missing is not None:
                refuse('Recovery profile directory is missing.')
            with config.lock():
                transaction = _Transaction(config)
                try:
                    return transaction.rollback()
                finally:
                    transaction.close()
    finally:
        os.umask(previous)
