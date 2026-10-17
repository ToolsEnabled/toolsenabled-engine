import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fleet_fs', ROOT / 'installer/openshell/fleet_fs.py')
fs = importlib.util.module_from_spec(spec)
sys.modules['fleet_fs'] = fs
spec.loader.exec_module(fs)


class WritableTree(unittest.TestCase):
    def test_group_writable_runtime_names_actionable_error(self):
        with tempfile.TemporaryDirectory(prefix='fleet-tree-writable-') as temp:
            root = pathlib.Path(temp)
            root.chmod(0o700)
            child = root / 'entry'
            child.write_bytes(b'fixed')
            child.chmod(0o666)
            inventory = fs.Inventory({
                '': fs.Entry('dir', 0o700),
                'entry': fs.Entry('file', 0o600, 5, __import__('hashlib').sha256(b'fixed').hexdigest())
            }, '0' * 64, _authority=fs._PROVENANCE, runtime=True)
            with fs.SafeDirectory.open(str(root)) as handle:
                with self.assertRaises(fs.FleetFSError) as caught:
                    fs.verify_tree(handle, inventory, allow_shared_ancestors=True)
            self.assertEqual(caught.exception.code, 'TREE_WRITABLE')


if __name__ == '__main__':
    unittest.main()
