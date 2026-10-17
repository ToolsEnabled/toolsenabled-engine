#!/usr/bin/python3
"""Linux vault custody. No unlock, prompt, keyring reset, or plaintext fallback.

Only the fixed GNOME login collection with an encrypted backing file is
supported. libsecret keeps one random AES-256 key per vault identity; the
application file contains individually authenticated encrypted records.
"""

import base64
import fcntl
import hashlib
import errno
import json
import os
import re
import resource
import secrets
import stat
import sys
import time
import uuid
from contextlib import contextmanager

MAX_BYTES = 4 * 1024 * 1024
MAX_SEQUENCE = 9007199254740991
FORMAT = "toolsenabled.linux-vault.v1"
BACKEND = "gnome-libsecret-aes-256-gcm"
COLLECTION = "/org/freedesktop/secrets/collection/login"
KEYRING_HEADER = b"GnomeKeyring\n\r\0\n"
DENIED = frozenset(("payment_card_default", "owner_legal_identity_v1"))
RETIRED_REMOTE_KEYS = frozenset((
    "custom.online_fra_device_credential_v1",
    "custom.online_fra_admin_operation_v1",
    "custom.online_fra_device_identity_v1",
))
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
MUTATIONS = frozenset(("set-many", "get-or-create", "set-monotonic"))
AUDIT_ACTIONS = frozenset(("audit-pair-inspect", "audit-pair-replace"))
AUDIT_KEYS = ("toolsenabled_audit_signing_key_v1", "toolsenabled_audit_head_v1")
# Only the inherited-pipe server reuses transport/session objects. No vault
# key, decrypted record, authorization verdict, or lock state is cached here.
REUSE_CONNECTION = False
_connection = None


class Refusal(Exception):
    def __init__(self, code):
        self.code = code


def refuse(code):
    raise Refusal(code)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            refuse("SECRET_VAULT_UNREADABLE")
        value[key] = item
    return value


def decode_json(raw):
    return json.loads(raw, object_pairs_hook=unique_object)


def encoded(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def valid_key(key):
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        refuse("SECRET_INPUT_INVALID")


def valid_value(value):
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > MAX_BYTES // 2:
        refuse("SECRET_INPUT_INVALID")


def validate_request(request):
    if not isinstance(request, dict):
        refuse("SECRET_INPUT_INVALID")
    action = request.get("action")
    if action not in MUTATIONS | AUDIT_ACTIONS | {"get", "get-many", "list", "present", "status", "remove"}:
        refuse("SECRET_INPUT_INVALID")
    if action in AUDIT_ACTIONS:
        expected = {"action", "file"} if action == "audit-pair-inspect" else {"action", "file", "expectedDigest", "privateKey", "anchor"}
        if set(request) != expected:
            refuse("SECRET_INPUT_INVALID")
        if action == "audit-pair-replace":
            if not isinstance(request["expectedDigest"], str) or not re.fullmatch(r"[a-f0-9]{64}", request["expectedDigest"]):
                refuse("SECRET_INPUT_INVALID")
            valid_value(request["privateKey"])
            valid_value(request["anchor"])
    if action == "remove" and set(request) != {"action", "file", "key"}:
        refuse("SECRET_INPUT_INVALID")
    keys = []
    if action in {"get", "present", "get-or-create", "set-monotonic", "remove"}:
        keys = [request.get("key")]
    elif action == "get-many":
        keys = request.get("keys")
        if not isinstance(keys, list) or not 1 <= len(keys) <= 256:
            refuse("SECRET_INPUT_INVALID")
    elif action == "set-many":
        entries = request.get("entries")
        if not isinstance(entries, list) or not 1 <= len(entries) <= 3:
            refuse("SECRET_INPUT_INVALID")
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"key", "value"}:
                refuse("SECRET_INPUT_INVALID")
            valid_value(entry["value"])
        keys = [entry["key"] for entry in entries]
        if len(set(keys)) != len(keys):
            refuse("SECRET_INPUT_INVALID")
    for key in keys:
        valid_key(key)
    if any(key.lower() in RETIRED_REMOTE_KEYS for key in keys):
        refuse("SECRET_ACCESS_DENIED")
    # Reject before lookup, for absent and present records alike. Protected
    # owner records are never read or written through the generic agent API.
    if action != "present" and any(key.lower() in DENIED for key in keys):
        refuse("SECRET_ACCESS_DENIED")
    if action in {"get-or-create", "set-monotonic"}:
        valid_value(request.get("value"))
    if action == "set-monotonic":
        sequence = request.get("sequence")
        if type(sequence) is not int or not 0 <= sequence <= MAX_SEQUENCE:
            refuse("SECRET_INPUT_INVALID")
        if embedded_sequence(request["value"]) != sequence:
            refuse("SECRET_INPUT_INVALID")


