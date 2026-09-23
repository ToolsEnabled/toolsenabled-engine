"""Unit seams for the production helper; not a kernel or GNOME integration proof.

The actual Linux suite separately exercises the real bus, keyring and files.
These cases make wrong/null kernel credentials and deletion failures explicit.
"""

import base64
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

helper_file = Path(__file__).resolve().parents[2] / "src" / "linux-vault.py"
spec = importlib.util.spec_from_file_location("vault_boundary_subject", helper_file)
helper = importlib.util.module_from_spec(spec)
# Import-only placeholders let these unit cases run on Windows too. No kernel
# operation is substituted in production or counted as exercised by this file.
missing_imports = {name: types.ModuleType(name) for name in ("fcntl", "resource")} if sys.platform == "win32" else {}
with patch.dict(sys.modules, missing_imports):
    spec.loader.exec_module(helper)


class SocketConnection:
    def __init__(self, socket):
        self.socket = socket

    def get_socket(self):
        return self.socket


class CustodyBoundary(unittest.TestCase):
    def setUp(self):
        self.uid = patch.object(helper.os, "getuid", return_value=1000, create=True)
        self.uid.start()
        self.addCleanup(self.uid.stop)
        self.environment = patch.dict(os.environ, {"DBUS_SESSION_BUS_ADDRESS": "unix:path=/unit-only/bus"}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.credentials = Mock()
        self.credentials.get_unix_user.return_value = 1000
        self.socket = Mock()
        self.socket.get_family.return_value = 1
        self.socket.get_credentials.return_value = self.credentials
        self.bus = Mock()
        self.bus.get_stream.return_value = SocketConnection(self.socket)
        self.bus.call_sync.side_effect = [Mock(unpack=lambda value=value: (value,)) for value in (":1.8", 4321, 1000)]
        self.collection = Mock()
        self.collection.get_object_path.return_value = helper.COLLECTION
        self.collection.get_name_owner.return_value = ":1.8"
        self.collection.init.return_value = True
        self.collection.get_locked.return_value = False
        self.service = Mock()
        self.service.get_name_owner.return_value = ":1.8"
        self.service.get_session_algorithms.return_value = "dh-ietf1024-sha256-aes128-cbc-pkcs7"
        self.service.get_collections.return_value = [self.collection]
        self.Gio = types.SimpleNamespace(
            SocketConnection=SocketConnection, SocketFamily=types.SimpleNamespace(UNIX=1),
            BusType=types.SimpleNamespace(SESSION=2), bus_get_sync=Mock(return_value=self.bus),
            DBusCallFlags=types.SimpleNamespace(NO_AUTO_START=4))
        self.Secret = types.SimpleNamespace(
            Service=Mock(), ServiceFlags=types.SimpleNamespace(OPEN_SESSION=1, LOAD_COLLECTIONS=2),
            Collection=Mock(return_value=self.collection), CollectionFlags=types.SimpleNamespace(NONE=0),
            Schema=Mock(), SchemaFlags=types.SimpleNamespace(NONE=0),
            SchemaAttributeType=types.SimpleNamespace(STRING=0))
        self.Secret.Service.open_sync.return_value = self.service
        gi = types.ModuleType("gi")
        gi.require_version = Mock()
        repository = types.ModuleType("gi.repository")
        repository.Gio = self.Gio
        repository.Secret = self.Secret
        repository.GLib = types.SimpleNamespace(Variant=Mock(), VariantType=Mock())
        gi.repository = repository
        for seam in (
            patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}),
            patch.object(helper.os, "readlink", return_value="/usr/bin/gnome-keyring-daemon"),
            patch.object(helper, "daemon_data_directory", return_value="/unit-only/data"),
            patch.object(helper, "encrypted_keyring_file"),
        ):
            seam.start()
            self.addCleanup(seam.stop)

    def refuses(self, code):
        with self.assertRaises(helper.Refusal) as caught:
            helper.secure_service()
        self.assertEqual(caught.exception.code, code)

    def test_current_uid_peer_reaches_existing_unique_owner_checks(self):
        self.assertIs(helper.secure_service()[-1], self.service)
        self.socket.get_credentials.assert_called_once_with()
        self.credentials.get_unix_user.assert_called_once_with()
        self.assertEqual(self.bus.call_sync.call_count, 3)
        self.assertEqual(self.Secret.Service.open_sync.call_args.args[1], ":1.8")

    def test_dangling_item_metadata_does_not_block_backend_availability(self):
        # libsecret's broad collection loader also initializes item proxies.
        # A missing item must not prevent opening the fixed login collection;
        # a later exact-key lookup still has to establish the requested key.
        def open_service(kind, owner, flags, cancellable):
            if flags & self.Secret.ServiceFlags.LOAD_COLLECTIONS:
                raise RuntimeError("UnknownMethod at synthetic dangling item")
            return self.service
        self.Secret.Service.open_sync.side_effect = open_service
        self.assertIs(helper.secure_service()[-1], self.service)
        self.service.get_collections.assert_not_called()
        self.Secret.Collection.assert_called_once_with(
            service=self.service, flags=self.Secret.CollectionFlags.NONE,
            g_object_path=helper.COLLECTION, g_connection=self.bus,
            g_name=":1.8", g_interface_name="org.freedesktop.Secret.Collection")
        self.collection.init.assert_called_once_with(None)
        self.collection.get_items.assert_not_called()
        self.collection.search_sync.assert_not_called()

    def test_fixed_collection_requires_exact_path_owner_and_successful_init(self):
        for attribute, value in (("get_object_path", "/unit-only/other-collection"),
                                 ("get_name_owner", ":1.9"), ("init", False)):
            with self.subTest(attribute=attribute):
                self.bus.call_sync.side_effect = [Mock(unpack=lambda value=value: (value,))
                                                  for value in (":1.8", 4321, 1000)]
                self.Secret.Collection.reset_mock()
                self.collection.init.reset_mock()
                selected = getattr(self.collection, attribute)
                original = selected.return_value
                selected.return_value = value
                self.refuses("SECRET_BACKEND_UNAVAILABLE")
                self.Secret.Collection.assert_called_once()
                self.collection.init.assert_called_once_with(None)
                selected.return_value = original

    def test_wrong_root_unknown_and_boolean_peer_uids_refuse_before_owner_claims(self):
        for uid in (1001, 0, None, True):
            with self.subTest(uid=uid):
                self.credentials.get_unix_user.return_value = uid
                self.refuses("SECRET_BACKEND_UNSAFE")
        self.bus.call_sync.assert_not_called()
        self.Secret.Service.open_sync.assert_not_called()

    def test_null_peer_credentials_refuse_before_owner_claims(self):
        self.socket.get_credentials.return_value = None
        self.refuses("SECRET_BACKEND_UNSAFE")
        self.bus.call_sync.assert_not_called()

    def test_credential_query_error_refuses_before_owner_claims(self):
        self.socket.get_credentials.side_effect = RuntimeError("private diagnostic")
        self.refuses("SECRET_BACKEND_UNSAFE")
        self.bus.call_sync.assert_not_called()

    def test_non_socket_and_non_unix_streams_refuse(self):
        self.bus.get_stream.return_value = object()
        self.refuses("SECRET_BACKEND_UNSAFE")
        self.bus.get_stream.return_value = SocketConnection(self.socket)
        self.socket.get_family.return_value = 2
        self.refuses("SECRET_BACKEND_UNSAFE")
        self.bus.call_sync.assert_not_called()

    def test_missing_bus_is_still_unavailable(self):
        os.environ.clear()
        self.refuses("SECRET_BACKEND_UNAVAILABLE")
        self.Gio.bus_get_sync.assert_not_called()

    def test_missing_dependency_still_refuses(self):
        with patch.dict(sys.modules, {"gi": None}):
            self.refuses("SECRET_HELPER_UNAVAILABLE")
        self.Gio.bus_get_sync.assert_not_called()

    def test_wrong_service_executable_still_refuses(self):
        helper.os.readlink.return_value = "/unit-only/other-daemon"
        self.refuses("SECRET_BACKEND_UNSAFE")
        self.Secret.Service.open_sync.assert_not_called()

    def test_changed_unique_owner_still_refuses(self):
        self.service.get_name_owner.return_value = ":1.9"
        self.refuses("SECRET_BACKEND_UNAVAILABLE")

    def test_plain_session_still_refuses(self):
        self.service.get_session_algorithms.return_value = "plain"
        self.refuses("SECRET_BACKEND_UNSAFE")

    def test_locked_collection_still_refuses_without_unlock(self):
        self.collection.get_locked.return_value = True
        self.refuses("SECRET_BACKEND_LOCKED")
        self.service.unlock_sync.assert_not_called()

    def enable_reuse(self, replies):
        reuse = patch.object(helper, "REUSE_CONNECTION", True)
        reuse.start()
        self.addCleanup(reuse.stop)
        connection = patch.object(helper, "_connection", None)
        connection.start()
        self.addCleanup(connection.stop)
        self.bus.call_sync.side_effect = [Mock(unpack=lambda value=value: (value,)) for value in replies]

    def test_warm_connection_rechecks_custody_and_observes_fresh_lock(self):
        self.enable_reuse([":1.8", 4321, 1000, ":1.8", 4321, 1000, False,
                           ":1.8", 4321, 1000, True])
        self.assertIs(helper.secure_service()[-1], self.service)
        self.assertIs(helper.secure_service()[-1], self.service)
        self.refuses("SECRET_BACKEND_LOCKED")
        self.assertIsNone(helper._connection)
        self.assertEqual(self.socket.get_credentials.call_count, 3)
        self.assertEqual(helper.encrypted_keyring_file.call_count, 3)
        self.Secret.Service.open_sync.assert_called_once()
        self.assertEqual(self.bus.call_sync.call_args.args[:4],
                         (":1.8", helper.COLLECTION, "org.freedesktop.DBus.Properties", "Get"))
        self.service.unlock_sync.assert_not_called()

    def test_warm_connection_does_not_accept_changed_owner_or_executable(self):
        self.enable_reuse([":1.8", 4321, 1000, ":1.9", 4322, 1000])
        helper.secure_service()
        self.refuses("SECRET_BACKEND_UNAVAILABLE")
        self.assertIsNone(helper._connection)
        self.assertEqual(self.Secret.Service.open_sync.call_count, 2)
        self.assertEqual(self.Secret.Service.open_sync.call_args.args[1], ":1.9")

    def test_warm_connection_does_not_accept_unreadable_or_non_boolean_lock(self):
        self.enable_reuse([":1.8", 4321, 1000, ":1.8", 4321, 1000, "false"])
        helper.secure_service()
        self.refuses("SECRET_BACKEND_UNAVAILABLE")
        self.assertIsNone(helper._connection)

    def test_warm_connection_does_not_reuse_a_custody_verdict(self):
        self.enable_reuse([":1.8", 4321, 1000, ":1.8", 4321, 1000])
        helper.secure_service()
        helper.encrypted_keyring_file.side_effect = helper.Refusal("SECRET_BACKEND_UNSAFE")
        self.refuses("SECRET_BACKEND_UNSAFE")
        self.assertIsNone(helper._connection)


