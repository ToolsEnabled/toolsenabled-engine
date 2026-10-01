#!/usr/bin/env python3
"""Offline release renderer. Reads pinned archive/source; performs no network I/O.

Produces fleet-fetch.py, host-command.txt and render-receipt.json in a NEW
directory. The publisher reviews those exact bytes/pins and publishes the
helper separately from the archive. No claim of host or artifact qualification.
"""
import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import tarfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fleet_fetch_template', HERE / 'fleet_fetch.py')
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)

# Exact foundation interface, reviewed with the bootstrap source. Never strip
# arbitrary imports or accept a changed interface by pattern matching.
BOOTSTRAP_IMPORT = 'from fleet_fs import VerifiedArchive, SafeDirectory, create_stage, extract_archive, verify_tree, remove_tree, capabilities, FleetFSError\n'


def compose_bootstrap(fs_source, bootstrap_source):
    if not BOOTSTRAP_IMPORT or bootstrap_source.count(BOOTSTRAP_IMPORT) != 1:
        raise ValueError('Reviewed bootstrap import contract is unavailable or changed')
    for node in ast.walk(ast.parse(fs_source)):
        if isinstance(node, ast.If) and isinstance(node.test, ast.Compare) and '__name__' in ast.unparse(node.test):
            raise ValueError('Filesystem foundation has an executable module entry point')
    combined = fs_source + '\n' + bootstrap_source.replace(BOOTSTRAP_IMPORT, '', 1)
    if len(combined.encode()) > 80000:
        raise ValueError('Printed bootstrap exceeds the reviewed command-size bound')
    compile(combined, '<reviewed-sandbox-bootstrap>', 'exec')
    return combined


def host_bootstrap_source(template, url, helper_hash, ceiling):
    start = '# BEGIN BOOTSTRAP CORE\n'
    end = '# END BOOTSTRAP CORE\n'
    if template.count(start) != 1 or template.count(end) != 1:
        raise ValueError('Host transport source markers changed')
    core = template.split(start, 1)[1].split(end, 1)[0]
    parsers = [node for node in ast.parse(template).body if isinstance(node, ast.FunctionDef) and node.name == 'parse_arguments']
    if len(parsers) != 1:
        raise ValueError('Host option parser contract changed')
    core += '\nimport re\nimport unicodedata\n' + ast.get_source_segment(template, parsers[0]) + '\n'
    # The downloaded, pinned helper executes from an already verified open
    # descriptor. Its private download file/directory are removed before exec;
    # no downloaded stream, shell fragment or adjacent checksum is executed.
    final = '''
import shutil
os.umask(0o077)
stage = None
try:
    parse_arguments(list(sys.argv[1:]))
    require_pidfds()
    curl = shutil.which('curl')
    if not curl:
        raise FetchError('PREFLIGHT', 'curl is required')
    stage = Path(tempfile.mkdtemp(prefix='fleet-bootstrap-', dir='/tmp'))
    os.chmod(stage, 0o700)
    helper = stage / 'fleet-fetch.py'
    env = {'PATH': os.environ.get('PATH', ''), 'LANG': 'C', 'LC_ALL': 'C'}
    download(HELPER_URL, helper, HELPER_LIMIT, curl, env, str(stage))
    fd = os.open(helper, os.O_RDONLY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_size > HELPER_LIMIT:
        raise FetchError('INTEGRITY', 'Downloaded helper identity is invalid')
    content = bytearray()
    while True:
        piece = os.read(fd, 65536)
        if not piece:
            break
        content.extend(piece)
        if len(content) > HELPER_LIMIT:
            raise FetchError('INTEGRITY', 'Downloaded helper exceeds byte ceiling')
    if hashlib.sha256(content).hexdigest() != HELPER_SHA256:
        raise FetchError('INTEGRITY', 'Downloaded helper differs from the trusted bootstrap pin')
    cancellation_checkpoint()
    current = os.lstat(helper)
    if set(os.listdir(stage)) != {'fleet-fetch.py'} or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
        raise FetchError('INTEGRITY', 'Private helper download changed')
    os.lseek(fd, 0, os.SEEK_SET)
    os.unlink(helper)
    os.rmdir(stage)
    stage = None
    os.set_inheritable(fd, True)
    cancellation_checkpoint()
    os.execve(sys.executable, [sys.executable, '-I', '/proc/self/fd/' + str(fd), *sys.argv[1:]], dict(os.environ))
except FetchError as error:
    print(error.phase + ': ' + escaped(error), file=sys.stderr)
    if stage is not None:
        print('Owned local evidence retained at ' + escaped(stage), file=sys.stderr)
    sys.exit(1)
except BaseException as error:
    print('BOOTSTRAP: ' + escaped(type(error).__name__), file=sys.stderr)
    if stage is not None:
        print('Owned local evidence retained at ' + escaped(stage), file=sys.stderr)
    sys.exit(1)
'''
    guarded = 'with host_signals():\n' + ''.join('    ' + line + '\n' for line in final.splitlines())
    return core + '\nHELPER_URL = ' + repr(url) + '\nHELPER_SHA256 = ' + repr(helper_hash) + '\nHELPER_LIMIT = ' + str(ceiling) + '\n' + guarded