def private_file(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        refuse("SECRET_VAULT_PATH_UNSAFE")
    return info


def encrypted_keyring_file(data_root):
    if not os.path.isabs(data_root):
        refuse("SECRET_BACKEND_UNSAFE")
    file = os.path.join(data_root, "keyrings", "login.keyring")
    if os.path.realpath(file) != file:
        refuse("SECRET_BACKEND_UNSAFE")
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            private_file(fd)
            if os.read(fd, len(KEYRING_HEADER)) != KEYRING_HEADER:
                refuse("SECRET_BACKEND_UNSAFE")
        finally:
            os.close(fd)
    except FileNotFoundError:
        refuse("SECRET_BACKEND_UNAVAILABLE")


def daemon_data_directory(pid):
    # Bind the format check to the SERVICE's actual data directory. Checking
    # the caller's XDG_DATA_HOME could certify an unrelated encrypted file
    # while the service itself used a passwordless plaintext keyring. Only
    # these two path fields are retained; no environment is returned or logged.
    selected = {}
    with open(f"/proc/{pid}/environ", "rb") as stream:
        for entry in stream.read(1024 * 1024).split(b"\0"):
            name, _, value = entry.partition(b"=")
            if name in (b"XDG_DATA_HOME", b"HOME"):
                selected[name] = value.decode("utf-8")
    return selected.get(b"XDG_DATA_HOME") or os.path.join(selected.get(b"HOME", ""), ".local", "share")


def require_owned_bus(bus, Gio):
    # A bus daemon can assert any service UID/PID. Bind those later assertions
    # to the actual local socket's kernel peer first. GDBusConnection's own
    # get_peer_credentials() is always null for a message-bus client; the
    # underlying GSocket reads SO_PEERCRED without consuming protocol bytes.
    try:
        stream = bus.get_stream()
        if not isinstance(stream, Gio.SocketConnection):
            refuse("SECRET_BACKEND_UNSAFE")
        socket = stream.get_socket()
        if socket is None or socket.get_family() != Gio.SocketFamily.UNIX:
            refuse("SECRET_BACKEND_UNSAFE")
        credentials = socket.get_credentials()
        uid = credentials.get_unix_user() if credentials is not None else None
        if type(uid) is not int or uid == 0 or uid != os.getuid():
            refuse("SECRET_BACKEND_UNSAFE")
    except Refusal:
        raise
    except Exception:
        refuse("SECRET_BACKEND_UNSAFE")


def secure_service():
    global _connection
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        _connection = None
        refuse("SECRET_BACKEND_UNAVAILABLE")
    try:
        import gi
        gi.require_version("Secret", "1")
        from gi.repository import Gio, GLib, Secret
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except (ImportError, ValueError):
        refuse("SECRET_HELPER_UNAVAILABLE")
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        require_owned_bus(bus, Gio)

        def bus_call(method, value, reply):
            return bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
                                 "org.freedesktop.DBus", method, GLib.Variant("(s)", (value,)),
                                 GLib.VariantType(reply), Gio.DBusCallFlags.NO_AUTO_START,
                                 5000, None).unpack()[0]

        # A service name alone says nothing about its custody implementation.
        # Do not activate one or accept a session-only or unknown implementation.
        owner = bus_call("GetNameOwner", "org.freedesktop.secrets", "(s)")
        pid = bus_call("GetConnectionUnixProcessID", owner, "(u)")
        uid = bus_call("GetConnectionUnixUser", owner, "(u)")
        if uid != os.getuid() or os.readlink(f"/proc/{pid}/exe") != "/usr/bin/gnome-keyring-daemon":
            refuse("SECRET_BACKEND_UNSAFE")
        data_root = daemon_data_directory(pid)
        encrypted_keyring_file(data_root)
        # Reuse the encrypted session only AFTER repeating the kernel peer,
        # unique owner, executable, UID and encrypted backing-file checks.
        # A synchronous Properties.Get is essential: proxy properties can be
        # stale when this synchronous helper has not dispatched GLib signals.
        binding = (bus, owner, pid, data_root)
        if REUSE_CONNECTION and _connection is not None and _connection[0] == binding:
            result = _connection[1]
            locked = bus.call_sync(owner, COLLECTION, "org.freedesktop.DBus.Properties", "Get",
                                   GLib.Variant("(ss)", ("org.freedesktop.Secret.Collection", "Locked")),
                                   GLib.VariantType("(v)"), Gio.DBusCallFlags.NO_AUTO_START,
                                   5000, None).unpack()[0]
            if type(locked) is not bool:
                refuse("SECRET_BACKEND_UNAVAILABLE")
            if locked:
                refuse("SECRET_BACKEND_LOCKED")
            return result
        _connection = None
        # Pin the unique D-Bus owner we measured, not a replaceable service name.
        service = Secret.Service.open_sync(Secret.Service, owner,
                                          Secret.ServiceFlags.OPEN_SESSION, None)
        if service.get_name_owner() != owner:
            refuse("SECRET_BACKEND_UNAVAILABLE")
        if service.get_session_algorithms() != "dh-ietf1024-sha256-aes128-cbc-pkcs7":
            refuse("SECRET_BACKEND_UNSAFE")
        # Loading all collections also initializes their item proxies. A stale
        # unrelated item must not prevent opening our fixed login collection;
        # master_key still validates the exact requested key independently.
        collection = Secret.Collection(
            service=service, flags=Secret.CollectionFlags.NONE,
            g_object_path=COLLECTION, g_connection=bus, g_name=owner,
            g_interface_name="org.freedesktop.Secret.Collection")
        if (collection.init(None) is not True or collection.get_object_path() != COLLECTION
                or collection.get_name_owner() != owner):
            refuse("SECRET_BACKEND_UNAVAILABLE")
        if collection.get_locked():
            refuse("SECRET_BACKEND_LOCKED")
        schema = Secret.Schema.new("org.toolsenabled.LinuxVaultKey.v1", Secret.SchemaFlags.NONE,
                                   {"vault": Secret.SchemaAttributeType.STRING,
                                    "identity": Secret.SchemaAttributeType.STRING})
        # Collections keep a weak service reference; retain our unique-owner
        # proxy for the entire operation, including encrypted item creation.
        result = Secret, AESGCM, collection, schema, data_root, service
        if REUSE_CONNECTION:
            _connection = (binding, result)
        return result
    except Refusal:
        _connection = None
        raise
    except Exception:
        _connection = None
        refuse("SECRET_BACKEND_UNAVAILABLE")


