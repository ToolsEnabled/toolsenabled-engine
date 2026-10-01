"""Bounded archive ownership and descriptor-bound Fleet filesystem operations.

Only a hash-pinned archive (or a separately pinned shipped legacy catalog) can
create an Inventory. Receipts are not inventories. The target must be trusted
and quiescent: POSIX has no inode-conditional unlink against a hostile same-uid
writer. Every operation nevertheless retains directory descriptors, refuses
links in directory traversal, and rechecks names/identities before mutation.
"""

from __future__ import annotations

import gzip
import base64
import hashlib
import json
import os
import posixpath
import pwd
import re
import secrets
import stat
import tarfile
import tempfile
from functools import lru_cache
from dataclasses import dataclass
from types import MappingProxyType


class FleetFSError(RuntimeError):
    def __init__(self, code, message, relative=None):
        super().__init__(message)
        self.code, self.relative = code, relative


def _require(condition, code, message, relative=None):
    if not condition:
        raise FleetFSError(code, message, relative)


@dataclass(frozen=True)
class Limits:
    compressed_bytes: int = 128 * 1024 * 1024
    tar_bytes: int = 512 * 1024 * 1024
    content_bytes: int = 384 * 1024 * 1024
    file_bytes: int = 64 * 1024 * 1024
    entries: int = 30000
    path_bytes: int = 4096
    metadata_bytes: int = 8192


@dataclass(frozen=True)
class Entry:
    kind: str
    mode: int
    size: int = 0
    sha256: str = ''
    target: str = ''


@dataclass(frozen=True)
class GeneratedFile:
    data: bytes
    mode: int = 0o600


@dataclass(frozen=True)
class GeneratedLink:
    target: str


@dataclass(frozen=True)
class CleanupResult:
    complete: bool
    removed: int
    retained: tuple


_PROVENANCE = object()


class Inventory:
    def __init__(self, entries, archive_sha256, *, _authority=None, runtime=False):
        _require(_authority is _PROVENANCE, 'INVENTORY_UNTRUSTED', 'Inventory needs independent pinned archive provenance')
        self.entries = MappingProxyType(dict(entries))
        self.archive_sha256 = archive_sha256
        self._authority = _authority
        self.runtime = runtime

    def subtree(self, name):
        _relative(name)
        _require(name in self.entries and self.entries[name].kind == 'dir', 'INVENTORY_PATH', 'Unknown inventory subtree')
        entries = {'': self.entries[name]}
        entries.update({key[len(name) + 1:]: value for key, value in self.entries.items() if key.startswith(name + '/')})
        return Inventory(entries, self.archive_sha256, _authority=_PROVENANCE, runtime=self.runtime)


def _relative(value, limits=Limits()):
    _require(isinstance(value, str) and value and not value.startswith('/') and '\\' not in value
             and not any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value)
             and len(value.encode('utf8')) <= limits.path_bytes
             and all(part not in ('', '.', '..') and len(part.encode('utf8')) <= 255 for part in value.split('/')),
             'PATH_INVALID', 'Expected a bounded relative path without traversal')
    return value


def _absolute(value):
    value = os.fspath(value)
    _require(value.startswith('/') and '\0' not in value and not any(part in ('.', '..') for part in value.split('/')),
             'PATH_INVALID', 'Expected an absolute path without dot components')
    return os.path.normpath(value)


def identity(value):
    value = os.fstat(value) if isinstance(value, int) else value
    return {'dev': value.st_dev, 'ino': value.st_ino, 'uid': value.st_uid,
            'gid': value.st_gid, 'mode': stat.S_IMODE(value.st_mode)}


def _same(value, expected):
    actual = identity(value)
    return all(actual.get(key) == expected[key] for key in expected)


def _fingerprint(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def capabilities():
    required = (os.open, os.stat, os.mkdir, os.unlink, os.rmdir, os.readlink, os.symlink)
    _require(os.name == 'posix' and all(function in os.supports_dir_fd for function in required)
             and os.stat in os.supports_follow_symlinks and os.scandir in os.supports_fd
             and hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'O_DIRECTORY') and hasattr(os, 'O_PATH'),
             'FILESYSTEM_UNSUPPORTED', 'Required no-follow directory-descriptor operations are unavailable')


class SafeDirectory:
    """A directory and its retained no-follow ancestor chain; caller must close."""

    def __init__(self, path, chain):
        self.path, self._chain = path, chain
        self.fd = chain[-1][0]
        self.identity = identity(self.fd)
        self.closed = False
        self.exclusive_created = False

    @classmethod
    def open(cls, path, *, protected_paths=()):
        capabilities()
        path = _absolute(path)
        chain = []
        try:
            # Ancestors need traversal/metadata authority only. In particular,
            # OpenShell may allow an owned subtree without permitting a read
            # descriptor for /. The final directory stays readable for list
            # and fsync; all links are still refused at every component.
            root = os.open('/', (os.O_RDONLY if path == '/' else os.O_PATH) | os.O_DIRECTORY | os.O_NOFOLLOW)
            chain.append((root, '', identity(root)))
            parts = path.strip('/').split('/') if path != '/' else []
            for index, name in enumerate(parts):
                access = os.O_RDONLY if index == len(parts) - 1 else os.O_PATH
                fd = os.open(name, access | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=chain[-1][0])
                info = os.fstat(fd)
                chain.append((fd, name, identity(info)))
                # Root-owned sticky temporary storage is allowed; individual
                # stage names still require exclusive creation and ownership.
                sticky_ancestor = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
                _require(info.st_uid in (0, os.geteuid()) and (not (info.st_mode & 0o022) or sticky_ancestor),
                         'PARENT_UNSAFE', 'Directory ancestor ownership or mode is unsafe')
            handle = cls(path, chain)
            if protected_paths:
                _guard_tree(handle, protected_paths)
            return handle
        except BaseException:
            for fd, _, _ in reversed(chain):
                os.close(fd)
            raise

    def revalidate(self):
        _require(not self.closed, 'DIRECTORY_CLOSED', 'Directory handle is closed')
        for index, (fd, name, expected) in enumerate(self._chain):
            _require(_same(os.fstat(fd), expected), 'DIRECTORY_CHANGED', 'Held directory identity or permissions changed')
            if index:
                current = os.stat(name, dir_fd=self._chain[index - 1][0], follow_symlinks=False)
                _require(stat.S_ISDIR(current.st_mode) and _same(current, expected),
                         'ANCESTOR_CHANGED', 'Directory name no longer identifies the retained directory')

    def child(self, name):
        _relative(name)
        _require('/' not in name, 'PATH_INVALID', 'Child name must contain one component')
        self.revalidate()
        chain = [(os.dup(fd), component, dict(expected)) for fd, component, expected in self._chain]
        try:
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fd)
            chain.append((fd, name, identity(fd)))
            handle = SafeDirectory(os.path.join(self.path, name), chain)
            handle.revalidate()
            return handle
        except BaseException:
            for fd, _, _ in reversed(chain):
                os.close(fd)
            raise

    def close(self):
        if not self.closed:
            for fd, _, _ in reversed(self._chain):
                os.close(fd)
            self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def create_stage(parent, prefix='.fleet-stage-', *, protected_paths=()):
    _relative(prefix)
    _require('/' not in prefix, 'PATH_INVALID', 'Stage prefix must be a basename')
    for _ in range(8):
        name = prefix + secrets.token_hex(16)
        # The exact new name is known before mkdir. This also prevents a
        # caller's TMPDIR inside the runtime being replaced from modifying
        # that old generation merely to discover a later overlap refusal.
        parent.revalidate()
        assert_target_safe(os.path.join(parent.path, name), protected_paths=protected_paths)
        try:
            return create_directory(parent, name)
        except FileExistsError:
            continue
    raise FleetFSError('STAGE_COLLISION', 'Could not exclusively create a private stage')