class FixedDeletion(unittest.TestCase):
    def setUp(self):
        self.key = "custom.online_fra_device_credential_v1"
        self.identity_key = "custom.online_fra_device_identity_v1"
        self.master = bytes(range(32))
        self.request = {"action": "clear-device-credential", "file": "/unit-only/vault.json"}
        self.data = {"format": helper.FORMAT, "backend": helper.BACKEND,
                     "identity": "af8e782c-844b-43d2-8597-a57b4a81108b", "records": {}}
        for index, key in enumerate((self.key, self.identity_key, "custom.other")):
            nonce = bytes([index + 1]) * 12
            aad = helper.encoded([helper.FORMAT, helper.BACKEND, self.data["identity"], key])
            cipher = AESGCM(self.master).encrypt(nonce, b"synthetic-boundary-record", aad)
            self.data["records"][key] = base64.b64encode(nonce + cipher).decode("ascii")
        self.service = (None, AESGCM, None, None, None, None)

    def call(self, data):
        return helper.operate(self.request, self.service, 123, "vault.json", data)

    def test_actual_aes_authenticated_removal_preserves_every_other_record(self):
        expected = copy.deepcopy(self.data)
        del expected["records"][self.key]
        with patch.object(helper, "master_key", return_value=self.master) as key, patch.object(helper, "write_vault") as writer:
            self.assertEqual(self.call(self.data), {"key": self.key, "status": "cleared", "mutationOutcome": "REMOVED_SYNCED"})
            writer.assert_called_once_with(123, "vault.json", expected, mutation=None)
            self.assertEqual(self.data, expected)
            self.assertNotIn("create", key.call_args.kwargs)

    def test_no_store_and_absent_record_do_not_write_or_create_key(self):
        with patch.object(helper, "master_key", return_value=self.master) as key, patch.object(helper, "write_vault") as writer:
            self.assertEqual(self.call(None), {"key": self.key, "status": "absent", "mutationOutcome": "NOT_ATTEMPTED"})
            key.assert_not_called()
            del self.data["records"][self.key]
            self.assertEqual(self.call(self.data), {"key": self.key, "status": "absent", "mutationOutcome": "NOT_ATTEMPTED"})
            writer.assert_not_called()
            self.assertNotIn("create", key.call_args.kwargs)

    def test_record_substitution_refuses_without_mutation(self):
        self.data["records"][self.key] = self.data["records"][self.identity_key]
        original = copy.deepcopy(self.data)
        with patch.object(helper, "master_key", return_value=self.master), patch.object(helper, "write_vault") as writer:
            with self.assertRaises(helper.Refusal) as caught:
                self.call(self.data)
            self.assertEqual(caught.exception.code, "SECRET_VAULT_UNREADABLE")
            self.assertEqual(self.data, original)
            writer.assert_not_called()

    def test_missing_key_and_write_failure_never_answer_cleared(self):
        for boundary, code in (("master_key", "SECRET_BACKEND_KEY_MISSING"), ("write_vault", "SECRET_VAULT_WRITE_FAILED")):
            with self.subTest(boundary=boundary), patch.object(helper, "master_key", return_value=self.master), patch.object(helper, "write_vault"), patch.object(helper, boundary, side_effect=helper.Refusal(code)):
                with self.assertRaises(helper.Refusal) as caught:
                    self.call(copy.deepcopy(self.data))
                self.assertEqual(caught.exception.code, code)

    def test_fixed_action_rejects_key_value_and_extra_fields(self):
        helper.validate_request(self.request)
        for field in ("key", "value", "keys", "entries"):
            with self.subTest(field=field), self.assertRaises(helper.Refusal) as caught:
                helper.validate_request({**self.request, field: self.identity_key})
            self.assertEqual(caught.exception.code, "SECRET_INPUT_INVALID")


