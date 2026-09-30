"""One candidate's bounded workload, live MCP process and scratch state lifetime.

K1–K8 deliberately create fresh installations and restart processes. This
separate installation survives those scenarios so K9 can observe accumulation.
"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import statistics
import subprocess
import time
from typing import Any

from core import (Candidate, MCP, SoakError, extract_candidate, install_candidate,
                  minimal_path, require, run_cli, scratch_directory, scratch_env, tool_ok)


LIMITS = {"rssBytes": (1.8, 30 * 1024 * 1024), "openFiles": (1.5, 20),
          "children": (1.0, 2), "stateBytes": (1.8, 10 * 1024 * 1024),
          "latencyP95Ms": (3.0, 100)}


def candidate_identity(candidate: Candidate) -> tuple[str, str]:
    return candidate.name, candidate.sha256


def process_start(pid: int) -> str | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except (FileNotFoundError, IndexError):
        return None


def descendants(pid: int) -> set[int]:
    found: set[int] = set()
    pending = [pid]
    while pending:
        current = pending.pop()
        try:
            children = Path(f"/proc/{current}/task/{current}/children").read_text().split()
        except FileNotFoundError:
            continue
        for child in children:
            value = int(child)
            if value not in found:
                found.add(value)
                pending.append(value)
    return found


def resources(mcp: MCP, state_roots: list[Path], latencies: list[float]) -> dict[str, float]:
    rss_pages = int(Path(f"/proc/{mcp.pid}/statm").read_text().split()[1])
    state_bytes = 0
    for root in state_roots:
        for item in root.rglob("*"):
            try:
                if item.is_file() and not item.is_symlink():
                    state_bytes += item.stat().st_size
            except FileNotFoundError:
                continue  # Atomic replacement of a scratch settings/state file.
    return {"rssBytes": float(rss_pages * os.sysconf("SC_PAGE_SIZE")),
            "openFiles": float(len(list(Path(f"/proc/{mcp.pid}/fd").iterdir()))),
            "children": float(len(descendants(mcp.pid))), "stateBytes": float(state_bytes),
            "latencyP95Ms": sorted(latencies)[int(0.95 * (len(latencies) - 1))]}


class LeakWatch:
    def __init__(self, candidate: Candidate, *, installed: tuple[Path, dict[str, str], Path] | None = None):
        self.candidate = candidate
        self.identity = candidate_identity(candidate)
        self.root: Path | None = installed[2] if installed else None
        self.prefix: Path | None = installed[0] if installed else None
        self.environment = dict(installed[1]) if installed else {}
        self.services_root: Path | None = None
        self.owns_root = installed is None
        self.mcp: MCP | None = None
        self.pid_start: str | None = None
        self.started_at: str | None = None
        self.started_clock: float | None = None
        self.closed = False
        self.start_failure: Exception | None = None
        self.revision = 0
        self.value: dict[str, bool] | None = None
        self.file_value = "alpha\n"
        self.sample_count = 0
        self.baseline: list[dict[str, float]] = []
        self.recent: deque[dict[str, float]] = deque(maxlen=3)
        self.latest: dict[str, Any] | None = None
        self.tracked_children: dict[int, str] = {}

    def _install(self) -> None:
        # Verify the exact bytes again immediately before creating the watched
        # installation. Candidate names alone do not establish identity.
        require(hashlib.sha256(self.candidate.archive.read_bytes()).hexdigest() == self.candidate.sha256,
                "CANDIDATE_BYTES", "K9 candidate archive checksum changed", "env")
        package = extract_candidate(self.candidate, self.root)
        environment = scratch_env(self.root, path_dir=minimal_path(self.root))
        self.prefix = install_candidate(package, self.root, environment)
        result = run_cli(self.prefix, environment, "setup", "--tier", "unrestricted",
                         "--workspace", str(self.root / "work"), "--agents")
        require(result.returncode == 0, "LEAK_SETUP", f"K9 setup failed: {result.stderr[-400:]}")
        script = (
            "const m=require('./src/lib/setup/machine-record');"
            "const c=require('./bin/toolsenabled-openshell');"
            "const r=m.readMachineRecord({servicesRoot:m.resolveServicesRoot({})});"
            "process.stdout.write(JSON.stringify({entry:c.serverEntry(r,{agents:true}),servicesRoot:r.servicesRoot}));"
        )
        entry = subprocess.run([shutil.which("node") or "/usr/local/bin/node", "-e", script],
                               cwd=self.prefix / "runtime/engine", env=environment,
                               text=True, capture_output=True, timeout=30)
        require(entry.returncode == 0, "LEAK_SETUP_ENTRY", f"K9 server entry failed: {entry.stderr[-400:]}")
        configured = json.loads(entry.stdout)
        self.services_root = Path(configured["servicesRoot"])
        self.environment = {**environment, **configured["entry"]["env"], "TOOLSENABLED_AGENT_ACTOR": "codex"}
        require(self.environment["TOOLSENABLED_STATE_ROOT"] == environment["TOOLSENABLED_STATE_ROOT"],
                "LEAK_STATE_ROOT", "K9 server entry changed the scratch state root")

    def _start(self) -> None:
        if self.start_failure is not None:
            raise self.start_failure
        require(not self.closed, "LEAK_WATCH_CLOSED", "K9 watcher was already closed", "harness")
        if self.mcp is not None:
            return
        try:
            if self.owns_root:
                self.root = scratch_directory("te-soak-leaks-")
                self._install()
            self.mcp = MCP(self.prefix, self.environment, self.root)
            self.pid_start = process_start(self.mcp.pid)
            self._assert_alive()
            self.started_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            self.started_clock = time.monotonic()
            # This workload keeps one bounded memory row. With audit off its
            # durable size should plateau; append-only audit history would be
            # legitimate growth and needs a different workload/budget.
            settings = tool_ok(self.mcp.call("settings.read", {"ids": ["audit.enabled"]}), "settings.read")
            require(settings.get("values", {}).get("audit.enabled") is False, "LEAK_AUDIT_MODE",
                    "K9 bounded-state workload requires the scratch default audit.enabled=false", "harness")
            work = self.root / "work"
            work.mkdir(exist_ok=True)
            (work / "k9-receipt-probe.txt").write_text(self.file_value)
        except Exception as error:
            self.start_failure = error
            self.close()
            raise

    def _assert_alive(self) -> None:
        require(self.mcp is not None and self.mcp.process.poll() is None and self.pid_start is not None
                and process_start(self.mcp.pid) == self.pid_start,
                "LEAK_PROCESS_DIED", "K9 persistent MCP process exited or changed identity; its baseline cannot be reused")

    def _state_roots(self) -> list[Path]:
        roots = [Path(self.environment[key]).resolve() for key in
                 ("HOME", "TOOLSENABLED_STATE_ROOT", "XDG_DATA_HOME", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR")
                 if self.environment.get(key)]
        roots += [self.root / "work"]
        if self.services_root is not None:
            roots.append(self.services_root.resolve())
        selected: list[Path] = []
        for root in sorted(set(roots), key=lambda item: len(item.parts)):
            require(root.is_relative_to(self.root.resolve()), "LEAK_STATE_OUTSIDE_SCRATCH",
                    "K9 writable profile or services root is outside its scratch directory", "harness")
            if not any(root.is_relative_to(parent) for parent in selected):
                selected.append(root)
        return selected

    def _track_children(self) -> None:
        self.tracked_children = {pid: start for pid, start in self.tracked_children.items()
                                 if process_start(pid) == start}
        for pid in descendants(self.mcp.pid):
            start = process_start(pid)
            if start is not None:
                self.tracked_children[pid] = start

    def sample(self) -> dict[str, Any]:
        self._start()
        self._assert_alive()
        selector = {"namespace": "soak-leaks", "key": "continuity"}
        if self.revision:
            before = tool_ok(self.mcp.call("memory.get", selector), "memory.get")
            require(before.get("revision") == self.revision and before.get("value") == self.value,
                    "LEAK_STATE_CHANGED", "K9 scratch memory changed or disappeared between iterations")
        # Alternate a fixed-size value rather than adding rows or task history.
        value = {"odd": self.revision % 2 == 0}
        saved = tool_ok(self.mcp.call("memory.set", {**selector, "value": value,
                                                    "expectedRevision": self.revision}), "memory.set")
        require(saved.get("revision") == self.revision + 1, "LEAK_MEMORY_REVISION",
                "K9 memory mutation did not advance its revision")
        self.revision += 1
        self.value = value
        after = tool_ok(self.mcp.call("memory.get", selector), "memory.get")
        require(after.get("revision") == self.revision and after.get("value") == value,
                "LEAK_MEMORY_READ", "K9 memory read disagreed with its write")
        file = self.root / "work/k9-receipt-probe.txt"
        observed = tool_ok(self.mcp.call("host.read_file", {"path": str(file)}), "host.read_file")
        require(observed.get("content") == self.file_value, "LEAK_FILE_CHANGED",
                "K9 scratch file changed between iterations")
        replacement = "bravo\n" if self.file_value == "alpha\n" else "alpha\n"
        tool_ok(self.mcp.call("host.patch_file", {"path": str(file), "oldText": self.file_value,
                                                 "newText": replacement}), "host.patch_file")
        self.file_value = replacement
        checked = tool_ok(self.mcp.call("host.read_file", {"path": str(file)}), "host.read_file")
        require(checked.get("content") == replacement and file.read_text() == replacement,
                "LEAK_FILE_WRITE", "K9 mediated file edit disagreed with the stored bytes")
        latencies = []
        for _ in range(10):
            for name, arguments in (("ledger.read", {"limit": 1}), ("task.list", {"limit": 1})):
                started = time.monotonic()
                tool_ok(self.mcp.call(name, arguments), name)
                latencies.append((time.monotonic() - started) * 1000)
        # Retain enumeration traffic too, but use real tool calls for p95.
        self.mcp.tools()
        self._assert_alive()
        try:
            metrics = resources(self.mcp, self._state_roots(), latencies)
        except OSError as error:
            self._assert_alive()
            raise SoakError("env", "LEAK_METRICS", f"K9 process/state metrics unavailable: {type(error).__name__}") from error
        self._assert_alive()
        self._track_children()
        self.sample_count += 1
        if len(self.baseline) < 3:
            self.baseline.append(metrics)
        self.recent.append(metrics)
        self.latest = {**metrics, "candidateSha256": self.candidate.sha256, "pid": self.mcp.pid,
                       "pidStartTicks": self.pid_start, "seriesStartedAt": self.started_at,
                       "seriesAgeSeconds": round(time.monotonic() - self.started_clock, 3),
                       "sampleCount": self.sample_count, "trendReady": self.sample_count >= 6,
                       "auditEnabled": False}
        if self.sample_count >= 6:
            for key, (ratio, slack) in LIMITS.items():
                old = statistics.median(row[key] for row in self.baseline)
                now = statistics.median(row[key] for row in self.recent)
                require(now <= old * ratio + slack, "LEAK_GROWTH",
                        f"{key} grew from {old:.0f} to {now:.0f} in one persistent candidate process/state")
        return self.latest

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        leftover = False
        try:
            if self.mcp is not None:
                if self.mcp.process.poll() is None:
                    self._track_children()
                self.mcp.close()
                leftover = bool(getattr(self.mcp, "orphan_cleanup_required", False))
                # Remember only this process's observed descendants, guarded
                # against PID reuse. Never inspect or terminate other trees.
                alive = lambda: [pid for pid, start in self.tracked_children.items() if process_start(pid) == start]
                deadline = time.monotonic() + 2
                while alive() and time.monotonic() < deadline:
                    time.sleep(0.05)
                remaining = alive()
                leftover = leftover or bool(remaining)
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    for pid in alive():
                        try:
                            os.kill(pid, sig)
                        except ProcessLookupError:
                            pass
                    deadline = time.monotonic() + 2
                    while alive() and time.monotonic() < deadline:
                        time.sleep(0.05)
                    if not alive():
                        break
        finally:
            if self.owns_root and self.root is not None:
                shutil.rmtree(self.root)
        require(not leftover, "LEAK_ORPHAN", "K9 MCP left descendant processes after closing; emergency cleanup was required")