def create_directory(parent, name):
    _relative(name)
    _require('/' not in name, 'PATH_INVALID', 'New directory name must be one component')
    parent.revalidate()
    current = os.fstat(parent.fd)
    sticky = current.st_uid == 0 and bool(current.st_mode & stat.S_ISVTX)
    _require((current.st_uid == os.geteuid() and not (current.st_mode & 0o022)) or sticky,
             'PARENT_UNSAFE', 'Parent must be owned or root-owned sticky storage')
    os.mkdir(name, 0o700, dir_fd=parent.fd)
    parent.revalidate()
    child = parent.child(name)
    child.exclusive_created = True
    os.fsync(parent.fd)
    return child


def _mount_paths():
    with open('/proc/self/mountinfo', 'rb') as stream:
        raw = stream.read(4 * 1024 * 1024 + 1)
    _require(raw and len(raw) <= 4 * 1024 * 1024 and raw.endswith(b'\n') and b'\0' not in raw,
             'MOUNT_UNKNOWN', 'Mount inventory is unavailable or incomplete')
    mounts = []
    for line in raw.decode('utf8', errors='strict').splitlines():
        halves = line.split(' - ')
        _require(len(halves) == 2, 'MOUNT_UNKNOWN', 'Malformed mount inventory')
        left, right = halves[0].split(' '), halves[1].split(' ')
        _require(len(left) >= 6 and len(right) == 3 and all(left + right)
                 and left[0].isdigit() and left[1].isdigit() and re.fullmatch(r'\d+:\d+', left[2]),
                 'MOUNT_UNKNOWN', 'Malformed mount inventory')
        value = left[4]
        _require(re.search(r'\\(?!040|011|012|134)', value) is None, 'MOUNT_UNKNOWN', 'Malformed mount escapes')
        value = re.sub(r'\\(040|011|012|134)', lambda match: {'040': ' ', '011': '\t', '012': '\n', '134': '\\'}[match[1]], value)
        mounts.append((_absolute(value), any(word.startswith(('shared:', 'master:', 'propagate_from:')) for word in left[6:])))
    return mounts


def _within(candidate, root):
    return candidate == root or candidate.startswith(root.rstrip('/') + '/')


def _canonical_protected(value):
    value = _absolute(value)
    probe = value
    while not os.path.exists(probe):
        _require(not os.path.islink(probe), 'PROTECTED_UNKNOWN', 'A protected path has a dangling link')
        parent = os.path.dirname(probe)
        _require(parent != probe, 'PROTECTED_UNKNOWN', 'Protected path cannot be resolved')
        probe = parent
    return os.path.realpath(value)


def default_protected_paths(env=None):
    env = os.environ if env is None else env
    homes = {_absolute(pwd.getpwuid(os.getuid()).pw_dir), _absolute(env.get('HOME', pwd.getpwuid(os.getuid()).pw_dir))}
    protected = {'/etc/openshell', '/tmp/toolsenabled-fleet-lifecycle-' + str(os.getuid())}
    states = {os.path.join(home, '.toolsenabled') for home in homes}
    for home in homes:
        for suffix in ('.codex', '.claude', '.claude.json', '.config/openshell', '.local/state/openshell', '.local/share/openshell'):
            protected.add(os.path.join(home, suffix))
    protected.update(states)
    if 'TOOLSENABLED_STATE_ROOT' in env:
        states.add(_absolute(env['TOOLSENABLED_STATE_ROOT']))
    # durable-memory-file.js derives the service product leaf from the state
    # parent. Protect selected/default service candidates without reading a
    # local-profile marker or any state/credential content. The optional local
    # layout uses the state's sibling services directory.
    service_bases = {os.path.join(home, '.local/share') for home in homes}
    for key in ('LOCALAPPDATA', 'XDG_DATA_HOME'):
        if key in env:
            service_bases.add(_absolute(env[key].strip()))
    for state in states:
        state_parent = os.path.dirname(state)
        product = os.path.basename(state_parent)
        _require(bool(product), 'PROTECTED_UNKNOWN', 'Service product identity has no parent leaf')
        protected.add(os.path.join(state_parent, 'services'))
        protected.update(os.path.join(base, product) for base in service_bases)
    for key in ('CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TOOLSENABLED_STATE_ROOT', 'OPENSHELL_SYSTEM_GATEWAY_DIR',
                'OPENSHELL_LOCAL_TLS_DIR', 'OPENSHELL_GATEWAY_CONFIG', 'OPENSHELL_TLS_CERT', 'OPENSHELL_TLS_KEY', 'OPENSHELL_TLS_CLIENT_CA'):
        if key in env:
            protected.add(_absolute(env[key]))
    for key in ('XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME'):
        if key in env:
            protected.add(os.path.join(_absolute(env[key]), 'openshell'))
    if 'OPENSHELL_DB_URL' in env:
        match = re.fullmatch(r'sqlite:(/(?!/)[^?#%\0]+)', env['OPENSHELL_DB_URL'])
        _require(match is not None, 'PROTECTED_UNKNOWN', 'Unqualified OpenShell database location')
        protected.add(_absolute(match[1]))
    return homes, protected


