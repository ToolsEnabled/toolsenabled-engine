#!/usr/bin/env python3
"""Validate the saved Codex MCP launch without starting an AI agent."""
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time
import tomllib

codex_home = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex'))
assert codex_home.is_absolute(), 'CODEX_HOME must be absolute'
config = tomllib.loads((codex_home / 'config.toml').read_text())
matches = [value for name, value in config['mcp_servers'].items() if 'toolsenabled' in name.lower()]
assert len(matches) == 1, 'Expected one ToolsEnabled MCP registration'
server = matches[0]
environment = {**os.environ, **server.get('env', {})}
with tempfile.TemporaryFile(mode='w+t') as errors:
    process = subprocess.Popen([server['command'], *server.get('args', [])], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=errors, env=environment, text=True)
    def send(message):
        process.stdin.write(json.dumps(message) + '\n')
        process.stdin.flush()
    def receive(identity):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if not select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                break
            line = process.stdout.readline()
            if not line:
                break
            value = json.loads(line)
            if value.get('id') == identity:
                assert 'error' not in value, value.get('error')
                return value['result']
        errors.seek(0)
        raise RuntimeError('MCP response missing: ' + errors.read()[-1500:])
    try:
        send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2024-11-05', 'capabilities': {},
            'clientInfo': {'name': 'manual-install-check', 'version': '1'}}})
        initialized = receive(1)
        send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        send({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
        tools = receive(2)['tools']
        assert tools, 'MCP returned no tools'
        print('Saved Codex MCP launch passed:', initialized['serverInfo']['name'], '-', len(tools), 'tools')
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)
