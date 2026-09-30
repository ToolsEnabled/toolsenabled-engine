"""Bounded K3 happy paths and named policy refusals against the installed MCP.

Stateful queue/ledger and agent lifecycle checks belong to K4/K6. This table
records that dependency; it does not claim those later scenarios have passed.
"""

from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from core import require, tool_ok, tool_value


DEFERRED = {
    **{name: "K4" for name in """
        task.submit task.claim task.start task.heartbeat task.checkpoint task.complete
        task.fail task.cancel task.get task.list ledger.read t_ledger.file
        t_ledger.progress t_ledger.complete a_ledger.file
    """.split()},
    **{name: "K6" for name in """
        agent.spawn agent.stop agent.restart agent.remove agent.resume
        agent.set_model agent.set_effort agent.set_provider
        agent_comms.send_local agent_comms.local_roster
    """.split()},
}


def check_surface(root: Path, call: Callable[[str, dict, str], dict]) -> dict[str, Any]:
    positive: set[str] = set()
    refusal: dict[str, str] = {}

    def ok(name: str, arguments: dict | None = None) -> dict:
        value = tool_ok(call(name, arguments or {}, "valid"), name)
        positive.add(name)
        return value

    def refused(name: str, arguments: dict, code: str) -> None:
        reply = call(name, arguments, "refusal")
        actual = tool_value(reply).get("error", {}).get("code")
        require(reply.get("result", {}).get("isError") is True and actual == code,
                "SURFACE_REFUSAL", f"{name}: expected {code}, got {actual}")
        refusal[name] = code

    settings = ok("settings.read", {"ids": ["audit.enabled", "rules.filing_from"]}).get("values", {})
    activity_audit_enabled = settings.get("audit.enabled")
    require(isinstance(activity_audit_enabled, bool), "SURFACE_SETTINGS", "settings.read omitted audit.enabled")
    require(settings.get("rules.filing_from") in ("Ledger page only", "Ledger page and /Request"),
            "SURFACE_RULE_SETTING", "Fresh scratch setup did not keep agent rule filing off")
    refused("r_ledger.file", {"actor": "codex", "scope": "global", "words": "Scratch soak fixture"},
            "R_LEDGER_AGENT_FILING_OFF")

    # Search is permitted only inside the workspace recorded by K2. Host file
    # calls use the same small directory, never the owner's profile contents.
    fixture = root / "work" / "surface-fixture"
    fixture.mkdir(parents=True)
    path = str(fixture / "surface-file.txt")
    initial, edited = "soak original\n", "soak modified\n"
    ok("host.write_file", {"path": path, "content": initial})
    require(ok("host.read_file", {"path": path}).get("content") == initial,
            "SURFACE_FILE_WRITE", "host.write_file did not persist its content")
    ok("host.patch_file", {"path": path, "oldText": initial, "newText": edited})
    require(ok("host.read_file", {"path": path}).get("content") == edited,
            "SURFACE_FILE_PATCH", "host.patch_file did not persist its content")
    entries = ok("host.list_dir", {"path": str(fixture)}).get("entries", [])
    require(any(row.get("name") == "surface-file.txt" and row.get("type") == "file"
                and row.get("bytes") == len(edited.encode()) for row in entries),
            "SURFACE_FILE_LIST", "host.list_dir did not report the written file and size")

    memory = {"namespace": "soak-surface", "key": "fixture", "value": {"probe": "soak surface marker"}}
    ok("memory.set", memory)
    stored = ok("memory.get", {"namespace": memory["namespace"], "key": memory["key"]})
    require(stored.get("value") == memory["value"], "SURFACE_MEMORY", "Memory value did not round trip")
    hits = ok("memory.search", {"namespace": memory["namespace"], "query": "soak surface marker"})
    require(any(row.get("namespace") == memory["namespace"] and row.get("key") == memory["key"]
                and row.get("value") == memory["value"] for row in hits.get("entries", [])),
            "SURFACE_MEMORY_SEARCH", "memory.search omitted the stored fixture")

    search_root = fixture / "search-sample"
    search_root.mkdir()
    note = search_root / "note.txt"
    note.write_text("soak search sample\n")
    indexed = ok("search.index", {"root": str(search_root), "embedder": "lexical", "maxFiles": 1})
    require(indexed.get("root") == str(search_root) and indexed.get("filesIndexed") == 1
            and indexed.get("chunksIndexed", 0) > 0,
            "SURFACE_SEARCH_INDEX", "search.index did not index the scratch note")
    matches = ok("search.query", {"query": "soak search sample", "root": str(search_root)}).get("matches", [])
    require(any(row.get("path") == str(note) and "soak search sample" in row.get("snippet", "") for row in matches),
            "SURFACE_SEARCH_QUERY", "search.query did not return the indexed note")
    status = ok("search.status")
    require(status.get("files", 0) > 0 and status.get("chunks", 0) > 0
            and any(row.get("root") == str(search_root) and row.get("files") == 1 for row in status.get("roots", [])),
            "SURFACE_SEARCH_STATUS", "search.status omitted the indexed root")

    capabilities = ok("capability.find", {"query": "read a UTF-8 text file", "limit": 10})
    require(capabilities.get("outcome") != "unavailable" and bool(capabilities.get("tools"))
            and any(row.get("id") == "host.read_file" for row in capabilities.get("tools", [])),
            "SURFACE_CAPABILITY", "capability.find could not find the offered file reader")
    status = ok("system.status")
    require(status.get("name") == "ToolsEnabled" and bool(status.get("version"))
            and status.get("state", {}).get("ok") is True,
            "SURFACE_SYSTEM_STATUS", "system.status did not report a healthy scratch state store")
    doctor = ok("system.doctor")
    require(isinstance(doctor.get("node"), str) and doctor.get("mcpServer") is True
            and doctor.get("state", {}).get("ok") is True
            and isinstance(doctor.get("credentialVault"), dict),
            "SURFACE_DOCTOR", "system.doctor omitted installed runtime/state/vault status")

    audit = ok("audit.status")
    # The activity setting controls optional operation summaries. Canonical
    # audit status derives independently from policy.audit.enabled.
    canonical_disabled = audit.get("disabled")
    require(audit.get("ok") is True and isinstance(canonical_disabled, bool),
            "SURFACE_AUDIT_STATUS", "Canonical audit status is unhealthy or missing")
    tail = ok("audit.tail", {"limit": 5}).get("value")
    require(isinstance(tail, list) and len(tail) <= 5, "SURFACE_AUDIT_TAIL", "audit.tail returned no bounded event array")
    verify = ok("audit.verify")
    require(verify.get("valid") is True and verify.get("disabled", False) is canonical_disabled,
            "SURFACE_AUDIT_VERIFY", "Audit verification failed or contradicts canonical status")

    advisor = ok("openshell.status")
    require(advisor.get("insideSandbox") is True and advisor.get("advisor") in ("on", "off"),
            "SURFACE_ADVISOR", "OpenShell advisor status is unknown or outside the expected sandbox", "env")
    if advisor["advisor"] == "on":
        denials = ok("openshell.denials", {"last": 1})
        require(isinstance(denials.get("logAvailable"), bool) and isinstance(denials.get("denials"), list)
                and denials.get("count") == len(denials["denials"]) <= 1,
                "SURFACE_DENIALS", "openshell.denials returned no bounded denial list")
        proposal_code = "OPENSHELL_DENIAL_NOT_RECENT"
    else:
        proposal_code = "OPENSHELL_ADVISOR_DISABLED"
        refused("openshell.denials", {"last": 1}, proposal_code)
    # Unique synthetic text cannot be a recent actual denial. The provider
    # must reject it before submitProposals; never file a live policy request.
    denial = f"NET:OPEN [MED] DENIED /usr/bin/curl(0) -> soak-{uuid4().hex}.invalid:443 [reason:transparent_tcp_policy_denied]"
    refused("openshell.propose", {"denial": denial, "intent": "Scratch refusal probe"}, proposal_code)
    return {"positive": sorted(positive), "refusal": refusal, "deferred": dict(DEFERRED),
            "audit": {"activityEnabled": activity_audit_enabled, "canonicalDisabled": canonical_disabled}}
