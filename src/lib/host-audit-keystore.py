#!/usr/bin/python3
"""Private host audit records only. Never accesses a provider credential/keyring.

Same-user processes can read or alter these files; this is not tamper-proof.
Kernel flock serializes Fleet clients and descriptors reject links/unsafe modes.
Only closed codes cross stdout on failure, never paths or record contents.
"""
import fcntl
import json
import os
import secrets
import stat
import sys
import time

LIMIT = 32768
KEY = 'toolsenabled_audit_signing_key_v1'
HEAD = 'toolsenabled_audit_head_v1'
FILES = {KEY: 'signing-private-key.pem', HEAD: 'head.json'}


class Refusal(Exception):
    pass


def refuse(code='SECRET_VAULT_PATH_UNSAFE'):
    raise Refusal(code)


def identity(info):
    return info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode


def private(info, directory=False):
    if (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)
            or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or not directory and (info.st_nlink != 1 or info.st_size > LIMIT)):
        refuse()


class Store:
    def __init__(self, root, create):
        self.chain = []
        self.fd = None
        if (not isinstance(root, str) or not root.startswith('/') or root == '/'
                or os.path.normpath(root) != root or len(root) > 4096):
            refuse()
        self.chain.append((os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW), '', None))
        self.chain[0] = (self.chain[0][0], '', identity(os.fstat(self.chain[0][0])))
        for name in root.strip('/').split('/'):
            descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.chain[-1][0])
            info = os.fstat(descriptor)
            self.chain.append((descriptor, name, identity(info)))
            sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022 and not sticky_root:
                refuse()
        private(os.fstat(self.chain[-1][0]), True)
        if os.listxattr(self.chain[-1][0]):
            refuse()
        try:
            descriptor = os.open('audit-keys', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.chain[-1][0])
        except FileNotFoundError:
            if not create:
                return
            try:
                os.mkdir('audit-keys', 0o700, dir_fd=self.chain[-1][0])
            except FileExistsError:
                pass
            descriptor = os.open('audit-keys', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.chain[-1][0])
            os.fsync(self.chain[-1][0])
        self.chain.append((descriptor, 'audit-keys', identity(os.fstat(descriptor))))
        self.fd = descriptor
        private(os.fstat(descriptor), True)
        if os.listxattr(descriptor):
            refuse()
        self.check()

    def check(self):
        for index, (descriptor, name, previous) in enumerate(self.chain):
            if identity(os.fstat(descriptor)) != previous:
                refuse()
            if index and identity(os.stat(name, dir_fd=self.chain[index - 1][0], follow_symlinks=False)) != previous:
                refuse()

    def read(self, name):
        self.check()
        if self.fd is None:
            return None
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(descriptor)
            private(info)
            if os.listxattr(descriptor):
                refuse()
            raw = bytearray()
            while len(raw) <= LIMIT:
                chunk = os.read(descriptor, min(4096, LIMIT + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            current = os.fstat(descriptor)
            named = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            if (len(raw) != info.st_size or len(raw) > LIMIT or identity(current) != identity(info)
                    or identity(named) != identity(info) or current.st_mtime_ns != info.st_mtime_ns
                    or current.st_ctime_ns != info.st_ctime_ns or named.st_ctime_ns != info.st_ctime_ns):
                refuse()
            self.check()
            return bytes(raw).decode('utf8')
        finally:
            os.close(descriptor)

    def write(self, name, value):
        self.check()
        self.read(name)  # Refuse unsafe existing entries before replacement.
        raw = value.encode('utf8')
        if not raw or len(raw) > LIMIT:
            refuse('SECRET_INPUT_INVALID')
        temporary = '.write-' + secrets.token_hex(16)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            private(os.fstat(descriptor))
            if os.listxattr(descriptor):
                refuse()
            remaining = memoryview(raw)
            while remaining:
                count = os.write(descriptor, remaining)
                if count <= 0:
                    refuse('SECRET_VAULT_WRITE_FAILED')
                remaining = remaining[count:]
            os.fsync(descriptor)
            self.check()
            os.replace(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        finally:
            os.close(descriptor)
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass

    def operate(self, request):
        operation = request.get('operation')
        if self.fd is None:
            if operation == 'peek':
                return None
            refuse('SECRET_NOT_CONFIGURED')
        lock = os.open('store.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.fd)
        try:
            private(os.fstat(lock))
            if os.fstat(lock).st_size or os.listxattr(lock):
                refuse()
            deadline = time.monotonic() + 2
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() > deadline:
                        refuse('SECRET_VAULT_LOCK_TIMEOUT')
                    time.sleep(0.01)
            self.check()
            if identity(os.stat('store.lock', dir_fd=self.fd, follow_symlinks=False)) != identity(os.fstat(lock)):
                refuse()
            selected = self.read('store.json')
            if selected is not None:
                parsed = json.loads(selected)
                if not isinstance(parsed, dict) or set(parsed) != {'kind'} or parsed['kind'] not in ('private-file', 'os-keyring'):
                    refuse('SECRET_VAULT_UNREADABLE')
                selected = parsed['kind']
            if operation == 'peek':
                return selected
            if operation == 'select':
                kind = request.get('kind')
                if kind not in ('private-file', 'os-keyring'):
                    refuse('SECRET_INPUT_INVALID')
                if selected is None:
                    self.write('store.json', json.dumps({'kind': kind}) + '\n')
                return selected or kind
            key = request.get('key')
            if key not in FILES:
                refuse('SECRET_ACCESS_DENIED')
            if selected not in (None, 'private-file'):
                refuse('SECRET_ACCESS_DENIED')
            value = self.read(FILES[key])
            if operation == 'get':
                if value is None:
                    refuse('SECRET_NOT_CONFIGURED')
                return value
            incoming = request.get('value')
            if not isinstance(incoming, str) or not incoming or len(incoming.encode()) > LIMIT:
                refuse('SECRET_INPUT_INVALID')
            if selected != 'private-file':
                refuse('SECRET_ACCESS_DENIED')
            if operation == 'getOrCreate' and key == KEY:
                if value is None:
                    self.write(FILES[key], incoming)
                return incoming if value is None else value
            if operation == 'setMonotonic' and key == HEAD:
                sequence = request.get('sequence')
                if type(sequence) is not int or not 0 <= sequence <= 9007199254740991 or json.loads(incoming).get('sequence') != sequence:
                    refuse('SECRET_INPUT_INVALID')
                if value is not None:
                    current = json.loads(value).get('sequence')
                    if type(current) is not int or current < 0:
                        refuse('SECRET_VAULT_UNREADABLE')
                    if sequence < current or sequence == current and value != incoming:
                        refuse('SECRET_MONOTONIC_CONFLICT')
                    if sequence == current:
                        return None
                self.write(FILES[key], incoming)
                return None
            refuse('SECRET_ACCESS_DENIED')
        finally:
            os.close(lock)  # Keep the inode stable for all Fleet processes.

    def close(self):
        for descriptor, _, _ in reversed(self.chain):
            os.close(descriptor)
        self.chain = []


def main():
    os.umask(0o077)
    store = None
    try:
        raw = sys.stdin.buffer.read(LIMIT + 1024)
        if len(raw) > LIMIT + 512 or len(sys.argv) != 2:
            refuse('SECRET_INPUT_INVALID')
        request = json.loads(raw)
        if not isinstance(request, dict):
            refuse('SECRET_INPUT_INVALID')
        store = Store(sys.argv[1], request.get('operation') in ('select', 'getOrCreate', 'setMonotonic'))
        response = {'ok': True, 'value': store.operate(request)}
    except Refusal as error:
        response = {'ok': False, 'code': str(error)}
    except (OSError, ValueError, TypeError, AttributeError):
        response = {'ok': False, 'code': 'SECRET_VAULT_PATH_UNSAFE'}
    finally:
        if store is not None:
            store.close()
    sys.stdout.write(json.dumps(response, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
