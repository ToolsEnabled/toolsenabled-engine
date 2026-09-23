"""Inert composition of production Inspector.close and pinned SDK method bodies.

Usage: python -I -B tests/web-inspector-session-composition.py --sdk-source DIR
DIR is pymobiledevice3 11.15.4's installed services/web_protocol directory.
No SDK source is vendored. Original AST methods execute unchanged; only the
session-scoped protocol, transports and lease I/O are simulated. No phone,
network, browser, physical fixture creation or deletion occurs.
"""
import argparse
import ast
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

EXPECTED = {
    "automation_session.py": "f518e0a390c5f1fa33d1c71ad9317d0994dd0f60a0c38ac5646ee04e0ef7031d",
    "driver.py": "df812d17a0b3cf85e13dcdfd3d638e35c717c433a2afeb35778fdfd5107b12e6",
}


def sdk_methods(root, filename, class_name, names):
    path = root / filename
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != EXPECTED[filename]:
        raise AssertionError(f"unsupported SDK source hash: {filename}")
    tree = ast.parse(data, filename=str(path))
    original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
    methods = [n for n in original.body if isinstance(n, ast.AsyncFunctionDef) and n.name in names]
    if {n.name for n in methods} != set(names):
        raise AssertionError(f"missing original methods: {class_name}")
    # Execute the ORIGINAL AST nodes, not rewritten or reimplemented SDK loops.
    namespace = {}
    exec(compile(ast.Module(body=methods, type_ignores=[]), str(path), "exec"), namespace)
    return type(class_name, (), {name: namespace[name] for name in names})


class Protocol:
    """One automation session only; unrelated browser tabs are not enumerable."""
    def __init__(self, owned, disappear=(), blocked=()):
        self.owned = list(owned)
        self.disappear = set(disappear)
        self.blocked = set(blocked)
        self.attempted = []
        self.closed = []
        self.unrelated = ["unrelated-personal-tab"]

    async def getBrowsingContexts(self):
        return {"contexts": [{"handle": h} for h in self.owned]}

    async def closeBrowsingContext(self, handle):
        if handle in self.unrelated:
            raise AssertionError("attempted unrelated-tab close")
        self.attempted.append(handle)
        if handle in self.blocked:
            raise RuntimeError("WindowNotFound: enumeration remains uncertain")
        if handle in self.disappear or handle not in self.owned:
            self.disappear.discard(handle)
            if handle in self.owned:
                self.owned.remove(handle)
            raise RuntimeError("WindowNotFound")
        self.owned.remove(handle)
        self.closed.append(handle)