def master_key(service, file, identity, create=False, metadata_only=False):
    Secret, _, collection, schema, data_root, proxy = service
    attributes = {"vault": hashlib.sha256(file.encode("utf-8")).hexdigest(), "identity": identity}
    try:
        # ALL finds ambiguity; neither UNLOCK nor LOAD_SECRETS is requested.
        items = collection.search_sync(schema, attributes, Secret.SearchFlags.ALL, None)
        if len(items) > 1:
            refuse("SECRET_BACKEND_KEY_INVALID")
        if not items:
            # A VAULT THAT MOVED IS THE SAME VAULT.
            #
            # The lookup above is keyed on sha256(absolute vault path), so any
            # relocation missed it: the product's own upgrade adoption copies
            # the vault file into a new state root, and reading it there then
            # failed with SECRET_BACKEND_KEY_MISSING -- every credential in it
            # inaccessible -- while a write minted a SECOND key and left the
            # first orphaned forever. Measured on a development machine: 4,195
            # items labelled "ToolsEnabled Linux vault key" in one login
            # keyring, of which exactly one can be current.
            #
            # The identity is a uuid4 stored INSIDE the vault file, validated
            # on every read and already bound into the AEAD's associated data,
            # so it travels with the file and a key filed under it is by
            # construction this vault's key. Re-file that key under the new
            # location rather than minting a second one. The ambiguity guard is
            # kept: two keys for one identity is still a refusal, never a guess.
            moved = collection.search_sync(schema, {"identity": identity},
                                           Secret.SearchFlags.ALL, None)
            if len(moved) > 1:
                refuse("SECRET_BACKEND_KEY_INVALID")
            if moved:
                try:
                    moved[0].set_attributes_sync(schema, attributes, None)
                except Exception:
                    refuse("SECRET_BACKEND_KEY_INVALID")
                items = collection.search_sync(schema, attributes,
                                               Secret.SearchFlags.ALL, None)
                if len(items) != 1:
                    refuse("SECRET_BACKEND_KEY_INVALID")
        if not items:
            if not create:
                refuse("SECRET_BACKEND_KEY_MISSING")
            key = secrets.token_bytes(32)
            value = Secret.Value.new(base64.b64encode(key).decode("ascii"), -1, "text/plain")
            # libsecret's high-level Item.create_sync handles prompts. This
            # unattended helper must never do so, including a lock racing the
            # readiness check. Send CreateItem with libsecret's encrypted
            # session payload ourselves; a returned prompt is a refusal and
            # its Prompt method is never invoked.
            from gi.repository import Gio, GLib
            properties = GLib.Variant("a{sv}", {
                "org.freedesktop.Secret.Item.Label": GLib.Variant("s", "ToolsEnabled Linux vault key"),
                "org.freedesktop.Secret.Item.Attributes": GLib.Variant("a{ss}", {
                    **attributes, "xdg:schema": "org.toolsenabled.LinuxVaultKey.v1"})})
            payload = GLib.Variant.new_tuple(properties,
                                            proxy.encode_dbus_secret(value),
                                            GLib.Variant("b", False))
            item_path, prompt_path = collection.call_sync("CreateItem", payload,
                                                          Gio.DBusCallFlags.NO_AUTO_START, 5000, None).unpack()
            if prompt_path != "/" or item_path == "/":
                refuse("SECRET_BACKEND_LOCKED")
            matches = collection.search_sync(schema, attributes, Secret.SearchFlags.ALL, None)
            if len(matches) != 1 or matches[0].get_object_path() != item_path:
                refuse("SECRET_BACKEND_KEY_INVALID")
            item = matches[0]
            # Verify the real backend can read the just-persisted value before
            # writing a vault that depends on it. No replacement of any item.
            item.load_secret_sync(None)
            if item.get_secret() is None or item.get_secret().get_text() != base64.b64encode(key).decode("ascii"):
                refuse("SECRET_BACKEND_KEY_INVALID")
            encrypted_keyring_file(data_root)
            return key
        item = items[0]
        if item.get_locked():
            refuse("SECRET_BACKEND_LOCKED")
        if metadata_only:
            return None
        if not item.load_secret_sync(None) or item.get_secret() is None:
            refuse("SECRET_BACKEND_KEY_INVALID")
        key = base64.b64decode(item.get_secret().get_text(), validate=True)
        if len(key) != 32:
            refuse("SECRET_BACKEND_KEY_INVALID")
        return key
    except Refusal:
        raise
    except Exception:
        refuse("SECRET_BACKEND_UNAVAILABLE")