class AdministrativeCommit(unittest.TestCase):
    """Real encrypted file/lock transactions, injected service and failure cuts.

    Actual service custody is separately covered by the private GNOME suite.
    """
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="te-admin-boundary-")
        self.addCleanup(self.directory.cleanup)
        self.file = os.path.join(self.directory.name, "vault.json")
        self.master = bytes(range(32))
        self.identity = Ed25519PrivateKey.generate()
        self.public = base64.urlsafe_b64encode(self.identity.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).decode().rstrip("=")
        self.pem = self.identity.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption()).decode()
        self.operation = "a" * 48
        self.context = {"publicKey": self.public}
        self.prepared = {"version": 1, "state": "prepared", "operationId": self.operation,
                         "context": self.context, "enrollmentRequest": {"synthetic": True}, "transportPrivateKeyPem": "disposable"}
        self.service = (None, AESGCM, None, None, None, None)
        for seam in (patch.object(helper, "secure_service", return_value=self.service),
                     patch.object(helper, "master_key", return_value=self.master)):
            seam.start()
            self.addCleanup(seam.stop)
        helper.process_request({"action": "set-many", "file": self.file, "entries": [
            {"key": helper.DEVICE_IDENTITY_KEY, "value": self.pem}, {"key": "custom.unrelated", "value": "disposable-other"}]})

    def wire(self, value):
        return helper.encoded(value).decode()

    def request(self, transition, before=None, record=None, credential=None):
        return {"action": "admin-device-operation", "file": self.file, "operationId": self.operation,
                "publicKey": self.public, "transition": transition,
                "expectedHash": hashlib.sha256(before.encode()).hexdigest() if before else None,
                "record": self.wire(record) if record else None, "credential": credential}

    def prepare(self):
        helper.request_result(self.request("prepare", record=self.prepared))
        return self.wire(self.prepared)

    def store_request(self):
        raw = self.prepare()
        grant = self.wire({"syntheticCredential": "private-disposable-token"})
        record = {**self.prepared, "state": "stored", "credentialHash": hashlib.sha256(grant.encode()).hexdigest()}
        del record["transportPrivateKeyPem"]
        return self.request("store", raw, record, grant)

    def test_fixed_request_does_not_accept_caller_selected_keys(self):
        request = self.request("inspect")
        helper.validate_request(request)
        for field in ("key", "entries", "keys", "value"):
            with self.subTest(field=field), self.assertRaises(helper.Refusal):
                helper.validate_request({**request, field: "custom.unrelated"})

    def test_missing_store_and_identity_never_create_custody(self):
        request = {**self.request("inspect"), "file": os.path.join(self.directory.name, "absent.json")}
        with self.assertRaises(helper.Refusal) as caught:
            helper.request_result(request)
        self.assertEqual(caught.exception.mutation_outcome, "NOT_ATTEMPTED")
        self.assertFalse(os.path.exists(request["file"]))

    def test_prepare_cancel_and_wrong_operation_preserve_unrelated_records(self):
        raw = self.prepare()
        before = Path(self.file).read_bytes()
        with self.assertRaises(helper.Refusal) as caught:
            helper.request_result({**self.request("inspect"), "operationId": "b" * 48})
        self.assertEqual(caught.exception.code, "ADMIN_OPERATION_CONFLICT")
        self.assertEqual(Path(self.file).read_bytes(), before)
        result = helper.request_result(self.request("cancel", raw))
        self.assertEqual(result, {"record": None, "mutationOutcome": "STORED_SYNCED"})
        self.assertEqual(helper.process_request({"action": "get", "file": self.file, "key": helper.DEVICE_IDENTITY_KEY}), self.pem)
        self.assertEqual(helper.process_request({"action": "get", "file": self.file, "key": "custom.unrelated"}), "disposable-other")

    def test_data_flush_failure_is_not_attempted_and_keeps_original_bytes(self):
        request = self.store_request()
        before = Path(self.file).read_bytes()
        with patch.object(helper.os, "fsync", side_effect=OSError("injected pre-replace flush failure")):
            with self.assertRaises(helper.Refusal) as caught:
                helper.request_result(request)
        self.assertEqual(caught.exception.code, "SECRET_VAULT_WRITE_FAILED")
        self.assertEqual(caught.exception.mutation_outcome, "NOT_ATTEMPTED")
        self.assertEqual(Path(self.file).read_bytes(), before)
        self.assertFalse(any(p.suffix == ".tmp" for p in Path(self.directory.name).iterdir()))

    def test_post_replace_directory_flush_failure_is_uncertain_and_reconcilable(self):
        request = self.store_request()
        before = Path(self.file).read_bytes()
        real_sync = helper.os.fsync
        def sync(fd):
            if helper.stat.S_ISDIR(helper.os.fstat(fd).st_mode):
                raise OSError("injected post-replace directory flush failure")
            return real_sync(fd)
        with patch.object(helper.os, "fsync", side_effect=sync):
            with self.assertRaises(helper.Refusal) as caught:
                helper.request_result(request)
        self.assertEqual(caught.exception.code, "SECRET_VAULT_WRITE_UNCERTAIN")
        self.assertEqual(caught.exception.mutation_outcome, "UNCERTAIN")
        self.assertNotEqual(Path(self.file).read_bytes(), before)
        # A fresh authenticated read + fresh file/directory sync reconciles the
        # visible exact grant; no repeat store or replacement is needed.
        result = helper.request_result(self.request("inspect"))
        self.assertEqual(result["record"], request["record"])
        self.assertNotIn(b"private-disposable-token", Path(self.file).read_bytes())
        self.assertNotIn(b"PRIVATE KEY", Path(self.file).read_bytes())

    def test_failed_reconciliation_sync_cannot_report_durable_receipt(self):
        helper.request_result(self.store_request())
        with patch.object(helper.os, "fsync", side_effect=OSError("injected reconciliation failure")):
            with self.assertRaises(helper.Refusal):
                helper.request_result(self.request("inspect"))

    def test_changed_current_identity_and_concurrent_grant_refuse(self):
        request = self.store_request()
        helper.process_request({"action": "set-many", "file": self.file, "entries": [
            {"key": helper.DEVICE_CREDENTIAL_KEY, "value": "unrelated grant"}]})
        before = Path(self.file).read_bytes()
        with self.assertRaises(helper.Refusal) as caught:
            helper.request_result(request)
        self.assertEqual(caught.exception.code, "ADMIN_CREDENTIAL_CONFLICT")
        self.assertEqual(Path(self.file).read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
