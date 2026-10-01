"""Verified user-run sandbox bootstrap; renderer embeds this with fleet_fs."""

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import types

from fleet_fs import VerifiedArchive, SafeDirectory, create_stage, extract_archive, verify_tree, remove_tree, capabilities, FleetFSError


def bootstrap_main(argv=None):
    words = sys.argv[1:] if argv is None else argv
    flags = [word for word in words if word.startswith('--')]
    if len(flags) != len(set(flags)) or any('=' in flag for flag in flags):
        raise FleetFSError('INSTALL', 'Repeated options or --flag=value are not supported')
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--prefix', required=True)
    parser.add_argument('--mode', required=True, choices=('fresh', 'upgrade'))
    parser.add_argument('--tier', choices=('guided', 'standard', 'unrestricted'))
    parser.add_argument('--providers', choices=('codex', 'claude', 'codex,claude'))
    parser.add_argument('--previous-archive')
    parser.add_argument('--previous-sha256')
    options = parser.parse_args(words)
    if options.mode == 'upgrade' and (options.tier is not None or options.providers is not None):
        raise FleetFSError('INSTALL', 'Upgrade cannot replace tier or provider choices')
    if bool(options.previous_archive) != bool(options.previous_sha256):
        raise FleetFSError('INSTALL', 'Previous archive and its independent checksum are required together')
    if options.previous_archive is not None:
        if options.mode != 'upgrade' or not re.fullmatch(r'[a-f0-9]{64}', options.previous_sha256):
            raise FleetFSError('INSTALL', 'Previous archive pins are supported only for upgrade')
    if not re.fullmatch(r'[a-f0-9]{40}', options.source) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', options.version):
        raise FleetFSError('INTEGRITY', 'Expected literal source and version pins')
    if os.environ.get('OPENSHELL_SANDBOX') != '1' or platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise FleetFSError('INSTALL', 'Run this command in the intended Linux x86_64 OpenShell sandbox')
    if sys.version_info < (3, 9):
        raise FleetFSError('INSTALL', 'Python 3.9 or newer is required')
    capabilities()
    node = shutil.which('node')
    if not node:
        raise FleetFSError('INSTALL', 'Node.js 22.19 or newer is required')
    version = subprocess.run([node, '-e', 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=19?0:1)'],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    if version.returncode:
        raise FleetFSError('INSTALL', 'Node.js 22.19 or newer is required')
    os.umask(0o077)
    sys.dont_write_bytecode = True
    stage = None
    with VerifiedArchive.open(options.archive, options.sha256) as archive:
        manifest = json.loads(archive.read_bytes('toolsenabled-installer/manifest.json', max_bytes=65536))
        if manifest.get('name') != 'toolsenabled-openshell' or manifest.get('source_commit') != options.source or manifest.get('version') != options.version:
            raise FleetFSError('INTEGRITY', 'Verified archive identity differs from the published source/version pins')
        with SafeDirectory.open('/tmp') as parent:
            stage = create_stage(parent, protected_paths=(options.prefix,))
            try:
                extract_archive(archive, stage)
                verify_tree(stage, archive.package_inventory)
                package = os.path.join(stage.path, 'toolsenabled-installer')
                # Execute the driver bytes from the verified spool, with an
                # absolute staged __file__. Its imports also come from that
                # fully verified package; no previous runtime is executed.
                sys.path.insert(0, package)
                for name in ('fleet_fs', 'fleet_install'):
                    filename = os.path.join(package, name + '.py')
                    source = archive.read_bytes('toolsenabled-installer/' + name + '.py', max_bytes=1024 * 1024)
                    stage.revalidate()
                    module = types.ModuleType(name)
                    module.__file__ = filename
                    sys.modules[name] = module
                    exec(compile(source, filename, 'exec'), module.__dict__)
                command = ['--setup' if options.mode == 'fresh' else '--upgrade', options.prefix,
                           '--archive', options.archive, '--sha256', options.sha256]
                if options.mode == 'fresh':
                    command += ['--tier', options.tier or 'unrestricted', '--providers', options.providers or 'codex,claude']
                if options.previous_archive is not None:
                    command += ['--previous-archive', options.previous_archive, '--previous-sha256', options.previous_sha256]
                try:
                    result = sys.modules['fleet_install'].main(command)
                except RuntimeError as error:
                    # The independently loaded archive defines fresh exception
                    # classes, even when its source equals this bootstrap. Map
                    # its stable phase at the boundary instead of relying on
                    # class identity or leaking a traceback for a known refusal.
                    code = getattr(error, 'code', 'INSTALL')
                    if not isinstance(code, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', code):
                        code = 'INSTALL'
                    raise FleetFSError(code, str(error)[:1024]) from error
                if result != 0:
                    raise FleetFSError('RECOVERY_REQUIRED', 'Local operation did not fully complete; verified stage retained')
                # Confirmed completion is necessary but not ownership proof.
                # Recheck every stage entry before descriptor-bound cleanup.
                cleanup = remove_tree(parent, os.path.basename(stage.path), archive.package_inventory, stage.identity)
                if not cleanup.complete:
                    raise FleetFSError('RECOVERY_REQUIRED', 'Installation completed but stage cleanup is pending')
                return 0
            except BaseException:
                sys.stderr.write('Verified stage retained for inspection/recovery: ' + json.dumps(stage.path) + '\n')
                raise
            finally:
                stage.close()


if __name__ == '__main__':
    try:
        raise SystemExit(bootstrap_main())
    except (FleetFSError, OSError, ValueError, subprocess.SubprocessError) as error:
        sys.stderr.write(getattr(error, 'code', 'INSTALL') + ': ' + str(error) + '\n')
        raise SystemExit(1)
