#!/usr/bin/env python3
"""Read-only host handoff qualification. Never installs, uninstalls or restarts."""
from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True


class HandoffRefusal(RuntimeError):
    pass


def installer_location(value):
    root = Path(value)
    if not root.is_absolute():
        raise HandoffRefusal("INSTALLER_ROOT_ABSOLUTE_REQUIRED")
    return root


def installer_module(directory):
    """Use the release's own archive/path checks, without copying their policy."""
    sys.path.insert(0, str(directory))
    return importlib.import_module("host_install")


def executable(value, installer):
    path = installer.absolute(value)
    if not stat.S_ISREG(path.stat().st_mode) or not os.access(path, os.X_OK):
        raise HandoffRefusal("EXECUTABLE_UNAVAILABLE: select an executable regular file")
    return path


def provider_path(codex, node, inherited_path):
    # Child-only command environment. No global PATH or provider-home mutation.
    selected = os.pathsep.join(dict.fromkeys([str(codex.parent), str(node.parent),
                                            *filter(None, inherited_path.split(os.pathsep))]))
    found = shutil.which("codex", path=selected)
    if found is None or Path(found).resolve() != codex.resolve():
        raise HandoffRefusal("CODEX_PATH_UNRESOLVED: select the Codex executable named codex")
    found_node = shutil.which("node", path=selected)
    if found_node is None or Path(found_node).resolve() != node.resolve():
        raise HandoffRefusal("NODE_PATH_UNRESOLVED: select the Node executable named node")
    return selected


def validate_layout(installer, options):
    installer.validate(options)


def verify_release(installer, options):
    # Descriptor-bound SHA256, archive inventory, host manifest and private modes.
    with installer.checked_archive(options) as archive:
        return json.loads(archive.read_bytes("toolsenabled-installer/manifest.json"))


def codex_version(codex, env=None):
    result = subprocess.run([str(codex), "--version"], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=10, text=True, env=env)
    if result.returncode != 0 or not re.fullmatch(r"codex-cli \d+\.\d+\.\d+(?:[.-][A-Za-z0-9]+)*\s*", result.stdout):
        raise HandoffRefusal("CODEX_VERSION_UNAVAILABLE: selected CLI failed --version")
    return result.stdout.strip()


def prepare(installer, *, archive, sha256, prefix, state_root, workspace, codex,
            node, inherited_path, tier, workers, installer_entry):
    options = installer.Options("host", Path(prefix), Path(archive), sha256,
                                Path(state_root), Path(workspace), workers, tier)
    validate_layout(installer, options)
    manifest = verify_release(installer, options)
    codex_path = executable(codex, installer)
    node_path = executable(node, installer)
    child_path = provider_path(codex_path, node_path, inherited_path)
    installer.check_node(str(node_path))
    # Execute only --version. Do not invoke login, config, registration or a turn.
    version = codex_version(codex_path, env={**os.environ, "PATH": child_path})
    command = ["env", "PATH=" + child_path, str(installer_entry), "--host",
               "--archive", str(options.archive), "--sha256", sha256,
               "--prefix", str(options.prefix), "--state-root", str(options.state_root),
               "--workspace", str(options.workspace), "--tier", tier]
    if workers:
        command.append("--enable-workers")
    return {"schemaVersion": 1, "preflightOnly": True, "effects": "none",
            "release": manifest, "archive": str(options.archive), "sha256": sha256,
            "workspace": str(options.workspace), "prefix": str(options.prefix),
            "stateRoot": str(options.state_root), "codexExecutable": str(codex_path),
            "codexVersion": version, "nodeExecutable": str(node_path),
            "permissionTier": tier, "workers": workers,
            "installArgv": command, "installCommand": shlex.join(command),
            "remainingChecks": ["Coordinator checkpoint and drain",
                "Verify extracted installer matches the selected archive",
                "Pin rollback archive and retained nonsecret install receipt",
                "Provider registration collision and native worker prerequisites",
                "Supported uninstall/install by the authorized owner",
                "Explicit retained tree reconnect and fresh tools/list"],
            "authentication": "Inherited provider-owned environment; no login/config reads",
            "serviceSpeed": {"requested": "standard", "submitted": None, "effective": None}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("installer-root", "archive", "sha256", "prefix", "state-root",
                 "workspace", "codex", "node"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--tier", choices=("unrestricted", "standard", "guided"), required=True)
    parser.add_argument("--enable-workers", action="store_true")
    args = parser.parse_args(argv)
    try:
        root = installer_location(args.installer_root)
        installer = installer_module(root)
        plan = prepare(installer, archive=args.archive, sha256=args.sha256,
                       prefix=args.prefix, state_root=args.state_root,
                       workspace=args.workspace, codex=args.codex, node=args.node,
                       inherited_path=os.environ.get("PATH", ""), tier=args.tier,
                       workers=args.enable_workers, installer_entry=root / "install.sh")
        print(json.dumps(plan, indent=2))
        return 0
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        # Do not print arbitrary child output, environment or credential values.
        print("HANDOFF_PREFLIGHT_REFUSED: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
