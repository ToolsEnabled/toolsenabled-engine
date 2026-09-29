#!/usr/bin/env python3
"""Prepare a local Ubuntu OpenShell shell; leave ToolsEnabled for manual install."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request

RELEASE = 'https://github.com/ToolsEnabled/toolsenabled-engine/releases/download/openshell-preview-20260929'
RUNTIME = 'toolsenabled-openshell-linux-x64.tar.gz'
RUNTIME_SHA256 = 'b7b5bace9ff4c2aa07db3ddd2c9f7de9aba1a5ab2e4a8896eb81e6a136cf5683'
POLICY_SHA256 = 'c41b8f5504c3889e1cbe3de6ed30b9507e2be1d14e2adaa5a532917c6c9c2749'
PREREQUISITE_IMAGE = 'toolsenabled-install-prerequisites:20260929'
DOCKERFILE = '''FROM nvcr.io/nvidia/base/ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl ca-certificates && rm -rf /var/lib/apt/lists/*
'''

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('sandbox', nargs='?', default='clean-shell')
parser.add_argument('--docker-host', default='unix:///var/run/docker.sock')
parser.add_argument('--assets-dir', type=Path, help='Use already downloaded release assets')
args = parser.parse_args()
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,18}', args.sandbox):
    parser.error('Use a sandbox name with at most 19 lowercase letters, digits, or hyphens.')
docker = ['docker', '--host', args.docker_host]

def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, capture_output=True, **kwargs)

def exists(container, path):
    probe = subprocess.run([*docker, 'exec', container, '/bin/sh', '-c',
                            'test -e "$1" || test -L "$1"', 'probe', path])
    if probe.returncode not in (0, 1):
        raise RuntimeError('Could not check the sandbox filesystem.')
    return probe.returncode == 0

def acquire(name, destination):
    if args.assets_dir:
        shutil.copyfile(args.assets_dir / name, destination)
    else:
        print('Downloading', name, flush=True)
        with urllib.request.urlopen(RELEASE + '/' + name, timeout=60) as response:
            with destination.open('wb') as output:
                shutil.copyfileobj(response, output)

def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def main():
    description = run(['openshell', 'sandbox', 'get', args.sandbox]).stdout
    identity = re.search(r'^\s*Id:\s*([0-9a-f-]{36})\s*$', description, re.MULTILINE)
    if identity is None:
        raise RuntimeError('Could not identify the requested OpenShell sandbox.')
    target = 'openshell-default--' + args.sandbox + '-' + identity.group(1)
    if target not in run([*docker, 'ps', '--format', '{{.Names}}']).stdout.splitlines():
        raise RuntimeError('The sandbox is not running in the selected local Docker gateway.')
    metadata = json.loads(run([*docker, 'inspect', target]).stdout)[0]
    if metadata['HostConfig']['ReadonlyRootfs']:
        raise RuntimeError('This sandbox needs an image with Python prerequisites instead.')
    operating_system = run([*docker, 'exec', target, '/bin/cat', '/etc/os-release']).stdout
    architecture = run([*docker, 'exec', target, '/bin/uname', '-m']).stdout.strip()
    if not re.search(r'^ID=ubuntu$', operating_system, re.MULTILINE) or not re.search(r'^VERSION_ID="24\.04"$', operating_system, re.MULTILINE) or architecture != 'x86_64':
        raise RuntimeError('This preview supports Ubuntu 24.04 on Linux x86_64.')
    if exists(target, '/sandbox/.local/toolsenabled'):
        raise RuntimeError('ToolsEnabled is already installed in this shell; nothing was changed.')
    python_present = exists(target, '/usr/bin/python3')
    if not python_present and any(exists(target, path) for path in ['/usr/bin/python3.12', '/usr/lib/python3.12']):
        raise RuntimeError('A partial Python installation exists; nothing was changed.')
    if not re.search(r'Policy:\s+version: 1\s+filesystem_policy:', description):
        raise RuntimeError('Could not read the sandbox policy; nothing was changed.')
    if 'network_policies:' in description:
        raise RuntimeError('This helper is for a minimal shell with no network policy. Preserve and merge your existing policy manually.')

    with tempfile.TemporaryDirectory(prefix='toolsenabled-prepare-') as temporary:
        folder = Path(temporary)
        runtime = folder / RUNTIME
        policy = folder / 'network-policy.yaml'
        acquire(RUNTIME, runtime)
        if digest_file(runtime) != RUNTIME_SHA256:
            raise RuntimeError('Runtime checksum did not match; nothing was changed.')
        acquire('network-policy.yaml', policy)
        if hashlib.sha256(policy.read_bytes()).hexdigest() != POLICY_SHA256:
            raise RuntimeError('Policy checksum did not match; nothing was changed.')
        if not python_present:
            print('Building Python prerequisites from Ubuntu packages (ToolsEnabled is excluded)…', flush=True)
            subprocess.run([*docker, 'build', '--tag', PREREQUISITE_IMAGE, '--file', '-', str(folder)],
                           input=DOCKERFILE, text=True, check=True)
            source = run([*docker, 'create', PREREQUISITE_IMAGE, '/bin/true']).stdout.strip()
            try:
                staged = []
                paths = ['/usr/bin/python3.12', '/usr/lib/python3.12', '/usr/lib/x86_64-linux-gnu/libexpat.so.1']
                for origin in paths:
                    if origin.endswith('libexpat.so.1') and exists(target, origin):
                        continue
                    local = folder / 'python' / origin.lstrip('/')
                    local.parent.mkdir(parents=True, exist_ok=True)
                    run([*docker, 'cp', '-L', source + ':' + origin, str(local)])
                    staged.append((local, origin))
                for local, destination in staged:
                    run([*docker, 'cp', str(local), target + ':' + destination])
                run([*docker, 'exec', '--user', '0', target, '/bin/ln', '-s', 'python3.12', '/usr/bin/python3'])
            finally:
                run([*docker, 'rm', source])
        version = run(['openshell', 'sandbox', 'exec', '--name', args.sandbox, '--no-login-shell', '--no-tty', '--timeout', '10', '--',
                       '/usr/bin/python3', '-I', '-S', '-B', '-c',
                       'import ctypes, os, signal, socket, subprocess, sys; print(sys.version.split()[0])']).stdout.strip()
        print('Python prerequisite verified:', version, flush=True)
        print('Applying installation and provider network endpoints; filesystem permissions stay at the default.', flush=True)
        subprocess.run(['openshell', 'policy', 'set', args.sandbox, '--policy', str(policy), '--wait'], check=True)
        subprocess.run(['openshell', 'sandbox', 'upload', args.sandbox, str(runtime), '/sandbox/toolsenabled-installer.tar.gz'], check=True)
    print('Ready. ToolsEnabled is still uninstalled. Run these yourself inside the shell:')
    print('cd /sandbox\ntar -xzf toolsenabled-installer.tar.gz\nbash toolsenabled-installer/install.sh\nsource ~/.local/toolsenabled/env.sh\ntoolsenabled setup --agents --providers codex,claude --add')

if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        message = getattr(error, 'stderr', None) or str(error)
        parser.exit(1, message.strip() + '\n')