@contextmanager
def vault_directory(file, create):
    if not isinstance(file, str) or not os.path.isabs(file) or os.path.normpath(file) != file:
        refuse("SECRET_VAULT_PATH_UNSAFE")
    directory = os.path.dirname(file)
    descriptors = []
    try:
        # Walk from the root descriptor with openat/mkdirat. No pathname check
        # is followed by an absolute-path create/open that could traverse a
        # replaced ancestor. Root-owned sticky temp directories are the sole
        # writable-ancestor exception: their entries cannot be renamed by a
        # different unprivileged UID. Every other ancestor must be owned by
        # root or this UID and cannot grant group/other write access.
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        descriptors.append(fd)
        for component in directory.split("/")[1:]:
            if not component:
                continue
            ancestor = os.fstat(fd)
            sticky_root = ancestor.st_uid == 0 and ancestor.st_mode & stat.S_ISVTX
            if ancestor.st_uid not in (0, os.getuid()) or (ancestor.st_mode & 0o022 and not sticky_root):
                refuse("SECRET_VAULT_PATH_UNSAFE")
            try:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    yield None
                    return
                try:
                    os.mkdir(component, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            descriptors.append(next_fd)
            fd = next_fd
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077 or os.readlink(f"/proc/self/fd/{fd}") != directory:
            refuse("SECRET_VAULT_PATH_UNSAFE")
        yield fd
    except OSError:
        refuse("SECRET_VAULT_PATH_UNSAFE")
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


@contextmanager
def vault_lock(directory, name):
    try:
        timeout = int(os.environ.get("TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS", "30000"))
        if not 100 <= timeout <= 30000:
            refuse("SECRET_INPUT_INVALID")
        fd = os.open(name + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=directory)
        try:
            private_file(fd)
            deadline = time.monotonic() + timeout / 1000
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        refuse("SECRET_VAULT_LOCK_TIMEOUT")
                    time.sleep(0.01)
            yield
        finally:
            os.close(fd)  # kernel releases the lock on every exit, including death
    except OSError:
        refuse("SECRET_VAULT_PATH_UNSAFE")


def read_vault(directory, name, allow_broken_audit=False):
    try:
        # Check the opened inode before reading. A FIFO must not wait for a
        # writer (or the outer helper timeout) before its type can be refused.
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    except FileNotFoundError:
        return None
    try:
        info = private_file(fd)
        if info.st_size > MAX_BYTES:
            refuse("SECRET_VAULT_UNREADABLE")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(MAX_BYTES + 1)
        if not raw or len(raw) > MAX_BYTES:
            refuse("SECRET_VAULT_UNREADABLE")
        data = decode_json(raw)
        if not isinstance(data, dict) or data.get("format") != FORMAT or data.get("backend") != BACKEND:
            refuse("SECRET_VAULT_FORMAT_UNSUPPORTED")
        if set(data) != {"format", "backend", "identity", "records"} or str(uuid.UUID(data["identity"])) != data["identity"]:
            refuse("SECRET_VAULT_UNREADABLE")
        if not isinstance(data["records"], dict) or len(data["records"]) > 4096:
            refuse("SECRET_VAULT_UNREADABLE")
        for key, value in data["records"].items():
            valid_key(key)
            if allow_broken_audit and key in AUDIT_KEYS:
                if not isinstance(value, str):
                    refuse("SECRET_VAULT_UNREADABLE")
                continue
            if not isinstance(value, str) or len(base64.b64decode(value, validate=True)) < 29:
                refuse("SECRET_VAULT_UNREADABLE")
        return data
    except Refusal:
        raise
    except Exception:
        refuse("SECRET_VAULT_UNREADABLE")
    finally:
        os.close(fd)


def write_vault(directory, name, data):
    raw = encoded(data) + b"\n"
    if len(raw) > MAX_BYTES:
        refuse("SECRET_VAULT_WRITE_FAILED")
    temporary = "." + name + "." + secrets.token_hex(16) + ".tmp"
    replacement_attempted = False
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        # Even an error returned by the replacement attempt is not evidence
        # that the old directory entry survived. Keep that boundary explicit.
        replacement_attempted = True
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    except OSError:
        refuse("SECRET_VAULT_WRITE_UNCERTAIN" if replacement_attempted else "SECRET_VAULT_WRITE_FAILED")
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        except OSError:
            refuse("SECRET_VAULT_WRITE_UNCERTAIN" if replacement_attempted else "SECRET_VAULT_WRITE_FAILED")


# The access log is append-only metadata and nothing prunes it. Measured on a
# development install, it grew by tens of megabytes in a few days beside a live
# vault -- on that trajectory a customer carries gigabytes of it. One previous generation is kept, so the pair
# is bounded and the recent history a person would actually read survives a
# rotation.
ACCESS_LOG_MAX_BYTES = 4 * 1024 * 1024

# Only the one logger per 4 MiB that crosses the bound ever waits here, and a
# rotation that cannot take the lock is skipped rather than retried into a
# stall: a log that cannot rotate is a large log, which is survivable, while a
# log that cannot write is no log at all.
ACCESS_LOG_ROTATE_LOCK_TIMEOUT_MS = 2000


def rotate_access_log(directory, log_name):
    """Move the live access log aside exactly once, however many loggers cross
    the bound together.

    CHECK-THEN-RENAME ALONE DESTROYS THE WHOLE RETAINED GENERATION. os.rename
    replaces the destination atomically, so the second logger to arrive renames
    the *fresh* log the first one just created over the 4 MiB of history the
    first one just saved. The earlier comment here reasoned only about entry
    loss -- a writer holding the renamed inode does keep appending to it, which
    is true -- and concluded no lock was needed. That conclusion did not cover
    the generation, which is the part a person actually reads.

    MEASURED on this build by releasing 8 loggers into a log sitting exactly at
    the bound: 25 of 25 trials destroyed the retained generation, reducing
    4,194,304 bytes to as little as 74. This is not a narrow race that needs
    unlucky timing; under concurrency it is the ordinary outcome. Every read
    verb logs from outside the vault lock, so two concurrent reads are the whole
    prerequisite.

    Never raises. A rotation failure must not propagate into access_log, or the
    blanket handler there would swallow it and drop the entry as well -- losing
    the record along with the history it was trying to bound.
    """
    fd = None
    try:
        fd = os.open(log_name + ".rotate.lock",
                     os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     0o600, dir_fd=directory)
        private_file(fd)
        deadline = time.monotonic() + ACCESS_LOG_ROTATE_LOCK_TIMEOUT_MS / 1000
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    return
                time.sleep(0.01)
        # THE RE-CHECK IS THE FIX. Stat the name, not the descriptor this caller
        # opened before it queued for the lock. If another logger rotated while
        # we waited, the live log is now a fresh small file and <log>.1 holds
        # the generation that logger saved; there is nothing here to rotate and
        # renaming again would destroy it.
        if os.stat(log_name, dir_fd=directory).st_size >= ACCESS_LOG_MAX_BYTES:
            os.rename(log_name, log_name + ".1",
                      src_dir_fd=directory, dst_dir_fd=directory)
    except Exception:
        pass  # best-effort, and deliberately silent -- see the docstring
    finally:
        if fd is not None:
            try:
                os.close(fd)  # kernel releases the lock on every exit, including death
            except OSError:
                pass


def access_log(directory, name, action, keys=(), **metadata):
    if directory is None:
        return
    try:
        log_name = name + ".access.log"
        open_flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
        fd = os.open(log_name, open_flags, 0o600, dir_fd=directory)
        try:
            private_file(fd)
            if os.fstat(fd).st_size >= ACCESS_LOG_MAX_BYTES:
                # Cheap unlocked pre-check: only the logger that actually
                # crosses the bound pays for the lock inside rotate_access_log,
                # which re-checks the size there before moving anything.
                os.close(fd)
                fd = None
                rotate_access_log(directory, log_name)
                fd = os.open(log_name, open_flags, 0o600, dir_fd=directory)
                private_file(fd)
            for key in keys or (None,):
                entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "pid": os.getpid(), "action": action, **metadata}
                if key is not None:
                    entry["key"] = key
                os.write(fd, encoded(entry) + b"\n")
        finally:
            if fd is not None:
                os.close(fd)
    except Exception:
        pass  # identical best-effort metadata-only posture to the DPAPI vault