class SessionComposition(unittest.IsolatedAsyncioTestCase):
    def make_session(self, protocol, current):
        session = SDKSession()
        session.protocol = protocol
        session.top_level_handle = current
        session.current_handle = current
        session.current_parent_handle = ""
        return session

    def make_inspector(self, protocol, current):
        inspector = worker.Inspector()
        session = self.make_session(protocol, current)
        driver = SDKDriver()
        driver.session = session
        service, device = SimpleNamespace(close=AsyncMock()), SimpleNamespace(close=AsyncMock())
        inspector.driver, inspector.session = driver, session
        inspector.inspector, inspector.device = service, device
        inspector.lease, inspector.remote_pending = 17, True
        return inspector, session, service, device

    def assert_unrelated_untouched(self, protocol):
        self.assertEqual(protocol.unrelated, ["unrelated-personal-tab"])
        self.assertNotIn("unrelated-personal-tab", protocol.attempted)

    async def test_actual_sdk_aborts_before_surviving_later_context(self):
        protocol = Protocol(["gone", "survivor"], disappear=["gone"])
        session = self.make_session(protocol, "gone")
        with self.assertRaisesRegex(RuntimeError, "WindowNotFound"):
            await session.stop_session()
        self.assertEqual(protocol.attempted, ["gone"])
        self.assertEqual(protocol.owned, ["survivor"])
        self.assertEqual(protocol.closed, [])
        self.assert_unrelated_untouched(protocol)

    async def test_disappeared_first_retains_custody_then_retry_closes_survivor(self):
        protocol = Protocol(["current", "gone", "survivor"], disappear=["gone"])
        inspector, session, service, device = self.make_inspector(protocol, "current")
        with patch.object(worker, "mark_remote") as mark, patch.object(worker.os, "close") as release:
            self.assertEqual(await inspector.close(), {"closed": False, "cleanupFailures": 1})
            self.assertEqual(protocol.closed, ["current"])
            self.assertEqual(protocol.attempted, ["current", "gone"])
            self.assertEqual(protocol.owned, ["survivor"])
            self.assertIs(inspector.session, session)
            self.assertIs(inspector.inspector, service)
            self.assertIs(inspector.device, device)
            self.assertEqual(inspector.lease, 17)
            self.assertTrue(inspector.cleanup_failed)
            mark.assert_not_called()
            release.assert_not_called()
            service.close.assert_not_awaited()
            device.close.assert_not_awaited()
            with self.assertRaisesRegex(worker.Refusal, "ALREADY_OPEN"):
                await inspector.open()
            with self.assertRaisesRegex(worker.Refusal, "CLEANUP_UNCONFIRMED"):
                await inspector.call({"action": "snapshot"})
            self.assertEqual(await inspector.close(), {"closed": True, "cleanupFailures": 0})
            self.assertEqual(protocol.closed, ["current", "survivor"])
            self.assertEqual(protocol.owned, [])
            mark.assert_called_once_with(17, False)
            release.assert_called_once_with(17)
            service.close.assert_awaited_once()
            device.close.assert_awaited_once()
            self.assertIsNone(inspector.session)
            self.assertIsNone(inspector.lease)
            self.assertFalse(inspector.cleanup_failed)
        self.assert_unrelated_untouched(protocol)

    async def test_all_gone_driver_absence_and_empty_session_are_positive(self):
        protocol = Protocol([])
        inspector, _, service, device = self.make_inspector(protocol, "already-gone")
        with patch.object(worker, "mark_remote") as mark, patch.object(worker.os, "close") as release:
            self.assertEqual(await inspector.close(), {"closed": True, "cleanupFailures": 0})
            self.assertEqual(protocol.attempted, ["already-gone"])
            self.assertEqual(protocol.closed, [])
            mark.assert_called_once_with(17, False)
            release.assert_called_once_with(17)
            service.close.assert_awaited_once()
            device.close.assert_awaited_once()
            self.assertIsNone(inspector.lease)
        self.assert_unrelated_untouched(protocol)

    async def test_repeated_unknown_session_cleanup_never_releases_lease(self):
        protocol = Protocol(["current", "unknown", "survivor"], blocked=["unknown"])
        inspector, session, service, device = self.make_inspector(protocol, "current")
        with patch.object(worker, "mark_remote") as mark, patch.object(worker.os, "close") as release:
            for _ in range(2):
                self.assertEqual(await inspector.close(), {"closed": False, "cleanupFailures": 1})
                self.assertIs(inspector.session, session)
                self.assertEqual(inspector.lease, 17)
            self.assertEqual(protocol.owned, ["unknown", "survivor"])
            self.assertEqual(protocol.closed, ["current"])
            mark.assert_not_called()
            release.assert_not_called()
            service.close.assert_not_awaited()
            device.close.assert_not_awaited()
        self.assert_unrelated_untouched(protocol)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-source", type=Path, required=True)
    parser.add_argument("--worker-source", type=Path, default=Path(__file__).resolve().parents[1] / "src/lib/providers/web-inspector.py")
    args = parser.parse_args()
    SDKSession = sdk_methods(args.sdk_source, "automation_session.py", "AutomationSession",
                             ["stop_session", "get_window_handles", "close_window"])
    SDKDriver = sdk_methods(args.sdk_source, "driver.py", "WebDriver", ["close"])
    spec = importlib.util.spec_from_file_location("inspector_worker", args.worker_source)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    unittest.main(argv=[__file__], verbosity=2)