def _guard_tree(handle, protected_paths=()):
    handle.revalidate()
    homes, protected = default_protected_paths()
    protected.update(_absolute(value) for value in protected_paths)
    root = handle.path
    _require(root != '/' and all(not _within(home, root) for home in homes), 'PROTECTED_PATH', 'Tree contains a protected home or filesystem root')
    for value in protected:
        canonical = _canonical_protected(value)
        # Bare homes are handled above. Any home also named here has an
        # explicit profile/state/service/protected role and stays symmetric.
        _require(not any(_within(item, root) or _within(root, item) for item in (value, canonical)),
                 'PROTECTED_PATH', 'Tree overlaps protected state or profile paths')
    try:
        mounts = _mount_paths()
    except (OSError, UnicodeError) as error:
        raise FleetFSError('MOUNT_UNKNOWN', 'Mount inventory could not be read') from error
    for mounted, shared in mounts:
        _require(not _within(mounted, root) and not (shared and _within(root, mounted)),
                 'MOUNTED_TREE', 'Tree contains a mount or is beneath a shared mount')


def assert_target_safe(path, *, protected_paths=()):
    """Preflight an absent or existing target without creating any ancestor."""
    path = _absolute(path)
    ancestor = path
    while True:
        try:
            os.lstat(ancestor)
            break
        except FileNotFoundError:
            parent = os.path.dirname(ancestor)
            _require(parent != ancestor, 'PARENT_UNSAFE', 'Target has no available safe ancestor')
            ancestor = parent
    with SafeDirectory.open(ancestor) as held:
        _assert_not_nested_install(held, include_self=ancestor != path)
        class Target:
            def revalidate(self):
                held.revalidate()
        prospective = Target()
        prospective.path = path
        _guard_tree(prospective, protected_paths)


