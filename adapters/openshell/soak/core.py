"""Artifact and MCP primitives for the OpenShell candidate soak.

Every writable path is below a scratch directory created by this runner.  The
only shared outputs are the requested error stream and summary in the port
channel.  This module never starts an OpenShell gateway or reads a CLI login.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import pwd
import select
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
from dataclasses import dataclass
from typing import Any


ARCHIVE_NAME = "toolsenabled-openshell-linux-x64.tar.gz"
ERROR_CLASSES = frozenset({"product", "harness", "env", "noise"})


class SoakError(Exception):
    def __init__(self, category: str, code: str, message: str):
        if category not in ERROR_CLASSES:
            raise ValueError(f"Unknown soak error class: {category}")
        super().__init__(message)
        self.category = category
        self.code = code


def require(condition: bool, code: str, message: str, category: str = "product") -> None:
    if not condition:
        raise SoakError(category, code, message)


@dataclass(frozen=True)
class Candidate:
    name: str
    directory: Path
    archive: Path
    sha256: str
    commit: str


def discover_candidates(root: Path) -> list[Candidate]:
    found = []
    for directory in root.glob("candidate-*"):
        if not directory.is_dir():
            continue
        try:
            number = int(directory.name.removeprefix("candidate-"))
        except ValueError:
            continue
        archive = directory / ARCHIVE_NAME
        build = directory / "BUILD.json"
        sums = directory / "SHA256SUMS"
        if not all(p.is_file() for p in (archive, build, sums)):
            continue  # Coordinator may still be writing this candidate.
        metadata = json.loads(build.read_text())
        require(metadata.get("candidate") == directory.name, "CANDIDATE_ID", "BUILD.json candidate does not match its directory", "env")
        expected = metadata.get("sha256")
        require(isinstance(expected, str) and len(expected) == 64, "CANDIDATE_HASH", "BUILD.json has no sha256", "env")
        sums_line = sums.read_text().strip()
        require(sums_line == f"{expected}  {ARCHIVE_NAME}" or sums_line == f"{expected} *{ARCHIVE_NAME}",
                "CANDIDATE_SUMS", "SHA256SUMS does not match BUILD.json", "env")
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        require(actual == expected, "CANDIDATE_BYTES", f"{directory.name} archive checksum mismatch", "env")
        found.append((number, Candidate(directory.name, directory, archive, expected, metadata.get("hub_commit", ""))))
    return [candidate for _, candidate in sorted(found)]


def scratch_directory(prefix: str = "te-soak-") -> Path:
    # The host file tools use the OS account home, not caller-controlled HOME.
    owner_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    return Path(tempfile.mkdtemp(prefix=f".{prefix}", dir=owner_home))


def extract_candidate(candidate: Candidate, root: Path) -> Path:
    with tarfile.open(candidate.archive) as archive:
        members = archive.getmembers()
        require(bool(members), "ARCHIVE_EMPTY", "Candidate archive is empty")
        for member in members:
            parts = Path(member.name).parts
            require(parts and parts[0] == "toolsenabled-installer" and ".." not in parts,
                    "ARCHIVE_PATH", f"Unsafe archive path: {member.name}")
            require(member.isfile() or member.isdir() or member.issym(),
                    "ARCHIVE_TYPE", f"Unsupported archive member: {member.name}")
        # npm's .bin links legitimately use ../ within the archive. Python's
        # data filter checks where each link resolves instead of rejecting its
        # spelling alone.
        try:
            archive.extractall(root, filter="data")
        except tarfile.FilterError as error:
            raise SoakError("product", "ARCHIVE_LINK", f"Unsafe archive link: {error}") from error
    package = root / "toolsenabled-installer"
    manifest = json.loads((package / "manifest.json").read_text())
    require(manifest.get("source_commit") == candidate.commit,
            "ARCHIVE_COMMIT", "Archive manifest does not match BUILD.json")
    require((package / "payload/engine/bin/toolsenabled-openshell.js").is_file(),
            "ARCHIVE_ENGINE", "Archive has no OpenShell CLI")
    for forbidden in ("node_modules/npm", "node_modules/npx", "node_modules/@openai/codex",
                      "node_modules/@anthropic-ai/claude-code", "adapters/openshell/soak"):
        require(not (package / "payload/engine" / forbidden).exists(),
                "ARCHIVE_EXTRA", f"Archive contains test/toolchain path {forbidden}")
    return package


def minimal_path(root: Path, *, cli_names: tuple[str, ...] = ()) -> Path:
    """A PATH with the installer's requirements, no package managers or provider CLIs."""
    directory = root / "bin"
    directory.mkdir(parents=True, exist_ok=True)
    for name in ("bash", "dirname", "uname", "mkdir", "mktemp", "rm", "cp", "chmod", "mv", "ln", "cat", "rmdir", "node"):
        source = shutil.which(name)
        require(source is not None, "HOST_PROGRAM", f"Required test program {name} is missing", "env")
        (directory / name).symlink_to(source)
    for name in cli_names:
        require(name in ("codex", "claude"), "CLI_NAME", "Unexpected stand-in CLI", "harness")
        stand_in = directory / name
        stand_in.write_text("#!/bin/sh\nexit 0\n")
        stand_in.chmod(0o700)
    return directory