def embedded_sequence(value):
    try:
        data = decode_json(value)
        sequence = data.get("sequence")
        if type(sequence) is int and 0 <= sequence <= MAX_SEQUENCE:
            return sequence
    except Exception:
        pass
    refuse("SECRET_INPUT_INVALID")


def operate(request, service, directory, name, data):
    action, key = request["action"], request.get("key")
    if action in AUDIT_ACTIONS and data is None:
        # A missing whole vault is not authority to create another custody
        # identity beside an existing ledger during repair.
        refuse("SECRET_VAULT_UNREADABLE")
    if data is None:
        if action not in MUTATIONS:
            if action == "get":
                refuse("SECRET_NOT_CONFIGURED")
            if action == "get-many":
                return {entry: {"found": False} for entry in request["keys"]}
            return "no-store" if action == "present" else []
        data = {"format": FORMAT, "backend": BACKEND, "identity": str(uuid.uuid4()), "records": {}}
        master = master_key(service, request["file"], data["identity"], create=True)
    else:
        master = master_key(service, request["file"], data["identity"], metadata_only=action in {"present", "list"})
    records = data["records"]
    if action == "present":
        return "present" if key in records else "absent"
    if action == "list":
        return sorted(entry for entry in records if entry.lower() not in DENIED | RETIRED_REMOTE_KEYS)
    _, AESGCM, _, _, _, _ = service
    cipher = AESGCM(master)

    def aad(entry):
        return encoded([FORMAT, BACKEND, data["identity"], entry])

    def decrypt(entry):
        try:
            blob = base64.b64decode(records[entry], validate=True)
            return cipher.decrypt(blob[:12], blob[12:], aad(entry)).decode("utf-8")
        except Exception:
            refuse("SECRET_VAULT_UNREADABLE")

    def encrypt(entry, value):
        nonce = secrets.token_bytes(12)
        records[entry] = base64.b64encode(nonce + cipher.encrypt(nonce, value.encode("utf-8"), aad(entry))).decode("ascii")

    if action in AUDIT_ACTIONS:
        def pair_state():
            states = []
            for entry in AUDIT_KEYS:
                if entry not in records:
                    states.append("missing")
                else:
                    try:
                        decrypt(entry)
                        states.append("readable")
                    except Refusal:
                        states.append("unreadable")
            digest = hashlib.sha256(encoded([FORMAT, data["identity"], *[records.get(entry) for entry in AUDIT_KEYS]])).hexdigest()
            return {"version": 1, "digest": digest, "signing": states[0], "head": states[1],
                    "owner": {"platform": "linux", "id": str(os.getuid()), "elevated": False}}
        before = pair_state()
        if action == "audit-pair-inspect":
            return before
        if before["digest"] != request["expectedDigest"]:
            refuse("AUDIT_REKEY_VAULT_CHANGED")
        encrypt(AUDIT_KEYS[0], request["privateKey"])
        encrypt(AUDIT_KEYS[1], request["anchor"])
        write_vault(directory, name, data)
        return pair_state()

    if action == "remove":
        # Authenticate the record before deleting it under the kernel lock.
        if key not in records:
            return {"key": key, "status": "absent", "mutationOutcome": "NOT_ATTEMPTED"}
        decrypt(key)
        del records[key]
        write_vault(directory, name, data)
        return {"key": key, "status": "removed", "mutationOutcome": "REMOVED_SYNCED"}
    if action == "get":
        if key not in records:
            refuse("SECRET_NOT_CONFIGURED")
        return decrypt(key)
    if action == "get-many":
        return {entry: {"found": True, "value": decrypt(entry)} if entry in records else {"found": False}
                for entry in request["keys"]}
    if action == "get-or-create" and key in records:
        return decrypt(key)
    if action == "set-monotonic" and key in records:
        current = decrypt(key)
        sequence = embedded_sequence(current)
        if request["sequence"] < sequence or (request["sequence"] == sequence and request["value"] != current):
            refuse("SECRET_MONOTONIC_CONFLICT")
        if request["sequence"] == sequence:
            return None
    entries = request["entries"] if action == "set-many" else [{"key": key, "value": request["value"]}]
    for entry in entries:
        encrypt(entry["key"], entry["value"])
    write_vault(directory, name, data)
    return request["value"] if action == "get-or-create" else None