def _assert_not_nested_install(handle, *, include_self):
    """Refuse an ancestor's fixed installation markers without reading files."""
    handle.revalidate()
    chain = handle._chain if include_self else handle._chain[:-1]
    for fd, _name, expected in chain[1:]:
        if expected['uid'] != os.geteuid():
            continue
        opened = []
        try:
            manifest = os.stat('manifest.json', dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(manifest.st_mode):
                continue
            runtime = os.open('runtime', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            opened.append(runtime)
            engine = os.open('engine', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=runtime)
            opened.append(engine)
            engine_bin = os.open('bin', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=engine)
            opened.append(engine_bin)
            entry = os.stat('toolsenabled-openshell.js', dir_fd=engine_bin, follow_symlinks=False)
            command_bin = os.open('bin', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            opened.append(command_bin)
            command = os.stat('toolsenabled', dir_fd=command_bin, follow_symlinks=False)
            _require(not (stat.S_ISREG(entry.st_mode) and stat.S_ISREG(command.st_mode)),
                     'NESTED_INSTALL', 'Target is nested inside another installed runtime')
        except FileNotFoundError:
            pass
        finally:
            for opened_fd in reversed(opened):
                os.close(opened_fd)
    handle.revalidate()


def _check_directory_chain(handle, directories, identities, directory):
    handle.revalidate()
    while directory:
        parent, leaf = posixpath.split(directory)
        current = os.stat(leaf, dir_fd=directories[parent], follow_symlinks=False)
        _require(stat.S_ISDIR(current.st_mode) and _same(current, identities[directory]),
                 'TREE_CHANGED', 'A retained directory was substituted', directory)
        directory = parent


def _validate_tar_blocks(spool, limits):
    """Bound GNU extension headers before tarfile can allocate their payload."""
    spool.seek(0)
    count = 0
    while True:
        header = spool.read(512)
        _require(len(header) == 512, 'ARCHIVE_TRUNCATED', 'Tar header is truncated')
        if header == b'\0' * 512:
            _require(spool.read(512) == b'\0' * 512, 'ARCHIVE_TRUNCATED', 'Tar terminator is incomplete')
            while True:
                remaining = spool.read(1024 * 1024)
                if not remaining:
                    return
                _require(not remaining.strip(b'\0'), 'ARCHIVE_TRAILING', 'Tar contains data after its terminator')
        count += 1
        _require(count <= limits.entries * 3, 'ARCHIVE_LIMIT', 'Too many physical archive headers')
        info = tarfile.TarInfo.frombuf(header, 'utf8', 'strict')
        extension = info.type in (tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK)
        _require(extension or info.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE),
                 'ARCHIVE_TYPE', 'Archive contains unsupported hardlink, special, sparse or PAX metadata')
        _require(0 <= info.size <= (limits.metadata_bytes if extension else limits.file_bytes),
                 'ARCHIVE_LIMIT', 'Archive member exceeds its size ceiling')
        amount = (info.size + 511) // 512 * 512
        _require(len(spool.read(amount)) == amount, 'ARCHIVE_TRUNCATED', 'Tar member is truncated')


class VerifiedArchive:
    @classmethod
    def open(cls, archive_path, sha256, limits=Limits()):
        _require(isinstance(sha256, str) and re.fullmatch(r'[0-9a-f]{64}', sha256), 'ARCHIVE_PIN', 'A literal independent SHA256 pin is required')
        fd = os.open(_absolute(archive_path), os.O_RDONLY | os.O_NOFOLLOW)
        spool = None
        tar = None
        try:
            before = os.fstat(fd)
            _require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= limits.compressed_bytes,
                     'ARCHIVE_LIMIT', 'Archive is not a bounded regular file')
            actual, hashed_bytes = hashlib.sha256(), 0
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                hashed_bytes += len(chunk)
                _require(hashed_bytes <= before.st_size, 'ARCHIVE_CHANGED', 'Archive grew while hashing')
                actual.update(chunk)
            _require(hashed_bytes == before.st_size, 'ARCHIVE_CHANGED', 'Archive shrank while hashing')
            _require(actual.hexdigest() == sha256, 'INTEGRITY', 'Archive checksum differs from its independent pin')
            os.lseek(fd, 0, os.SEEK_SET)
            # Anonymous private storage must not inherit a caller's TMPDIR,
            # which may name a provider profile or the prefix being upgraded.
            spool = tempfile.TemporaryFile(mode='w+b', dir='/tmp')
            total = 0
            with os.fdopen(os.dup(fd), 'rb') as compressed, gzip.GzipFile(fileobj=compressed, mode='rb') as expanded:
                while True:
                    chunk = expanded.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    _require(total <= limits.tar_bytes, 'ARCHIVE_LIMIT', 'Expanded archive exceeds its byte ceiling')
                    spool.write(chunk)
            _require(_fingerprint(os.fstat(fd)) == _fingerprint(before), 'ARCHIVE_CHANGED', 'Archive changed while it was verified')
            _validate_tar_blocks(spool, limits)
            spool.seek(0)
            tar = tarfile.open(fileobj=spool, mode='r:')
            entries, members = {'': Entry('dir', 0o700)}, {}
            content = 0
            for member in tar:
                _require(len(members) < limits.entries, 'ARCHIVE_LIMIT', 'Archive has too many members')
                name = member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name
                _relative(name, limits)
                _require(name == 'toolsenabled-installer' or name.startswith('toolsenabled-installer/'), 'ARCHIVE_ROOT', 'Archive has an unexpected root')
                _require(name not in entries, 'ARCHIVE_DUPLICATE', 'Archive has duplicate or conflicting member paths')
                _require(not member.mode & ~0o777, 'ARCHIVE_MODE', 'Archive has set-id or unsupported mode bits')
                if member.isdir():
                    _require(member.size == 0, 'ARCHIVE_TYPE', 'Directory member carries data')
                    entry = Entry('dir', member.mode)
                elif member.issym():
                    _require(member.size == 0, 'ARCHIVE_TYPE', 'Link member carries data')
                    target = member.linkname
                    _require(isinstance(target, str) and target and not target.startswith('/') and '\\' not in target
                             and not any(ord(char) < 32 or ord(char) == 127 for char in target)
                             and len(target.encode('utf8')) <= limits.path_bytes, 'ARCHIVE_LINK', 'Archive link target is invalid')
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                    _require(resolved == 'toolsenabled-installer' or resolved.startswith('toolsenabled-installer/'), 'ARCHIVE_LINK', 'Archive link escapes the package')
                    entry = Entry('link', 0o777, target=target)
                elif member.isfile():
                    content += member.size
                    _require(member.size <= limits.file_bytes and content <= limits.content_bytes, 'ARCHIVE_LIMIT', 'Archive content exceeds its ceiling')
                    stream = tar.extractfile(member)
                    hashed = hashlib.sha256()
                    read = 0
                    with stream:
                        while True:
                            chunk = stream.read(1024 * 1024)
                            if not chunk:
                                break
                            read += len(chunk)
                            _require(read <= member.size, 'ARCHIVE_SIZE', 'Member grew beyond its header')
                            hashed.update(chunk)
                    _require(read == member.size, 'ARCHIVE_TRUNCATED', 'Archive content is truncated')
                    entry = Entry('file', member.mode, member.size, hashed.hexdigest())
                else:
                    raise FleetFSError('ARCHIVE_TYPE', 'Unsupported archive member')
                entries[name], members[name] = entry, member
            _require(entries.get('toolsenabled-installer', Entry('', 0)).kind == 'dir', 'ARCHIVE_ROOT', 'Package root directory is absent')
            for name, entry in entries.items():
                if not name:
                    continue
                parent = posixpath.dirname(name)
                _require(parent in entries and entries[parent].kind == 'dir', 'ARCHIVE_PARENT', 'Member parent is missing or is a link')
                if entry.kind == 'link':
                    seen, target = {name}, posixpath.normpath(posixpath.join(parent, entry.target))
                    while True:
                        _require(target in entries and target not in seen, 'ARCHIVE_LINK', 'Archive link is dangling or cyclic')
                        seen.add(target)
                        if entries[target].kind != 'link':
                            break
                        target = posixpath.normpath(posixpath.join(posixpath.dirname(target), entries[target].target))
            result = cls()
            result.archive_sha256, result.limits, result._spool, result._tar, result._members = sha256, limits, spool, tar, members
            result.package_inventory = Inventory(entries, sha256, _authority=_PROVENANCE)
            return result
        except BaseException as error:
            if tar is not None:
                tar.close()
            if spool is not None:
                spool.close()
            if isinstance(error, (tarfile.TarError, gzip.BadGzipFile, EOFError, UnicodeError)):
                raise FleetFSError('ARCHIVE_INVALID', 'Archive compression or headers are invalid') from error
            raise
        finally:
            os.close(fd)

    def read_bytes(self, member, max_bytes=1024 * 1024):
        _require(member in self._members and self._members[member].isfile() and self._members[member].size <= max_bytes,
                 'ARCHIVE_MEMBER', 'Expected bounded regular archive member')
        with self._tar.extractfile(self._members[member]) as stream:
            data = stream.read(max_bytes + 1)
        _require(len(data) <= max_bytes and hashlib.sha256(data).hexdigest() == self.package_inventory.entries[member].sha256,
                 'INTEGRITY', 'Archive member no longer matches its verified inventory')
        return data

    def runtime_inventory(self, prefix, generated_files):
        return _runtime_inventory(self.package_inventory, self.read_bytes('toolsenabled-installer/manifest.json'), prefix, generated_files)

    def close(self):
        self._tar.close()
        self._spool.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def _runtime_inventory(package_inventory, manifest, prefix, generated_files):
    _absolute(prefix)
    required = {'bin/toolsenabled', 'bin/toolsenabled-openshell', 'env.sh'}
    _require(required <= set(generated_files) <= required | {'.fleet-ownership.json', '.fleet-generation'},
             'GENERATED_PATH', 'Generated paths must be the exact supported runtime wrappers and optional receipt and marker')
    _require('.fleet-generation' not in generated_files or '.fleet-ownership.json' in generated_files,
             'GENERATED_PATH', 'Generation marker requires an ownership receipt')
    entries = {'': Entry('dir', 0o700), 'bin': Entry('dir', 0o700), 'runtime': Entry('dir', 0o700),
               'manifest.json': Entry('file', 0o600, len(manifest), hashlib.sha256(manifest).hexdigest())}
    base = 'toolsenabled-installer/payload/engine'
    _require(base in package_inventory.entries and package_inventory.entries[base].kind == 'dir', 'ARCHIVE_ENGINE', 'Archive lacks the runtime engine')
    for name, entry in package_inventory.entries.items():
        if name == base or name.startswith(base + '/'):
            installed = entry
            if (package_inventory.archive_sha256 not in LEGACY_ARCHIVES
                    and package_inventory.archive_sha256 not in C10_RELEASES
                    and entry.kind in ('file', 'dir')):
                installed = Entry(entry.kind, entry.mode & ~0o022, entry.size, entry.sha256, entry.target)
            entries['runtime/engine' + name[len(base):]] = installed
    for name, generated in generated_files.items():
        if isinstance(generated, GeneratedFile):
            _require(isinstance(generated.data, bytes) and len(generated.data) <= 65536
                     and generated.mode in (0o600, 0o644, 0o700, 0o755), 'GENERATED_DATA', 'Generated file is not bounded or has an unsafe mode')
            if name == '.fleet-ownership.json':
                _require(generated.mode == 0o600 and len(generated.data) <= 16384, 'GENERATED_DATA', 'Receipt must be a bounded private regular file')
            if name == '.fleet-generation':
                _require(generated.mode == 0o600 and len(generated.data) == 65
                         and re.fullmatch(rb'[a-f0-9]{64}\n', generated.data),
                         'GENERATED_DATA', 'Generation marker must be a bounded private regular file')
            entries[name] = Entry('file', generated.mode, len(generated.data), hashlib.sha256(generated.data).hexdigest())
        else:
            _require(isinstance(generated, GeneratedLink) and name == 'bin/toolsenabled-openshell'
                     and generated.target == 'toolsenabled', 'GENERATED_DATA', 'Only the fixed command alias may be a generated link')
            entries[name] = Entry('link', 0o777, target=generated.target)
    for name, entry in entries.items():
        if name.startswith('runtime/engine/') and entry.kind == 'link':
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), entry.target))
            _require(target.startswith('runtime/engine/') and target in entries,
                     'ARCHIVE_LINK', 'A runtime link leaves the independently inventoried engine')
    return Inventory(entries, package_inventory.archive_sha256, _authority=_PROVENANCE, runtime=True)


