#!/usr/bin/env python3
"""Explicit owner lifecycle sequencing; no retries or automatic consent."""
from __future__ import annotations
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
import sys

class HandoffFailure(RuntimeError):
    pass

@dataclass
class Step:
    name: str
    argv: list[str]
    capture: bool = False
    env: dict | None = None

def stop_on_failure(step, result):
    if result.returncode != 0:
        raise HandoffFailure(f"{step.name} failed (exit {result.returncode}); later steps were not run")

def real_runner(step):
    return subprocess.run(step.argv, check=False, capture_output=step.capture,
                          text=True, env=step.env)

def checked_sequence(steps, runner=real_runner):
    results = []
    for step in steps:
        result = runner(step)
        stop_on_failure(step, result)
        results.append(result)
    return results

DIGEST_PROGRAM = """
import hashlib,pathlib,sys
actual=hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
sys.exit(0 if actual==sys.argv[2] else 2)
"""

VERIFY_PROGRAM = """
import json,pathlib,sys
stage,archive,sha,prefix,state,work,installed=sys.argv[1:]
sys.path.insert(0,stage)
import host_install as h
o=h.Options('host',pathlib.Path(prefix),pathlib.Path(archive),sha,pathlib.Path(state),pathlib.Path(work))
h.validate(o)
with h.checked_archive(o) as a,h.fs.SafeDirectory.open(str(pathlib.Path(stage).parent)) as parent:
 h.fs.verify_extracted_package(parent,a,allow_shared_ancestors=True)
 if installed=='yes':
  receipt=json.loads((pathlib.Path(state)/'install-receipt.json').read_text())
  if receipt.get('status')!='installed' or receipt.get('sha256')!=sha:
   raise RuntimeError('Current installed receipt does not match selected archive')
  with h.fs.SafeDirectory.open(prefix) as target:
   h.fs.verify_tree(target,a.package_inventory,allow_shared_ancestors=True)
"""

EXTRACT_PROGRAM = """
import pathlib,sys
backend,stage,archive,sha,prefix,state,work=sys.argv[1:]
sys.path.insert(0,backend)
import host_install as h
stage=h.absolute(stage)
if h.overlaps(stage,h.absolute(prefix)):
 raise RuntimeError('Fresh stage cannot overlap the current runtime')
original=h.Options('host',pathlib.Path(prefix),pathlib.Path(archive),sha,pathlib.Path(state),pathlib.Path(work))
h.validate(original)
o=h.Options('host',stage,pathlib.Path(archive),sha,pathlib.Path(state),pathlib.Path(work))
h.validate(o)
with h.checked_archive(o) as a,h.fs.SafeDirectory.open(str(stage.parent)) as parent:
 with h.fs.create_directory(parent,stage.name) as target:
  h.fs.extract_archive(a,target,allow_shared_ancestors=True)
"""

def checksum_steps(spec):
    return [Step(name+"-checksum", [sys.executable, "-B", "-c", DIGEST_PROGRAM,
                 spec[name+"_archive"], spec[name+"_sha256"]])
            for name in ("candidate", "rollback")]

def installer(spec, release):
    return str(Path(spec[release+"_stage"]) / "toolsenabled-installer")

def preflight_step(spec, release):
    return Step(release+"-preflight", [sys.executable, "-B",
        str(Path(installer(spec, "candidate")) / "handoff_preflight.py"),
        "--installer-root", installer(spec, release),
        "--archive", spec[release+"_archive"], "--sha256", spec[release+"_sha256"],
        "--prefix", spec["prefix"], "--state-root", spec["state_root"],
        "--workspace", spec["workspace"], "--codex", spec["codex"],
        "--node", spec["node"], "--tier", spec["tier"], "--enable-workers"], capture=True)

def verification_step(spec, release, installed=False):
    return Step(release+("-installed-verification" if installed else "-stage-verification"),
        [sys.executable, "-B", "-c", VERIFY_PROGRAM, installer(spec, release),
         spec[release+"_archive"], spec[release+"_sha256"], spec["prefix"],
         spec["state_root"], spec["workspace"], "yes" if installed else "no"])

def plan_environment(result):
    try:
        plan = json.loads(result.stdout)
        child_path = plan["installArgv"][1].removeprefix("PATH=")
        if plan["effects"] != "none" or plan["preflightOnly"] is not True or not child_path:
            raise ValueError()
        return {**os.environ, "PATH": child_path}
    except (KeyError, TypeError, ValueError, IndexError, AttributeError):
        raise HandoffFailure("Preflight plan is unavailable or invalid; no lifecycle step was run") from None

