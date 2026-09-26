"""Dependency-free helper contracts; no phone connection is opened."""
import asyncio
import io
import importlib.util
import os
import pathlib
import subprocess
import sys
import json
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

source = pathlib.Path(__file__).resolve().parents[1] / 'src/lib/providers/web-inspector.py'
spec = importlib.util.spec_from_file_location('inspector_worker', source)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class HelperContracts(unittest.IsolatedAsyncioTestCase):
    async def test_unopened_actions_refuse(self):
        with self.assertRaisesRegex(worker.Refusal, 'NOT_OPEN'):
            await worker.Inspector().call({'action': 'snapshot'})

    async def test_cleanup_attempts_every_resource_and_reports_failure(self):
        inspector = worker.Inspector()
        driver, session, service, device = [AsyncMock() for _ in range(4)]
        driver.close.side_effect = RuntimeError('private driver detail')
        inspector.driver, inspector.session = driver, session
        inspector.inspector, inspector.device = service, device
        result = await inspector.close()
        self.assertEqual(result, {'closed': False, 'cleanupFailures': 1})
        for mock, method in [(driver,'close'),(session,'stop_session'),(service,'close'),(device,'close')]:
            getattr(mock, method).assert_awaited_once()
        self.assertIs(inspector.driver, driver)
        self.assertTrue(inspector.cleanup_failed)
        with self.assertRaisesRegex(worker.Refusal, 'CLEANUP_UNCONFIRMED'):
            await inspector.call({'action': 'snapshot'})

    async def test_session_window_not_found_retains_unknown_context_custody(self):
        inspector = worker.Inspector()
        inspector.session = AsyncMock()
        inspector.session.stop_session.side_effect = RuntimeError('WindowNotFound')
        self.assertEqual((await inspector.close())['closed'], False)
        self.assertIsNotNone(inspector.session)
        self.assertTrue(inspector.cleanup_failed)

    async def test_native_touch_releases_the_finger(self):
        inspector = worker.Inspector()
        inspector.driver, inspector.session = AsyncMock(), AsyncMock()
        inspector.driver.execute_script.return_value = {'safe': True}
        result = await inspector.call({'action':'tap','x':12,'y':34})
        self.assertEqual(result['effectVerified'],False)
        sources, steps = inspector.session.perform_interaction_sequence.call_args.args
        self.assertEqual(sources[0]['sourceType'],'Touch')
        self.assertEqual(steps[0]['states'][0]['pressedButton'],'Left')
        self.assertEqual(steps[0]['states'][0]['location'], {'x': 12, 'y': 34})
        self.assertEqual(steps[1]['states'][0]['location'], {'x': 12, 'y': 34})
        self.assertEqual(steps[1]['states'][0]['mouseInteraction'],'Up')
        self.assertNotIn('pressedButton',steps[1]['states'][0])

    async def test_keyboard_is_native_and_has_no_hidden_dom_fallback(self):
        inspector = worker.Inspector()
        inspector.driver, inspector.session = AsyncMock(), AsyncMock()
        result = await inspector.call({'action':'type','text':'test'})
        self.assertEqual(result['inputMethod'],'native-keyboard')
        self.assertEqual(len(inspector.session.perform_keyboard_interactions.call_args.args[0]),4)
        inspector.driver.execute_script.assert_not_called()

    async def test_unsafe_touch_viewport_refuses_before_any_gesture(self):
        inspector = worker.Inspector()
        inspector.driver, inspector.session = AsyncMock(), AsyncMock()
        inspector.driver.execute_script.return_value = {'safe': False}
        with self.assertRaisesRegex(worker.Refusal, 'WEB_INSPECTOR_UNSAFE_TOUCH_VIEWPORT'):
            await inspector.call({'action': 'tap', 'x': 12, 'y': 34})
        inspector.session.perform_interaction_sequence.assert_not_called()

    async def test_sticky_lease_marker_refuses_crash_residue_without_os_files(self):
        for platform in ('posix', 'nt'):
            fake_lock = MagicMock()
            fake_lock.flock.return_value = None
            fake_lock.locking.return_value = None
            with ExitStack() as stack:
                stack.enter_context(patch.dict('sys.modules', {'fcntl': fake_lock, 'msvcrt': fake_lock}))
                stack.enter_context(patch.object(worker.os, 'name', platform))
                stack.enter_context(patch.object(worker.tempfile, 'gettempdir', return_value='/inert'))
                stack.enter_context(patch.object(worker.os, 'getuid', create=True, return_value=123))
                stack.enter_context(patch.object(worker.os.path, 'isdir', return_value=False))
                stack.enter_context(patch.object(worker.os, 'open', return_value=17))
                stack.enter_context(patch.object(worker.os, 'fstat', return_value=MagicMock(st_size=7)))
                stack.enter_context(patch.object(worker.os, 'lseek'))
                stack.enter_context(patch.object(worker.os, 'read', return_value=b'pending'))
                close = stack.enter_context(patch.object(worker.os, 'close'))
                with self.assertRaisesRegex(worker.Refusal, 'CLEANUP_UNCONFIRMED'):
                    worker.claim_device()
                close.assert_called_once_with(17)

    async def test_main_eof_emits_cleanup_receipt(self):
        inspector = AsyncMock()
        inspector.close.return_value = {'closed': True, 'cleanupFailures': 0}
        emitted = []
        with ExitStack() as stack:
            stack.enter_context(patch.object(worker, 'Inspector', return_value=inspector))
            stack.enter_context(patch.object(worker.sys, 'stdin', SimpleNamespace(buffer=SimpleNamespace(raw=io.BytesIO(b'')))))
            stack.enter_context(patch.object(worker, 'emit', side_effect=emitted.append))
            await worker.main()
        self.assertEqual(emitted, [{'type': 'cleanup', 'result': {'closed': True, 'cleanupFailures': 0}}])
        inspector.close.assert_awaited_once()

    async def test_main_eof_emits_failed_cleanup_receipt(self):
        inspector = AsyncMock()
        inspector.close.return_value = {'closed': False, 'cleanupFailures': 1}
        emitted = []
        with ExitStack() as stack:
            stack.enter_context(patch.object(worker, 'Inspector', return_value=inspector))
            stack.enter_context(patch.object(worker.sys, 'stdin', SimpleNamespace(buffer=SimpleNamespace(raw=io.BytesIO(b'')))))
            stack.enter_context(patch.object(worker, 'emit', side_effect=emitted.append))
            await worker.main()
        self.assertEqual(emitted, [{'type': 'cleanup', 'result': {'closed': False, 'cleanupFailures': 1}}])

    async def test_main_idle_emits_cleanup_without_reader_thread(self):
        inspector = AsyncMock()
        inspector.close.return_value = {'closed': True, 'cleanupFailures': 0}
        emitted = []
        fake_threading = SimpleNamespace(Thread=lambda **kwargs: SimpleNamespace(start=lambda: None))
        with ExitStack() as stack:
            stack.enter_context(patch.dict('sys.modules', {'threading': fake_threading}))
            stack.enter_context(patch.object(worker, 'IDLE_SECONDS', 0))
            stack.enter_context(patch.object(worker, 'Inspector', return_value=inspector))
            stack.enter_context(patch.object(worker, 'emit', side_effect=emitted.append))
            await worker.main()
        self.assertEqual(emitted, [{'type': 'cleanup', 'result': {'closed': True, 'cleanupFailures': 0}}])

    async def test_successful_close_clears_marker_and_releases_inert_lease(self):
        inspector = worker.Inspector()
        inspector.lease, inspector.driver, inspector.remote_pending = 17, AsyncMock(), True
        with patch.object(worker, 'mark_remote') as mark, patch.object(worker.os, 'close') as close:
            result = await inspector.close()
        self.assertEqual(result, {'closed': True, 'cleanupFailures': 0})
        mark.assert_called_once_with(17, False)
        close.assert_called_once_with(17)
        self.assertIsNone(inspector.lease)

    async def test_marker_write_mock_reports_complete_seven_byte_write(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(worker.os, 'lseek'))
            write = stack.enter_context(patch.object(worker.os, 'write', return_value=7))
            fsync = stack.enter_context(patch.object(worker.os, 'fsync'))
            worker.mark_remote(17, True)
        write.assert_called_once_with(17, b'pending')
        fsync.assert_called_once_with(17)

    async def test_failed_close_retains_lock_and_marker_and_blocks_actions(self):
        inspector = worker.Inspector()
        inspector.lease, inspector.driver, inspector.remote_pending = 17, AsyncMock(), True
        inspector.driver.close.side_effect = RuntimeError('driver still alive')
        with patch.object(worker, 'mark_remote') as mark, patch.object(worker.os, 'close') as close:
            result = await inspector.close()
        self.assertEqual(result, {'closed': False, 'cleanupFailures': 1})
        mark.assert_not_called()
        close.assert_not_called()
        self.assertEqual(inspector.lease, 17)
        with self.assertRaisesRegex(worker.Refusal, 'CLEANUP_UNCONFIRMED'):
            await inspector.call({'action': 'type', 'text': 'blocked'})

    async def test_fill_is_explicit_verified_dom_editing_without_echo(self):
        inspector = worker.Inspector()
        inspector.driver, inspector.session = AsyncMock(), AsyncMock()
        inspector.driver.execute_script.return_value = {'dispatched': True, 'effectVerified': True}
        result = await inspector.call({'action': 'fill', 'text': 'private test value'})
        self.assertEqual(result, {'dispatched': True, 'effectVerified': True, 'inputMethod': 'dom-fill'})
        inspector.driver.execute_script.assert_awaited_once_with(worker.FILL, 'private test value')
        inspector.session.perform_keyboard_interactions.assert_not_called()
        inspector.driver.execute_script.return_value = {'refusal': 'INPUT_CANCELLED'}
        with self.assertRaisesRegex(worker.Refusal, 'WEB_INSPECTOR_INPUT_CANCELLED'):
            await inspector.call({'action': 'fill', 'text': ''})