def _materialize(handle, inventory, content):
    _guard_tree(handle)
    _require(handle.exclusive_created and not os.listdir(handle.fd) and _same(os.fstat(handle.fd), {'uid': os.geteuid(), 'mode': 0o700}),
             'STAGE_NOT_EMPTY', 'Destination must be an empty exclusively-created private directory')
    fds = {'': os.dup(handle.fd)}
    identities = {'': identity(handle.fd)}
    try:
        for name, entry in sorted(inventory.entries.items(), key=lambda item: (item[0].count('/'), item[0])):
            if not name or entry.kind != 'dir':
                continue
            handle.revalidate()
            parent, leaf = posixpath.split(name)
            _check_directory_chain(handle, fds, identities, parent)
            os.mkdir(leaf, 0o700, dir_fd=fds[parent])
            fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fds[parent])
            fds[name] = fd
            identities[name] = identity(fd)
        for name, entry in inventory.entries.items():
            if entry.kind == 'dir':
                continue
            handle.revalidate()
            parent, leaf = posixpath.split(name)
            _check_directory_chain(handle, fds, identities, parent)
            if entry.kind == 'link':
                os.symlink(entry.target, leaf, dir_fd=fds[parent])
                continue
            fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fds[parent])
            try:
                data = content(name)
                _require(len(data) == entry.size and hashlib.sha256(data).hexdigest() == entry.sha256,
                         'INTEGRITY', 'Materialized file differs from verified inventory', name)
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    _require(written > 0, 'WRITE_FAILED', 'File write made no progress')
                    view = view[written:]
                os.fchmod(fd, entry.mode)
                os.fsync(fd)
            finally:
                os.close(fd)
        for name, fd in sorted(fds.items(), key=lambda item: item[0].count('/'), reverse=True):
            os.fchmod(fd, inventory.entries[name].mode)
            os.fsync(fd)
    finally:
        for fd in fds.values():
            os.close(fd)
    verify_tree(handle, inventory)
    return inventory


def extract_archive(archive, handle):
    return _materialize(handle, archive.package_inventory,
                        lambda name: archive.read_bytes(name, max_bytes=archive.limits.file_bytes))


def materialize_runtime(archive, handle, generated_files):
    inventory = archive.runtime_inventory(handle.path, generated_files)
    def content(name):
        if name in generated_files:
            return generated_files[name].data
        member = 'toolsenabled-installer/manifest.json' if name == 'manifest.json' else 'toolsenabled-installer/payload/engine' + name[len('runtime/engine'):]
        return archive.read_bytes(member, max_bytes=archive.limits.file_bytes)
    return _materialize(handle, inventory, content)


