#!/usr/bin/env python3
"""Verified local Fleet transactions. Never execute a previous installation.

The release entry imports this file from an independently verified archive,
outside the target prefix. Filesystem authority comes from fleet_fs inventories;
the journal records identities and progress, and cannot authorize extra files.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import ExitStack, contextmanager
import ctypes
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import selectors
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True

MAX_JSON = 65536
PHASES = ("PREPARED", "OLD_MOVED", "NEW_ACTIVE", "COMMITTED")
WRAPPER = b'''#!/usr/bin/env bash
set -euo pipefail
toolsenabled_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec node "$toolsenabled_root/runtime/engine/bin/toolsenabled-openshell.js" "$@"
'''


class InstallError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def fail(code, message):
    raise InstallError(code, message)


def absolute(value):
    value = os.fspath(value)
    if (not value.startswith("/") or len(value) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or any(part in (".", "..") for part in value.split("/"))
            or value == "/" or value.endswith("/") or "//" in value):
        fail("INTEGRITY", "Expected a bounded absolute path without dot components")
    return Path(value)


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        fail("INTEGRITY", "An independently supplied lowercase SHA-256 pin is required")
    return value


def same_identity(left, right):
    return (isinstance(left, dict) and isinstance(right, dict)
            and left.get("dev") == right.get("dev")
            and left.get("ino") == right.get("ino"))


def identity(st):
    return {"dev": st.st_dev, "ino": st.st_ino}


def strict_json(data):
    if len(data) > MAX_JSON:
        fail("INTEGRITY", "Lifecycle record exceeds its size limit")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail("INTEGRITY", "Lifecycle record contains duplicate keys")
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs,
                          parse_constant=lambda _value: fail("INTEGRITY", "Non-finite JSON number"))
    except (ValueError, UnicodeError) as error:
        fail("INTEGRITY", f"Invalid lifecycle JSON: {error}")


def json_bytes(value):
    result = (json.dumps(value, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=True, allow_nan=False) + "\n").encode()
    if len(result) > MAX_JSON:
        fail("INTEGRITY", "Lifecycle record exceeds its size limit")
    return result


def file_fingerprint(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def read_at(directory, name, *, capture_fingerprint=False):
    directory.revalidate()
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory.fd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_nlink != 1:
            fail("INTEGRITY", "Lifecycle record is not a privately owned regular file")
        if stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > MAX_JSON:
            fail("INTEGRITY", "Lifecycle record has unsafe permissions or size")
        data = os.read(fd, MAX_JSON + 1)
        if len(data) != st.st_size:
            fail("INTEGRITY", "Lifecycle record changed while it was read")
        directory.revalidate()
        current = os.stat(name, dir_fd=directory.fd, follow_symlinks=False)
        if file_fingerprint(current) != file_fingerprint(st):
            fail("INTEGRITY", "Lifecycle record was substituted")
        return (data, identity(st), file_fingerprint(st)) if capture_fingerprint else (data, identity(st))
    finally:
        os.close(fd)


def write_at(directory, name, data, *, exclusive=False):
    directory.revalidate()
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_EXCL
    temporary = name if exclusive else f".{name}.next-{os.urandom(16).hex()}"
    fd = os.open(temporary, flags, 0o600, dir_fd=directory.fd)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    directory.revalidate()
    if not exclusive:
        os.replace(temporary, name, src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
    os.fsync(directory.fd)


def rename_owned(source_parent, source, target_parent, target, expected):
    """Linux no-clobber rename, bounded by retained parent descriptors."""
    source_parent.revalidate()
    target_parent.revalidate()
    current = os.stat(source, dir_fd=source_parent.fd, follow_symlinks=False)
    if not stat.S_ISDIR(current.st_mode) or not same_identity(identity(current), expected):
        fail("RECOVERY_REQUIRED", "The directory to move no longer has its recorded identity")
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        fail("INSTALL", "Linux renameat2(RENAME_NOREPLACE) is required")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(source_parent.fd, os.fsencode(source), target_parent.fd, os.fsencode(target), 1):
        error = ctypes.get_errno()
        fail("RECOVERY_REQUIRED", f"No-clobber directory move refused: {os.strerror(error)}")
    os.fsync(source_parent.fd)
    os.fsync(target_parent.fd)
    source_parent.revalidate()
    target_parent.revalidate()


def entry_identity(parent, name):
    parent.revalidate()
    try:
        st = os.stat(name, dir_fd=parent.fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(st.st_mode):
        fail("RECOVERY_REQUIRED", f"Conflicting non-directory retained: {name}")
    return identity(st)


def generated_files(fs_api, prefix, *, legacy=False, receipt=None):
    prefix = absolute(prefix)
    if legacy:
        # This is the published manual installer's fixed printf template, never
        # code or data loaded from the old runtime. Arguments remain arguments.
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c",
                                 'printf \'export PATH=%q:"$PATH"\\n\' "$1"',
                                 "fleet-template", str(prefix / "bin")],
                                env={"LANG": "C", "LC_ALL": "C"},
                                capture_output=True, timeout=5, check=True)
        env_bytes = result.stdout
    else:
        env_bytes = f'export PATH={shlex.quote(str(prefix / "bin"))}:"$PATH"\n'.encode()
    result = {
        "bin/toolsenabled": fs_api.GeneratedFile(WRAPPER, 0o755),
        "bin/toolsenabled-openshell": fs_api.GeneratedLink("toolsenabled"),
        "env.sh": fs_api.GeneratedFile(env_bytes, 0o600),
    }
    if receipt is not None:
        result[".fleet-ownership.json"] = fs_api.GeneratedFile(receipt, 0o600)
        value = strict_json(receipt)
        if value.get("schema") == 2:
            generation = value.get("generation")
            if not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9]{64}", generation):
                fail("INTEGRITY", "Runtime generation marker is invalid")
            result[".fleet-generation"] = fs_api.GeneratedFile((generation + "\n").encode(), 0o600)
    return result


def parse_manifest(archive):
    value = strict_json(archive.read_bytes("toolsenabled-installer/manifest.json", max_bytes=MAX_JSON))
    if (not isinstance(value, dict) or value.get("name") != "toolsenabled-openshell"
            or not re.fullmatch(r"[a-f0-9]{40}", str(value.get("source_commit", "")))
            or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", str(value.get("version", "")))):
        fail("INTEGRITY", "The pinned release manifest is invalid")
    return value


RECEIPT_KEYS = {"schema", "root", "file", "archiveSha256", "sourceCommit", "version", "context"}
RECEIPT_V2_KEYS = RECEIPT_KEYS | {"generation", "marker", "installId"}
STATE_KEYS = {"schema", "installId", "uid", "prefix", "archiveSha256", "rootIno",
              "markerSha256", "receiptSha256"}
CONTEXT_KEYS = {"schemaVersion", "uid", "prefix", "home", "accountHome", "stateRoot", "servicesRoot",
                "codexProfile", "claudeProfile", "codexProfileMode", "claudeProfileMode", "workspace",
                "tier", "providers", "availableProviders", "protectedPaths"}


def validate_context(context, prefix=None):
    if (not isinstance(context, dict) or set(context) != CONTEXT_KEYS or context["schemaVersion"] != 1
            or type(context["uid"]) is not int or context["uid"] != os.getuid()
            or context["codexProfileMode"] not in ("default", "explicit")
            or context["claudeProfileMode"] not in ("default", "explicit")
            or context["tier"] not in ("unrestricted", "standard", "guided")
            or context["providers"] not in ("codex,claude", "codex", "claude")):
        fail("INTEGRITY", "Unknown or foreign nonsecret lifecycle context")
    for key in ("prefix", "home", "accountHome", "stateRoot", "servicesRoot", "codexProfile", "claudeProfile", "workspace"):
        absolute(context[key])
    if prefix is not None and context["prefix"] != str(prefix):
        fail("INTEGRITY", "Lifecycle context identifies a different runtime prefix")
    available, protected = context["availableProviders"], context["protectedPaths"]
    if (not isinstance(available, list) or len(available) > 2 or len(set(available)) != len(available)
            or any(item not in ("codex", "claude") for item in available)
            or not isinstance(protected, list) or len(protected) > 128
            or any(not isinstance(item, str) for item in protected)
            or len(set(protected)) != len(protected)):
        fail("INTEGRITY", "Lifecycle context has invalid provider or protected path metadata")
    for item in protected:
        absolute(item)
    if not {context[key] for key in ("home", "accountHome", "stateRoot", "servicesRoot", "codexProfile", "claudeProfile")} <= set(protected):
        fail("INTEGRITY", "Lifecycle context omits a selected protected root")
    if len(json_bytes(context)) > 8192:
        fail("INTEGRITY", "Lifecycle context exceeds its private receipt bound")
    return context


def durable_identity_matches(recorded, current):
    # Overlay st_dev changes across an OpenShell stop/start. Inodes remain
    # stable there; live descriptor checks still include st_dev throughout fs.
    return (isinstance(recorded, dict) and set(recorded) == {"dev", "ino"}
            and all(type(recorded[key]) is int and recorded[key] >= 0 for key in recorded)
            and recorded["ino"] == current["ino"])


@contextmanager
def state_scope(context, *, create=False):
    """Hold the private Fleet authority outside the removable runtime tree."""
    import fleet_fs as fs
    state = absolute(context["stateRoot"])
    prefix = absolute(context["prefix"])
    selected = os.environ.get("TOOLSENABLED_STATE_ROOT") or str(absolute(os.environ.get("HOME", "")) / ".toolsenabled")
    if state != Path(os.path.realpath(absolute(selected))):
        fail("INTEGRITY", "Fleet state record root differs from the selected sandbox state root")
    if state == prefix or state in prefix.parents or prefix in state.parents:
        fail("INTEGRITY", "Fleet state authority overlaps the runtime")
    missing, ancestor = [], state
    while not os.path.lexists(ancestor):
        if not create:
            fail("INTEGRITY", "Fleet state record is missing")
        missing.append(ancestor.name)
        ancestor = ancestor.parent
    with ExitStack() as stack:
        directory = stack.enter_context(fs.SafeDirectory.open(str(ancestor)))
        for name in reversed(missing):
            directory = stack.enter_context(fs.create_directory(directory, name))
        value = os.fstat(directory.fd)
        if value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) != 0o700:
            fail("INTEGRITY", "Fleet state authority must be privately owned 0700")
        try:
            scope = stack.enter_context(directory.child(".fleet-installations"))
        except FileNotFoundError:
            if not create:
                fail("INTEGRITY", "Fleet state record is missing")
            scope = stack.enter_context(fs.create_directory(directory, ".fleet-installations"))
        value = os.fstat(scope.fd)
        if value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) != 0o700:
            fail("INTEGRITY", "Fleet state record directory must be privately owned 0700")
        yield scope


def expected_state_record(receipt, data):
    schema = receipt["schema"]
    install_id = receipt["installId"] if schema == 2 else hashlib.sha256(b"c10-state:" + data).hexdigest()[:32]
    if not isinstance(install_id, str) or not re.fullmatch(r"[a-f0-9]{32}", install_id):
        fail("INTEGRITY", "Fleet install ID is invalid")
    marker = (receipt["generation"] + "\n").encode() if schema == 2 else None
    return {"schema": 1, "installId": install_id, "uid": os.getuid(),
            "prefix": receipt["context"]["prefix"], "archiveSha256": receipt["archiveSha256"],
            "rootIno": receipt["root"]["ino"],
            "markerSha256": hashlib.sha256(marker).hexdigest() if marker is not None else None,
            "receiptSha256": hashlib.sha256(data).hexdigest()}


def require_state_record(receipt, data, *, seed_c10=False):
    expected = expected_state_record(receipt, data)
    name = expected["installId"] + ".json"
    with state_scope(receipt["context"], create=seed_c10) as scope:
        try:
            observed, _ = read_at(scope, name)
        except FileNotFoundError:
            if not seed_c10:
                fail("INTEGRITY", "Fleet state record is missing; runtime ownership was not accepted")
            write_at(scope, name, json_bytes(expected), exclusive=True)
            observed, _ = read_at(scope, name)
        value = strict_json(observed)
        if not isinstance(value, dict) or set(value) != STATE_KEYS or value != expected:
            fail("INTEGRITY", "Fleet state record does not match this runtime generation")


def read_receipt(directory, archive, context=None, *, with_anchors=False, allow_missing=False):
    manifest = parse_manifest(archive)
    from fleet_fs import C10_RELEASES, LEGACY_ARCHIVES
    release = (manifest["source_commit"], manifest["version"])
    if archive.archive_sha256 in LEGACY_ARCHIVES:
        if release != LEGACY_ARCHIVES[archive.archive_sha256]:
            fail("INTEGRITY", "Pinned legacy release identity differs")
        required_schema = None
    elif archive.archive_sha256 in C10_RELEASES:
        if release != C10_RELEASES[archive.archive_sha256]:
            fail("INTEGRITY", "Pinned c10 release identity differs")
        required_schema = 1
    else:
        required_schema = 2
    try:
        data, file_id, file_fp = read_at(directory, ".fleet-ownership.json", capture_fingerprint=True)
    except FileNotFoundError:
        if required_schema is None or allow_missing:
            return (None, {}) if with_anchors else None
        fail("INTEGRITY", "Pinned runtime requires an ownership receipt")
    receipt = strict_json(data)
    schema = receipt.get("schema") if isinstance(receipt, dict) else None
    if (type(schema) is not int or schema != required_schema
            or set(receipt) != (RECEIPT_KEYS if schema == 1 else RECEIPT_V2_KEYS)
            or not durable_identity_matches(receipt["root"], identity(os.fstat(directory.fd)))
            or not durable_identity_matches(receipt["file"], file_id)
            or receipt["archiveSha256"] != archive.archive_sha256
            or receipt["sourceCommit"] != manifest["source_commit"] or receipt["version"] != manifest["version"]
            or not isinstance(receipt["context"], dict)
            or (context is not None and receipt["context"] != context)):
        fail("INTEGRITY", "Runtime ownership receipt does not match this exact generation")
    root_stat = os.fstat(directory.fd)
    if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != os.getuid() or stat.S_IMODE(root_stat.st_mode) != 0o700:
        fail("INTEGRITY", "Runtime ownership receipt root changed type, owner or permissions")
    anchors = {"": file_fingerprint(root_stat), ".fleet-ownership.json": file_fp}
    if schema == 2:
        generation = receipt["generation"]
        if not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9]{64}", generation):
            fail("INTEGRITY", "Runtime generation marker is invalid")
        try:
            marker_data, marker_id, marker_fp = read_at(directory, ".fleet-generation", capture_fingerprint=True)
        except FileNotFoundError:
            fail("INTEGRITY", "Runtime generation marker is missing")
        if (marker_data != (generation + "\n").encode()
                or not durable_identity_matches(receipt["marker"], marker_id)
                or marker_id["ino"] == file_id["ino"]):
            fail("INTEGRITY", "Runtime generation marker does not match this exact generation")
        anchors[".fleet-generation"] = marker_fp
    validate_context(receipt["context"])
    if schema == 2:
        require_state_record(receipt, data)
    return (data, anchors) if with_anchors else data


def create_receipt(directory, archive, context):
    validate_context(context)
    directory.revalidate()
    generation = os.urandom(32).hex()
    install_id = os.urandom(16).hex()
    write_at(directory, ".fleet-generation", (generation + "\n").encode(), exclusive=True)
    _, marker_id = read_at(directory, ".fleet-generation")
    fd = os.open(".fleet-ownership.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory.fd)
    try:
        manifest = parse_manifest(archive)
        value = {"schema": 2, "root": identity(os.fstat(directory.fd)), "file": identity(os.fstat(fd)),
                 "generation": generation, "marker": marker_id, "installId": install_id,
                 "archiveSha256": archive.archive_sha256, "sourceCommit": manifest["source_commit"],
                 "version": manifest["version"], "context": context}
        data = json_bytes(value)
        offset = 0
        while offset < len(data):
            offset += os.write(fd, data[offset:])
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(directory.fd)
    with state_scope(context, create=True) as scope:
        write_at(scope, install_id + ".json", json_bytes(expected_state_record(value, data)), exclusive=True)
    return data


_active_cancellation = None


class Cancellation:
    def __init__(self):
        self.number = None

    def latch(self, number, _frame):
        self.number = number

    def checkpoint(self):
        if self.number is not None:
            fail("OUTCOME_UNCERTAIN", "Local operation was cancelled; descendant outcome may be unknown")


@contextmanager
def deferred_signals():
    """Defer cancellation across child assignment and cleanup; never mask it.

    Nested callers share the latch, so an owner can finish its durable pending
    write before checking cancellation again. No signal mask reaches children.
    """
    global _active_cancellation
    if _active_cancellation is not None:
        yield _active_cancellation
        return
    cancellation, previous = Cancellation(), {}
    try:
        _active_cancellation = cancellation
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[number] = signal.signal(number, cancellation.latch)
        yield cancellation
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        _active_cancellation = None
    # Exceptional exits preserve their original failure after cleanup.
    cancellation.checkpoint()


def bounded_command(argv, *, env, pass_fds=(), timeout=120):
    with deferred_signals() as cancellation:
        return _bounded_command_owned(argv, env=env, pass_fds=pass_fds, timeout=timeout, cancellation=cancellation)


def _bounded_command_owned(argv, *, env, pass_fds, timeout, cancellation):
    """No shell; bounded output and deadline. Uncertain work retains its journal.

    A timeout kills/reaps only our direct child. It does not claim that its
    descendants stopped, and therefore cannot authorize rollback or cleanup.
    """
    process = None
    deadline = time.monotonic() + timeout
    try:
        cancellation.checkpoint()
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=env, pass_fds=pass_fds)
        cancellation.checkpoint()
        output = {process.stdout: bytearray(), process.stderr: bytearray()}
        with selectors.DefaultSelector() as selector:
            for pipe in output:
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ)
            while selector.get_map():
                cancellation.checkpoint()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    fail("OUTCOME_UNCERTAIN", "Local command deadline elapsed; its descendants may still run")
                for key, _ in selector.select(min(remaining, 0.25)):
                    data = os.read(key.fileobj.fileno(), 8192)
                    if not data:
                        selector.unregister(key.fileobj)
                    else:
                        output[key.fileobj].extend(data)
                        if sum(map(len, output.values())) > MAX_JSON:
                            fail("OUTCOME_UNCERTAIN", "Local command exceeded the diagnostic output bound")
            while True:
                cancellation.checkpoint()
                try:
                    code = process.wait(timeout=min(0.25, max(0.001, deadline - time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() >= deadline:
                        fail("OUTCOME_UNCERTAIN", "Local command did not terminate before its deadline")
        cancellation.checkpoint()
        if code < 0:
            fail("OUTCOME_UNCERTAIN", "Local command terminated by signal; its descendants may still run")
        return code, bytes(output[process.stdout]), bytes(output[process.stderr])
    except BaseException as error:
        # Once a child was launched, interruption/output failure says nothing
        # about its descendants. Cleanup errors must not downgrade uncertainty
        # into a generic error that an outer transaction might roll back.
        if isinstance(error, InstallError) and error.code == "OUTCOME_UNCERTAIN":
            raise
        raise InstallError("OUTCOME_UNCERTAIN", "Local command was interrupted; descendant outcome is unknown") from error
    finally:
        cleanup_error = None
        try:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        except BaseException as error:
            # The primary path already classified an unfinished child as
            # uncertain. Never mask that classification during cleanup.
            cleanup_error = error
        for pipe in (process.stdout, process.stderr) if process is not None else ():
            try:
                pipe.close()
            except BaseException as error:
                cleanup_error = error
        if cleanup_error is not None:
            raise InstallError("OUTCOME_UNCERTAIN", "Local child cleanup could not be confirmed") from cleanup_error


class Lifecycle:
    def __init__(self, package, lock, env=None):
        self.package, self.lock = Path(package), lock
        self.env = dict(os.environ if env is None else env)
        self.node = shutil.which("node", path=self.env.get("PATH", ""))
        if not self.node:
            fail("INSTALL", "Node.js 22.19 or newer is required")

    def command(self, argv, *, context=None, phase="SETUP"):
        env = self.lock.child_env(self.env)
        if context is not None:
            # The CLI compares its emitted context in the original key order.
            env["TOOLSENABLED_FLEET_FRESH_CONTEXT"] = json.dumps(context, separators=(",", ":"))
        try:
            code, out, err = bounded_command(argv, env=env, pass_fds=self.lock.pass_fds)
        except InstallError as error:
            if error.code == "OUTCOME_UNCERTAIN" and self.lock.pending is None:
                self.lock.write_pending({"nonce": self.lock.nonce, "kind": "fleet-inspection",
                                         "phase": "OUTCOME_UNCERTAIN"})
            raise
        if code:
            # Keep raw output out of receipts. Setup diagnostics may contain
            # local paths; the bounded terminal output remains with the user.
            reported = err.decode("utf8", "replace").partition(":")[0]
            known = {"SCOPE_EXISTS", "SCOPE_CHANGED", "SCOPE_UNSAFE", "SCOPE_BUSY", "INSPECTION_UNAVAILABLE",
                     "TARGET", "INTEGRITY", "RECOVERY_REQUIRED", "OUTCOME_UNCERTAIN"}
            fail(reported if reported in known else phase,
                 f"Verified new runtime {phase.lower()} command failed (exit {code}); existing runtime and state were retained")
        return out

    def preflight(self, options):
        self.command([self.node, "-e", "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=19?0:1)"], phase="INSTALL")
        helper = self.package / "payload/engine/src/lib/openshell-lifecycle-context.js"
        context = strict_json(self.command([self.node, str(helper), "--fresh", "--prefix", str(options.prefix),
                                            "--tier", options.tier, "--providers", options.providers], phase="INSTALL"))
        if not isinstance(context, dict) or not isinstance(context.get("protectedPaths"), list):
            fail("INTEGRITY", "Fresh-scope inspection did not return a bounded context")
        return context

    def inspect(self, options):
        helper = self.package / "payload/engine/src/lib/openshell-lifecycle-context.js"
        context = strict_json(self.command([self.node, str(helper), "--inspect", "--prefix", str(options.prefix)], phase="INSTALL"))
        if not isinstance(context, dict) or not isinstance(context.get("protectedPaths"), list):
            fail("INTEGRITY", "Scope inspection did not return a bounded context")
        return context

    def setup(self, options, context):
        entry = options.prefix / "runtime/engine/bin/toolsenabled-openshell.js"
        output = self.command([self.node, str(entry), "setup", "--agents", "--add", "--tier", options.tier,
                               "--providers", options.providers], context=context)
        sys.stdout.write(output.decode("utf8", "replace"))

    def status(self, options):
        entry = options.prefix / "runtime/engine/bin/toolsenabled-openshell.js"
        output = self.command([self.node, str(entry), "status"])
        sys.stdout.write(output.decode("utf8", "replace"))


@dataclass
class Options:
    mode: str
    prefix: Path | None
    archive: Path
    sha256: str
    previous_archive: Path | None = None
    previous_sha256: str | None = None
    tier: str = "unrestricted"
    providers: str = "codex,claude"
    journal: Path | None = None


def parse_args(argv):
    # argparse otherwise silently accepts repeated security/choice options.
    flags = [item for item in argv if item.startswith("--")]
    if len(flags) != len(set(flags)) or any("=" in item for item in flags):
        fail("INSTALL", "Repeated flags and --flag=value are not supported")
    parser = argparse.ArgumentParser(allow_abbrev=False)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--setup", nargs="?", const="")
    group.add_argument("--upgrade", nargs="?", const="")
    group.add_argument("--recover")
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--previous-archive")
    parser.add_argument("--previous-sha256")
    parser.add_argument("--tier", choices=("unrestricted", "standard", "guided"))
    parser.add_argument("--providers", choices=("codex,claude", "codex", "claude"))
    args = parser.parse_args(argv)
    mode = "recover" if args.recover is not None else "upgrade" if args.upgrade is not None else "setup"
    if mode != "setup" and (args.tier is not None or args.providers is not None):
        fail("INSTALL", "Tier and provider choices apply only to fresh installation")
    if bool(args.previous_archive) != bool(args.previous_sha256):
        fail("INTEGRITY", "A previous archive and its independent digest must be supplied together")
    if mode != "upgrade" and args.previous_archive:
        fail("INSTALL", "Previous archive options apply only to upgrade")
    chosen = args.setup if mode == "setup" else args.upgrade
    prefix = None if mode == "recover" else absolute(chosen or str(absolute(os.environ.get("HOME", "")) / ".local/toolsenabled"))
    return Options(mode, prefix, absolute(args.archive), digest(args.sha256),
                   absolute(args.previous_archive) if args.previous_archive else None,
                   digest(args.previous_sha256) if args.previous_sha256 else None,
                   args.tier or "unrestricted", args.providers or "codex,claude",
                   absolute(args.recover) if args.recover else None)


JOURNAL_KEYS = {
    "schema", "uid", "nonce", "mode", "prefix", "transaction", "parentIdentity", "transactionIdentity",
    "oldIdentity", "newIdentity", "archive", "previousArchive", "context", "tier", "providers", "phase",
    "intent", "setup", "oldReceipt", "newReceipt", "driverSha256", "oldStyle", "outcome",
}


def validate_journal(value, journal_path):
    if not isinstance(value, dict) or set(value) != JOURNAL_KEYS or value["schema"] != 1 or value["uid"] != os.getuid():
        fail("INTEGRITY", "Unknown or foreign transaction journal")
    if not re.fullmatch(r"[0-9a-f]{32,64}", str(value["nonce"])):
        fail("INTEGRITY", "Invalid transaction identity")
    prefix, transaction = absolute(value["prefix"]), absolute(value["transaction"])
    if transaction != prefix.with_name(prefix.name + ".transaction-" + value["nonce"]) or journal_path != transaction / "journal.json":
        fail("INTEGRITY", "Transaction paths do not match their recorded scope")
    if (value["mode"] not in ("setup", "upgrade") or value["phase"] not in PHASES
            or value["setup"] not in ("NOT_STARTED", "STARTED", "COMPLETE", "NOT_APPLICABLE")
            or value["oldStyle"] not in ("legacy", "fleet", None)
            or value["outcome"] not in ("PENDING", "ROLLED_BACK", "COMMITTED")
            or value["intent"] not in (None, "BUILD_NEW", "MOVE_OLD", "ACTIVATE_NEW", "SETUP", "STATUS",
                                       "COMMIT", "CLEAN_OLD", "ROLLBACK_NEW", "RESTORE_OLD", "CLEAN_NEW")
            or value["tier"] not in ("unrestricted", "standard", "guided")
            or value["providers"] not in ("codex,claude", "codex", "claude")):
        fail("INTEGRITY", "Transaction has an invalid phase or operation")
    for key in ("parentIdentity", "transactionIdentity", "newIdentity", "oldIdentity"):
        item = value[key]
        if key == "oldIdentity" and item is None:
            continue
        if not isinstance(item, dict) or set(item) != {"dev", "ino"} or any(type(number) is not int or number < 0 for number in item.values()):
            fail("INTEGRITY", "Transaction has an invalid directory identity")
    for key in ("archive", "previousArchive"):
        item = value[key]
        if key == "previousArchive" and item is None:
            continue
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            fail("INTEGRITY", "Transaction archive identity is invalid")
        if item["path"] is not None:
            absolute(item["path"])
        digest(item["sha256"])
    digest(value["driverSha256"])
    validate_context(value["context"], prefix)
    if value["mode"] == "setup":
        if value["oldIdentity"] is not None or value["previousArchive"] is not None or value["oldStyle"] is not None or value["oldReceipt"] is not None or value["setup"] == "NOT_APPLICABLE":
            fail("INTEGRITY", "Fresh-install journal claims an old generation")
    elif value["oldIdentity"] is None or value["previousArchive"] is None or value["oldStyle"] is None or value["setup"] != "NOT_APPLICABLE":
        fail("INTEGRITY", "Upgrade journal lacks its old generation proof")
    if (value["phase"] == "COMMITTED") != (value["outcome"] == "COMMITTED"):
        fail("INTEGRITY", "Commit phase and outcome disagree")
    if value["phase"] == "COMMITTED" and value["mode"] == "setup" and value["setup"] != "COMPLETE":
        fail("INTEGRITY", "Fresh install cannot commit before setup and status finish")
    if value["phase"] != "PREPARED" and value["newReceipt"] is None:
        fail("INTEGRITY", "Activated journal lacks the verified new receipt")
    for key in ("oldReceipt", "newReceipt"):
        encoded = value[key]
        if encoded is not None:
            try:
                receipt = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError):
                fail("INTEGRITY", "Transaction receipt encoding is invalid")
            if not isinstance(strict_json(receipt), dict):
                fail("INTEGRITY", "Transaction receipt is invalid")
    return value


def receipt_decode(value):
    return base64.b64decode(value, validate=True) if value is not None else None


def receipt_encode(value):
    return base64.b64encode(value).decode("ascii") if value is not None else None


PREPARATION_KEYS = {"schema", "mode", "archive", "previousArchive", "driverSha256", "context",
                    "anchorPath", "anchorIdentity", "oldIdentity", "oldReceipt", "oldStyle"}


def validate_preparation(pending, journal_path, nonce):
    if (not isinstance(pending, dict) or set(pending) != {"nonce", "kind", "phase", "prefix", "journal",
            "transactionIdentity", "preparation"} or pending["kind"] != "fleet-install"
            or pending["phase"] != "PREPARING" or pending["nonce"] != nonce
            or pending["transactionIdentity"] is not None):
        fail("RECOVERY_REQUIRED", "Preparation does not match the pending lifecycle operation")
    prefix = absolute(pending["prefix"])
    transaction = prefix.with_name(prefix.name + ".transaction-" + nonce)
    if journal_path != transaction / "journal.json" or pending["journal"] != str(journal_path):
        fail("RECOVERY_REQUIRED", "Preparation recovery requires its exact intended journal path")
    value = pending["preparation"]
    if (not isinstance(value, dict) or set(value) != PREPARATION_KEYS or value["schema"] != 1
            or value["mode"] not in ("setup", "upgrade")):
        fail("INTEGRITY", "Preparation has an unknown schema")
    validate_context(value["context"], prefix)
    digest(value["driverSha256"])
    anchor = absolute(value["anchorPath"])
    if anchor != prefix.parent and anchor not in prefix.parent.parents:
        fail("INTEGRITY", "Preparation anchor is not a prefix parent")
    for key in ("anchorIdentity", "oldIdentity"):
        item = value[key]
        if key == "oldIdentity" and item is None:
            continue
        if (not isinstance(item, dict) or set(item) != {"dev", "ino"}
                or any(type(number) is not int or number < 0 for number in item.values()) or item["ino"] == 0):
            fail("INTEGRITY", "Preparation has an invalid retained identity")
    for key in ("archive", "previousArchive"):
        item = value[key]
        if key == "previousArchive" and item is None:
            continue
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            fail("INTEGRITY", "Preparation archive metadata is invalid")
        digest(item["sha256"])
        if item["path"] is not None:
            absolute(item["path"])
        elif key == "archive":
            fail("INTEGRITY", "Preparation lacks its independent new archive")
    if value["mode"] == "setup":
        if any(value[key] is not None for key in ("oldIdentity", "oldReceipt", "oldStyle", "previousArchive")):
            fail("INTEGRITY", "Fresh preparation claims a prior runtime")
    elif (value["oldIdentity"] is None or value["previousArchive"] is None
          or value["oldStyle"] not in ("legacy", "fleet")
          or (value["oldReceipt"] is None) != (value["oldStyle"] == "legacy")):
        fail("INTEGRITY", "Upgrade preparation lacks independent prior-runtime proof")
    if value["oldReceipt"] is not None:
        try:
            receipt = strict_json(receipt_decode(value["oldReceipt"]))
        except (ValueError, TypeError):
            fail("INTEGRITY", "Preparation receipt is invalid")
        if not isinstance(receipt, dict):
            fail("INTEGRITY", "Preparation receipt is invalid")
        validate_context(receipt.get("context"), prefix)
    return value


class Transaction:
    """One serialized operation. fault is a test-only Python callback."""
    def __init__(self, options, lock, fs_api, lifecycle, package, *, fault=None):
        self.options, self.lock, self.fs = options, lock, fs_api
        self.lifecycle, self.package = lifecycle, absolute(package)
        self.fault = fault or (lambda _event: None)
        self.journal = None
        self.parent = self.directory = self.archive = self.previous = None
        self.protected = ()
        self.stack = ExitStack()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)

    def open_archive(self, path, pin):
        return self.stack.enter_context(self.fs.VerifiedArchive.open(path, pin))

    def save(self, *, phase=None, intent=None, **changes):
        if phase is not None:
            self.journal["phase"] = phase
        self.journal.update(changes)
        self.journal["intent"] = intent
        validate_journal(self.journal, Path(self.journal["transaction"]) / "journal.json")
        write_at(self.directory, "journal.json", json_bytes(self.journal))
        self.fault("journal:" + (intent or phase or "updated"))

    def pending(self):
        return {"nonce": self.lock.nonce, "kind": "fleet-install", "prefix": str(self.options.prefix),
                "journal": str(Path(self.journal["transaction"]) / "journal.json"),
                "transactionIdentity": self.journal["transactionIdentity"]}

    def inventory(self, archive, receipt, *, legacy=False):
        return archive.runtime_inventory(str(self.options.prefix),
            generated_files(self.fs, self.options.prefix, legacy=legacy, receipt=receipt))

    def legacy_mode_reduction(self, archive, receipt, legacy):
        # Only the independently pinned published 1.4.0/1.4.1 generations
        # lacked an ownership receipt and inherited extraction mode losses.
        # Every beta-3 generation remains subject to exact installed modes.
        return ((legacy and receipt is None and archive.archive_sha256 in self.fs.LEGACY_ARCHIVES)
                or (receipt is not None and strict_json(receipt)["schema"] == 1
                    and archive.archive_sha256 in self.fs.C10_RELEASES))

    def verify(self, parent, name, expected, archive, receipt, *, legacy=False, allow_missing=False):
        if not same_identity(entry_identity(parent, name), expected):
            fail("RECOVERY_REQUIRED", f"Recorded generation is missing or changed: {name}")
        with parent.child(name) as directory:
            if receipt is not None:
                observed = read_receipt(directory, archive, allow_missing=allow_missing)
                if observed != receipt and not (allow_missing and observed is None):
                    fail("INTEGRITY", "Generation receipt changed since transaction preparation")
            self.fs.verify_tree(directory, self.inventory(archive, receipt, legacy=legacy), protected_paths=self.protected,
                                allow_missing=allow_missing,
                                legacy_runtime=self.legacy_mode_reduction(archive, receipt, legacy))
            # Committed cleanup may have removed the runtime receipt already.
            # The journaled receipt still requires its independent state record.
            if receipt is not None:
                require_state_record(strict_json(receipt), receipt)

    def previous_for(self, observed_manifest=None):
        options = self.options
        if options.previous_archive:
            return self.open_archive(options.previous_archive, options.previous_sha256)
        # The catalog loader is anchored to source-embedded pins; manifest
        # strings only select which independently pinned inventory to compare.
        if not hasattr(self.fs, "load_legacy_catalog"):
            fail("INTEGRITY", "This previous runtime needs --previous-archive and --previous-sha256")
        return self.fs.load_legacy_catalog(observed_manifest)

    def stage_identity(self):
        member = self.archive.read_bytes("toolsenabled-installer/fleet_install.py", max_bytes=1024 * 1024)
        # Official archives preserve some group-writable package/engine modes.
        # They are safe only beneath this owned private extraction boundary;
        # do not weaken the general ancestor rules to reopen an inner path.
        with self.fs.SafeDirectory.open(str(self.package.parent)) as outer, outer.child(self.package.name) as stage:
            private = os.fstat(outer.fd)
            if private.st_uid != os.getuid() or stat.S_IMODE(private.st_mode) != 0o700:
                fail("INTEGRITY", "The verified package needs a privately owned extraction parent")
            proof = self.fs.verify_extracted_package(outer, self.archive)
            if proof["rootIdentity"] != stage.identity:
                fail("INTEGRITY", "Staged package changed between retained handles")
            fd = os.open("fleet_install.py", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=stage.fd)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size != len(member):
                    fail("INTEGRITY", "Staged driver has an unexpected file type or size")
                observed = os.read(fd, len(member) + 1)
                stage.revalidate()
                if identity(os.stat("fleet_install.py", dir_fd=stage.fd, follow_symlinks=False)) != identity(info):
                    fail("INTEGRITY", "Staged driver was substituted during verification")
            finally:
                os.close(fd)
        if observed != member:
            fail("INTEGRITY", "The staged transaction driver differs from the pinned archive")
        return hashlib.sha256(member).hexdigest()

    def check_disjoint(self, context):
        prefix = self.options.prefix
        validate_context(context, prefix)
        protected = context.get("protectedPaths")
        if not isinstance(protected, list) or len(protected) > 128:
            fail("INTEGRITY", "Bounded protected path context is required")
        for item in [self.package, self.options.archive, self.options.previous_archive, Path(self.lock.protected_root)]:
            if item is not None and (item == prefix or prefix in item.parents or item in prefix.parents):
                fail("INTEGRITY", "Prefix overlaps its independent driver, archive or lock namespace")
        homes = {context["home"], context["accountHome"], os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)}
        roles = {context[key] for key in ("stateRoot", "servicesRoot", "codexProfile", "claudeProfile", "workspace")}
        for home in homes:
            if home and (prefix == Path(home) or prefix in Path(home).parents):
                fail("INTEGRITY", "Prefix contains a protected home")
        return [str(absolute(value)) for value in protected if value not in homes or value in roles] + [str(self.lock.protected_root)]

    def preparation_anchor(self):
        target = self.options.prefix.parent
        missing = []
        while not target.exists():
            # lexists distinguishes a dangling link from a missing component.
            if os.path.lexists(target):
                fail("INTEGRITY", "Prefix parent contains an unresolved link")
            missing.append(target.name)
            target = target.parent
        parent = self.stack.enter_context(self.fs.SafeDirectory.open(str(target)))
        return parent, list(reversed(missing))

    def begin(self):
        options = self.options
        if self.lock.pending is not None:
            fail("RECOVERY_REQUIRED", "An unresolved lifecycle operation already exists")
        self.archive = self.open_archive(options.archive, options.sha256)
        driver_sha = self.stage_identity()
        context = self.lifecycle.preflight(options) if options.mode == "setup" else self.lifecycle.inspect(options)
        protected = self.check_disjoint(context)
        self.protected = protected
        self.fs.assert_target_safe(str(options.prefix), protected_paths=protected)
        nonce = self.lock.nonce
        if not re.fullmatch(r"[0-9a-f]{32,64}", str(nonce)):
            fail("INTEGRITY", "The lifecycle lock supplied an invalid nonce")
        transaction = options.prefix.with_name(options.prefix.name + ".transaction-" + nonce)
        self.parent, missing_parents = self.preparation_anchor()
        existing = None if missing_parents else entry_identity(self.parent, options.prefix.name)
        if options.mode == "setup" and existing is not None:
            fail("INSTALL", "Fresh installation requires an absent prefix")
        if options.mode == "upgrade" and existing is None:
            fail("INSTALL", "Upgrade requires an existing, independently verified runtime")
        old_receipt, old_style = None, None
        if existing is not None:
            with self.fs.SafeDirectory.open(str(options.prefix), protected_paths=protected) as old:
                observed, _ = read_at(old, "manifest.json")
                self.previous = self.previous_for(strict_json(observed))
                old_receipt = read_receipt(old, self.previous)
                old_style = "fleet" if old_receipt is not None else "legacy"
                if old_receipt is not None:
                    recorded_context = strict_json(old_receipt)["context"]
                    # Old selected state/profile paths remain protected even
                    # when this shell selects a different profile for reads.
                    self.protected = list(set(self.protected + self.check_disjoint(recorded_context)))
                self.fs.verify_tree(old, self.inventory(self.previous, old_receipt, legacy=old_style == "legacy"),
                                    protected_paths=self.protected,
                                    legacy_runtime=self.legacy_mode_reduction(self.previous, old_receipt,
                                                                                old_style == "legacy"))
                if old_receipt is not None:
                    if strict_json(old_receipt)["schema"] == 1:
                        require_state_record(strict_json(old_receipt), old_receipt, seed_c10=True)
                    context = strict_json(old_receipt)["context"]
        previous_archive = ({"path": str(options.previous_archive) if options.previous_archive else None,
                             "sha256": self.previous.archive_sha256} if self.previous else None)
        preparation = {"schema": 1, "mode": options.mode,
                       "archive": {"path": str(options.archive), "sha256": options.sha256},
                       "previousArchive": previous_archive, "driverSha256": driver_sha, "context": context,
                       "anchorPath": str(self.parent.path), "anchorIdentity": identity(os.fstat(self.parent.fd)),
                       "oldIdentity": existing, "oldReceipt": receipt_encode(old_receipt), "oldStyle": old_style}
        pending = {"nonce": nonce, "kind": "fleet-install", "phase": "PREPARING", "prefix": str(options.prefix),
                   "journal": str(transaction / "journal.json"), "transactionIdentity": None, "preparation": preparation}
        validate_preparation(pending, transaction / "journal.json", nonce)
        # This first durable record authorizes no deletion. It can only be
        # abandoned after independent proof that the active target is unchanged.
        self.lock.write_pending(pending)
        self.fault("pending:PREPARING")
        for index, name in enumerate(missing_parents):
            self.parent = self.stack.enter_context(self.fs.create_directory(self.parent, name))
            self.fault("mkdir:parent:" + str(index))
        self.parent.revalidate()
        self.directory = self.stack.enter_context(self.fs.create_directory(self.parent, transaction.name))
        self.fault("mkdir:transaction")
        new_directory = self.stack.enter_context(self.fs.create_directory(self.directory, "new"))
        self.fault("mkdir:new")
        self.journal = {
            "schema": 1, "uid": os.getuid(), "nonce": nonce, "mode": options.mode,
            "prefix": str(options.prefix), "transaction": str(transaction),
            "parentIdentity": identity(os.fstat(self.parent.fd)),
            "transactionIdentity": identity(os.fstat(self.directory.fd)), "oldIdentity": existing,
            "newIdentity": entry_identity(self.directory, "new"),
            "archive": {"path": str(options.archive), "sha256": options.sha256},
            "previousArchive": previous_archive,
            "context": context, "tier": options.tier, "providers": options.providers,
            "phase": "PREPARED", "intent": "BUILD_NEW",
            "setup": "NOT_STARTED" if options.mode == "setup" else "NOT_APPLICABLE",
            "oldReceipt": receipt_encode(old_receipt), "newReceipt": None, "driverSha256": driver_sha,
            "oldStyle": old_style, "outcome": "PENDING",
        }
        self.save(intent="BUILD_NEW")
        self.lock.write_pending(self.pending())
        self.fault("pending:JOURNALED")
        self.fs.materialize_runtime(self.archive, new_directory, generated_files(self.fs, options.prefix))
        new_receipt = create_receipt(new_directory, self.archive, context)
        self.fs.verify_tree(new_directory, self.inventory(self.archive, new_receipt), protected_paths=self.protected)
        new_directory.close()
        self.save(phase="PREPARED", newReceipt=receipt_encode(new_receipt))
        if existing is not None:
            self.verify(self.parent, options.prefix.name, existing, self.previous, old_receipt, legacy=old_style == "legacy")
            self.save(intent="MOVE_OLD")
            rename_owned(self.parent, options.prefix.name, self.directory, "old", existing)
            self.fault("rename:old")
            self.save(phase="OLD_MOVED")
        self.save(intent="ACTIVATE_NEW")
        rename_owned(self.directory, "new", self.parent, options.prefix.name, self.journal["newIdentity"])
        self.fault("rename:new")
        self.save(phase="NEW_ACTIVE")
        self.verify(self.parent, options.prefix.name, self.journal["newIdentity"], self.archive, new_receipt)
        if options.mode == "setup":
            self.save(intent="SETUP", setup="STARTED")
            self.lifecycle.setup(options, context)
            self.save(intent="STATUS")
            self.lifecycle.status(options)
            self.save(setup="COMPLETE")
            self.verify(self.parent, options.prefix.name, self.journal["newIdentity"], self.archive, new_receipt)
        self.save(intent="COMMIT")
        self.save(phase="COMMITTED", outcome="COMMITTED")
        return self.cleanup_committed()

    def cleanup_generation(self, name, archive, receipt, expected, *, legacy=False, allow_missing=False):
        if allow_missing and not (name == "old" and self.journal["phase"] == "COMMITTED"
                                  and self.journal["intent"] == "CLEAN_OLD"
                                  and same_identity(expected, self.journal["oldIdentity"])):
            fail("INTEGRITY", "Partial cleanup lacks a committed, fully verified old generation")
        if entry_identity(self.directory, name) is None:
            return True
        self.verify(self.directory, name, expected, archive, receipt, legacy=legacy, allow_missing=allow_missing)
        result = self.fs.remove_tree(self.directory, name, self.inventory(archive, receipt, legacy=legacy), expected,
                                     protected_paths=self.protected, allow_missing=allow_missing,
                                     legacy_runtime=self.legacy_mode_reduction(archive, receipt, legacy))
        return result.complete

    def finish_journal(self):
        # Removing control files is deliberately separate from arbitrary tree
        # traversal. Exactly this owned journal and an otherwise empty directory
        # are required; any crash-remainder or unknown child is retained.
        self.directory.revalidate()
        if set(os.listdir(self.directory.fd)) != {"journal.json"}:
            return False
        current, _ = read_at(self.directory, "journal.json")
        if current != json_bytes(self.journal):
            fail("RECOVERY_REQUIRED", "Journal changed before final cleanup")
        self.lock.clear_pending(self.lock.nonce)
        os.unlink("journal.json", dir_fd=self.directory.fd)
        os.fsync(self.directory.fd)
        self.directory.revalidate()
        self.parent.revalidate()
        if not same_identity(entry_identity(self.parent, Path(self.journal["transaction"]).name), self.journal["transactionIdentity"]):
            fail("RECOVERY_REQUIRED", "Transaction directory changed before removal")
        os.rmdir(Path(self.journal["transaction"]).name, dir_fd=self.parent.fd)
        os.fsync(self.parent.fd)
        return True

    def cleanup_committed(self):
        self.verify(self.parent, self.options.prefix.name, self.journal["newIdentity"], self.archive,
                    receipt_decode(self.journal["newReceipt"]))
        try:
            if self.journal["oldIdentity"] is not None:
                self.save(intent="CLEAN_OLD")
                if not self.cleanup_generation("old", self.previous, receipt_decode(self.journal["oldReceipt"]),
                                               self.journal["oldIdentity"], legacy=self.journal["oldStyle"] == "legacy",
                                               allow_missing=True):
                    self.lock.clear_pending(self.lock.nonce)
                    return self.result("COMMITTED_WITH_CLEANUP_PENDING")
            if not self.finish_journal():
                self.lock.clear_pending(self.lock.nonce)
                return self.result("COMMITTED_WITH_CLEANUP_PENDING")
        except Exception as error:
            # Commit is durable. Never roll the new runtime back because the
            # previous generation gained an unexpected file or cleanup failed.
            self.lock.clear_pending(self.lock.nonce)
            return self.result("COMMITTED_WITH_CLEANUP_PENDING", str(error))
        return self.result("COMMITTED")

    def result(self, outcome, detail=None):
        result = {"outcome": outcome, "prefix": str(self.options.prefix), "sha256": self.options.sha256}
        if outcome.endswith("PENDING"):
            result["journal"] = str(Path(self.journal["transaction"]) / "journal.json")
        if detail:
            result["detail"] = detail[:1024]
        return result

    def preparation_target_unchanged(self, old_identity, old_receipt, old_style):
        """No cleanup authority: prove the original active target still holds."""
        self.fs.assert_target_safe(str(self.options.prefix), protected_paths=self.protected)
        if old_identity is None:
            if os.path.lexists(self.options.prefix):
                fail("RECOVERY_REQUIRED", "Preparation acquired an unexpected active target; everything was retained")
        else:
            if self.parent is None:
                self.parent = self.stack.enter_context(self.fs.SafeDirectory.open(str(self.options.prefix.parent)))
            self.verify(self.parent, self.options.prefix.name, old_identity, self.previous, old_receipt,
                        legacy=old_style == "legacy")

    def recover_preparation(self, pending):
        options = self.options
        preparation = validate_preparation(pending, options.journal, self.lock.nonce)
        options.prefix = absolute(pending["prefix"])
        if options.sha256 != preparation["archive"]["sha256"]:
            fail("INTEGRITY", "Preparation recovery requires the original independently pinned release")
        self.archive = self.open_archive(options.archive, options.sha256)
        if self.stage_identity() != preparation["driverSha256"]:
            fail("INTEGRITY", "Preparation recovery driver differs from the verified original")
        anchor = self.stack.enter_context(self.fs.SafeDirectory.open(preparation["anchorPath"]))
        if identity(os.fstat(anchor.fd)) != preparation["anchorIdentity"]:
            fail("RECOVERY_REQUIRED", "Preparation parent anchor changed; all contents were retained")
        current_context = self.lifecycle.inspect(options)
        self.protected = list(set(self.check_disjoint(current_context) + self.check_disjoint(preparation["context"])))
        previous = preparation["previousArchive"]
        if previous is not None:
            self.previous = (self.open_archive(Path(previous["path"]), previous["sha256"])
                             if previous["path"] is not None
                             else self.fs.load_legacy_catalog({"archiveSha256": previous["sha256"]}))
        self.preparation_target_unchanged(preparation["oldIdentity"], receipt_decode(preparation["oldReceipt"]),
                                          preparation["oldStyle"])
        transaction = options.journal.parent
        if os.path.lexists(transaction):
            self.directory = self.stack.enter_context(self.fs.SafeDirectory.open(str(transaction)))
            try:
                encoded, _ = read_at(self.directory, "journal.json")
            except FileNotFoundError:
                pass  # No identity was persisted: this directory is retained.
            else:
                journal = validate_journal(strict_json(encoded), options.journal)
                shared = ("mode", "archive", "previousArchive", "driverSha256", "context", "oldIdentity", "oldReceipt", "oldStyle")
                if (any(journal[key] != preparation[key] for key in shared)
                        or journal["nonce"] != self.lock.nonce or journal["phase"] != "PREPARED"
                        or journal["intent"] != "BUILD_NEW" or journal["newReceipt"] is not None
                        or journal["setup"] not in ("NOT_STARTED", "NOT_APPLICABLE")
                        or journal["transactionIdentity"] != identity(os.fstat(self.directory.fd))):
                    fail("RECOVERY_REQUIRED", "Journal advanced beyond preparation or contradicts its first durable record")
                with self.fs.SafeDirectory.open(str(transaction.parent)) as parent:
                    if journal["parentIdentity"] != identity(os.fstat(parent.fd)):
                        fail("RECOVERY_REQUIRED", "Preparation journal parent identity changed")
        retained = []
        anchor_path = Path(preparation["anchorPath"])
        if anchor_path != options.prefix.parent:
            first_parent = anchor_path / options.prefix.parent.relative_to(anchor_path).parts[0]
            if os.path.lexists(first_parent):
                retained.append(str(first_parent))
        if os.path.lexists(transaction):
            retained.append(str(transaction))
        # No activation or provider operation may occur until the concrete
        # journal identity replaces PREPARING. Unknown preparation stays put.
        anchor.revalidate()
        self.preparation_target_unchanged(preparation["oldIdentity"], receipt_decode(preparation["oldReceipt"]),
                                          preparation["oldStyle"])
        self.lock.clear_pending(self.lock.nonce)
        return {"outcome": "PREPARATION_RETAINED" if retained else "ROLLED_BACK", "prefix": str(options.prefix),
                "sha256": options.sha256, "runtime": "unchanged", "retained": retained}

    def recover(self):
        options = self.options
        if options.journal.name != "journal.json":
            fail("INTEGRITY", "Recovery requires the exact transaction journal")
        pending = self.lock.pending
        if isinstance(pending, dict) and pending.get("phase") == "PREPARING":
            return self.recover_preparation(pending)
        self.directory = self.stack.enter_context(self.fs.SafeDirectory.open(str(options.journal.parent)))
        encoded, _ = read_at(self.directory, "journal.json")
        self.journal = validate_journal(strict_json(encoded), options.journal)
        options.prefix = Path(self.journal["prefix"])
        pending = self.lock.pending
        resumed_commit_cleanup = pending is None and self.journal["phase"] == "COMMITTED"
        if not resumed_commit_cleanup and (not isinstance(pending, dict) or pending.get("nonce") != self.journal["nonce"]
                or self.lock.nonce != self.journal["nonce"] or pending.get("journal") != str(options.journal)
                or pending.get("transactionIdentity") != self.journal["transactionIdentity"]):
            fail("RECOVERY_REQUIRED", "Recovery journal is not the lock's pending operation")
        if identity(os.fstat(self.directory.fd)) != self.journal["transactionIdentity"]:
            fail("INTEGRITY", "Recovery transaction directory was substituted")
        self.parent = self.stack.enter_context(self.fs.SafeDirectory.open(str(options.prefix.parent)))
        if identity(os.fstat(self.parent.fd)) != self.journal["parentIdentity"]:
            fail("INTEGRITY", "Recovery prefix parent was substituted")
        if options.sha256 != self.journal["archive"]["sha256"]:
            fail("INTEGRITY", "Recovery must use the independently verified original new release")
        self.archive = self.open_archive(options.archive, options.sha256)
        if self.stage_identity() != self.journal["driverSha256"]:
            fail("INTEGRITY", "Recovery driver differs from the recorded verified driver")
        current_context = self.lifecycle.inspect(options)
        protected = self.check_disjoint(current_context)
        self.protected = list(set(protected + self.check_disjoint(self.journal["context"])))
        self.fs.assert_target_safe(str(options.prefix), protected_paths=self.protected)
        previous = self.journal["previousArchive"]
        if previous is not None and (self.journal["phase"] != "COMMITTED" or entry_identity(self.directory, "old") is not None):
            if previous["path"] is not None:
                self.previous = self.open_archive(Path(previous["path"]), previous["sha256"])
            else:
                self.previous = self.fs.load_legacy_catalog({"archiveSha256": previous["sha256"]})
        if (self.journal["phase"] == "PREPARED" and self.journal["intent"] == "BUILD_NEW"
                and self.journal["newReceipt"] is None
                and self.journal["setup"] in ("NOT_STARTED", "NOT_APPLICABLE")):
            # Materialization may have stopped after any entry. Full activation
            # intent was never durable, so retain every partial/unknown entry.
            self.preparation_target_unchanged(self.journal["oldIdentity"], receipt_decode(self.journal["oldReceipt"]),
                                              self.journal["oldStyle"])
            self.lock.clear_pending(self.lock.nonce)
            return {"outcome": "PREPARATION_RETAINED", "prefix": str(options.prefix), "sha256": options.sha256,
                    "runtime": "unchanged", "retained": [str(options.journal.parent)]}
        if self.journal["phase"] == "COMMITTED":
            if resumed_commit_cleanup:
                self.verify(self.parent, options.prefix.name, self.journal["newIdentity"], self.archive,
                            receipt_decode(self.journal["newReceipt"]))
                self.lock.nonce = self.journal["nonce"]
                self.lock.write_pending(self.pending())
            return self.cleanup_committed()
        if self.journal["mode"] == "setup" and self.journal["setup"] in ("STARTED", "COMPLETE"):
            fail("RECOVERY_REQUIRED", "Partial setup is preserved; automatic setup replay or registration rollback is not supported")
        return self.rollback()

    def rollback(self):
        prefix = self.options.prefix
        old_id, new_id = self.journal["oldIdentity"], self.journal["newIdentity"]
        active = entry_identity(self.parent, prefix.name)
        old, new = entry_identity(self.directory, "old"), entry_identity(self.directory, "new")
        old_receipt, new_receipt = receipt_decode(self.journal["oldReceipt"]), receipt_decode(self.journal["newReceipt"])
        if active is not None and not same_identity(active, old_id) and not same_identity(active, new_id):
            fail("RECOVERY_REQUIRED", "Conflicting active prefix retained; recovery did not replace it")
        if old is not None and not same_identity(old, old_id):
            fail("RECOVERY_REQUIRED", "Conflicting old generation retained")
        if new is not None and not same_identity(new, new_id):
            fail("RECOVERY_REQUIRED", "Conflicting staged generation retained")
        if same_identity(active, new_id):
            if new is not None:
                fail("RECOVERY_REQUIRED", "Both active and staged new paths exist; retained for inspection")
            self.verify(self.parent, prefix.name, new_id, self.archive, new_receipt)
            self.save(intent="ROLLBACK_NEW")
            rename_owned(self.parent, prefix.name, self.directory, "new", new_id)
            self.fault("rename:rollback-new")
            active, new = None, new_id
        if old_id is not None:
            if active is None:
                if old is None:
                    fail("RECOVERY_REQUIRED", "The previous generation is missing; no replacement was guessed")
                self.verify(self.directory, "old", old_id, self.previous, old_receipt,
                            legacy=self.journal["oldStyle"] == "legacy")
                self.save(intent="RESTORE_OLD")
                rename_owned(self.directory, "old", self.parent, prefix.name, old_id)
                self.fault("rename:restore-old")
            elif old is not None:
                fail("RECOVERY_REQUIRED", "Both active and backup old paths exist; retained for inspection")
            self.verify(self.parent, prefix.name, old_id, self.previous, old_receipt,
                        legacy=self.journal["oldStyle"] == "legacy")
        elif active is not None:
            fail("RECOVERY_REQUIRED", "Fresh-install recovery found an unowned active prefix")
        self.save(intent="CLEAN_NEW", outcome="ROLLED_BACK")
        try:
            if new is not None and not self.cleanup_generation("new", self.archive, new_receipt, new_id):
                return self.result("ROLLED_BACK_WITH_CLEANUP_PENDING")
            if not self.finish_journal():
                return self.result("ROLLED_BACK_WITH_CLEANUP_PENDING")
        except Exception as error:
            return self.result("ROLLED_BACK_WITH_CLEANUP_PENDING", str(error))
        return self.result("ROLLED_BACK")


def main(argv=None):
    options = parse_args(sys.argv[1:] if argv is None else argv)
    if os.environ.get("OPENSHELL_SANDBOX") != "1" or platform.system() != "Linux" or platform.machine() != "x86_64":
        fail("INSTALL", "Run this Linux x86_64 release inside your trusted OpenShell sandbox")
    package = Path(__file__).resolve().parent
    import fleet_fs
    lock_path = package / "payload/engine/src/lib/openshell_lifecycle_lock.py"
    spec = importlib.util.spec_from_file_location("fleet_lifecycle_lock", lock_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    def interrupted(_number, _frame):
        fail("OUTCOME_UNCERTAIN", "Local lifecycle was interrupted; retained evidence requires review")
    previous_handler = signal.signal(signal.SIGTERM, interrupted)
    try:
        return locked_main(options, module, fleet_fs, package)
    finally:
        signal.signal(signal.SIGTERM, previous_handler)


def locked_main(options, module, fleet_fs, package):
    with module.LifecycleLock(recovery=options.mode == "recover") as lock:
        lifecycle = Lifecycle(package, lock)
        with Transaction(options, lock, fleet_fs, lifecycle, package) as transaction:
            try:
                result = transaction.recover() if options.mode == "recover" else transaction.begin()
            except Exception as error:
                # An exception is not proof that external setup ended or that
                # a rename did not happen. Keep evidence for explicit recovery.
                if transaction.journal is not None:
                    if (options.mode != "recover" and transaction.journal["phase"] != "COMMITTED"
                            and transaction.journal["setup"] not in ("STARTED", "COMPLETE")
                            and not (transaction.journal["phase"] == "PREPARED"
                                     and transaction.journal["newReceipt"] is None)
                            and getattr(error, "code", None) != "OUTCOME_UNCERTAIN"):
                        try:
                            transaction.rollback()
                        except Exception:
                            # Every rollback action has its own full inventory
                            # and identity check. Failure retains both trees.
                            pass
                    journal = Path(transaction.journal["transaction"]) / "journal.json"
                    retained = transaction.lock.pending is not None
                    if retained:
                        sys.stderr.write(f"RECOVERY_REQUIRED: retained journal {shlex.quote(str(journal))}\n")
                    if retained and transaction.journal["setup"] not in ("STARTED", "COMPLETE"):
                        recovery = ["bash", str(package / "install.sh"), "--recover", str(journal),
                                    "--archive", str(options.archive), "--sha256", options.sha256]
                        sys.stderr.write("Recovery after reviewing the retained evidence: " + shlex.join(recovery) + "\n")
                elif isinstance(lock.pending, dict) and lock.pending.get("phase") == "PREPARING":
                    journal = lock.pending["journal"]
                    sys.stderr.write("RECOVERY_REQUIRED: preparation retained; intended journal " + shlex.quote(journal) + "\n")
                    recovery = ["bash", str(package / "install.sh"), "--recover", journal,
                                "--archive", str(options.archive), "--sha256", options.sha256]
                    sys.stderr.write("Recovery also accepts this intended path before a journal exists: " + shlex.join(recovery) + "\n")
                raise
            sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
            return 0 if result["outcome"] in ("COMMITTED", "ROLLED_BACK") else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstallError as error:
        sys.stderr.write(f"{error.code}: {error}\n")
        sys.exit(1)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.stderr.write(f"INSTALL: {error}\n")
        sys.exit(1)
    except RuntimeError as error:
        sys.stderr.write(f"{getattr(error, 'code', 'INSTALL')}: {error}\n")
        sys.exit(1)