class WorkerProcessContracts(unittest.TestCase):
    def assert_clean_exit_with_open_stdin(self, action):
        # Compose the real request loop and interpreter shutdown. Only the
        # device boundary is inert; keeping stdin open exposed SIGABRT after
        # an otherwise successful cleanup receipt on the old buffered reader.
        script = """
import asyncio, runpy, sys
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
except ImportError:
    pass
namespace = runpy.run_path(sys.argv[1])
class InertInspector:
    async def call(self, request):
        return {'closed': True, 'cleanupFailures': 0}
    async def close(self):
        return {'closed': True, 'cleanupFailures': 0}
namespace['main'].__globals__['Inspector'] = InertInspector
asyncio.run(namespace['main']())
"""
        child = subprocess.Popen(
            [sys.executable, '-I', '-B', '-c', script, str(source)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            child.stdin.write(json.dumps({'action': action}) + '\n')
            child.stdin.flush()
            child.wait(timeout=5)
            output = child.stdout.read()
            errors = child.stderr.read()
            self.assertEqual(child.returncode, 0, errors)
            self.assertEqual(errors, '')
            records = [json.loads(line) for line in output.splitlines()]
            self.assertEqual(records, [
                {'ok': True, 'result': {'closed': True, 'cleanupFailures': 0}},
                {'type': 'cleanup', 'result': {'closed': True, 'cleanupFailures': 0}},
            ])
        finally:
            child.stdin.close()
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
            child.stdout.close()
            child.stderr.close()

    def test_explicit_close_exits_without_parent_eof(self):
        self.assert_clean_exit_with_open_stdin('close')

    def test_status_exits_without_parent_eof(self):
        self.assert_clean_exit_with_open_stdin('status')


if __name__ == '__main__':
    unittest.main()