def _verify_open_tree(handle, inventory, protected_paths, allow_missing=False, *,
                      _package_staging=False, _legacy_runtime=False):
    _require(isinstance(inventory, Inventory) and inventory._authority is _PROVENANCE, 'INVENTORY_UNTRUSTED', 'Inventory does not have pinned archive provenance')
    _require(type(allow_missing) is bool, 'INVENTORY_UNTRUSTED', 'Cleanup resumption must be an explicit boolean')
    _require(type(_legacy_runtime) is bool and (not _legacy_runtime or inventory.archive_sha256 in LEGACY_ARCHIVES
             or inventory.archive_sha256 in C10_RELEASES),
             'INVENTORY_UNTRUSTED', 'Runtime mode reduction requires an independently pinned older archive')
    _require(not (_legacy_runtime and _package_staging), 'INVENTORY_UNTRUSTED',
             'Runtime and package staging mode policies cannot be combined')
    _guard_tree(handle, protected_paths)
    directories, snapshots, seen = {'': os.dup(handle.fd)}, {}, set()
    try:
        def check(name, value):
            _require(name in inventory.entries, 'TREE_UNKNOWN', 'Tree contains an unexpected entry', name)
            entry = inventory.entries[name]
            kind = 'dir' if stat.S_ISDIR(value.st_mode) else 'file' if stat.S_ISREG(value.st_mode) else 'link' if stat.S_ISLNK(value.st_mode) else 'special'
            expected_uid, actual_mode = os.geteuid(), stat.S_IMODE(value.st_mode)
            mode_matches = actual_mode == entry.mode
            if (_package_staging or _legacy_runtime) and entry.kind in ('file', 'dir'):
                # External extraction may remove group/other bits. For a
                # published 1.4.0/1.4.1 runtime only, the old installer could
                # leave those same reduced modes. New runtimes stay exact.
                mode_matches = (actual_mode & 0o700) == (entry.mode & 0o700) and actual_mode & ~entry.mode == 0
            _require(kind == entry.kind and value.st_uid == expected_uid and mode_matches,
                     'TREE_CHANGED', f'Entry {(name or ".")!r} differs from the pinned inventory: '
                     f'expected type={entry.kind} uid={expected_uid} mode={entry.mode:04o}; '
                     f'actual type={kind} uid={value.st_uid} mode={actual_mode:04o}', name)
            if inventory.runtime and kind in ('file', 'dir'):
                _require(not actual_mode & 0o022, 'TREE_WRITABLE',
                         'Runtime has group/other-writable files or directories; run chmod -R go-w <runtime> yourself and retry', name)
            _require(kind != 'file' or value.st_nlink == 1, 'TREE_CHANGED', 'Regular file has unowned hardlink aliases', name)
            seen.add(name)
            snapshots[name] = _fingerprint(value)
            return entry
        check('', os.fstat(handle.fd))
        pending = ['']
        while pending:
            directory = pending.pop()
            fd = directories[directory]
            for leaf in os.listdir(fd):
                _relative(leaf)
                name = directory + '/' + leaf if directory else leaf
                value = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                entry = check(name, value)
                if entry.kind == 'dir':
                    child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    directories[name] = child
                    _require(_fingerprint(os.fstat(child)) == snapshots[name], 'TREE_CHANGED', 'Directory changed while opening', name)
                    pending.append(name)
                elif entry.kind == 'link':
                    _require(os.readlink(leaf, dir_fd=fd) == entry.target, 'TREE_CHANGED', 'Link target differs from pinned inventory', name)
                else:
                    child = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        before = os.fstat(child)
                        _require(_fingerprint(before) == snapshots[name] and before.st_size == entry.size,
                                 'TREE_CHANGED', 'File changed while opening', name)
                        hashed, total = hashlib.sha256(), 0
                        while True:
                            data = os.read(child, min(1024 * 1024, entry.size + 1 - total))
                            if not data:
                                break
                            total += len(data)
                            _require(total <= entry.size, 'TREE_CHANGED', 'File exceeds pinned size', name)
                            hashed.update(data)
                        _require(total == entry.size and hashed.hexdigest() == entry.sha256
                                 and _fingerprint(os.fstat(child)) == snapshots[name],
                                 'TREE_CHANGED', 'File bytes or identity differ from pinned inventory', name)
                    finally:
                        os.close(child)
                _require(_fingerprint(os.stat(leaf, dir_fd=fd, follow_symlinks=False)) == snapshots[name],
                         'TREE_CHANGED', 'Entry changed during verification', name)
        _require(allow_missing or seen == set(inventory.entries), 'TREE_MISSING', 'Tree is missing pinned entries')
        handle.revalidate()
        return directories, snapshots
    except BaseException:
        for fd in directories.values():
            os.close(fd)
        raise


def verify_extracted_package(private_parent, archive):
    """Verify only a pinned package beneath an owned, private direct parent.

    Ordinary extraction may remove group/other permissions; it may not change
    owner permissions, add permissions, or alter any other inventory property.
    This proof is for staging, never for runtime adoption or deletion.
    """
    _require(isinstance(archive, VerifiedArchive), 'INVENTORY_UNTRUSTED',
             'Package staging requires an independently verified archive')
    _require(isinstance(private_parent, SafeDirectory), 'STAGE_BOUNDARY',
             'Package staging requires a retained private parent')
    private_parent.revalidate()
    value = os.fstat(private_parent.fd)
    _require(stat.S_ISDIR(value.st_mode) and value.st_uid == os.geteuid()
             and stat.S_IMODE(value.st_mode) == 0o700, 'STAGE_BOUNDARY',
             'Package staging requires an owned 0700 direct parent')
    inventory = archive.package_inventory.subtree('toolsenabled-installer')
    with private_parent.child('toolsenabled-installer') as package:
        directories, snapshots = _verify_open_tree(package, inventory, (), _package_staging=True)
        try:
            private_parent.revalidate()
            return {'rootIdentity': dict(package.identity), 'entries': len(snapshots),
                    'archiveSha256': inventory.archive_sha256}
        finally:
            for fd in directories.values():
                os.close(fd)


def verify_tree(handle, inventory, *, protected_paths=(), allow_missing=False, legacy_runtime=False):
    """Full proof by default; allow_missing is only for a journaled cleanup.

    The transaction caller must already have persisted the full initial proof,
    same root identity, COMMITTED phase and CLEAN_OLD intent. This flag is not
    permitted for initial ownership/adoption or rollback preflight. Every entry
    that still exists is always checked; unknown entries are never allowed.
    """
    directories, snapshots = _verify_open_tree(handle, inventory, protected_paths, allow_missing,
                                                _legacy_runtime=legacy_runtime)
    try:
        return {'rootIdentity': dict(handle.identity), 'entries': len(snapshots), 'archiveSha256': inventory.archive_sha256}
    finally:
        for fd in directories.values():
            os.close(fd)


def _require_root_identity(expected_identity):
    _require(isinstance(expected_identity, dict) and {'dev', 'ino'} <= set(expected_identity)
             and set(expected_identity) <= {'dev', 'ino', 'uid', 'gid', 'mode'}
             and all(type(value) is int and value >= 0 for value in expected_identity.values())
             and expected_identity['ino'] > 0,
             'ROOT_CHANGED', 'A concrete independently retained root identity is required')


