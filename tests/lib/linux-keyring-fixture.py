"""Destructive operations ONLY against the test's private Secret Service."""
import hashlib
import json
import os
import re
import stat
import sys


def ordinary_directory(directory, private=False):
    if not os.path.isabs(directory) or os.path.normpath(directory) != directory:
        return False
    cursor = "/"
    try:
        for part in directory.split("/")[1:]:
            if part:
                cursor = os.path.join(cursor, part)
            metadata = os.lstat(cursor)
            if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid not in (0, os.getuid()):
                return False
            sticky_root = metadata.st_uid == 0 and metadata.st_mode & stat.S_ISVTX
            if metadata.st_mode & 0o022 and not sticky_root:
                return False
        if private:
            return metadata.st_uid == os.getuid() and stat.S_IMODE(metadata.st_mode) == 0o700
        return metadata.st_uid == os.getuid() or bool(sticky_root)
    except OSError:
        return False


# Match the parent's Node os.tmpdir() selection, including its supported /tmp
# fallback. The temp spelling is not authority: inspect its real ancestry before
# allowing the destructive fixture to contact any Secret Service.
temporary_parent = (os.environ.get("TMPDIR") or os.environ.get("TMP")
                    or os.environ.get("TEMP") or "/tmp").rstrip("/") or "/"

root = os.environ.get("TOOLSENABLED_TEST_ROOT", "")
data = os.environ.get("XDG_DATA_HOME", "")
if (not ordinary_directory(temporary_parent)
        or os.path.dirname(root) != temporary_parent
        or not re.fullmatch(r"toolsenabled-private-libsecret-[A-Za-z0-9]{6}", os.path.basename(root))
        or not ordinary_directory(root, private=True)
        or data != os.path.join(root, "data")
        or not ordinary_directory(data, private=True)):
    sys.exit(2)
request = json.load(sys.stdin)

import gi
gi.require_version("Secret", "1")
from gi.repository import Secret

service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS, None)
collection = next(entry for entry in service.get_collections()
                  if entry.get_object_path() == "/org/freedesktop/secrets/collection/login")
if request["action"] == "lock":
    service.lock_sync([collection], None)
elif request["action"] == "delete-key":
    if os.path.dirname(request["file"]) != root:
        sys.exit(2)
    schema = Secret.Schema.new("org.toolsenabled.LinuxVaultKey.v1", Secret.SchemaFlags.NONE,
                               {"vault": Secret.SchemaAttributeType.STRING, "identity": Secret.SchemaAttributeType.STRING})
    attributes = {"vault": hashlib.sha256(request["file"].encode("utf-8")).hexdigest(), "identity": request["identity"]}
    items = collection.search_sync(schema, attributes, Secret.SearchFlags.ALL, None)
    if len(items) != 1:
        sys.exit(2)
    items[0].delete_sync(None)
else:
    sys.exit(2)