def require_drain(drained):
    if not drained:
        raise HandoffFailure("Owner must explicitly attest the coordinated drain; no lifecycle step was run")

def lifecycle_step(spec, release, remove, env):
    argv = ["bash", str(Path(installer(spec, release)) / "install.sh"),
        "--uninstall" if remove else "--host", "--archive", spec[release+"_archive"],
        "--sha256", spec[release+"_sha256"], "--prefix", spec["prefix"],
        "--state-root", spec["state_root"], "--workspace", spec["workspace"]]
    if not remove:
        argv += ["--tier", spec["tier"], "--enable-workers"]
    return Step(release+("-uninstall" if remove else "-install"), argv, env=env)

def prepare(spec, runner=real_runner):
    checked_sequence(checksum_steps(spec), runner)
    # Existing descriptor-bound extraction refuses a preexisting stage and
    # unsafe/overlapping roots; no tar subprocess or stage clearing fallback.
    backend = spec.get("native_installer", str(Path(__file__).resolve().parent))
    checked_sequence([Step(release+"-extraction", [sys.executable, "-B", "-c",
        EXTRACT_PROGRAM, backend, spec[release+"_stage"], spec[release+"_archive"],
        spec[release+"_sha256"], spec["prefix"], spec["state_root"], spec["workspace"]])
        for release in ("candidate", "rollback")], runner)
    results = checked_sequence([verification_step(spec, "candidate"),
        verification_step(spec, "rollback"), preflight_step(spec, "candidate")], runner)
    plan_environment(results[-1])

def transition(spec, *, rollback=False, drained=False, runner=real_runner):
    require_drain(drained)
    remove, add = ("candidate", "rollback") if rollback else ("rollback", "candidate")
    checked_sequence(checksum_steps(spec), runner)
    results = checked_sequence([verification_step(spec, "candidate"),
        verification_step(spec, "rollback"), preflight_step(spec, add)], runner)
    env = plan_environment(results[-1])
    checked_sequence([verification_step(spec, remove, True), lifecycle_step(spec, remove, True, env),
        lifecycle_step(spec, add, False, env), verification_step(spec, add, True)], runner)
    # Reconnect is a separate owner call after this fully verified transition.

def reconnect(spec, *, release="candidate", role_control=False, runner=real_runner):
    checked_sequence(checksum_steps(spec), runner)
    results = checked_sequence([verification_step(spec, release, True),
        preflight_step(spec, release)], runner)
    env = plan_environment(results[-1])
    argv = [str(Path(spec["prefix"])/"toolsenabled-installer/toolsenabled"),
        "serve", "--state-root", spec["state_root"],
        "--tree-key", spec["tree_key"]]
    # Preserve an unbound root. An actor is supplied only when the caller's
    # existing registration explicitly uses that binding.
    if spec.get("actor"):
        argv += ["--actor", spec["actor"]]
    if role_control:
        argv.append("--enable-role-control")
    checked_sequence([Step(release+"-reconnect", argv, env=env)], runner)

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "install", "rollback", "reconnect"))
    for field in ("candidate-archive", "candidate-sha256", "rollback-archive",
            "rollback-sha256", "candidate-stage", "rollback-stage", "prefix",
            "state-root", "workspace", "codex", "node", "tree-key"):
        parser.add_argument("--"+field, required=True)
    parser.add_argument("--actor", default=None)
    parser.add_argument("--tier", choices=("unrestricted", "standard", "guided"), required=True)
    parser.add_argument("--drained", action="store_true")
    parser.add_argument("--release", choices=("candidate", "rollback"), default="candidate")
    parser.add_argument("--enable-role-control", action="store_true")
    args=parser.parse_args(argv); spec=vars(args)
    try:
        if args.phase == "prepare": prepare(spec)
        elif args.phase in ("install","rollback"):
            transition(spec, rollback=args.phase=="rollback", drained=args.drained)
        else: reconnect(spec, release=args.release, role_control=args.enable_role_control)
    except (HandoffFailure, OSError, subprocess.SubprocessError) as error:
        print("OWNER_HANDOFF_STOPPED: "+str(error), file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
