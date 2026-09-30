"""Scratch loopback model simulator for the installed candidate's real CLIs."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.request

from core import SoakError, require, run_cli


def contract(marker: str, role: str = "WORKER") -> str:
    return "\n".join([
        "CONTRACT/1", f"role {role}", "target .",
        f"do [[{marker}]] Run this scratch simulator script and report its result.",
        "because K6 has zero completed scratch worker turns at the start of this probe",
        f"done the final reply contains SIM-RESULT {marker} PASS",
        "report reply",
    ])


class Simulator:
    def __init__(self, root: Path):
        self.root = root / "sim"
        self.scripts = self.root / "scripts"
        self.logs = self.root / "logs"
        self.flags = self.root / "flags"
        for directory in (self.scripts, self.logs, self.flags):
            directory.mkdir(parents=True)
        self.process = None
        self.port = None
        self._write_scripts()

    def _write_scripts(self) -> None:
        scripts = {
            "leaf": {"steps": [{"call": "openshell.status", "args": {}},
                               {"say": "K6 leaf answered openshell.status"}]},
            "depth2": {"steps": [{"call": "agent.spawn", "args": {
                "contract": contract("leaf"), "tier": "luna", "surface": "tree"}},
                {"say": "K6 depth2 started a leaf"}]},
            "depth1": {"steps": [{"call": "agent.spawn", "args": {
                "contract": contract("depth2", "MANAGER"), "tier": "luna", "surface": "tree"}},
                {"say": "K6 depth1 started depth2"}]},
        }
        for name, script in scripts.items():
            (self.scripts / f"{name}.json").write_text(json.dumps(script))

    def __enter__(self) -> "Simulator":
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        environment = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(self.root), "SIM_PORT": str(self.port), "SIM_BIND": "127.0.0.1",
            "SIM_SCRIPTS_DIR": str(self.scripts), "SIM_LOGS_DIR": str(self.logs),
            "SIM_FLAGS_DIR": str(self.flags),
        }
        server = Path(__file__).resolve().parents[3] / "handtest/sim/server.mjs"
        self.process = subprocess.Popen([shutil.which("node") or "/usr/local/bin/node", str(server)],
                                        env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        start_new_session=True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(50):
            if self.process.poll() is not None:
                break
            try:
                with opener.open(f"http://127.0.0.1:{self.port}/health", timeout=1) as response:
                    if response.status == 200:
                        return self
            except Exception:
                time.sleep(0.1)
        self.__exit__(None, None, None)
        raise SoakError("env", "SIM_START", "Scratch loopback simulator did not start")

    def configure(self, context) -> None:
        codex = shutil.which("codex")
        claude = shutil.which("claude")
        require(codex is not None and claude is not None, "SIM_CLIS", "Codex and Claude CLIs are required for K6", "env")
        codex_home = self.root / "codex"
        claude_home = self.root / "claude"
        codex_home.mkdir()
        claude_home.mkdir()
        (codex_home / "config.toml").write_text(
            'model = "gpt-5.6-luna"\nmodel_provider = "soak-sim"\n'
            '[model_providers.soak-sim]\nname = "Scratch soak simulator"\n'
            f'base_url = "http://127.0.0.1:{self.port}/v1"\n'
            'env_key = "OPENAI_API_KEY"\nwire_api = "responses"\n')
        cli_dirs = list(dict.fromkeys([str(Path(codex).parent), str(Path(claude).parent)]))
        context.env.update({
            "PATH": os.pathsep.join([context.env["PATH"], *cli_dirs]),
            "CODEX_HOME": str(codex_home), "CLAUDE_CONFIG_DIR": str(claude_home),
            "OPENAI_API_KEY": "sim", "ANTHROPIC_API_KEY": "sim",
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{self.port}",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        })
        setup = run_cli(context.prefix, context.env, "setup", "--workspace", str(context.root / "work"), "--agents")
        require(setup.returncode == 0, "SIM_SETUP", f"Simulator profile setup failed: {setup.stderr[-300:]}")
        # Imported here to keep scenario state in one module.
        from scenarios import _server_entry
        entry = _server_entry(context, context.env, True)
        context.server_env = {**context.env, **entry["env"], "TOOLSENABLED_AGENT_ACTOR": "codex"}

    def __exit__(self, *_: object) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
