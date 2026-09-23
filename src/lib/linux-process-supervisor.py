"""Interactive engine descendant scope, not a sandbox or durable cgroup.

Derived from the qualified LIVE build guardian; fd 4 carries only worker stdin.
The private lifecycle descriptor (fd 3) never reaches the worker.

Subreaper adoption includes double-forked and setsid descendants. A /proc child
list is only a discovery hint: completeness is established by kernel ECHILD.
Every signalled process is first a waitid(P_PIDFD)-verified child and its pidfd
is retained until it is positively reaped. No numeric-PID or group kill.
Primary interfaces:
https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
https://man7.org/linux/man-pages/man2/pidfd_open.2.html
https://man7.org/linux/man-pages/man2/waitid.2.html
"""
import ctypes
import errno
import json
import os
import select
import signal
import sys
import time

LIMIT = 4 * 1024 * 1024
# waitid otherwise excludes clone children whose exit signal is not SIGCHLD.
# Since Linux 4.7 this __WALL flag covers both clone and non-clone children.
# https://man7.org/linux/man-pages/man2/waitid.2.html (Linux notes).
WALL = 0x40000000
OBSERVE = os.WEXITED | os.WNOHANG | os.WNOWAIT | WALL
REAP = os.WEXITED | WALL


# Descriptors 0-2 plus the protocol pipe (3) and worker stdin (4) are this
# helper's whole contract; anything above it belongs to the caller. The Linux
# launcher hands the LIVE lifetime lock to Electron at fd 9 on purpose, and the
# browser process keeps that lock, its own IPC sockets, its profile cache files
# and (when outside control is on) its debugging listener open WITHOUT
# FD_CLOEXEC. Node re-marks what it inherits close-on-exec at startup; CPython
# does not, and the root below is started with fork + execvpe, which honours no
# subprocess close_fds. Without this the worker, and every descendant of it,
# would hold the caller's descriptors: a survivor then keeps the lifetime lock
# and the app cannot be started again. Closing a duplicate descriptor never
# releases an flock still held through another one.
CONTRACT = (0, 1, 2, 3, 4)


def close_inherited():
    # The current soft limit does not bound descriptors already inherited.
    # These standalone, single-threaded entry points must enumerate completely
    # before admission; unavailable enumeration is a refusal, never a scan of
    # an assumed fd range.
    try:
        listing = os.listdir("/proc/self/fd")
    except OSError:
        raise RuntimeError("inherited descriptor enumeration unavailable") from None
    for name in listing:
        try:
            value = int(name)
        except ValueError:
            raise RuntimeError("inherited descriptor enumeration invalid") from None
        if value in CONTRACT:
            continue
        try:
            os.close(value)
        except OSError as error:
            # listdir's own fd has already closed. Any other close failure
            # cannot establish sanitation and must prevent admission.
            if error.errno != errno.EBADF:
                raise RuntimeError("inherited descriptor closure unconfirmed") from None


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def children():
    # This single thread never reaps between discovery and pidfd acquisition.
    # The kernel may omit entries during exit; absence here NEVER means empty.
    with open("/proc/self/task/%d/children" % os.getpid(), "r", encoding="ascii") as stream:
        value = stream.read(1024 * 1024 + 1)
    if len(value) > 1024 * 1024:
        raise RuntimeError("child discovery unavailable")
    return [int(item) for item in value.split()]


def prepare():
    if not sys.platform.startswith("linux") or not all(hasattr(os, key) for key in
            ("fork", "pidfd_open", "P_PIDFD", "waitid", "WNOWAIT")) or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("native ownership unavailable")
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("subreaper unavailable")
    fd = os.pidfd_open(os.getpid())
    try:
        try:
            os.waitid(os.P_PIDFD, fd, OBSERVE)
        except ChildProcessError:
            pass
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    children()