def process_request(request):
    try:
        validate_request(request)
    except Refusal as error:
        if error.code == "SECRET_ACCESS_DENIED":
            try:
                with vault_directory(request.get("file"), False) as directory:
                    keys = request.get("keys", [request["key"]] if "key" in request else [])
                    if request["action"] == "set-many":
                        keys = [entry["key"] for entry in request["entries"]]
                    access_log(directory, os.path.basename(request["file"]), request["action"], keys, denied=True)
            except Exception:
                pass
        raise
    service = secure_service()
    if request["action"] == "status":
        return {"available": True, "backend": "gnome_libsecret", "persistent": True}
    file = request.get("file")
    with vault_directory(file, request["action"] in MUTATIONS) as directory:
        name = os.path.basename(file)
        if directory is None:
            return operate(request, service, None, name, None)
        with vault_lock(directory, name):
            keys = request.get("keys", [request["key"]] if "key" in request else [])
            if request["action"] == "set-many":
                keys = [entry["key"] for entry in request["entries"]]
            access_log(directory, name, request["action"], keys)
            try:
                return operate(request, service, directory, name, read_vault(directory, name, allow_broken_audit=request["action"] in AUDIT_ACTIONS))
            except Refusal as error:
                access_log(directory, name, request["action"], keys, denied=True, code=error.code)
                raise


