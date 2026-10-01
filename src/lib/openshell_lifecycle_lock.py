"""One Linux per-uid Fleet mutation lock with durable uncertainty.

The fixed namespace is independent of HOME, profiles, services and prefix.
Children inherit the actual flock description; environment text alone is not
authority. Pending records are never discarded on PID/liveness guesses.
"""
import argparse
import contextlib
import fcntl
import json
import os
import secrets
import signal
import stat
import subprocess
import sys
import time

MAX_RECORD = 65536
FD_ENV = 'TOOLSENABLED_FLEET_LOCK_FD'
NONCE_ENV = 'TOOLSENABLED_FLEET_LOCK_NONCE'


class LockError(RuntimeError):
    pass


class Cancellation:
    def __init__(self):
        self.number = None

    def latch(self, number, _frame):
        self.number = self.number or number

    def checkpoint(self):
        if self.number is not None:
            raise LockError('OUTCOME_UNCERTAIN: lifecycle command was interrupted')


@contextlib.contextmanager
def deferred_signals():
    cancellation, previous = Cancellation(), {}
    try:
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[number] = signal.signal(number, cancellation.latch)
        yield cancellation
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    cancellation.checkpoint()


def retain_uncertainty(lock):
    if _read_pending(lock.dfd) is None:
        lock.write_pending({'nonce': lock.nonce, 'kind': 'manual', 'phase': 'OUTCOME_UNCERTAIN'})


def run_manual(lock, command, cancellation):
    child = None
    try:
        cancellation.checkpoint()
        child = subprocess.Popen(command, env=lock.child_env(), pass_fds=lock.pass_fds)
        cancellation.checkpoint()
        deadline = time.monotonic() + 180
        while True:
            cancellation.checkpoint()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LockError('OUTCOME_UNCERTAIN: lifecycle command timed out')
            try:
                returncode = child.wait(timeout=min(0.25, remaining))
                break
            except subprocess.TimeoutExpired:
                pass
        cancellation.checkpoint()
        if returncode == 0:
            lock.clear_pending(lock.nonce)
        elif returncode < 0:
            retain_uncertainty(lock)
            print('OUTCOME_UNCERTAIN: lifecycle child was interrupted; descendants may still run; recovery is required.', file=sys.stderr)
        elif _read_pending(lock.dfd) is not None:
            print('RECOVERY_REQUIRED: partial Fleet mutation retained; do not blindly replay setup.', file=sys.stderr)
        # The journal clear is also interruptible work. A latched signal must
        # reinstate the barrier rather than report a successful mutation.
        cancellation.checkpoint()
        return returncode if returncode >= 0 else 128 - returncode
    except BaseException:
        # Keep nonraising handlers installed through BOTH the durable record
        # and direct-child settlement. No claim is made about descendants.
        try:
            retain_uncertainty(lock)
        finally:
            if child is not None and child.poll() is None:
                try:
                    child.kill()
                    child.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        raise LockError('OUTCOME_UNCERTAIN: Fleet mutation did not settle; descendants may still run; recovery is required') from None


def namespace():
    return '/tmp/toolsenabled-fleet-lifecycle-' + str(os.getuid())


def _private(entry, directory=False):
    return (stat.S_ISDIR(entry.st_mode) if directory else stat.S_ISREG(entry.st_mode)) and entry.st_uid == os.getuid() and stat.S_IMODE(entry.st_mode) == (0o700 if directory else 0o600) and (directory or entry.st_nlink == 1)


def _open_namespace(root):
    # Production root is an immediate child of root-owned sticky /tmp. An
    # explicit root is an in-process test seam, never a CLI/environment option.
    parent, name = os.path.split(root)
    pfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        ps = os.fstat(pfd)
        if not (ps.st_uid == 0 and stat.S_IMODE(ps.st_mode) == 0o1777 or ps.st_uid == os.getuid() and stat.S_IMODE(ps.st_mode) == 0o700):
            raise LockError('SCOPE_UNSAFE: lifecycle parent is not protected')
        try:
            os.mkdir(name, 0o700, dir_fd=pfd)
        except FileExistsError:
            pass
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pfd)
        if not _private(os.fstat(fd), True):
            os.close(fd)
            raise LockError('SCOPE_UNSAFE: lifecycle namespace is not private')
        return pfd, fd, name
    except BaseException:
        os.close(pfd)
        raise