def main():
    close_inherited()
    pending = b""

    def read_line(limit):
        nonlocal pending
        while b"\n" not in pending and len(pending) <= limit:
            data = os.read(0, min(8192, limit + 1 - len(pending)))
            if not data:
                return pending
            pending += data
        if b"\n" not in pending:
            return pending
        line, pending = pending.split(b"\n", 1)
        return line + b"\n"

    raw = read_line(LIMIT + 1)
    if len(raw) > LIMIT + 1 or not raw.endswith(b"\n"):
        return 2
    try:
        config = json.loads(raw, object_pairs_hook=unique_object)
        if set(config) != {"version", "nonce", "command", "args", "cwd", "env", "terminateDescendantsOnRootExit"} or config["version"] != 2:
            return 2
        nonce = config["nonce"]
        if not isinstance(nonce, str) or len(nonce) != 64 or any(char not in "0123456789abcdef" for char in nonce):
            return 2
    except BaseException:
        return 2

    def emit(kind, **fields):
        value = {"version": 2, "nonce": nonce, "type": kind, **fields}
        try:
            os.write(3, (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii"))
        except OSError:
            pass  # Losing the caller cannot release the still-owned descendants.

    def complete(started=False, cancelled=False, reason=None, code=None, sig=None, observed=0, reaped=0):
        emit("complete", started=started, quiescent=True, cancelled=cancelled,
             exitCode=code, exitSignal=sig, reason=reason, observedChildren=observed, reapedChildren=reaped)

    try:
        if (not isinstance(config["command"], str) or not config["command"] or "\0" in config["command"]
                or not isinstance(config["args"], list) or any(not isinstance(arg, str) or "\0" in arg for arg in config["args"])
                or not isinstance(config["cwd"], str) or "\0" in config["cwd"]
                or not isinstance(config["terminateDescendantsOnRootExit"], bool)
                or not isinstance(config["env"], dict)
                or any(not isinstance(key, str) or not key or "=" in key or "\0" in key
                       or not isinstance(value, str) or "\0" in value for key, value in config["env"].items())):
            raise ValueError("invalid input")
    except BaseException:
        complete(reason="INPUT_INVALID")
        return 0
    try:
        prepare()
        os.set_inheritable(3, False)
        os.set_inheritable(4, False)
    except BaseException:
        complete(reason="NATIVE_UNAVAILABLE")
        return 0

    cancelled = False
    reason = None
    cleanup_at = None

    def cancel(_signal=None, _frame=None):
        nonlocal cancelled, reason, cleanup_at
        cancelled = True
        if reason is None:
            reason = "CANCELLED"
        if cleanup_at is None:
            cleanup_at = time.monotonic()

    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    emit("ready")
    # Preserve any read-ahead cancellation; mixing buffered readline with raw
    # select/read could otherwise hide CANCEL until the parent closes stdin.
    line = read_line(128)
    if line != b"START\n" or pending or cancelled:
        complete(cancelled=True, reason="CANCELLED")
        return 0

    barrier_read, barrier_write = os.pipe2(os.O_CLOEXEC)
    error_read, error_write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    root_pid = os.fork()
    if root_pid == 0:
        try:
            os.close(barrier_write)
            os.close(error_read)
            if os.read(barrier_read, 1) != b"1":
                os._exit(126)
            os.close(barrier_read)
            os.close(3)
            os.dup2(4, 0)
            os.close(4)
            os.chdir(config["cwd"])
            os.execvpe(config["command"], [config["command"], *config["args"]], config["env"])
        except BaseException:
            try:
                os.write(error_write, b"EXEC_FAILED")
            except OSError:
                pass
            os._exit(127)
    os.close(barrier_read)
    os.close(error_write)
    os.close(4)
    # The forked bootstrap cannot exec until its exact pidfd is retained. A
    # failed admission closes the barrier and positively reaps that bootstrap.
    try:
        root_fd = os.pidfd_open(root_pid)
        os.waitid(os.P_PIDFD, root_fd, OBSERVE)
    except BaseException:
        os.close(barrier_write)
        os.waitpid(root_pid, 0)
        os.close(error_read)
        complete(reason="NATIVE_UNAVAILABLE")
        return 0
    owned = {root_pid: root_fd}
    observed, reaped = 1, 0
    root_code, root_signal = None, None
    root_observed = False
    emit("started", rootPid=root_pid)
    os.write(barrier_write, b"1")
    os.close(barrier_write)
    os.set_blocking(0, False)
    control_open = True
    signal_attempts = {}
    signal_failed = False

    def signal_child(fd, sig):
        nonlocal reason, signal_failed
        key = (fd, sig)
        attempts, next_at = signal_attempts.get(key, (0, 0))
        now = time.monotonic()
        if attempts >= 3 or now < next_at:
            return
        try:
            signal.pidfd_send_signal(fd, sig)
        except ProcessLookupError:
            pass  # Only waitid/reaping below can establish that it is gone.
        except OSError:
            reason = "OBSERVER_FAILED"
            signal_failed = True
            # A denied signal cannot become permission by retrying at 40Hz.
            # Keep custody and observe natural exit, but bound each pidfd/signal
            # to three attempts with backoff. Never substitute a numeric PID.
            signal_attempts[key] = (attempts + 1, now + 0.1 * (4 ** attempts))
            return
        signal_attempts[key] = (3, 0)  # A delivered signal needs no repeat.

    while True:
        try:
            for pid in children():
                if pid in owned:
                    continue
                fd = os.pidfd_open(pid)
                try:
                    os.waitid(os.P_PIDFD, fd, OBSERVE)
                except BaseException:
                    os.close(fd)
                    raise
                owned[pid] = fd
                observed += 1
            finished = []
            for pid, fd in list(owned.items()):
                event = os.waitid(os.P_PIDFD, fd, OBSERVE)
                if event is not None:
                    if pid == root_pid and not root_observed:
                        root_observed = True
                        if event.si_code == os.CLD_EXITED:
                            root_code = event.si_status
                        else:
                            # Python only names the endpoints of the Linux
                            # realtime range; do not lose an actual exit signal.
                            if signal.SIGRTMIN < event.si_status < signal.SIGRTMAX:
                                root_signal = "SIGRTMIN+%d" % (event.si_status - signal.SIGRTMIN)
                            else:
                                root_signal = signal.Signals(event.si_status).name
                    finished.append((pid, fd))
            if root_observed and config["terminateDescendantsOnRootExit"] and cleanup_at is None:
                cleanup_at = time.monotonic()
            if cleanup_at is not None:
                sig = signal.SIGKILL if time.monotonic() - cleanup_at >= 0.25 else signal.SIGTERM
                for pid, fd in list(owned.items()):
                    if (pid, fd) not in finished:
                        signal_child(fd, sig)
            for pid, fd in finished:
                os.waitid(os.P_PIDFD, fd, REAP)
                os.close(fd)
                del owned[pid]
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    signal_attempts.pop((fd, sig), None)
                reaped += 1
            try:
                os.waitid(os.P_ALL, 0, OBSERVE)
            except ChildProcessError:
                if not root_observed or owned or observed != reaped:
                    raise RuntimeError("incomplete root outcome")
                try:
                    if os.read(error_read, 32):
                        reason = "EXEC_FAILED"
                finally:
                    os.close(error_read)
                complete(started=True, cancelled=cancelled, reason=reason, code=root_code,
                         sig=root_signal, observed=observed, reaped=reaped)
                return 0
            readable, _, _ = select.select([0] if control_open else [], [], [], 0.25 if signal_failed else 0.025)
            if readable:
                data = os.read(0, 128)
                if not data:
                    control_open = False
                cancel()  # Any post-START input or EOF is a cancellation.
        except BaseException:
            reason = "OBSERVER_FAILED"
            cancel()
            # Keep the guardian alive and retry child reconciliation. The JS
            # deadline can return UNKNOWN, but no receipt claims empty until
            # the kernel and every retained child agree.
            for fd in list(owned.values()):
                signal_child(fd, signal.SIGKILL)
            time.sleep(0.25 if signal_failed else 0.025)


if __name__ == "__main__":
    sys.exit(main())
