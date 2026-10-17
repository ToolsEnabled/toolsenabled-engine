#!/usr/bin/env python3
"""Exercise a pinned beta 3 install upgraded to a pinned Fleet build.

Run only through the isolated test launcher in a fresh disposable non-root
OpenShell account. The account home must not already have a work directory.
Successful and failed runs retain their scratch and account state for review.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fleet_install_gate', HERE / 'test-install.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def main():
    environment = os.environ
    account_home = gate.require_dedicated_scope(environment)
    names = ('TOOLSENABLED_BETA3_ARCHIVE', 'TOOLSENABLED_BETA3_SHA256',
             'TOOLSENABLED_BETA4_ARCHIVE', 'TOOLSENABLED_BETA4_SHA256')
    gate.require(all(environment.get(name) for name in names), 'Both archive paths and independent SHA-256 pins are required')
    previous = Path(environment[names[0]]).resolve(strict=True)
    previous_pin = environment[names[1]]
    candidate = Path(environment[names[2]]).resolve(strict=True)
    candidate_pin = environment[names[3]]
    baseline = gate.inspect_release(previous, previous_pin)
    target = gate.inspect_release(candidate, candidate_pin)
    gate.require(baseline['version'] == gate.BETA3_VERSION and target['version'] == gate.CURRENT_VERSION
                 and target['source_commit'] != baseline['source_commit'],
                 'Expected published beta 3 and a distinct Fleet 1.8.0 version/source')
    node = gate.shutil.which('node')
    gate.require(node is not None, 'Node is required for the isolated archive gate')
    root = Path(tempfile.mkdtemp(prefix='toolsenabled-beta3-to-beta4-', dir='/tmp'))
    report = {'beta3Archive': str(previous), 'beta3Sha256': previous_pin,
              'targetArchive': str(candidate), 'targetSha256': candidate_pin,
              'beta3Source': baseline['source_commit'], 'targetSource': target['source_commit'],
              'uid': os.getuid(), 'accountHome': str(account_home), 'scratch': str(root), 'passed': False}
    try:
        package = gate.extract_beta3(previous, root, baseline)
        staged_before = gate.snapshot([package])
        env = gate.beta3_environment(root, node)
        prefix = root / "Fleet 'quoted' $runtime"
        cli = prefix / 'bin/toolsenabled'
        setup = ['/bin/bash', str(package / 'install.sh'), '--setup', str(prefix),
                 '--archive', str(previous), '--sha256', previous_pin,
                 '--tier', 'guided', '--providers', 'codex,claude']
        gate.require('COMMITTED' in gate.beta3_command(setup, env), 'Beta 3 setup did not commit')
        gate.require(f"ToolsEnabled Fleet {baseline['version']} ({baseline['source_commit']})"
                     in gate.beta3_command([cli, '--version'], env), 'Beta 3 install identity differs')
        state = root / 'state'
        state.mkdir(exist_ok=True)
        (state / 'keep.txt').write_text('beta 3 data survives Fleet upgrade\n')
        protected = [state, root / 'services', root / 'codex', root / 'claude', account_home / 'work']
        before = gate.snapshot(protected)
        calls = (root / 'provider-calls.jsonl').read_bytes()
        previous_inode = prefix.stat().st_ino
        # The new runtime's independently pinned beta 3 inventory must suffice;
        # the release host command cannot supply a previous-archive pair.
        upgrade = [cli, 'upgrade', '--archive', str(candidate), '--sha256', candidate_pin]
        gate.require('COMMITTED' in gate.beta3_command(upgrade, env)
                     and prefix.stat().st_ino != previous_inode, 'Upgrade did not replace the runtime generation')
        after = gate.snapshot(protected)
        gate.require_one_new_fleet_record(before, after, state)
        gate.require(gate.without_fleet_authority(after, state)
                     == gate.without_fleet_authority(before, state),
                     'Upgrade changed user state, profiles or workspace')
        gate.require((root / 'provider-calls.jsonl').read_bytes() == calls,
                     'Runtime-only upgrade invoked a provider')
        gate.require(f"ToolsEnabled Fleet {target['version']} ({target['source_commit']})"
                     in gate.beta3_command([cli, '--version'], env), 'Upgraded runtime identity differs')
        status = gate.beta3_command([cli, 'status'], env)
        gate.require(gate.guided_setup_status(status, account_home / 'work'),
                     'Guided permission level or working folder changed on upgrade')
        # Upgrade deliberately preserves the beta 3 CLI registration. Exercise
        # that exact saved command and allowlist against the new runtime.
        saved = json.loads((root / 'claude' / '.claude.json').read_text())
        server_env = {**env, **saved.get('env', {})}
        requests = ''.join(json.dumps(message) + '\n' for message in (
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
             'params': {'protocolVersion': '2025-06-18', 'capabilities': {},
                        'clientInfo': {'name': 'upgrade-gate', 'version': '1'}}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}}))
        listed = subprocess.run([saved['command'], *saved['args']], input=requests,
                                text=True, capture_output=True, timeout=30,
                                env=server_env, cwd=account_home / 'work', check=False)
        gate.require(listed.returncode == 0, 'Upgraded MCP server did not answer tools/list')
        replies = [json.loads(line) for line in listed.stdout.splitlines() if line.startswith('{')]
        tools = next((reply.get('result', {}).get('tools', []) for reply in replies if reply.get('id') == 2), [])
        gate.require('agent.spawn' in {tool['name'] for tool in tools}
                     and 'agent.wait' in {tool['name'] for tool in tools},
                     'Retained beta 3 registration does not advertise agent.spawn and agent.wait after upgrade')
        engine = prefix / 'runtime/engine'
        for retired in ('src/lib/providers/pay.js', 'src/lib/providers/deployment.js',
                        'src/lib/providers/research.js', 'src/lib/mission-bridge.js'):
            gate.require(not os.path.lexists(engine / retired), f'Retired module survived upgrade: {retired}')
        gate.require(gate.snapshot([package]) == staged_before
                     and gate.sha256_file(previous) == previous_pin
                     and gate.sha256_file(candidate) == candidate_pin,
                     'A pinned archive or extracted beta 3 package changed')
        retained_before = gate.snapshot([state, root / 'services', account_home / 'work'])
        gate.beta3_command([cli, 'uninstall', '--keep-state', '--archive', str(candidate), '--sha256', candidate_pin], env)
        gate.require(not os.path.lexists(prefix)
                     and gate.snapshot([state, root / 'services', account_home / 'work']) == retained_before,
                     'Uninstall failed to retain state or remove the runtime')
        report['passed'] = True
        print('PASS exact beta3 setup -> Fleet upgrade -> status -> keep-state uninstall', flush=True)
    finally:
        (root / 'beta3-to-beta4-report.json').write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        print('BETA3_TO_BETA4 ' + json.dumps(report, sort_keys=True), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (gate.GateError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
