"""Explicit faults on a real disposable vault, not power-loss durability proof.

This process uses the production helper/keyring/lock/encryption path. Only one
filesystem syscall is faulted at a named boundary; no owner backend is allowed.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys

root = os.environ.get("TOOLSENABLED_TEST_ROOT", "")
if (not os.path.isabs(root) or not Path(root).name.startswith("toolsenabled-private-libsecret-")
        or os.path.realpath(root) != root
        or os.path.dirname(os.environ.get("XDG_DATA_HOME", "")) != root
        or not os.environ.get("DBUS_SESSION_BUS_ADDRESS")):
    sys.exit(2)
control = json.load(sys.stdin)
target = control["file"]
if target != os.path.join(root, "vault.json") or target != os.environ.get("TOOLSENABLED_VAULT_PATH"):
    sys.exit(2)
phase = control["phase"]
if phase not in {"before-replace", "replace-error", "after-replace", "lost-receipt"}:
    sys.exit(2)
subject = Path(__file__).resolve().parents[2] / "src" / "linux-vault.py"
spec = importlib.util.spec_from_file_location("vault_native_fault_subject", subject)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
real_fsync, real_replace = os.fsync, os.replace
events = []


def fsync(fd):
    directory = stat.S_ISDIR(os.fstat(fd).st_mode)
    events.append("directory-fsync" if directory else "file-fsync")
    if (phase == "before-replace" and not directory) or (phase == "after-replace" and directory):
        raise OSError("Injected isolated I/O refusal")
    return real_fsync(fd)


def replace(*args, **kwargs):
    events.append("replace-attempted")
    if phase == "replace-error":
        raise OSError("Injected isolated replacement refusal")
    result = real_replace(*args, **kwargs)
    events.append("replace-returned")
    return result


helper.os.fsync, helper.os.replace = fsync, replace
sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps({"action": "clear-device-credential", "file": target}).encode()))
try:
    result = helper.main()
    if phase == "lost-receipt":
        os._exit(7)  # A completed mutation without its response is still unknown to its caller.
    print(json.dumps({"ok": True, "result": result, "events": events}))
except helper.Refusal as error:
    print(json.dumps({"ok": False, "code": error.code,
                      "mutationOutcome": getattr(error, "mutation_outcome", None), "events": events}))
    sys.exit(1)
finally:
    helper.os.fsync, helper.os.replace = real_fsync, real_replace
