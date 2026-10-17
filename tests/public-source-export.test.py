"""Host archive source mapping rejects altered installer files."""

import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("public_build", ROOT / "public-source/build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
orphan_spec = importlib.util.spec_from_file_location("public_orphan", ROOT / "public-source/orphan.py")
orphan = importlib.util.module_from_spec(orphan_spec)
orphan_spec.loader.exec_module(orphan)


class HostArchiveMappingTest(unittest.TestCase):
    def test_public_guide_omits_internal_test_commands(self):
        guide = (ROOT / 'docs/HOST-MODE.md').read_bytes()
        public = build.public_content('docs/HOST-MODE.md', guide)
        self.assertNotIn(b'## Local headless tests', public)
        self.assertNotIn(b'tests/host-integration.test.js', public)
        self.assertIn(b'## macOS feasibility', public)
        self.assertEqual(build.public_content('docs/HOST-MODE.md', public), public)

    def test_orphan_mapping_allows_only_manifest_source_commit(self):
        old_commit, new_commit = 'a' * 40, 'b' * 40
        with tempfile.TemporaryDirectory() as directory:
            original, public = (pathlib.Path(directory) / name for name in ('old.tar.gz', 'public.tar.gz'))
            def make(path, commit, helper):
                members = {'toolsenabled-installer/manifest.json': json.dumps(
                    {'source_commit': commit, 'version': '1.8.0'}).encode(),
                    'toolsenabled-installer/host_install.py': helper}
                with tarfile.open(path, 'w:gz') as archive:
                    for name, content in members.items():
                        item = tarfile.TarInfo(name)
                        item.size = len(content)
                        archive.addfile(item, io.BytesIO(content))
            make(original, old_commit, b'helper')
            make(public, new_commit, b'helper')
            self.assertEqual(orphan.compare_archives(original, public, old_commit, new_commit), 2)
            make(public, new_commit, b'changed')
            with self.assertRaisesRegex(ValueError, 'outside manifest'):
                orphan.compare_archives(original, public, old_commit, new_commit)

    def test_host_helper_and_wrapper_bytes_are_checked(self):
        commit = "a" * 40
        runtime = []
        sources = {
            "installer/host/install.sh": b"host install\n",
            "installer/openshell/fleet_fs.py": b"filesystem helper\n",
            "installer/host/host_install.py": b"host install helper\n",
            "installer/host/host_registration.py": b"host registration helper\n",
            "installer/host/handoff_preflight.py": b"handoff preflight helper\n",
            "installer/host/owner_handoff.py": b"owner handoff helper\n",
        }
        blobs = {name: (content, 0o644) for name, content in sources.items()}
        base = "toolsenabled-installer/"
        members = {
            base + "manifest.json": json.dumps({"source_commit": commit, "version": "1.8.0", "mode": "host"}).encode(),
            base + "install.sh": sources["installer/host/install.sh"],
            base + "fleet_fs.py": sources["installer/openshell/fleet_fs.py"],
            base + "host_install.py": sources["installer/host/host_install.py"],
            base + "host_registration.py": sources["installer/host/host_registration.py"],
            base + "handoff_preflight.py": sources["installer/host/handoff_preflight.py"],
            base + "owner_handoff.py": sources["installer/host/owner_handoff.py"],
            base + "toolsenabled": (ROOT / "installer/host/build.sh").read_bytes().split(
                b"<<'WRAPPER'\n", 1)[1].split(b"\nWRAPPER\n", 1)[0] + b"\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            archive_path = pathlib.Path(directory) / "host.tar.gz"
            for changed in [None, base + "host_install.py", base + "host_registration.py", base + "handoff_preflight.py",
                            base + "owner_handoff.py", base + "toolsenabled"]:
                with tarfile.open(archive_path, "w:gz") as archive:
                    for name, content in members.items():
                        if name == changed:
                            content += b"tampered\n"
                        item = tarfile.TarInfo(name)
                        item.size = len(content)
                        archive.addfile(item, io.BytesIO(content))
                if changed is None:
                    build.verify_archive(archive_path, commit, runtime, blobs, "host", "1.8.0")
                else:
                    with self.assertRaisesRegex(ValueError, "differs"):
                        build.verify_archive(archive_path, commit, runtime, blobs, "host", "1.8.0")


if __name__ == "__main__":
    unittest.main()