def scratch_env(root: Path, *, path_dir: Path | None = None, agents: bool = False) -> dict[str, str]:
    home = root / "home"
    state = root / "state"
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = {
        "HOME": str(home), "TOOLSENABLED_STATE_ROOT": str(state), "OPENSHELL_SANDBOX": "1",
        "PATH": str(path_dir or minimal_path(root)), "LANG": "C.UTF-8",
    }
    if agents:
        environment["TOOLSENABLED_OPENSHELL_AGENTS"] = "1"
    return environment


def install_candidate(package: Path, root: Path, environment: dict[str, str]) -> Path:
    prefix = root / "installed runtime"
    result = subprocess.run(["/bin/bash", str(package / "install.sh"), str(prefix)],
                            env=environment, text=True, capture_output=True, timeout=45)
    require(result.returncode == 0, "INSTALL_EXIT", f"Installer failed: {(result.stdout + result.stderr)[-500:]}")
    require((prefix / "bin/toolsenabled").is_file(), "INSTALL_WRAPPER", "Installed wrapper is missing")
    require(json.loads((prefix / "manifest.json").read_text()) == json.loads((package / "manifest.json").read_text()),
            "INSTALL_MANIFEST", "Installed manifest differs from the archive")
    return prefix


def run_cli(prefix: Path, environment: dict[str, str], *args: str, timeout: float = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(prefix / "bin/toolsenabled"), *args], env=environment,
                          text=True, capture_output=True, timeout=timeout)