class RetainedTree:
    """Full ownership proof held across bounded external registration work.

    No missing-entry mode is supported here. The same descriptors and original
    entry identities are used for final checks and deletion. Caller retains
    the parent and closes this session even on an uncertain external outcome.
    """
    def __init__(self, parent, name, inventory, expected_identity, *, protected_paths=(), expected_snapshots=None,
                 legacy_runtime=False):
        _require_root_identity(expected_identity)
        self.parent, self.name, self.inventory = parent, name, inventory
        self.expected_identity, self.protected_paths = dict(expected_identity), tuple(protected_paths)
        self.handle, self.directories, self.snapshots = None, {}, {}
        self.closed = False
        try:
            parent.revalidate()
            self.handle = parent.child(name)
            _require(_same(os.fstat(self.handle.fd), expected_identity), 'ROOT_CHANGED', 'Retained root identity differs')
            self.directories, self.snapshots = _verify_open_tree(self.handle, inventory, self.protected_paths,
                                                                 _legacy_runtime=legacy_runtime)
            for relative, fingerprint in (expected_snapshots or {}).items():
                _require(relative in self.snapshots and self.snapshots[relative] == fingerprint,
                         'TREE_CHANGED', 'Validated generation identity changed before retention', relative)
        except BaseException:
            self.close()
            raise

    def revalidate(self):
        _require(not self.closed, 'DIRECTORY_CLOSED', 'Retained tree session is closed')
        self.parent.revalidate()
        _guard_tree(self.handle, self.protected_paths)
        expected_children = {name: set() for name in self.directories}
        for name in self.snapshots:
            if name:
                directory, leaf = posixpath.split(name)
                expected_children[directory].add(leaf)
        for directory, fd in self.directories.items():
            _require(_fingerprint(os.fstat(fd)) == self.snapshots[directory],
                     'TREE_CHANGED', 'A retained directory changed during external work', directory)
            _require(set(os.listdir(fd)) == expected_children[directory],
                     'TREE_CHANGED', 'Retained directory membership changed during external work', directory)
        for name, before in self.snapshots.items():
            if not name:
                continue
            directory, leaf = posixpath.split(name)
            current = os.stat(leaf, dir_fd=self.directories[directory], follow_symlinks=False)
            _require(_fingerprint(current) == before, 'TREE_CHANGED', 'Entry identity changed during external work', name)
            entry = self.inventory.entries[name]
            if entry.kind == 'link':
                _require(os.readlink(leaf, dir_fd=self.directories[directory]) == entry.target,
                         'TREE_CHANGED', 'Retained link target changed', name)
            elif entry.kind == 'file':
                fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.directories[directory])
                try:
                    _require(_fingerprint(os.fstat(fd)) == before, 'TREE_CHANGED', 'File substituted during recheck', name)
                    hashed, total = hashlib.sha256(), 0
                    while True:
                        data = os.read(fd, min(1024 * 1024, entry.size + 1 - total))
                        if not data:
                            break
                        total += len(data)
                        _require(total <= entry.size, 'TREE_CHANGED', 'Retained file exceeded pinned size', name)
                        hashed.update(data)
                    _require(total == entry.size and hashed.hexdigest() == entry.sha256
                             and _fingerprint(os.fstat(fd)) == before,
                             'TREE_CHANGED', 'Retained file bytes changed during external work', name)
                finally:
                    os.close(fd)
        self.handle.revalidate()
        return {'rootIdentity': dict(self.handle.identity), 'entries': len(self.snapshots),
                'archiveSha256': self.inventory.archive_sha256}

    def protect(self, paths):
        """Add inspected context roots without relaxing the existing proof."""
        self.protected_paths = tuple(sorted(set(self.protected_paths) | set(paths)))
        return self.revalidate()

    def remove(self, *, _before_remove=None):
        try:
            self.revalidate()
        except (FleetFSError, OSError) as error:
            return _cleanup_refusal(error, 0)
        return _remove_retained(self.parent, self.name, self.inventory, self.expected_identity,
                                self.handle, self.directories, self.snapshots,
                                self.protected_paths, _before_remove)

    def close(self):
        if not self.closed:
            for fd in self.directories.values():
                os.close(fd)
            self.directories = {}
            if self.handle is not None:
                self.handle.close()
            self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def _cleanup_refusal(error, removed):
    return CleanupResult(False, removed, ({'code': getattr(error, 'code', 'FILESYSTEM_CHANGED'),
                                          'relative': getattr(error, 'relative', None), 'message': str(error)},))


def remove_tree(parent, name, inventory, expected_identity, *, protected_paths=(), allow_missing=False,
                legacy_runtime=False, _before_remove=None):
    """Remove only the independently inventoried tree; retain uncertainty.

    Whole-tree verification precedes mutation. If a later change appears, known
    entries already removed stay removed, the unknown entry stays, and complete
    is false. Never turn an incomplete cleanup into a successful recursive rm.
    """
    directories, handle = {}, None
    try:
        _require_root_identity(expected_identity)
        parent.revalidate()
        handle = parent.child(name)
        _require(_same(os.fstat(handle.fd), expected_identity), 'ROOT_CHANGED', 'Tree root differs from the exclusively-created identity')
        directories, snapshots = _verify_open_tree(handle, inventory, protected_paths, allow_missing,
                                                    _legacy_runtime=legacy_runtime)
        return _remove_retained(parent, name, inventory, expected_identity, handle, directories,
                                snapshots, protected_paths, _before_remove)
    except (FleetFSError, OSError) as error:
        return _cleanup_refusal(error, 0)
    finally:
        for fd in directories.values():
            os.close(fd)
        if handle is not None:
            handle.close()