def close_inherited(contract=(0, 1, 2)):
    """Drop descriptors above stdio that this helper never asked for.

    The Electron main process starts this helper, and the browser process keeps
    the LIVE lifetime lock (fd 9), its own IPC sockets, its profile cache files
    and its debugging listener open WITHOUT FD_CLOEXEC. CPython keeps whatever
    it inherits, so a long-lived --serve host would hold the lifetime lock and
    keep the app from starting again after the window is gone. Every launcher
    of this file passes exactly three stdio entries. Closing a duplicate
    descriptor never releases an flock still held through another one.

    Call this ONLY from main() and serve(), the two entry points reached from
    __main__ when this file is run as its own process. It must never run inside
    protect_process(): linux-credential-prompt.py imports this file as a module
    and calls protect_process() in process, once before the dialog and again
    from save_to_vault() while the GTK display connection is open and the
    native_prompt_lock flock is still held. Closing descriptors there would
    release that lock and break the dialog teardown that wipes the entry.
    """
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
        if value in contract:
            continue
        try:
            os.close(value)
        except OSError as error:
            # listdir's own fd has already closed. Any other close failure
            # cannot establish sanitation and must prevent admission.
            if error.errno != errno.EBADF:
                raise RuntimeError("inherited descriptor closure unconfirmed") from None


