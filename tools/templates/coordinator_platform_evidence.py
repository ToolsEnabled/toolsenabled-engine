"""Generated P10 evidence verifier.

This module is read-only, uses only the Python standard library, and deliberately
offers no protected-content read API. Runtime authorization remains the owning
application's responsibility; exact task/scope matching is still mandatory.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
import struct
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

POLICY = __POLICY_JSON__
RECORD_SCHEMA = __SCHEMA_JSON__
PROVENANCE_POLICY = __PROVENANCE_POLICY_JSON__
REDACTION_POLICY = __REDACTION_POLICY_JSON__
REDACTION_REPORT_SCHEMA = __REDACTION_REPORT_SCHEMA_JSON__
_HASH = re.compile(r"^[a-f0-9]{64}$")
_MEDIA_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}/[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$")
_SOURCE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$")
_CONTROL_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_PROVENANCE_EVIDENCE_ID = re.compile(PROVENANCE_POLICY["sourceReference"]["evidenceIdPattern"])
_PROVENANCE_CONTENT_HASH = re.compile(PROVENANCE_POLICY["sourceReference"]["contentHashPattern"])
_ID_PATTERNS = {
    "evidence": re.compile(r"^ev_[A-Za-z0-9_-]{32}$"),
    "task": re.compile(r"^tsk_[A-Za-z0-9_-]{32}$"),
    "context": re.compile(r"^ctx_[A-Za-z0-9_-]{32}$"),
    "event": re.compile(r"^evt_[A-Za-z0-9_-]{32}$"),
}
_SAFE_INTEGER = 9007199254740991
_REQUIRED_RECORD_COLUMNS = {
    "sequence", "evidence_id", "task_id", "scope_id", "tool_request_id",
    "kind", "media_type", "summary", "protected_sha256",
    "protected_size_bytes", "protected_format", "public_sha256",
    "public_size_bytes", "public_format", "provenance_json",
    "source_version", "locator_json", "redaction_report_json",
    "retention_class", "expires_at", "created_at", "record_hash",
}
_REQUIRED_TOMBSTONE_COLUMNS = {
    "sequence", "tombstone_id", "evidence_id", "task_id", "scope_id",
    "record_hash", "protected_sha256", "public_sha256", "reason",
    "deleted_at", "tombstone_hash",
}


class EvidenceVerificationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise EvidenceVerificationError(code, message)


def _validate_id(kind: str, value: str) -> str:
    pattern = _ID_PATTERNS[kind]
    if type(value) is not str or pattern.fullmatch(value) is None:
        _fail("EVIDENCE_INVALID_ARGUMENT", f"{kind} identity is invalid")
    return value


def _bounded_text(value: Any, label: str, maximum: int) -> str:
    if (
        type(value) is not str
        or not value
        or len(value) > maximum
        or re.search(r"[\x00-\x1f\x7f]", value) is not None
    ):
        _fail("EVIDENCE_RECORD_INVALID", f"{label} is invalid")
    return value


def _parse_control_timestamp(value: Any, label: str) -> datetime:
    if type(value) is not str or _CONTROL_TIMESTAMP.fullmatch(value) is None:
        _fail("EVIDENCE_RECORD_INVALID", f"{label} is not a P07 control timestamp")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        _fail("EVIDENCE_RECORD_INVALID", f"{label} is not a real UTC timestamp")
    rendered = parsed.strftime("%Y-%m-%dT%H:%M:%S.") + f"{parsed.microsecond // 1000:03d}Z"
    if rendered != value:
        _fail("EVIDENCE_RECORD_INVALID", f"{label} is not canonical")
    return parsed


def _validate_provenance(value: Any) -> None:
    if not isinstance(value, Mapping) or set(value) != {"schemaVersion", "labels", "sources"}:
        _fail("EVIDENCE_RECORD_INVALID", "provenance envelope is not closed")
    labels = value["labels"]
    if (
        value["schemaVersion"] != POLICY["policyVersion"]
        or not isinstance(labels, list)
        or not labels
        or any(type(label) is not str or label not in PROVENANCE_POLICY["labels"] for label in labels)
        or labels != sorted(set(labels))
    ):
        _fail("EVIDENCE_RECORD_INVALID", "provenance labels are invalid")
    sources = value["sources"]
    if not isinstance(sources, list):
        _fail("EVIDENCE_RECORD_INVALID", "provenance sources are invalid")
    keys: list[tuple[str, str]] = []
    for source in sources:
        if (
            not isinstance(source, Mapping)
            or set(source) != {"evidenceId", "contentHash"}
            or type(source["evidenceId"]) is not str
            or _PROVENANCE_EVIDENCE_ID.fullmatch(source["evidenceId"]) is None
            or type(source["contentHash"]) is not str
            or _PROVENANCE_CONTENT_HASH.fullmatch(source["contentHash"]) is None
        ):
            _fail("EVIDENCE_RECORD_INVALID", "provenance source is invalid")
        keys.append((source["evidenceId"], source["contentHash"]))
    if keys != sorted(set(keys)):
        _fail("EVIDENCE_RECORD_INVALID", "provenance sources are not canonical")


def _validate_redaction_report(value: Any) -> None:
    required = {
        "schemaVersion", "serviceId", "egress", "applied", "changed",
        "canaryDetected", "canaryCount", "findingCount", "findings",
    }
    if not isinstance(value, Mapping) or set(value) != required:
        _fail("EVIDENCE_RECORD_INVALID", "redaction report is not closed")
    if (
        value["schemaVersion"] != POLICY["policyVersion"]
        or value["serviceId"] != REDACTION_POLICY["serviceId"]
        or value["egress"] != POLICY["publicExport"]["egress"]
        or value["applied"] is not True
        or type(value["changed"]) is not bool
        or type(value["canaryDetected"]) is not bool
        or type(value["canaryCount"]) is not int
        or not 0 <= value["canaryCount"] <= _SAFE_INTEGER
        or type(value["findingCount"]) is not int
        or not 0 <= value["findingCount"] <= _SAFE_INTEGER
        or not isinstance(value["findings"], list)
    ):
        _fail("EVIDENCE_RECORD_INVALID", "redaction report header is invalid")
    categories = set(
        REDACTION_REPORT_SCHEMA["properties"]["findings"]["items"]["properties"]["category"]["enum"]
    )
    finding_keys: list[tuple[str, str, str]] = []
    total = 0
    for finding in value["findings"]:
        if (
            not isinstance(finding, Mapping)
            or set(finding) != {"path", "detectorId", "category", "count"}
            or type(finding["path"]) is not str
            or not 1 <= len(finding["path"]) <= 512
            or type(finding["detectorId"]) is not str
            or re.fullmatch(r"[a-z][a-z0-9-]{0,63}", finding["detectorId"]) is None
            or type(finding["category"]) is not str
            or finding["category"] not in categories
            or type(finding["count"]) is not int
            or not 1 <= finding["count"] <= _SAFE_INTEGER
        ):
            _fail("EVIDENCE_RECORD_INVALID", "redaction finding is invalid")
        finding_keys.append((finding["path"], finding["detectorId"], finding["category"]))
        total += finding["count"]
    if (
        finding_keys != sorted(set(finding_keys))
        or total != value["findingCount"]
        or total > _SAFE_INTEGER
        or value["changed"] != (total > 0)
        or value["canaryDetected"] != (value["canaryCount"] > 0)
    ):
        _fail("EVIDENCE_RECORD_INVALID", "redaction report counts are inconsistent")


def _normalize(value: Any, path: str = "$") -> Any:
    if value is None or type(value) in (bool, str):
        return value
    if type(value) is int:
        if abs(value) > _SAFE_INTEGER:
            _fail("EVIDENCE_RECORD_INVALID", f"{path} is outside the safe-integer range")
        return 0 if value == 0 else value
    if type(value) is float:
        if not value.is_integer() or abs(value) > _SAFE_INTEGER:
            _fail("EVIDENCE_RECORD_INVALID", f"{path} is not a canonical safe integer")
        return int(value)
    if isinstance(value, list):
        return [_normalize(item, f"{path}[{index}]") for index, item in enumerate(value)]
    if isinstance(value, Mapping):
        output: dict[str, Any] = {}
        for key in sorted(value):
            if type(key) is not str or any(ord(character) < 0x20 or ord(character) > 0x7E for character in key):
                _fail("EVIDENCE_RECORD_INVALID", f"{path} has a non-ASCII object key")
            output[key] = _normalize(value[key], f"{path}.{key}")
        return output
    _fail("EVIDENCE_RECORD_INVALID", f"{path} is not a canonical JSON value")


def canonical_string(value: Any) -> str:
    return json.dumps(
        _normalize(value), ensure_ascii=True, sort_keys=True,
        separators=(",", ":"), allow_nan=False,
    )


def canonical_hash(domain: str, value: Any) -> str:
    if type(domain) is not str or re.fullmatch(r"[a-z][a-z0-9:._-]{0,127}", domain) is None:
        _fail("EVIDENCE_RECORD_INVALID", "hash domain is invalid")
    domain_bytes = domain.encode("ascii")
    payload = canonical_string(value).encode("ascii")
    frame = (
        b"coordinator-platform-hash-v1" + b"\x00"
        + struct.pack(">Q", len(domain_bytes)) + domain_bytes
        + struct.pack(">Q", len(payload)) + payload
    )
    return hashlib.sha256(frame).hexdigest()


def _connect_read_only(db_path: str | os.PathLike[str]) -> sqlite3.Connection:
    selected = Path(db_path).resolve(strict=True)
    connection = sqlite3.connect(selected.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    application_id = connection.execute("PRAGMA application_id").fetchone()[0]
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if application_id != POLICY["database"]["applicationId"]:
        connection.close()
        _fail("EVIDENCE_DATABASE_IDENTITY", "database application identity is invalid")
    if version != POLICY["database"]["schemaVersion"]:
        connection.close()
        _fail("EVIDENCE_SCHEMA_INVALID", "database schema version is invalid")
    schema_rows = connection.execute(
        """
        SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name
        """
    ).fetchall()
    fingerprint_input = [
        [
            row["type"], row["name"], row["tbl_name"],
            re.sub(r"\s+", " ", str(row["sql"])).strip(),
        ]
        for row in schema_rows
    ]
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_input, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    if fingerprint != POLICY["database"]["schemaFingerprint"]:
        connection.close()
        _fail("EVIDENCE_SCHEMA_INVALID", "database DDL fingerprint is invalid")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        connection.close()
        _fail("EVIDENCE_SCHEMA_INVALID", "database foreign-key bindings are invalid")
    records = {row["name"] for row in connection.execute("PRAGMA table_info(evidence_records)")}
    tombstones = {row["name"] for row in connection.execute("PRAGMA table_info(evidence_tombstones)")}
    if records != _REQUIRED_RECORD_COLUMNS or tombstones != _REQUIRED_TOMBSTONE_COLUMNS:
        connection.close()
        _fail("EVIDENCE_SCHEMA_INVALID", "database columns do not match the P10 contract")
    return connection


def _parse_json(value: str, label: str) -> Any:
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        _fail("EVIDENCE_RECORD_INVALID", f"{label} is invalid JSON")


def _record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "schemaVersion": POLICY["policyVersion"],
        "evidenceId": row["evidence_id"],
        "taskId": row["task_id"],
        "scopeId": row["scope_id"],
        "toolRequestId": row["tool_request_id"],
        "kind": row["kind"],
        "mediaType": row["media_type"],
        "summary": row["summary"],
        "protectedContent": {
            "sha256": row["protected_sha256"],
            "sizeBytes": row["protected_size_bytes"],
            "format": row["protected_format"],
        },
        "publicContent": {
            "sha256": row["public_sha256"],
            "sizeBytes": row["public_size_bytes"],
            "format": row["public_format"],
        },
        "provenance": _parse_json(row["provenance_json"], "provenance"),
        "sourceVersion": row["source_version"],
        "locator": _parse_json(row["locator_json"], "locator"),
        "redactionReport": _parse_json(row["redaction_report_json"], "redaction report"),
        "retentionClass": row["retention_class"],
        "expiresAt": row["expires_at"],
        "createdAt": row["created_at"],
        "recordHash": row["record_hash"],
    }


def _tombstone(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "schemaVersion": POLICY["policyVersion"],
        "tombstoneId": row["tombstone_id"],
        "evidenceId": row["evidence_id"],
        "taskId": row["task_id"],
        "scopeId": row["scope_id"],
        "recordHash": row["record_hash"],
        "protectedSha256": row["protected_sha256"],
        "publicSha256": row["public_sha256"],
        "reason": row["reason"],
        "deletedAt": row["deleted_at"],
        "tombstoneHash": row["tombstone_hash"],
    }


def _without(value: Mapping[str, Any], field: str) -> dict[str, Any]:
    return {key: item for key, item in value.items() if key != field}


def _validate_record(record: Mapping[str, Any]) -> dict[str, Any]:
    if set(record) != set(RECORD_SCHEMA["required"]):
        _fail("EVIDENCE_RECORD_INVALID", "evidence record fields are invalid")
    if record["schemaVersion"] != POLICY["policyVersion"]:
        _fail("EVIDENCE_RECORD_INVALID", "evidence record version is invalid")
    _validate_id("evidence", record["evidenceId"])
    _validate_id("task", record["taskId"])
    _validate_id("context", record["scopeId"])
    _validate_id("event", record["toolRequestId"])
    if record["kind"] not in POLICY["recordKinds"]:
        _fail("EVIDENCE_RECORD_INVALID", "evidence kind is invalid")
    if type(record["mediaType"]) is not str or _MEDIA_TYPE.fullmatch(record["mediaType"]) is None:
        _fail("EVIDENCE_RECORD_INVALID", "evidence media type is invalid")
    _bounded_text(record["summary"], "summary", POLICY["limits"]["summaryCharacters"])
    for name, formats, maximum in (
        ("protectedContent", set(POLICY["contentFormats"]["protected"]), POLICY["limits"]["protectedObjectBytes"]),
        ("publicContent", set(POLICY["contentFormats"]["public"]), POLICY["limits"]["publicObjectBytes"]),
    ):
        descriptor = record[name]
        if (
            not isinstance(descriptor, Mapping)
            or set(descriptor) != {"sha256", "sizeBytes", "format"}
            or type(descriptor["sha256"]) is not str
            or _HASH.fullmatch(descriptor["sha256"]) is None
            or type(descriptor["sizeBytes"]) is not int
            or not 0 <= descriptor["sizeBytes"] <= maximum
            or descriptor["format"] not in formats
        ):
            _fail("EVIDENCE_RECORD_INVALID", f"{name} descriptor is invalid")
    _validate_provenance(record["provenance"])
    _bounded_text(
        record["sourceVersion"],
        "sourceVersion",
        POLICY["limits"]["sourceVersionCharacters"],
    )
    if _SOURCE_VERSION.fullmatch(record["sourceVersion"]) is None:
        _fail("EVIDENCE_RECORD_INVALID", "sourceVersion is not an opaque version token")
    locator = record["locator"]
    if (
        not isinstance(locator, Mapping)
        or set(locator) != {"kind", "value"}
        or locator["kind"] not in POLICY["locatorKinds"]
    ):
        _fail("EVIDENCE_RECORD_INVALID", "locator is invalid")
    _bounded_text(locator["value"], "locator.value", POLICY["limits"]["locatorValueCharacters"])
    _validate_redaction_report(record["redactionReport"])
    retention_class = record["retentionClass"]
    if retention_class not in POLICY["retention"]["classes"]:
        _fail("EVIDENCE_RECORD_INVALID", "retention class is invalid")
    created = _parse_control_timestamp(record["createdAt"], "createdAt")
    max_age_ms = POLICY["retention"]["classes"][retention_class]["maxAgeMs"]
    if max_age_ms is None:
        expected_expiry = None
    else:
        try:
            expires = created + timedelta(milliseconds=max_age_ms)
        except OverflowError:
            _fail("EVIDENCE_RECORD_INVALID", "retention expiry is outside the supported range")
        expected_expiry = expires.strftime("%Y-%m-%dT%H:%M:%S.") + f"{expires.microsecond // 1000:03d}Z"
    if record["expiresAt"] != expected_expiry:
        _fail("EVIDENCE_RECORD_INVALID", "retention expiry is invalid")
    if type(record["recordHash"]) is not str or _HASH.fullmatch(record["recordHash"]) is None:
        _fail("EVIDENCE_RECORD_INVALID", "record hash syntax is invalid")
    expected = canonical_hash(POLICY["recordHash"]["domain"], _without(record, "recordHash"))
    if expected != record["recordHash"]:
        _fail("EVIDENCE_RECORD_INVALID", "record hash is invalid")
    return dict(record)


def _validate_tombstone(
    tombstone: Mapping[str, Any],
    record: Mapping[str, Any] | None,
) -> dict[str, Any]:
    required = {
        "schemaVersion", "tombstoneId", "evidenceId", "taskId", "scopeId",
        "recordHash", "protectedSha256", "publicSha256", "reason",
        "deletedAt", "tombstoneHash",
    }
    if set(tombstone) != required or tombstone["schemaVersion"] != POLICY["policyVersion"]:
        _fail("EVIDENCE_TOMBSTONE_INVALID", "tombstone fields are invalid")
    _validate_id("event", tombstone["tombstoneId"])
    _validate_id("evidence", tombstone["evidenceId"])
    _validate_id("task", tombstone["taskId"])
    _validate_id("context", tombstone["scopeId"])
    if (
        tombstone["reason"] not in POLICY["retention"]["deletion"]["reasonCodes"]
        or any(
            type(tombstone[field]) is not str or _HASH.fullmatch(tombstone[field]) is None
            for field in (
                "recordHash", "protectedSha256", "publicSha256", "tombstoneHash",
            )
        )
    ):
        _fail("EVIDENCE_TOMBSTONE_INVALID", "tombstone metadata is invalid")
    _parse_control_timestamp(tombstone["deletedAt"], "deletedAt")
    expected = canonical_hash(
        POLICY["tombstoneHash"]["domain"],
        _without(tombstone, "tombstoneHash"),
    )
    if expected != tombstone["tombstoneHash"]:
        _fail("EVIDENCE_TOMBSTONE_INVALID", "tombstone hash is invalid")
    if record is None or any(
        (
            tombstone["evidenceId"] != record["evidenceId"],
            tombstone["taskId"] != record["taskId"],
            tombstone["scopeId"] != record["scopeId"],
            tombstone["recordHash"] != record["recordHash"],
            tombstone["protectedSha256"] != record["protectedContent"]["sha256"],
            tombstone["publicSha256"] != record["publicContent"]["sha256"],
        )
    ):
        _fail("EVIDENCE_TOMBSTONE_INVALID", "tombstone does not bind its evidence record")
    return dict(tombstone)


def _object_path(object_root: str | os.PathLike[str], digest: str) -> Path:
    if type(digest) is not str or _HASH.fullmatch(digest) is None:
        _fail("EVIDENCE_RECORD_INVALID", "content digest is invalid")
    selected_root = Path(object_root).absolute()
    selected_details = selected_root.lstat()
    if not stat.S_ISDIR(selected_details.st_mode) or selected_root.is_symlink():
        _fail("EVIDENCE_STORAGE_UNSAFE", "object root is not a real directory")
    root = selected_root.resolve(strict=True)
    directory = root
    for segment in ("objects", "sha256", digest[:2], digest[2:4]):
        directory = directory / segment
        try:
            details = directory.lstat()
        except FileNotFoundError:
            _fail("EVIDENCE_OBJECT_MISSING", "content-addressed object is missing")
        if not stat.S_ISDIR(details.st_mode) or directory.is_symlink():
            _fail("EVIDENCE_STORAGE_UNSAFE", "content-addressed object has an unsafe directory")
        directory = directory.resolve(strict=True)
        try:
            if os.path.commonpath((os.fspath(root), os.fspath(directory))) != os.fspath(root):
                _fail("EVIDENCE_STORAGE_UNSAFE", "content-addressed object escaped its root")
        except ValueError:
            _fail("EVIDENCE_STORAGE_UNSAFE", "content-addressed object escaped its volume")
    candidate = directory / f"{digest}.blob"
    try:
        details = candidate.lstat()
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError:
        _fail("EVIDENCE_OBJECT_MISSING", "content-addressed object is missing")
    try:
        if os.path.commonpath((os.fspath(root), os.fspath(resolved))) != os.fspath(root):
            _fail("EVIDENCE_STORAGE_UNSAFE", "content-addressed object escaped its root")
    except ValueError:
        _fail("EVIDENCE_STORAGE_UNSAFE", "content-addressed object escaped its volume")
    if not stat.S_ISREG(details.st_mode) or candidate.is_symlink():
        _fail("EVIDENCE_STORAGE_UNSAFE", "content-addressed object is not a regular file")
    return resolved


def _verify_open_blob(source: Any, digest: str, expected_bytes: int) -> os.stat_result:
    if type(expected_bytes) is not int or expected_bytes < 0 or expected_bytes > _SAFE_INTEGER:
        _fail("EVIDENCE_RECORD_INVALID", "content length is invalid")
    hasher = hashlib.sha256()
    total = 0
    before = os.fstat(source.fileno())
    if before.st_size != expected_bytes:
        _fail("EVIDENCE_OBJECT_TAMPERED", "content-addressed object size changed")
    source.seek(0)
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        hasher.update(chunk)
        total += len(chunk)
    after = os.fstat(source.fileno())
    if total != expected_bytes or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        _fail("EVIDENCE_OBJECT_TAMPERED", "content-addressed object changed while verifying")
    if hasher.hexdigest() != digest:
        _fail("EVIDENCE_OBJECT_TAMPERED", "content-addressed object hash changed")
    return after


def _verify_blob(object_root: str | os.PathLike[str], digest: str, expected_bytes: int) -> None:
    filename = _object_path(object_root, digest)
    with filename.open("rb") as source:
        _verify_open_blob(source, digest, expected_bytes)


def _safe_record(record: Mapping[str, Any], sequence: int) -> dict[str, Any]:
    labels = list(record["provenance"]["labels"])
    return {
        "schemaVersion": record["schemaVersion"],
        "sequence": sequence,
        "evidenceId": record["evidenceId"],
        "taskId": record["taskId"],
        "scopeId": record["scopeId"],
        "toolRequestId": record["toolRequestId"],
        "kind": record["kind"],
        "mediaType": record["mediaType"],
        "summary": record["summary"],
        "publicContent": dict(record["publicContent"]),
        "provenance": {
            "labels": labels,
            "sourceCount": len(record["provenance"]["sources"]),
            "containsSecret": "secret" in labels or "secret-derived" in labels,
        },
        "retentionClass": record["retentionClass"],
        "expiresAt": record["expiresAt"],
        "createdAt": record["createdAt"],
        "recordHash": record["recordHash"],
        "tombstoned": False,
    }


def _authorize(
    authorize: Any,
    operation: str,
    access: Any,
    task_id: str,
    scope_id: str,
    evidence_id: str,
) -> None:
    if not callable(authorize):
        _fail("EVIDENCE_ACCESS_DENIED", "evidence access was denied")
    try:
        allowed = authorize(
            {
                "operation": operation,
                "access": access,
                "binding": {
                    "taskId": task_id,
                    "scopeId": scope_id,
                    "evidenceId": evidence_id,
                },
            }
        )
    except Exception as error:
        raise EvidenceVerificationError("EVIDENCE_ACCESS_DENIED", "evidence access was denied") from error
    if allowed is not True:
        _fail("EVIDENCE_ACCESS_DENIED", "evidence access was denied")


def get_public_record(
    db_path: str | os.PathLike[str],
    evidence_id: str,
    task_id: str,
    scope_id: str,
    *,
    access: Any = None,
    authorize: Any = None,
) -> dict[str, Any]:
    _validate_id("evidence", evidence_id)
    _validate_id("task", task_id)
    _validate_id("context", scope_id)
    _authorize(authorize, "read-public", access, task_id, scope_id, evidence_id)
    connection = _connect_read_only(db_path)
    try:
        row = connection.execute(
            """
            SELECT r.* FROM evidence_records r
            LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id
            WHERE r.evidence_id=? AND r.task_id=? AND r.scope_id=?
              AND t.evidence_id IS NULL
            """,
            (evidence_id, task_id, scope_id),
        ).fetchone()
        if row is None:
            _fail("EVIDENCE_ACCESS_DENIED", "evidence access was denied")
        record = _validate_record(_record(row))
        return _safe_record(record, row["sequence"])
    finally:
        connection.close()


def read_public_span(
    db_path: str | os.PathLike[str],
    object_root: str | os.PathLike[str],
    evidence_id: str,
    task_id: str,
    scope_id: str,
    offset: int,
    length: int,
    *,
    access: Any = None,
    authorize: Any = None,
) -> dict[str, Any]:
    if type(offset) is not int or offset < 0:
        _fail("EVIDENCE_INVALID_ARGUMENT", "span offset is invalid")
    if type(length) is not int or length < 1 or length > POLICY["limits"]["spanBytes"]:
        _fail("EVIDENCE_INVALID_ARGUMENT", "span length is invalid")
    record = get_public_record(
        db_path, evidence_id, task_id, scope_id,
        access=access, authorize=authorize,
    )
    descriptor = record["publicContent"]
    if offset > descriptor["sizeBytes"] or length > descriptor["sizeBytes"] - offset:
        _fail("EVIDENCE_SPAN_INVALID", "requested public span is outside the object")
    filename = _object_path(object_root, descriptor["sha256"])
    with filename.open("rb") as source:
        checked = _verify_open_blob(source, descriptor["sha256"], descriptor["sizeBytes"])
        source.seek(offset)
        content = source.read(length)
        after = os.fstat(source.fileno())
    if checked.st_size != after.st_size or checked.st_mtime_ns != after.st_mtime_ns:
        _fail("EVIDENCE_OBJECT_TAMPERED", "public object changed during span read")
    if len(content) != length:
        _fail("EVIDENCE_OBJECT_TAMPERED", "public object changed during span read")
    return {
        "bytes": content,
        "offset": offset,
        "length": length,
        "totalBytes": descriptor["sizeBytes"],
        "sha256": descriptor["sha256"],
    }


def verify_store(
    db_path: str | os.PathLike[str],
    object_root: str | os.PathLike[str],
) -> dict[str, Any]:
    connection = _connect_read_only(db_path)
    failures: list[dict[str, str]] = []
    records_by_id: dict[str, dict[str, Any]] = {}
    objects_verified = 0
    active = 0
    try:
        quick = connection.execute("PRAGMA quick_check").fetchall()
        if len(quick) != 1 or quick[0][0] != "ok":
            return {
                "ok": False, "code": "EVIDENCE_DATABASE_CORRUPT",
                "records": 0, "activeRecords": 0, "tombstones": 0,
                "objectsVerified": 0, "failures": [],
            }
        rows = connection.execute(
            """
            SELECT r.*, t.tombstone_id FROM evidence_records r
            LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id
            ORDER BY r.sequence
            """
        ).fetchall()
        tombstones = connection.execute(
            "SELECT * FROM evidence_tombstones ORDER BY sequence"
        ).fetchall()
        for row in rows:
            evidence_id = row["evidence_id"]
            try:
                record = _validate_record(_record(row))
                records_by_id[evidence_id] = record
            except EvidenceVerificationError:
                failures.append({"evidenceId": evidence_id, "part": "record", "reason": "invalid"})
                continue
            if row["tombstone_id"] is not None:
                continue
            active += 1
            for part in ("protectedContent", "publicContent"):
                descriptor = record[part]
                try:
                    _verify_blob(object_root, descriptor["sha256"], descriptor["sizeBytes"])
                    objects_verified += 1
                except EvidenceVerificationError as error:
                    failures.append({
                        "evidenceId": evidence_id,
                        "part": "protected" if part == "protectedContent" else "public",
                        "reason": error.code,
                    })
        for row in tombstones:
            evidence_id = row["evidence_id"]
            try:
                record = records_by_id.get(evidence_id)
                _validate_tombstone(_tombstone(row), record)
            except EvidenceVerificationError as error:
                reason = "binding" if "bind" in str(error).lower() else "invalid"
                failures.append({"evidenceId": evidence_id, "part": "tombstone", "reason": reason})
        return {
            "ok": not failures,
            "code": "OK" if not failures else "EVIDENCE_INTEGRITY_FAILURE",
            "schemaVersion": POLICY["database"]["schemaVersion"],
            "records": len(rows),
            "activeRecords": active,
            "tombstones": len(tombstones),
            "objectsVerified": objects_verified,
            "failures": failures,
        }
    finally:
        connection.close()


__all__ = [
    "EvidenceVerificationError",
    "POLICY",
    "RECORD_SCHEMA",
    "canonical_hash",
    "canonical_string",
    "get_public_record",
    "read_public_span",
    "verify_store",
]