def _read_pending(dfd):
    try:
        fd = os.open('pending.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
    except FileNotFoundError:
        return None
    try:
        if not _private(os.fstat(fd)):
            raise LockError('RECOVERY_REQUIRED: invalid operation record')
        raw = os.read(fd, MAX_RECORD + 1)
        if len(raw) > MAX_RECORD:
            raise LockError('RECOVERY_REQUIRED: operation record is too large')
        record = json.loads(raw)
        if not isinstance(record, dict) or not isinstance(record.get('nonce'), str) or len(record['nonce']) != 32 or any(c not in '0123456789abcdef' for c in record['nonce']):
            raise ValueError('invalid nonce')
        return record
    except (ValueError, UnicodeError) as error:
        raise LockError('RECOVERY_REQUIRED: unreadable operation record') from error
    finally:
        os.close(fd)


class LifecycleLock:
    def __init__(self, recovery=False, *, _root=None):
        self.protected_root = _root or namespace()
        self.recovery = recovery
        self.fd = self.dfd = self.pfd = None
        self.nonce = secrets.token_hex(16)
        self.pending = None

    def __enter__(self):
        try:
            self.pfd, self.dfd, self.name = _open_namespace(self.protected_root)
            self.root_identity = (os.fstat(self.dfd).st_dev, os.fstat(self.dfd).st_ino)
            self.fd = os.open('lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=self.dfd)
            if not _private(os.fstat(self.fd)):
                raise LockError('SCOPE_UNSAFE: lifecycle lock is not a private regular file')
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise LockError('SCOPE_BUSY: another Fleet mutation is active') from error
            self.pending = _read_pending(self.dfd)
            if self.pending is not None:
                if not self.recovery:
                    raise LockError('RECOVERY_REQUIRED: an earlier Fleet mutation is unresolved')
                self.nonce = self.pending['nonce']
            self.revalidate()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    @property
    def pass_fds(self):
        return (self.fd,)

    def revalidate(self):
        root = os.stat(self.name, dir_fd=self.pfd, follow_symlinks=False)
        if not _private(root, True) or (root.st_dev, root.st_ino) != self.root_identity:
            raise LockError('SCOPE_UNSAFE: lifecycle namespace identity changed')
        current = os.stat('lock', dir_fd=self.dfd, follow_symlinks=False)
        held = os.fstat(self.fd)
        if not _private(current) or (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
            raise LockError('SCOPE_UNSAFE: lifecycle lock identity changed')

    def write_pending(self, record):
        self.revalidate()
        if not isinstance(record, dict) or record.get('nonce') != self.nonce:
            raise LockError('SCOPE_UNSAFE: operation nonce does not match held lock')
        data = (json.dumps(record, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
        if len(data) > MAX_RECORD:
            raise LockError('SCOPE_UNSAFE: operation record exceeds limit')
        existing = _read_pending(self.dfd)
        if existing is not None and existing['nonce'] != self.nonce:
            raise LockError('RECOVERY_REQUIRED: operation identity changed')
        temporary = '.pending-' + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.dfd)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self.revalidate()
            os.replace(temporary, 'pending.json', src_dir_fd=self.dfd, dst_dir_fd=self.dfd)
            os.fsync(self.dfd)
            self.pending = record
        finally:
            try:
                os.unlink(temporary, dir_fd=self.dfd)
            except FileNotFoundError:
                pass

    def clear_pending(self, expectedNonce):
        self.revalidate()
        record = _read_pending(self.dfd)
        if expectedNonce != self.nonce or record is not None and record['nonce'] != self.nonce:
            raise LockError('RECOVERY_REQUIRED: operation identity changed')
        if record is not None:
            os.unlink('pending.json', dir_fd=self.dfd)
            os.fsync(self.dfd)
        self.pending = None

    def child_env(self, base_env=None):
        self.revalidate()
        return {**(os.environ if base_env is None else base_env), FD_ENV: str(self.fd), NONCE_ENV: self.nonce}

    def __exit__(self, *_):
        for name in ('fd', 'dfd', 'pfd'):
            value = getattr(self, name, None)
            if value is not None:
                os.close(value)
                setattr(self, name, None)


def inherited():
    value, nonce = os.environ.get(FD_ENV, ''), os.environ.get(NONCE_ENV, '')
    if not value.isdecimal() or int(value) < 3 or len(nonce) != 32 or any(c not in '0123456789abcdef' for c in nonce):
        raise LockError('SCOPE_UNSAFE: missing validated lifecycle handle')
    lock = LifecycleLock()
    lock.pfd, lock.dfd, lock.name = _open_namespace(lock.protected_root)
    lock.root_identity = (os.fstat(lock.dfd).st_dev, os.fstat(lock.dfd).st_ino)
    try:
        lock.fd = os.dup(int(value))
        lock.nonce = nonce
        lock.revalidate()
        fcntl.flock(lock.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock.pending = _read_pending(lock.dfd)
        if lock.pending is not None and lock.pending['nonce'] != nonce:
            raise LockError('RECOVERY_REQUIRED: inherited operation does not match')
        return lock
    except BaseException:
        lock.__exit__(None, None, None)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['run', 'check', 'mark'])
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.action == 'run':
        command = args.command[1:] if args.command[:1] == ['--'] else args.command
        if not command or not os.path.isabs(command[0]):
            raise LockError('SCOPE_UNSAFE: expected an absolute executable')
        with LifecycleLock() as lock:
            try:
                with deferred_signals() as cancellation:
                    return run_manual(lock, command, cancellation)
            except BaseException:
                # Also cover cancellation latched during handler restoration
                # after a normally settled child. The lock is still held.
                with deferred_signals():
                    retain_uncertainty(lock)
                raise
    lock = inherited()
    try:
        if args.command:
            raise LockError('SCOPE_UNSAFE: unexpected handle-check arguments')
        if args.action == 'mark' and lock.pending is None:
            lock.write_pending({'nonce': lock.nonce, 'kind': 'manual', 'phase': 'MUTATING', 'home': os.environ.get('HOME')})
        print(json.dumps({'nonce': lock.nonce, 'protectedRoot': lock.protected_root}))
        return 0
    finally:
        lock.__exit__(None, None, None)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (LockError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