def _remove_retained(parent, name, inventory, expected_identity, handle, directories,
                     snapshots, protected_paths, _before_remove):
    removed = 0
    try:
        for relative in sorted(snapshots, key=lambda value: (value.count('/'), value), reverse=True):
            if not relative:
                continue
            if _before_remove:
                _before_remove(relative)
            _guard_tree(handle, protected_paths)
            directory, leaf = posixpath.split(relative)
            # Every retained directory must still be reachable by the same
            # no-follow chain before a mutation beneath it.
            probe = directory
            while probe:
                above, component = posixpath.split(probe)
                current = os.stat(component, dir_fd=directories[above], follow_symlinks=False)
                _require(stat.S_ISDIR(current.st_mode) and current.st_dev == snapshots[probe][0]
                         and current.st_ino == snapshots[probe][1], 'TREE_CHANGED', 'Directory entry was substituted', probe)
                probe = above
            current = os.stat(leaf, dir_fd=directories[directory], follow_symlinks=False)
            entry = inventory.entries[relative]
            if entry.kind == 'dir':
                _require(current.st_dev == snapshots[relative][0] and current.st_ino == snapshots[relative][1]
                         and current.st_uid == os.geteuid() and current.st_mode == snapshots[relative][2]
                         and current.st_gid == snapshots[relative][4]
                         and not os.listdir(directories[relative]), 'TREE_CHANGED', 'Directory changed or acquired unknown entries', relative)
                os.rmdir(leaf, dir_fd=directories[directory])
            else:
                _require(_fingerprint(current) == snapshots[relative], 'TREE_CHANGED', 'Entry changed before removal', relative)
                os.unlink(leaf, dir_fd=directories[directory])
            removed += 1
        _guard_tree(handle, protected_paths)
        _require(not os.listdir(handle.fd), 'TREE_UNKNOWN', 'Root acquired unknown entries')
        parent.revalidate()
        _require(_same(os.stat(name, dir_fd=parent.fd, follow_symlinks=False), expected_identity),
                 'ROOT_CHANGED', 'Root name changed before removal')
        os.rmdir(name, dir_fd=parent.fd)
        os.fsync(parent.fd)
        return CleanupResult(True, removed + 1, ())
    except (FleetFSError, OSError) as error:
        return _cleanup_refusal(error, removed)


# These are independent immutable release pins, not values learned from the
# runtime being replaced or from its ownership receipt. The catalog's own hash
# binds every entry and exact manifest byte to the reviewed generated source.
LEGACY_CATALOG_SHA256 = 'f261de89bfb730927d55fd143685500f549b52d177db09701f71b7859df76634'
LEGACY_ARCHIVES = {
    'edc9e4bc76a738b56f037587ed9438458a4a0e7f06a08ab305aa5de57e356eed': ('2d77e45e70b37b2911a2da342dda8ff23b583030', '1.4.0'),
    '0fff72445daa33613702a76ee7c2d01b0cac0188329728e8a7301883b87f42b3': ('3b7f5b1fe753a085d50c63e06ee115a2bcfb7212', '1.4.1'),
}
C10_RELEASES = {
    '04071944a67ae4f4dddbc06d6e1d529d287aa5eba1848aea0443455ee5d622b5':
        ('38ef40d96301028427bea4916ada04672c4b1581', '1.4.2'),
}


class LegacyCatalog:
    def __init__(self, archive_sha256, manifest, entries, *, _authority=None):
        _require(_authority is _PROVENANCE, 'INVENTORY_UNTRUSTED', 'Legacy inventory is not from the independently pinned catalog')
        self.archive_sha256, self._manifest = archive_sha256, manifest
        self.package_inventory = Inventory(entries, archive_sha256, _authority=_PROVENANCE)

    def read_bytes(self, member, max_bytes=1024 * 1024):
        _require(member == 'toolsenabled-installer/manifest.json' and len(self._manifest) <= max_bytes,
                 'ARCHIVE_MEMBER', 'Legacy catalog contains only exact manifest bytes and payload hashes')
        return self._manifest

    def runtime_inventory(self, prefix, generated_files):
        return _runtime_inventory(self.package_inventory, self._manifest, prefix, generated_files)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


@lru_cache(maxsize=1)
def _legacy_catalogs():
    location = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fleet_legacy_inventory.json')
    fd = os.open(location, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        _require(stat.S_ISREG(info.st_mode) and info.st_size <= 2 * 1024 * 1024,
                 'INTEGRITY', 'Legacy catalog is not a bounded regular file')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
        _require(hashlib.sha256(data).hexdigest() == LEGACY_CATALOG_SHA256,
                 'INTEGRITY', 'Legacy catalog differs from its independently pinned bytes')
    finally:
        os.close(fd)
    value = json.loads(data)
    _require(set(value) == {'schemaVersion', 'catalogs'} and value['schemaVersion'] == 1
             and len(value['catalogs']) == len(LEGACY_ARCHIVES), 'INTEGRITY', 'Legacy catalog schema differs')
    catalogs = {}
    for item in value['catalogs']:
        _require(set(item) == {'archiveSha256', 'sourceCommit', 'version', 'manifestBase64', 'entries'},
                 'INTEGRITY', 'Legacy inventory has unexpected fields')
        pin = item['archiveSha256']
        _require(pin in LEGACY_ARCHIVES and pin not in catalogs
                 and (item['sourceCommit'], item['version']) == LEGACY_ARCHIVES[pin],
                 'INTEGRITY', 'Legacy inventory does not name an independently pinned archive')
        manifest = base64.b64decode(item['manifestBase64'], validate=True)
        metadata = json.loads(manifest)
        _require(len(manifest) <= 65536 and metadata['source_commit'] == item['sourceCommit']
                 and metadata['version'] == item['version'] and metadata['name'] == 'toolsenabled-openshell',
                 'INTEGRITY', 'Legacy manifest differs from independently pinned release identity')
        entries = {}
        for relative, entry in item['entries'].items():
            _relative(relative)
            _require(set(entry) == {'kind', 'mode', 'size', 'sha256', 'target'} and entry['kind'] in ('file', 'dir', 'link')
                     and isinstance(entry['mode'], int) and 0 <= entry['mode'] <= 0o777
                     and isinstance(entry['size'], int) and 0 <= entry['size'] <= Limits().file_bytes,
                     'INTEGRITY', 'Legacy entry schema differs')
            entries[relative] = Entry(**entry)
        catalogs[pin] = LegacyCatalog(pin, manifest, entries, _authority=_PROVENANCE)
    return MappingProxyType(catalogs)


def load_legacy_catalog(selector):
    """Select a candidate proof; manifest claims never replace verify_tree."""
    _require(isinstance(selector, dict), 'INTEGRITY', 'Legacy selector must be an object')
    matches = []
    for pin, catalog in _legacy_catalogs().items():
        source, version = LEGACY_ARCHIVES[pin]
        if selector.get('archiveSha256') == pin or (selector.get('source_commit') == source and selector.get('version') == version):
            matches.append(catalog)
    _require(len(matches) == 1, 'INVENTORY_UNAVAILABLE', 'No independently pinned legacy inventory matches this runtime')
    return matches[0]