def protect_process():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        refuse("SECRET_BACKEND_IDENTITY_INVALID")


def main():
    close_inherited()
    protect_process()
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        refuse("SECRET_INPUT_INVALID")
    request = decode_json(raw)
    return process_request(request)


def serve():
    """One inherited private pipe, with the full custody check on each request.

    Interpreter/library initialization and the encrypted session are reused. No master-key or
    decrypted-record cache is created, and no public socket is opened.
    """
    global REUSE_CONNECTION
    REUSE_CONNECTION = True
    close_inherited()
    protect_process()
    print("linux-vault-host-ready", file=sys.stderr, flush=True)
    while True:
        raw = sys.stdin.buffer.readline(MAX_BYTES + 2)
        if not raw:
            return
        # A partial/oversized frame cannot safely be resynchronized: close.
        if len(raw) > MAX_BYTES or not raw.endswith(b"\n"):
            return
        request_id = None
        status = 1
        try:
            frame = decode_json(raw)
            if (not isinstance(frame, dict) or set(frame) != {"id", "request"}
                    or type(frame["id"]) is not int or not 1 <= frame["id"] <= MAX_SEQUENCE):
                return
            request_id = frame["id"]
            response = {"ok": True, "result": process_request(frame["request"])}
            status = 0
        except Refusal as error:
            response = {"ok": False, "code": error.code}
        except Exception:
            response = {"ok": False, "code": "SECRET_VAULT_UNREADABLE"}
        if request_id is None:
            return
        body = json.dumps(response, separators=(",", ":"), ensure_ascii=False)
        print(json.dumps({"id": request_id, "status": status, "stdout": body},
                         separators=(",", ":"), ensure_ascii=False), flush=True)
        # Drop references between operations. This is not a claim of secure
        # erasure of immutable Python strings or libsecret-owned buffers.
        raw = frame = response = body = None


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--serve"]:
            serve()
        else:
            print(json.dumps({"ok": True, "result": main()}, separators=(",", ":")))
    except Refusal as error:
        response = {"ok": False, "code": error.code}
        print(json.dumps(response, separators=(",", ":")))
        sys.exit(1)
    except Exception:
        # Parsing/crypto/OS exception messages may quote credentials. Never
        # include an exception string, traceback, request, or environment.
        print('{"ok":false,"code":"SECRET_VAULT_UNREADABLE"}')
        sys.exit(1)
