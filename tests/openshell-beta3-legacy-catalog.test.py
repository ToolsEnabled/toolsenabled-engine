import importlib.util
import json
import os
import tempfile
import unittest
from unittest import mock
import tarfile
from pathlib import Path


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FS_PATH = os.path.join(ROOT, 'installer', 'openshell', 'fleet_fs.py')
spec = importlib.util.spec_from_file_location('fleet_fs', FS_PATH)
fleet_fs = importlib.util.module_from_spec(spec)
import sys
sys.modules['fleet_fs'] = fleet_fs
spec.loader.exec_module(fleet_fs)
install_spec = importlib.util.spec_from_file_location('fleet_install',
    os.path.join(ROOT, 'installer', 'openshell', 'fleet_install.py'))
fleet_install = importlib.util.module_from_spec(install_spec)
sys.modules['fleet_install'] = fleet_install
install_spec.loader.exec_module(fleet_install)

BETA3_SHA = 'ef1fe25cd4d251859e1c773e11c94b57839a4108b01602979c723c2e041801cd'
BETA3_SOURCE = '8cc22f708194e6128c99785b72c722605264aac4'


class Beta3CatalogTest(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('TOOLSENABLED_BETA3_ARCHIVE'), 'requires independently pinned published beta 3 archive')
    def test_published_beta3_writer_receipt_passes_both_upgrade_routes(self):
        archive_path = Path(os.environ['TOOLSENABLED_BETA3_ARCHIVE']).resolve(strict=True)
        with fleet_fs.VerifiedArchive.open(str(archive_path), BETA3_SHA) as explicit, \
                fleet_fs.load_legacy_catalog({'archiveSha256': BETA3_SHA}) as catalog, \
                tempfile.TemporaryDirectory() as scratch:
            with tarfile.open(archive_path, 'r:gz') as archive:
                original = archive.extractfile('toolsenabled-installer/fleet_install.py').read()
            beta3_file = Path(scratch) / 'beta3_fleet_install.py'
            beta3_file.write_bytes(original)
            beta3_spec = importlib.util.spec_from_file_location('beta3_fleet_install', beta3_file)
            beta3_install = importlib.util.module_from_spec(beta3_spec)
            sys.modules['beta3_fleet_install'] = beta3_install
            beta3_spec.loader.exec_module(beta3_install)
            base = Path(scratch)
            prefix, state = base / 'runtime', base / 'state'
            prefix.mkdir(mode=0o700)
            home = base / 'home'
            home.mkdir(mode=0o700)
            context = {'schemaVersion': 1, 'uid': os.getuid(), 'prefix': str(prefix),
                       'home': str(home), 'accountHome': str(home), 'stateRoot': str(state),
                       'servicesRoot': str(base / 'services'), 'codexProfile': str(base / 'codex'),
                       'claudeProfile': str(base / 'claude'), 'codexProfileMode': 'default',
                       'claudeProfileMode': 'default', 'workspace': str(base / 'work'),
                       'tier': 'guided', 'providers': 'codex', 'availableProviders': ['codex'],
                       'protectedPaths': [str(base / name) for name in ('home', 'state', 'services', 'codex', 'claude')]}
            previous = {name: os.environ.get(name) for name in ('TOOLSENABLED_STATE_ROOT', 'HOME')}
            os.environ['TOOLSENABLED_STATE_ROOT'], os.environ['HOME'] = str(state), str(home)
            try:
                with fleet_fs.SafeDirectory.open(str(prefix)) as directory:
                    written = beta3_install.create_receipt(directory, explicit, context)
                    self.assertEqual(json.loads(written)['schema'], 2)
                    self.assertEqual(fleet_install.read_receipt(directory, catalog), written)
                    self.assertEqual(fleet_install.read_receipt(directory, explicit), written)
                    (prefix / '.fleet-generation').write_text('0' * 64 + '\n')
                    with self.assertRaisesRegex(Exception, 'generation marker'):
                        fleet_install.read_receipt(directory, explicit)
            finally:
                for name, value in previous.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value

    def test_published_beta3_is_pinned_for_archive_free_upgrade(self):
        with fleet_fs.load_legacy_catalog({'archiveSha256': BETA3_SHA}) as catalog:
            self.assertEqual(catalog.archive_sha256, BETA3_SHA)
            manifest = __import__('json').loads(catalog.read_bytes('toolsenabled-installer/manifest.json'))
            self.assertEqual(manifest['source_commit'], BETA3_SOURCE)
            self.assertEqual(manifest['version'], '1.4.2')
            self.assertIn('toolsenabled-installer/payload/engine/package.json', catalog.package_inventory.entries)

    def test_published_beta3_receipt_is_accepted_without_previous_archive_flags(self):
        # Beta 3's exact pinned catalog stands in for --previous-archive. Its
        # installed runtime has a schema 2 receipt; 1.4.0/1.4.1 do not.
        with fleet_fs.load_legacy_catalog({'archiveSha256': BETA3_SHA}) as catalog, \
                tempfile.TemporaryDirectory() as directory:
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                marker = 'a' * 64
                receipt = {'schema': 2, 'root': fleet_install.identity(os.fstat(fd)),
                           'file': {'dev': 1, 'ino': 12345}, 'generation': marker,
                           'marker': {'dev': 1, 'ino': 12346}, 'installId': 'b' * 32,
                           'archiveSha256': BETA3_SHA, 'sourceCommit': BETA3_SOURCE,
                           'version': '1.4.2', 'context': {}}
                encoded = fleet_install.json_bytes(receipt)

                def read_member(_directory, name, **_options):
                    if name == '.fleet-ownership.json':
                        return encoded, receipt['file'], {}
                    if name == '.fleet-generation':
                        return (marker + '\n').encode(), receipt['marker'], {}
                    raise AssertionError(name)

                with mock.patch.object(fleet_install, 'read_at', side_effect=read_member), \
                        mock.patch.object(fleet_install, 'validate_context'), \
                        mock.patch.object(fleet_install, 'require_state_record'):
                    old = type('Directory', (), {'fd': fd})()
                    self.assertEqual(fleet_install.read_receipt(old, catalog), encoded)
                    # The explicit --previous-archive route uses the same
                    # published archive identity without the embedded catalog.
                    explicit = type('Archive', (), {
                        'archive_sha256': BETA3_SHA,
                        'read_bytes': catalog.read_bytes,
                    })()
                    self.assertEqual(fleet_install.read_receipt(old, explicit), encoded)
            finally:
                os.close(fd)

    def test_beta3_receipt_cannot_be_missing_or_get_legacy_mode_reduction(self):
        with fleet_fs.load_legacy_catalog({'archiveSha256': BETA3_SHA}) as catalog, \
                tempfile.TemporaryDirectory() as directory:
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                old = type('Directory', (), {'fd': fd})()
                with mock.patch.object(fleet_install, 'read_at', side_effect=FileNotFoundError()):
                    with self.assertRaisesRegex(Exception, 'ownership receipt'):
                        fleet_install.read_receipt(old, catalog)
                transaction = object.__new__(fleet_install.Transaction)
                transaction.fs = fleet_fs
                self.assertFalse(transaction.legacy_mode_reduction(catalog, None, True))
            finally:
                os.close(fd)


if __name__ == '__main__':
    unittest.main()