class MCP:
    """One artifact stdio session, with strict per-request deadlines."""

    def __init__(self, prefix: Path, environment: dict[str, str], root: Path):
        script = prefix / "runtime/engine/src/mcp-server.js"
        self.process = None
        self.closed = False
        self.orphan_cleanup_required = False
        self.started_ticks = None
        self.spawn_floor = int(time.monotonic() * os.sysconf("SC_CLK_TCK"))
        self.stderr = (root / f"mcp-{time.monotonic_ns()}.stderr").open("w+")
        self.buffer = b""
        self.next_id = 0
        try:
            self.process = subprocess.Popen([shutil.which("node") or "/usr/local/bin/node", str(script)],
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
                                            env=environment, start_new_session=True)
            identity = self._process_identity(self.process.pid)
            self.started_ticks = identity[0] if identity is not None else None
            self.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                         "clientInfo": {"name": "openshell-soak", "version": "1"}})
            self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except BaseException:
            self.close()
            raise

    @property
    def pid(self) -> int:
        return self.process.pid

    def send(self, value: dict[str, Any]) -> None:
        require(self.process.poll() is None, "MCP_DIED", "MCP server exited before a request")
        self.process.stdin.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
        self.process.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        self.next_id += 1
        identity = self.next_id
        self.send({"jsonrpc": "2.0", "id": identity, "method": method, "params": params or {}})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\n" not in self.buffer:
                if not select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                    break
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    break
                self.buffer += chunk
                require(len(self.buffer) < 8 * 1024 * 1024, "MCP_OUTPUT", "MCP response exceeded 8 MiB")
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if not line:
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise SoakError("product", "MCP_JSON", f"MCP wrote invalid JSON: {error}") from error
                if value.get("id") == identity:
                    return value
        self.stderr.flush()
        self.stderr.seek(0)
        detail = self.stderr.read()[-500:]
        raise SoakError("product", "MCP_TIMEOUT", f"No {method} response; server={self.process.poll()} {detail}")

    def tools(self) -> dict[str, dict[str, Any]]:
        reply = self.request("tools/list")
        require("error" not in reply, "MCP_TOOLS", f"tools/list refused: {reply.get('error')}")
        return {tool["name"]: tool for tool in reply["result"]["tools"]}

    def call(self, name: str, arguments: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
        reply = self.request("tools/call", {"name": name, "arguments": arguments}, timeout=timeout)
        require("result" in reply or "error" in reply, "MCP_CALL_SHAPE", f"{name} returned no result/error")
        return reply

    @staticmethod
    def _process_identity(pid: int) -> tuple[int, int, int] | None:
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return None if fields[0] == "Z" else (int(fields[19]), int(fields[2]), int(fields[3]))
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError):
            return None

    def _owned_group(self) -> dict[int, tuple[int, int, int]]:
        if self.process is None:
            return {}
        leader = self._process_identity(self.process.pid)
        if leader is not None and self.started_ticks is not None and leader[0] != self.started_ticks:
            return {}  # The leader PID was reused; never signal its new tree.
        members = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            identity = self._process_identity(pid)
            # start_new_session binds both the session and process group to
            # our child's PID. Only those members, born after our spawn, count.
            if identity is not None and identity[1:] == (self.process.pid, self.process.pid) and identity[0] >= self.spawn_floor:
                members[pid] = identity
        return members

    def _close_group(self) -> None:
        # The leader can exit cleanly before its children. Reap the exact
        # remaining members even on that path; guard every signal against reuse.
        members = self._owned_group()
        children = {pid: identity for pid, identity in members.items() if pid != self.process.pid}
        deadline = time.monotonic() + 0.25
        while time.monotonic() < deadline and any(self._process_identity(pid) == identity for pid, identity in children.items()):
            time.sleep(0.025)
        self.orphan_cleanup_required = self.orphan_cleanup_required or any(
            self._process_identity(pid) == identity for pid, identity in children.items())
        for sig in (signal.SIGTERM, signal.SIGKILL):
            self._signal_members(members, sig)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and any(self._process_identity(pid) == identity for pid, identity in members.items()):
                time.sleep(0.05)
            if not any(self._process_identity(pid) == identity for pid, identity in members.items()):
                return
        require(not any(self._process_identity(pid) == identity for pid, identity in members.items()),
                "MCP_CLEANUP", "An owned MCP process-group member survived cleanup")

    def _signal_members(self, members: dict[int, tuple[int, int, int]], sig: int) -> None:
        for pid, identity in members.items():
            if self._process_identity(pid) == identity:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            if self.process is not None and self.process.poll() is None:
                try:
                    self.process.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        # Group termination may remove every remaining child
                        # before _close_group can observe it. Preserve that
                        # evidence using the same ownership/start-time checks.
                        members = self._owned_group()
                        self.orphan_cleanup_required = self.orphan_cleanup_required or any(
                            pid != self.process.pid for pid in members)
                        try:
                            os.killpg(self.process.pid, sig)
                        except ProcessLookupError:
                            pass
                        except PermissionError:
                            # OpenShell may deny group signaling while allowing
                            # signals to our children. Reuse the exact owned
                            # snapshot; never target a PID that changed identity.
                            self._signal_members(members, sig)
                        try:
                            self.process.wait(timeout=3)
                            break
                        except subprocess.TimeoutExpired:
                            if sig == signal.SIGKILL:
                                raise
        finally:
            try:
                self._close_group()
            finally:
                streams = (self.process.stdin, self.process.stdout) if self.process is not None else ()
                for stream in (*streams, self.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except (BrokenPipeError, OSError):
                            pass

    def __enter__(self) -> "MCP":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def tool_value(reply: dict[str, Any]) -> dict[str, Any]:
    require("error" not in reply, "MCP_PROTOCOL_ERROR", str(reply.get("error")))
    result = reply.get("result") or {}
    value = result.get("structuredContent")
    if isinstance(value, dict):
        return value
    for block in result.get("content", []):
        if block.get("type") == "text":
            try:
                value = json.loads(block["text"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(value, dict):
                return value
    return result


def tool_ok(reply: dict[str, Any], name: str) -> dict[str, Any]:
    require("error" not in reply and not reply.get("result", {}).get("isError"),
            "TOOL_REFUSED", f"{name}: {tool_value(reply)}")
    return tool_value(reply)