def render(archive_path, expected_sha, source, version, base_url, output, choices,
           max_archive_bytes=64 * 1024 * 1024, max_checksums_bytes=65536,
           fs_path=None, bootstrap_path=None):
    archive_path = Path(archive_path)
    pins = {'base_url': base_url, 'tag': base_url.rsplit('/', 1)[-1], 'archive': archive_path.name,
            'sha256': expected_sha, 'source': source, 'version': version,
            'max_archive_bytes': max_archive_bytes, 'max_checksums_bytes': max_checksums_bytes}
    fetch.validate_release(pins)
    if fetch.digest_file(archive_path, max_archive_bytes) != expected_sha:
        raise ValueError('Local release archive does not equal the independently supplied pin')
    sources = {'fleet_fs.py': Path(fs_path or HERE / 'fleet_fs.py').read_bytes(),
               'fleet_bootstrap.py': Path(bootstrap_path or HERE / 'fleet_bootstrap.py').read_bytes()}
    bindings = []
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        entries = [entry for entry in members if entry.name == 'toolsenabled-installer/manifest.json']
        if len(entries) != 1 or not entries[0].isfile() or entries[0].size > 65536:
            raise ValueError('Exact unique bounded release manifest is required')
        manifest = fetch.strict_json(archive.extractfile(entries[0]).read())
        # The pasted verifier is reviewed source, but must also be the exact
        # source shipped by these release pins. Bind both installer and later
        # installed-upgrade copies; do not silently mix a checkout with a tar.
        for name, content in sources.items():
            for prefix in ('toolsenabled-installer/', 'toolsenabled-installer/payload/engine/libexec/'):
                archive_name = prefix + name
                entries = [entry for entry in members if entry.name == archive_name]
                if (len(entries) != 1 or not entries[0].isfile() or entries[0].size > 80000
                        or entries[0].size != len(content) or archive.extractfile(entries[0]).read() != content):
                    raise ValueError('Exact unique bounded archive bootstrap source must match local source: ' + archive_name)
                bindings.append({'path': archive_name, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
    if manifest.get('name') != 'toolsenabled-openshell' or manifest.get('source_commit') != source or manifest.get('version') != version:
        raise ValueError('Release manifest does not match explicit source/version pins')
    fs_source = sources['fleet_fs.py'].decode('utf-8')
    bootstrap_source = sources['fleet_bootstrap.py'].decode('utf-8')
    bootstrap = compose_bootstrap(fs_source, bootstrap_source)
    template = (HERE / 'fleet_fetch.py').read_text()
    replacements = {'RELEASE = None  # RELEASE_PINS': 'RELEASE = ' + repr(pins) + '  # RELEASE_PINS',
                    'SANDBOX_BOOTSTRAP = None  # SANDBOX_BOOTSTRAP_SOURCE': 'SANDBOX_BOOTSTRAP = ' + repr(bootstrap) + '  # SANDBOX_BOOTSTRAP_SOURCE'}
    generated = template
    for old, new in replacements.items():
        if generated.count(old) != 1:
            raise ValueError('Helper template substitution contract changed')
        generated = generated.replace(old, new, 1)
    compile(generated, '<rendered-fleet-fetch>', 'exec')
    encoded = generated.encode()
    helper_limit = 512 * 1024
    if len(encoded) > helper_limit:
        raise ValueError('Rendered helper exceeds independent bootstrap byte limit')
    helper_hash = hashlib.sha256(encoded).hexdigest()
    url = base_url + '/fleet-fetch.py'
    host_source = host_bootstrap_source(template, url, helper_hash, helper_limit)
    # All user choices are fixed positional shell arguments, never interpolated
    # into either embedded program. The generated command has real release pins.
    command = shlex.join(['python3', '-I', '-c', host_source, *choices])
    fetch.parse_arguments(list(choices))
    output = Path(output)
    output.mkdir(mode=0o700)  # Publication staging must be new, never clobbered.
    for name, content in [('fleet-fetch.py', encoded), ('host-command.txt', (command + '\n').encode())]:
        with open(output / name, 'xb') as stream:
            stream.write(content)
        os.chmod(output / name, 0o600)
    receipt = {'release': pins, 'helper': {'basename': 'fleet-fetch.py', 'sha256': helper_hash, 'bytes': len(encoded), 'ceiling': helper_limit},
               'hostCommandSha256': hashlib.sha256((command + '\n').encode()).hexdigest(),
               'archiveSourceBindings': bindings,
               'sourceHashes': {name: hashlib.sha256(content.encode()).hexdigest() for name, content in [
                   ('fleet_fetch.py', template), ('fleet_fs.py', fs_source), ('fleet_bootstrap.py', bootstrap_source)]},
               'prerequisites': ['Linux/WSL', 'Python>=3.9 with working pidfd APIs/kernel support', 'Bash', 'OpenShell0.1.2', 'curl', 'sha256sum', 'mktemp'],
               'qualification': 'OFFLINE_RENDER_ONLY; host prerequisites remain subject to explicit approval and exact host acceptance'}
    with open(output / 'render-receipt.json', 'x', encoding='utf-8') as stream:
        json.dump(receipt, stream, indent=2)
        stream.write('\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--release-base-url', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--max-archive-bytes', type=int, default=64 * 1024 * 1024)
    parser.add_argument('--gateway', required=True)
    parser.add_argument('--sandbox', required=True)
    parser.add_argument('--workspace', default='default')
    parser.add_argument('--prefix')
    parser.add_argument('--tier')
    parser.add_argument('--providers')
    parser.add_argument('--upgrade', action='store_true')
    args = parser.parse_args()
    choices = ['--gateway', args.gateway, '--sandbox', args.sandbox, '--workspace', args.workspace]
    for key in ('prefix', 'tier', 'providers'):
        if getattr(args, key) is not None:
            choices.extend(['--' + key, getattr(args, key)])
    if args.upgrade:
        choices.append('--upgrade')
    result = render(args.archive, args.sha256, args.source, args.version, args.release_base_url, args.output,
                    choices, max_archive_bytes=args.max_archive_bytes)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
