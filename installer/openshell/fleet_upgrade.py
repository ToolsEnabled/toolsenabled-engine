"""Installed entry: verify a new archive, then run its staged driver."""
import argparse
import json
import sys

from fleet_fs import VerifiedArchive, FleetFSError
from fleet_bootstrap import bootstrap_main


def main(argv=None):
    words = sys.argv[1:] if argv is None else argv
    flags = [word for word in words if word.startswith('--')]
    if len(flags) != len(set(flags)) or any('=' in flag for flag in flags):
        raise FleetFSError('INSTALL', 'Repeated options are refused')
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--prefix', required=True)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--previous-archive')
    parser.add_argument('--previous-sha256')
    options = parser.parse_args(words)
    if bool(options.previous_archive) != bool(options.previous_sha256):
        raise FleetFSError('INTEGRITY', 'Previous archive and independent release digest are required together')
    with VerifiedArchive.open(options.archive, options.sha256) as archive:
        manifest = json.loads(archive.read_bytes('toolsenabled-installer/manifest.json', max_bytes=65536))
        if not isinstance(manifest, dict) or manifest.get('name') != 'toolsenabled-openshell':
            raise FleetFSError('INTEGRITY', 'Verified archive has no Fleet manifest')
        source, version = manifest.get('source_commit'), manifest.get('version')
        if not isinstance(source, str) or not isinstance(version, str):
            raise FleetFSError('INTEGRITY', 'Verified archive has no source/version identity')
    previous = (['--previous-archive', options.previous_archive, '--previous-sha256', options.previous_sha256]
                if options.previous_archive else [])
    return bootstrap_main(['--mode', 'upgrade', '--prefix', options.prefix,
                           '--archive', options.archive, '--sha256', options.sha256,
                           '--source', source, '--version', version, *previous])


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (FleetFSError, OSError, ValueError) as error:
        sys.stderr.write(getattr(error, 'code', 'INSTALL') + ': ' + str(error) + '\n')
        raise SystemExit(1)
