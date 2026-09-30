"""K1–K9 checks against an installed candidate archive, never the checkout."""

from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any

from core import Candidate, MCP, SoakError, discover_candidates, extract_candidate, install_candidate, minimal_path, require, run_cli, scratch_env, tool_ok, tool_value
from simulator import Simulator, contract
from leak_watch import LeakWatch


@dataclass
class Iteration:
    candidate: Candidate
    root: Path
    package: Path | None = None
    prefix: Path | None = None
    env: dict[str, str] = field(default_factory=dict)
    server_env: dict[str, str] = field(default_factory=dict)
    timings_ms: dict[str, float] = field(default_factory=dict)
    measures: dict[str, Any] = field(default_factory=dict)
    history: list[dict[str, float]] = field(default_factory=list)
    leak_watch: LeakWatch | None = None


def k1_install(context: Iteration) -> None:
    package = extract_candidate(context.candidate, context.root)
    path_dir = minimal_path(context.root)
    environment = scratch_env(context.root, path_dir=path_dir)
    prefix = install_candidate(package, context.root, environment)
    duplicate = run_cli(prefix, environment, "--help")
    require(duplicate.returncode == 0, "INSTALLED_HELP", "Installed CLI did not answer --help")
    require(json.loads((prefix / "manifest.json").read_text())["source_commit"] == context.candidate.commit,
            "INSTALLED_COMMIT", "Installed manifest does not name this candidate")
    context.package, context.prefix, context.env = package, prefix, environment


def _server_entry(context: Iteration, environment: dict[str, str], agents: bool) -> dict[str, Any]:
    engine = context.prefix / "runtime/engine"
    script = (
        "const m=require('./src/lib/setup/machine-record');"
        "const c=require('./bin/toolsenabled-openshell');"
        "const r=m.readMachineRecord({servicesRoot:m.resolveServicesRoot({})});"
        f"process.stdout.write(JSON.stringify(c.serverEntry(r,{{agents:{str(agents).lower()}}})));"
    )
    result = subprocess.run([shutil.which("node") or "/usr/local/bin/node", "-e", script],
                            cwd=engine, env=environment, text=True, capture_output=True, timeout=30)
    require(result.returncode == 0, "SETUP_ENTRY", f"Could not read candidate server entry: {result.stderr[-500:]}")
    return json.loads(result.stdout)


def k2_setup(context: Iteration) -> None:
    require(context.prefix is not None, "K2_ORDER", "K1 did not install a candidate", "harness")
    for tier in ("guided", "standard", "unrestricted"):
        for agents in (False, True):
            for providers in (("codex",), ("claude",), ("codex", "claude")):
                label = f"{tier}-{'agents' if agents else 'base'}-{'-'.join(providers)}"
                root = context.root / "setup-matrix" / label
                root.mkdir(parents=True)
                path_dir = minimal_path(root, cli_names=providers)
                environment = scratch_env(root, path_dir=path_dir)
                workspace = root / "work"
                args = ["setup", "--tier", tier, "--workspace", str(workspace), "--add"]
                if agents:
                    args += ["--agents", "--providers", ",".join(providers)]
                result = run_cli(context.prefix, environment, *args)
                require(result.returncode == 0, "SETUP_EXIT", f"{label}: {result.stderr[-400:]}")
                require(result.stdout.count("ToolsEnabled added.") == len(providers),
                        "SETUP_REGISTRATION", f"{label}: wrong CLI registration count")
                require("ToolsEnabled is set up" in result.stdout and workspace.is_dir(),
                        "SETUP_WORKSPACE", f"{label}: no setup workspace")
                entry = _server_entry(context, environment, agents)
                names = entry["env"]["TOOLSENABLED_TOOL_ALLOWLIST"].split(",")
                require(len(names) == len(set(names)) and all(names), "SETUP_TOOLS", f"{label}: bad tool list")
                if tier == "unrestricted":
                    require(len(names) == (47 if agents else 36), "SETUP_TOOL_COUNT",
                            f"{label}: expected 47/36 registered tools, found {len(names)}")
                else:
                    require(0 < len(names) <= (47 if agents else 36), "SETUP_TOOL_COUNT",
                            f"{label}: invalid narrowed count {len(names)}")
                first_count = re.search(r"Tools offered\s+(\d+)", result.stdout)
                require(first_count is not None and 0 < int(first_count.group(1)) <= len(names),
                        "SETUP_COUNT_PRINT", f"{label}: printed count differs from entry")

    # Stand-in CLIs exercise the full setup matrix but cannot prove where the
    # real CLIs wrote their MCP registrations. Check both selected profile
    # roots against the installed candidate before calling K2 a pass.
    codex = shutil.which("codex")
    claude = shutil.which("claude")
    require(codex is not None and claude is not None, "SETUP_REAL_CLIS",
            "Codex and Claude CLIs are required for the real profile check", "env")
    profile_root = context.root / "setup-real-cli"
    profile_root.mkdir()
    path_dir = minimal_path(profile_root)
    profile_env = scratch_env(profile_root, path_dir=path_dir)
    profile_env.update({
        "PATH": os.pathsep.join([str(path_dir), str(Path(codex).parent), str(Path(claude).parent)]),
        "CODEX_HOME": str(profile_root / "home" / ".codex"),
        "CLAUDE_CONFIG_DIR": str(profile_root / "home" / ".claude"),
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    })
    Path(profile_env["CODEX_HOME"]).mkdir()
    Path(profile_env["CLAUDE_CONFIG_DIR"]).mkdir()
    registered = run_cli(context.prefix, profile_env, "setup", "--tier", "unrestricted",
                         "--workspace", str(profile_root / "work"), "--agents",
                         "--providers", "codex,claude", "--add")
    require(registered.returncode == 0, "SETUP_REAL_ADD",
            f"Real CLI registration failed: {registered.stderr[-300:]}")
    expected_server = str(context.prefix / "runtime/engine/src/mcp-server.js")
    for name, executable in (("codex", codex), ("claude", claude)):
        listed = subprocess.run([executable, "mcp", "list"], env=profile_env,
                                text=True, capture_output=True, timeout=20)
        output = listed.stdout + listed.stderr
        require(listed.returncode == 0 and "toolsenabled" in output and expected_server in output,
                f"SETUP_REAL_{name.upper()}",
                f"{name} did not list the installed MCP server in its selected profile: {output[-300:]}")
        if name == "claude":
            require("Connected" in output, "SETUP_REAL_CLAUDE_CONNECT",
                    f"Claude did not connect to the selected MCP server: {output[-300:]}")

    # The rest of this iteration uses one clean unrestricted agent-enabled setup.
    workspace = context.root / "work"
    result = run_cli(context.prefix, context.env, "setup", "--tier", "unrestricted",
                     "--workspace", str(workspace), "--agents")
    require(result.returncode == 0, "SETUP_MAIN", f"Main setup failed: {result.stderr[-500:]}")
    entry = _server_entry(context, context.env, True)
    context.server_env = {**context.env, **entry["env"], "TOOLSENABLED_AGENT_ACTOR": "codex"}
    require(context.server_env["TOOLSENABLED_STATE_ROOT"] == context.env["TOOLSENABLED_STATE_ROOT"],
            "SETUP_STATE_ROOT", "Server entry changed the scratch state root")


def _sample_argument(key: str, schema: dict[str, Any], context: Iteration) -> Any:
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]
    fixed = {
        "actor": "codex", "scope": "global", "words": "Soak fixture entry", "id": "T999999",
        "path": str(context.root / "surface-file.txt"), "content": "soak sample\n",
        "oldText": "soak sample", "newText": "soak edited", "root": str(context.root / "search-sample"),
        "queue": "soak-surface", "type": "probe", "idempotencyKey": "soak-surface-once",
        "objective": "Check the scratch queue", "title": "Scratch probe", "expiryPolicy": "uncertain",
        "maxAttempts": 1, "checkpointKey": "soak-checkpoint", "expectedRevision": 0,
        "disposition": "failed", "code": "TEST_FAILURE", "status": "in-progress",
        "reason": "Scratch soak probe", "namespace": "soak", "key": "surface",
        "query": "soak", "denial": "soak-no-such-denial", "intent": "Scratch soak probe",
        "from": "root", "to": "soak-no-such-worker", "body": "Scratch probe",
        "contract": "Scratch soak worker probe", "tier": "cheap", "nodeId": "soak-missing-node",
        "model": "soak-model", "effort": "low", "provider": "codex", "taskId": "soak-missing-task",
        "value": {"fixture": True}, "result": {"summary": "Scratch probe"},
    }
    if key in fixed:
        return fixed[key]
    if isinstance(schema.get("oneOf"), list) and schema["oneOf"]:
        return _sample_argument(key, schema["oneOf"][0], context)
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((part for part in kind if part != "null"), kind[0])
    if kind == "object" or "properties" in schema:
        properties = schema.get("properties") or {}
        return {name: _sample_argument(name, properties.get(name, {}), context)
                for name in schema.get("required", [])}
    if kind == "array":
        return []
    if kind == "integer" or kind == "number":
        return max(0, schema.get("minimum", 0))
    if kind == "boolean":
        return False
    return "a" * max(4, schema.get("minLength", 0))


def k3_surface(context: Iteration) -> None:
    require(context.prefix is not None and bool(context.server_env), "K3_ORDER", "K2 did not set up the server", "harness")
    search_root = context.root / "search-sample"
    search_root.mkdir()
    (search_root / "note.txt").write_text("soak search sample\n")
    with MCP(context.prefix, context.server_env, context.root) as mcp:
        tools = mcp.tools()
        # K2's main fixture is unrestricted, agent-enabled, and uses the
        # shipped Controller lead. Freeze its reviewed surface independently
        # of both tools/list and the candidate's registration allowlist so a
        # missing tool in either cannot weaken this check. The allowlist has
        # 47 names; the Controller legitimately withholds agent.set_role
        # (bin/toolsenabled-openshell.js offeredToLead and role-functions.js).
        expected = frozenset("""
            task.submit task.claim task.start task.heartbeat task.checkpoint task.complete
            task.fail task.cancel task.get task.list ledger.read t_ledger.file
            t_ledger.progress t_ledger.complete r_ledger.file a_ledger.file
            host.read_file host.write_file host.patch_file host.list_dir
            memory.get memory.set memory.search search.index search.query search.status
            settings.read capability.find system.status system.doctor
            audit.status audit.tail audit.verify openshell.status openshell.denials openshell.propose
            agent.spawn agent.stop agent.restart agent.remove agent.resume
            agent.set_model agent.set_effort agent.set_provider
            agent_comms.send_local agent_comms.local_roster
        """.split())
        offered = set(tools)
        require(offered == expected, "SURFACE_LIST",
                f"Controller surface mismatch: missing={sorted(expected - offered)}; "
                f"unexpected={sorted(offered - expected)}")
        latencies = []
        for name, tool in tools.items():
            schema = tool.get("inputSchema") or {}
            # These generated calls check transport and response shape, not
            # successful semantics; frozen hand tests cover each tool's work.
            valid = {key: _sample_argument(key, (schema.get("properties") or {}).get(key, {}), context)
                     for key in schema.get("required", [])}
            if name == "host.list_dir":
                valid["path"] = str(context.root)
            # A wrong top-level type works even for tools without required
            # fields. Required-field omission also exercises each schema.
            invalid = {} if schema.get("required") else []
            for label, arguments in (("invalid", invalid), ("valid", valid)):
                started = time.monotonic()
                reply = mcp.call(name, arguments, timeout=15)
                elapsed = (time.monotonic() - started) * 1000
                latencies.append(elapsed)
                context.timings_ms[f"K3/{name}/{label}"] = elapsed
                require(isinstance(reply.get("error") or reply.get("result"), dict),
                        "TOOL_RESPONSE", f"{name} {label} returned no structured response")
                if label == "invalid":
                    require("error" in reply or reply.get("result", {}).get("isError") is True,
                            "TOOL_INVALID_ACCEPTED", f"{name} accepted an invalid top-level or missing-required input")
                require(mcp.process.poll() is None, "MCP_SURFACE_DIED", f"Server exited after {name} {label}")
        context.measures["tool_latencies_ms"] = latencies


def _submit_task(mcp: MCP, queue: str, key: str) -> str:
    value = tool_ok(mcp.call("task.submit", {
        "queue": queue, "type": "probe", "idempotencyKey": key,
        "payload": {"title": "Scratch soak job", "objective": "Check queue state across two MCP sessions"},
        "expiryPolicy": "uncertain", "maxAttempts": 1,
    }), "task.submit")
    require(isinstance(value.get("taskId"), str), "TASK_SUBMIT", "Queue submission returned no task ID")
    return value["taskId"]


def k4_ledger_tasks(context: Iteration) -> None:
    require(context.prefix is not None and bool(context.server_env), "K4_ORDER", "K2 did not set up the server", "harness")
    with MCP(context.prefix, context.server_env, context.root) as first, MCP(context.prefix, context.server_env, context.root) as second:
        task = tool_ok(first.call("t_ledger.file", {
            "actor": "codex", "scope": "global", "words": "Scratch ledger task", "difficulty": "easy"
        }), "t_ledger.file")
        ask = tool_ok(second.call("a_ledger.file", {
            "actor": "codex", "scope": "global", "words": "Scratch ledger question?"
        }), "a_ledger.file")
        task_id, ask_id = task["id"], ask["id"]
        read = tool_ok(second.call("ledger.read", {"ids": [task_id, ask_id]}), "ledger.read")
        require({row["id"] for row in read["records"]} == {task_id, ask_id},
                "LEDGER_CROSS_SESSION", "Second MCP session did not see both ledger records")
        answered = run_cli(context.prefix, context.env, "ledger", "answer", ask_id, "Scratch answer")
        require(answered.returncode == 0, "LEDGER_ANSWER", f"Answer failed: {answered.stderr[-300:]}")
        tool_ok(first.call("t_ledger.progress", {
            "actor": "codex", "id": task_id, "status": "in-progress", "reason": "Scratch task started"
        }), "t_ledger.progress")
        tool_ok(second.call("t_ledger.complete", {"actor": "codex", "id": task_id}), "t_ledger.complete")
        persisted = tool_ok(first.call("ledger.read", {"ids": [task_id, ask_id]}), "ledger.read")
        records = {row["id"]: row for row in persisted["records"]}
        answered_record = records.get(ask_id, {})
        require(answered_record.get("status") == "answered"
                and (answered_record.get("answer") or {}).get("words") == "Scratch answer",
                "LEDGER_ANSWER_STATE", "The CLI answer was not persisted for the other MCP session")
        require(records.get(task_id, {}).get("status") == "done", "LEDGER_DONE_STATE",
                "The completed ledger task was not done in the other MCP session")
        all_page = run_cli(context.prefix, context.env, "ledger", "--all")
        require(all_page.returncode == 0 and task_id in all_page.stdout and ask_id in all_page.stdout,
                "LEDGER_PAGE", "--all page does not agree with records from both sessions")
        removed = run_cli(context.prefix, context.env, "ledger", "remove", task_id)
        require(removed.returncode == 0, "LEDGER_REMOVE", f"Task removal failed: {removed.stderr[-300:]}")
        read = tool_ok(first.call("ledger.read", {"ids": [task_id], "removed": True}), "ledger.read")
        require(read["records"] and read["records"][0]["status"] == "removed",
                "LEDGER_REMOVED", "Removed task was not visible in the removed ledger view")

        # The ledger's default page is 25. Go past 50 and walk every page;
        # stable revisions prevent a silent skipped or duplicated record.
        expected_ids = set()
        for number in range(52):
            filed = tool_ok(first.call("t_ledger.file", {
                "actor": "codex", "scope": "global", "words": f"Scratch pagination task {number}", "difficulty": "easy"
            }), "t_ledger.file")
            expected_ids.add(filed["id"])
        require(len(expected_ids) == 52, "LEDGER_FILE_IDS", "Pagination setup returned repeated ledger task IDs")
        seen = set()
        offset = 0
        revision = None
        while True:
            page = tool_ok(second.call("ledger.read", {"scope": "global", "kinds": ["T"], "limit": 20,
                                                       "offset": offset}), "ledger.read")
            if revision is None:
                revision = page["revision"]
            require(page["revision"] == revision, "LEDGER_REVISION", "Ledger changed during pagination")
            for row in page["records"]:
                require(row["id"] not in seen, "LEDGER_DUPLICATE", "Ledger pagination repeated an ID")
                seen.add(row["id"])
            next_offset = page.get("nextOffset")
            if next_offset is None:
                break
            require(next_offset > offset, "LEDGER_OFFSET", "Ledger pagination did not advance")
            offset = next_offset
        require(expected_ids <= seen, "LEDGER_PAGES",
                f"Pagination omitted {len(expected_ids - seen)} of the 52 filed records")
        all_page = run_cli(context.prefix, context.env, "ledger", "--all")
        terminal_ids = set(re.findall(r"^(T[1-9]\d*)\s", all_page.stdout, re.MULTILINE))
        require(all_page.returncode == 0 and expected_ids <= terminal_ids, "LEDGER_ALL_PAGES",
                f"The --all terminal page omitted {len(expected_ids - terminal_ids)} of the 52 filed records")

        queue = "soak-complete"
        queued_id = _submit_task(first, queue, "soak-complete-once")
        claim = tool_ok(second.call("task.claim", {"queue": queue, "workerLabel": "soak-worker"}), "task.claim")
        require(claim.get("claimed") is True and claim["handle"]["taskId"] == queued_id,
                "TASK_CLAIM", "Second session did not claim the submitted task")
        handle = claim["handle"]  # Opaque token is never logged or serialized.
        tool_ok(second.call("task.start", {"handle": handle}), "task.start")
        tool_ok(second.call("task.checkpoint", {"handle": handle, "checkpointKey": "soak-progress-one",
                                                "expectedRevision": 0, "checkpoint": {"summary": "Scratch progress"}}), "task.checkpoint")
        checkpoint = tool_ok(first.call("task.get", {"taskId": queued_id, "includeCheckpoint": True}), "task.get")
        latest = checkpoint.get("latestCheckpoint") or {}
        require(checkpoint.get("checkpointRevision") == 1 and latest.get("revision") == 1
                and latest.get("checkpoint") == {"summary": "Scratch progress"},
                "TASK_CHECKPOINT_STATE", "The checkpoint body or revision was not persisted for the other MCP session")
        tool_ok(second.call("task.heartbeat", {"handle": handle}), "task.heartbeat")
        tool_ok(second.call("task.complete", {"handle": handle, "result": {"summary": "Scratch done"}}), "task.complete")
        read_task = tool_ok(first.call("task.get", {"taskId": queued_id}), "task.get")
        require(read_task.get("status") == "succeeded", "TASK_COMPLETE", "First session did not see completion")

        fail_id = _submit_task(first, "soak-fail", "soak-fail-once")
        failed_claim = tool_ok(second.call("task.claim", {"queue": "soak-fail", "workerLabel": "soak-worker"}), "task.claim")
        require(failed_claim.get("claimed") is True, "TASK_FAIL_CLAIM", "Failure task was not claimable")
        tool_ok(second.call("task.start", {"handle": failed_claim["handle"]}), "task.start")
        tool_ok(second.call("task.fail", {"handle": failed_claim["handle"], "disposition": "failed",
                                         "code": "TEST_FAILURE", "message": "Scratch failure"}), "task.fail")
        require(tool_ok(first.call("task.get", {"taskId": fail_id}), "task.get").get("status") == "failed",
                "TASK_FAILED", "First session did not see failed task")

        cancel_id = _submit_task(first, "soak-cancel", "soak-cancel-once")
        tool_ok(second.call("task.cancel", {"taskId": cancel_id, "reason": "Scratch cancel"}), "task.cancel")
        cancelled = tool_ok(first.call("task.get", {"taskId": cancel_id}), "task.get")
        require(cancelled.get("status") == "cancelled" or cancelled.get("cancellationRequested") is True,
                "TASK_CANCEL", "First session did not see cancellation")


def k5_concurrent_edits(context: Iteration) -> None:
    require(context.prefix is not None and bool(context.server_env), "K5_ORDER", "K2 did not set up the server", "harness")
    document = context.root / "concurrent-edit.txt"
    document.write_text("alpha\nbeta\ngamma\n")
    with MCP(context.prefix, context.server_env, context.root) as first, MCP(context.prefix, context.server_env, context.root) as second:
        # Read only each writer's target bytes. A whole-file observation is
        # deliberately invalidated by any other edit, even a disjoint one.
        tool_ok(first.call("host.read_file", {"path": str(document), "startByte": 0, "endByte": 5}), "host.read_file")
        tool_ok(second.call("host.read_file", {"path": str(document), "startByte": 11, "endByte": 16}), "host.read_file")
        with ThreadPoolExecutor(max_workers=2) as writers:
            left = writers.submit(first.call, "host.patch_file", {
                "path": str(document), "oldText": "alpha", "newText": "ALPHA"})
            right = writers.submit(second.call, "host.patch_file", {
                "path": str(document), "oldText": "gamma", "newText": "GAMMA"})
            tool_ok(left.result(timeout=30), "host.patch_file left")
            tool_ok(right.result(timeout=30), "host.patch_file right")
        require(document.read_text() == "ALPHA\nbeta\nGAMMA\n", "EDIT_MERGE",
                "Two disjoint edits did not merge without tearing the file")
        for mcp in (first, second):
            tool_ok(mcp.call("host.read_file", {"path": str(document), "startByte": 6, "endByte": 10}), "host.read_file")
        tool_ok(first.call("host.patch_file", {"path": str(document), "oldText": "beta", "newText": "BETA"}),
                "host.patch_file first overlap")
        stale = second.call("host.patch_file", {"path": str(document), "oldText": "beta", "newText": "other"})
        require("error" in stale or stale.get("result", {}).get("isError") is True,
                "EDIT_STALE", "Overlapping edit was accepted after another session changed the same bytes")
        require(document.read_text() == "ALPHA\nBETA\nGAMMA\n", "EDIT_TORN",
                "Overlapping refusal changed the file")


def _tree_nodes(context: Iteration) -> list[dict[str, Any]]:
    result = run_cli(context.prefix, context.env, "tree", "--json", timeout=15)
    require(result.returncode == 0, "TREE_PAGE", f"Tree page failed: {result.stderr[-300:]}")
    trees = json.loads(result.stdout)
    live = [tree for tree in trees if tree.get("live") is True]
    require(len(live) == 1, "TREE_LIVE",
            f"Expected one live scratch tree; rows={[(tree.get('treeKey'), tree.get('live'), len(tree.get('nodes', []))) for tree in trees]}")
    return live[0]["nodes"]


def _wait_tree(context: Iteration, predicate, code: str, message: str, timeout: float = 90) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    nodes = []
    while time.monotonic() < deadline:
        nodes = _tree_nodes(context)
        if predicate(nodes):
            return nodes
        time.sleep(0.5)
    detail = ""
    if code == "TREE_DEPTH":
        # A failed nested spawn leaves the same five visible nodes whether the
        # manager lacked the tool, its turn failed, or it is still working.
        # Preserve a bounded, simulator-only diagnosis before K6 tears down
        # the scratch tree and the continuous runner deletes its directory.
        stored = {}
        state_root = Path(context.env["TOOLSENABLED_STATE_ROOT"])
        for file in (state_root / "openshell-tree").glob("*/tree.json"):
            for node in json.loads(file.read_text()).get("nodes", []):
                stored[node.get("nodeId")] = node
        parts = []
        for row in nodes:
            node = stored.get(row.get("nodeId"), {})
            last = node.get("lastTurn") or {}
            text = str(last.get("text") or "").splitlines()
            verdict = next((line for line in reversed(text) if line.startswith("SIM-RESULT ")), "")
            note = verdict or (text[-1] if text else str((node.get("error") or {}).get("code") or ""))
            parts.append(f"{row.get('role')}:{row.get('state')}/{row.get('turn')}/"
                         f"{last.get('status') or '-'}{':' + note[:90] if note else ''}")
        detail = f"; nodes [{', '.join(parts)}]"
        for marker in ("depth1", "depth2"):
            file = context.root / "sim" / "logs" / marker / "exchanges.jsonl"
            if file.is_file():
                lines = file.read_text().splitlines()
                if lines:
                    last = json.loads(lines[-1]).get("sim") or {}
                    detail += f"; {marker} exchanges={len(lines)} last={last.get('kind')}/{last.get('verdict') or '-'}"
    raise SoakError("product", code, f"{message}; last node count {len(nodes)}{detail}")


def _assert_simulator_verdicts(context: Iteration) -> None:
    # A CLI turn can complete successfully while the simulator says its MCP
    # call was not offered. K6 must count that as a product failure even if
    # another worker built the required depth.
    for marker in ("depth1", "depth2", "leaf"):
        file = context.root / "sim" / "logs" / marker / "exchanges.jsonl"
        require(file.is_file(), "TREE_SIM_VERDICT", f"No {marker} simulator exchanges")
        verdicts = []
        for line in file.read_text().splitlines():
            sim = json.loads(line).get("sim") or {}
            if sim.get("kind") == "end":
                verdicts.append(sim.get("verdict"))
        require(bool(verdicts) and all(verdict == "PASS" for verdict in verdicts),
                "TREE_SIM_VERDICT", f"{marker} simulator turn verdicts: {verdicts}")


def k6_tree(context: Iteration) -> None:
    require(context.prefix is not None, "K6_ORDER", "K1 did not install a candidate", "harness")
    with Simulator(context.root) as sim:
        sim.configure(context)
        with MCP(context.prefix, context.server_env, context.root) as mcp:
            direct = []
            reports = []
            for index in range(4):
                marker, role = ("depth1", "MANAGER") if index == 0 else ("leaf", "WORKER")
                spawned = tool_ok(mcp.call("agent.spawn", {
                    "contract": contract(marker, role), "tier": "luna", "surface": "tree", "effort": "low"
                }, timeout=45), "agent.spawn")
                direct.append(spawned["nodeId"])
                reports.extend(spawned.get("reports", []))
            nodes = _wait_tree(context, lambda rows: len(rows) >= 6 and all(
                (row.get("lastTurn") or {}).get("status") == "completed" and row.get("turn") == "idle"
                for row in rows), "TREE_DEPTH", "Four wide, three deep scratch tree did not finish", timeout=120)
            _assert_simulator_verdicts(context)
            by_id = {row["nodeId"]: row for row in nodes}
            require(sum(row["parent"] == "root" for row in nodes) == 4, "TREE_WIDTH",
                    "Tree did not retain four direct children")
            depths = {}
            def depth(node_id: str) -> int:
                if node_id in depths:
                    return depths[node_id]
                parent = by_id[node_id]["parent"]
                depths[node_id] = 1 if parent == "root" else 1 + depth(parent)
                return depths[node_id]
            require(max(depth(row["nodeId"]) for row in nodes) == 3, "TREE_DEPTH",
                    "The nested simulator chain did not reach depth three")
            roster = tool_ok(mcp.call("agent_comms.local_roster", {"from": "Codex"}), "agent_comms.local_roster")
            reports.extend(roster.get("reports", []))
            require(set(direct).issubset({item.get("nodeId") for item in reports}), "TREE_REPORTS",
                    "A direct worker did not deliver its report")
            again = tool_ok(mcp.call("agent_comms.local_roster", {"from": "Codex"}), "agent_comms.local_roster")
            require(not again.get("reports"), "TREE_REPORT_DUPLICATE", "Reports were delivered more than once")

            stopped = tool_ok(mcp.call("agent.stop", {"nodeId": direct[1]}), "agent.stop")
            require(stopped.get("stopped") is True, "TREE_STOP", "First worker was not stopped")
            resumed = tool_ok(mcp.call("agent.resume", {"nodeId": direct[1],
                                                        "assignment": "[[leaf]] Complete another scratch turn"}), "agent.resume")
            require(resumed.get("resumed") is True, "TREE_RESUME", "Stopped worker did not resume")
            _wait_tree(context, lambda rows: any(row["nodeId"] == direct[1] and row["state"] == "running"
                                                 and (row.get("lastTurn") or {}).get("status") == "completed"
                                                 and row["turn"] == "idle" for row in rows),
                       "TREE_RESUME_TURN", "Resumed worker did not complete")
            restarted = tool_ok(mcp.call("agent.restart", {"nodeId": direct[2]}), "agent.restart")
            require(restarted.get("restarted") is True, "TREE_RESTART", "Worker did not restart")
            _wait_tree(context, lambda rows: any(row["nodeId"] == direct[2] and row["state"] == "running"
                                                 and (row.get("lastTurn") or {}).get("status") == "completed"
                                                 and row["turn"] == "idle" for row in rows),
                       "TREE_RESTART_TURN", "Restarted worker did not complete")
            tool_ok(mcp.call("agent.stop", {"nodeId": direct[3]}), "agent.stop")
            removed = tool_ok(mcp.call("agent.remove", {"nodeId": direct[3]}), "agent.remove")
            require(removed.get("removed") is True, "TREE_REMOVE", "Stopped worker was not removed")
            require(all(row["nodeId"] != direct[3] for row in _tree_nodes(context)), "TREE_REMOVE_PAGE",
                    "Removed worker remains on the tree")

            # Clean every remaining slot from deepest to shallowest. The
            # worker groups should be gone before the lead exits.
            remaining = _tree_nodes(context)
            by_id = {row["nodeId"]: row for row in remaining}
            depths.clear()
            for row in sorted(remaining, key=lambda item: depth(item["nodeId"]), reverse=True):
                if row["state"] in ("running", "starting"):
                    tool_ok(mcp.call("agent.stop", {"nodeId": row["nodeId"]}), "agent.stop")
                tool_ok(mcp.call("agent.remove", {"nodeId": row["nodeId"]}), "agent.remove")
            require(not _tree_nodes(context), "TREE_CLEANUP", "Worker slots remained after cleanup")

            # One idle worker remains when the lead is killed. The new lead
            # must recover its slot as stopped and reap the old CLI process.
            survivor = tool_ok(mcp.call("agent.spawn", {
                "contract": contract("leaf"), "tier": "luna", "surface": "tree"
            }, timeout=45), "agent.spawn")
            survivor_id = survivor["nodeId"]
            _wait_tree(context, lambda rows: any(row["nodeId"] == survivor_id
                                                 and (row.get("lastTurn") or {}).get("status") == "completed"
                                                 for row in rows),
                       "TREE_LEAD_WORKER", "Worker did not finish before lead restart")
            tracked = {pid: started for pid in _descendants(mcp.pid) if (started := _pid_start(pid)) is not None}
            try:
                mcp.process.kill()
                mcp.process.wait(timeout=5)
                with MCP(context.prefix, context.server_env, context.root) as recovered:
                    rows = _wait_tree(context, lambda items: any(row["nodeId"] == survivor_id for row in items),
                                      "TREE_RECOVER", "Restarted lead did not load the worker slot")
                    restored = next(row for row in rows if row["nodeId"] == survivor_id)
                    require(restored["state"] == "stopped", "TREE_RECOVER_STATE",
                            f"Restarted lead left the old worker in state {restored['state']}")
                    tool_ok(recovered.call("agent.remove", {"nodeId": survivor_id}), "agent.remove")
                    require(not _tree_nodes(context), "TREE_RECOVER_REMOVE",
                            "Restarted lead could not remove the recovered slot")
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and any(_pid_start(pid) == start for pid, start in tracked.items()):
                    time.sleep(0.1)
                require(not any(_pid_start(pid) == start for pid, start in tracked.items()),
                        "TREE_ORPHAN", "A worker process survived lead death and recovery")
            finally:
                # Only the exact worker PIDs this scratch lead owned are
                # eligible for emergency cleanup, guarded against PID reuse.
                for pid, start in tracked.items():
                    if start is not None and _pid_start(pid) == start:
                        try: os.kill(pid, signal.SIGTERM)
                        except ProcessLookupError: pass


def k7_restart(context: Iteration) -> None:
    require(context.prefix is not None and bool(context.server_env), "K7_ORDER", "K2 did not set up the server", "harness")
    with MCP(context.prefix, context.server_env, context.root) as first:
        task_id = _submit_task(first, "soak-restart", "soak-restart-once")
        claim = tool_ok(first.call("task.claim", {"queue": "soak-restart", "workerLabel": "soak-restart-worker"}),
                        "task.claim")
        require(claim.get("claimed") is True, "RESTART_CLAIM", "Restart task was not claimed")
        handle = claim["handle"]
        tool_ok(first.call("task.start", {"handle": handle}), "task.start")
        before = tool_ok(first.call("task.get", {"taskId": task_id}), "task.get")
        require(before.get("status") == "running", "RESTART_BEFORE", "Task was not running before restart")
    # The first MCP process has exited. Start the terminal CLI while the task
    # is unfinished, then a fresh MCP process with the same scratch state.
    status = run_cli(context.prefix, context.env, "status")
    require(status.returncode == 0, "RESTART_CLI", f"CLI status failed mid-task: {status.stderr[-300:]}")
    with MCP(context.prefix, context.server_env, context.root) as second:
        after = tool_ok(second.call("task.get", {"taskId": task_id}), "task.get")
        require(after.get("status") == "running", "RESTART_TASK", "Task did not survive MCP restart")
        tool_ok(second.call("task.heartbeat", {"handle": handle}), "task.heartbeat")
        tool_ok(second.call("task.complete", {"handle": handle, "result": {"summary": "Restart survived"}}),
                "task.complete")
        finished = tool_ok(second.call("task.get", {"taskId": task_id}), "task.get")
        require(finished.get("status") == "succeeded", "RESTART_COMPLETE", "Restarted MCP could not complete task")
        audit = tool_ok(second.call("settings.read", {"ids": ["audit.enabled"]}), "settings.read")
        # If this candidate has audit enabled in its scratch setup, verify
        # the canonical chain after the restart. The default setup leaves it off.
        audit_enabled = audit.get("values", {}).get("audit.enabled")
        require(isinstance(audit_enabled, bool), "AUDIT_SETTING",
                "K7 could not determine whether audit is enabled")
        context.measures["k7"] = {"auditEnabled": audit_enabled, "auditVerified": False}
        if audit_enabled:
            verification = tool_ok(second.call("audit.verify", {}), "audit.verify")
            require(verification.get("valid") is True and verification.get("disabled") is not True,
                    "AUDIT_RESTART", "Audit verification did not confirm a clean enabled audit after restart")
            context.measures["k7"]["auditVerified"] = True


def k8_upgrade(context: Iteration) -> None:
    require(context.package is not None, "K8_ORDER", "K1 did not extract a candidate", "harness")
    root = context.root / "upgrade"
    root.mkdir()
    path_dir = minimal_path(root, cli_names=("codex", "claude"))
    environment = scratch_env(root, path_dir=path_dir)
    candidates = discover_candidates(context.candidate.directory.parent)
    earlier = [candidate for candidate in candidates if candidate.name != context.candidate.name
               and int(candidate.name.split("-")[-1]) < int(context.candidate.name.split("-")[-1])]
    prior = earlier[-1] if earlier else context.candidate
    old_package = extract_candidate(prior, root)
    prefix = install_candidate(old_package, root, environment)
    require(json.loads((prefix / "manifest.json").read_text())["source_commit"] == prior.commit,
            "UPGRADE_PRIOR_COMMIT", "Upgrade fixture did not install the previous candidate")
    marker = root / "state" / "upgrade-marker.txt"
    marker.write_text("keep across upgrade\n")

    # Initialize the prior artifact's actual stores, including the separate
    # services directory that carries its machine record and settings.
    setup = run_cli(prefix, environment, "setup", "--tier", "unrestricted",
                    "--workspace", str(root / "work"))
    require(setup.returncode == 0, "UPGRADE_SETUP", f"Prior candidate setup failed: {setup.stderr[-300:]}")
    setting = run_cli(prefix, environment, "settings", "set", "tools.throughput", "strict")
    require(setting.returncode == 0, "UPGRADE_SETTING", f"Could not seed a nondefault setting: {setting.stderr[-300:]}")

    def registration() -> tuple[Path, dict[str, str]]:
        script = (
            "const m=require('./src/lib/setup/machine-record');"
            "const c=require('./bin/toolsenabled-openshell');"
            "const r=m.readMachineRecord({servicesRoot:m.resolveServicesRoot({})});"
            "process.stdout.write(JSON.stringify({record:r&&{servicesRoot:r.servicesRoot,"
            "installRoot:r.installRoot,tier:r.tier},entry:r?c.serverEntry(r,{agents:false}):null}));"
        )
        result = subprocess.run([shutil.which("node") or "/usr/local/bin/node", "-e", script],
                                cwd=prefix / "runtime/engine", env=environment,
                                text=True, capture_output=True, timeout=30)
        require(result.returncode == 0, "UPGRADE_SETUP_STATE", f"Could not read installed setup: {result.stderr[-300:]}")
        configured = json.loads(result.stdout)
        record = configured.get("record") or {}
        require(record.get("tier") == "unrestricted" and isinstance(record.get("servicesRoot"), str)
                and record.get("installRoot") == str(prefix / "runtime/engine") and configured.get("entry"),
                "UPGRADE_SETUP_STATE", "The installed machine record disappeared or changed across the lifecycle")
        services = Path(record["servicesRoot"])
        require(services.is_absolute() and services.resolve().is_relative_to(root.resolve()),
                "UPGRADE_STATE_SCOPE", "The installed service root escaped this scratch upgrade", "harness")
        return services, {**environment, **configured["entry"]["env"], "TOOLSENABLED_AGENT_ACTOR": "codex"}

    services_root, server_env = registration()
    state_root = Path(environment["TOOLSENABLED_STATE_ROOT"])
    require(state_root.is_absolute() and state_root.resolve().is_relative_to(root.resolve()),
            "UPGRADE_STATE_SCOPE", "The runtime state root escaped this scratch upgrade", "harness")
    state_paths = {state_root, services_root}
    memory_selector = {"namespace": "soak-upgrade", "key": "retained"}
    memory_value = {"fromCommit": prior.commit, "retained": True}
    task_payload = {"title": "Scratch soak job", "objective": "Check queue state across two MCP sessions"}
    with MCP(prefix, server_env, root) as before:
        task_id = _submit_task(before, "soak-upgrade", "soak-upgrade-once")
        memory = tool_ok(before.call("memory.set", {**memory_selector, "value": memory_value,
                                                    "expectedRevision": 0}), "memory.set")
        require(memory.get("revision") == 1, "UPGRADE_MEMORY_SEED", "The prior candidate did not create the memory row")

    def verify_state(stage: str) -> None:
        current_services, current_env = registration()
        require(current_services == services_root and all(item.is_dir() for item in state_paths),
                "UPGRADE_SETUP_STATE", f"The authoritative state directories changed {stage}")
        with MCP(prefix, current_env, root) as current:
            task = tool_ok(current.call("task.get", {"taskId": task_id, "includePayload": True}), "task.get")
            require(task.get("taskId") == task_id and task.get("status") == "queued"
                    and task.get("queue") == "soak-upgrade" and task.get("payload") == task_payload,
                    "UPGRADE_TASK_STATE", f"The queued task or its payload changed {stage}")
            memory = tool_ok(current.call("memory.get", memory_selector), "memory.get")
            require(memory.get("revision") == 1 and memory.get("value") == memory_value,
                    "UPGRADE_MEMORY_STATE", f"The durable memory row changed {stage}")
            settings = tool_ok(current.call("settings.read", {"ids": ["tools.throughput"]}), "settings.read")
            require(settings.get("values", {}).get("tools.throughput") == "strict",
                    "UPGRADE_SETTING_STATE", f"The nondefault setting changed {stage}")

    verify_state("before upgrade")

    help_result = subprocess.run(["/bin/bash", str(context.package / "install.sh"), "--help"],
                                 env={**environment, "OPENSHELL_SANDBOX": "0"}, text=True,
                                 capture_output=True, timeout=10)
    require(help_result.returncode == 0 and "Usage:" in help_result.stdout,
            "INSTALL_HELP", f"install.sh --help failed outside setup: {(help_result.stdout + help_result.stderr)[-300:]}")
    unknown = subprocess.run(["/bin/bash", str(context.package / "install.sh"), "--unknown"],
                             cwd=root, env=environment, text=True, capture_output=True, timeout=10)
    require(unknown.returncode != 0 and "Unknown option" in unknown.stderr,
            "INSTALL_UNKNOWN", "install.sh accepted an unknown option")
    relative = subprocess.run(["/bin/bash", str(context.package / "install.sh"), "relative-prefix"],
                              cwd=root, env=environment, text=True, capture_output=True, timeout=10)
    require(relative.returncode != 0 and "absolute" in relative.stderr and not (root / "relative-prefix").exists(),
            "INSTALL_RELATIVE", "install.sh accepted a relative prefix")

    upgrade = subprocess.run(["/bin/bash", str(context.package / "install.sh"), str(prefix)],
                             env=environment, text=True, capture_output=True, timeout=45)
    require(upgrade.returncode == 0 and prior.commit in upgrade.stdout and context.candidate.commit in upgrade.stdout,
            "UPGRADE_EXIT", f"Upgrade failed or omitted commit IDs: {(upgrade.stdout + upgrade.stderr)[-400:]}")
    require(marker.read_text() == "keep across upgrade\n", "UPGRADE_STATE", "Upgrade changed scratch state")
    require(json.loads((prefix / "manifest.json").read_text())["source_commit"] == context.candidate.commit,
            "UPGRADE_COMMIT", "Upgrade did not install this candidate")
    version = run_cli(prefix, environment, "--version")
    require(version.returncode == 0 and context.candidate.commit in version.stdout,
            "VERSION", "Installed --version does not name this candidate")
    require(context.package.joinpath("manifest.json").read_text() == (prefix / "manifest.json").read_text(),
            "VERSION_MANIFEST", "Installed manifest does not match the candidate")
    verify_state("after upgrade")

    kept = run_cli(prefix, environment, "uninstall", "--keep-state")
    require(kept.returncode == 0 and not prefix.exists() and marker.exists()
            and all(item.is_dir() for item in state_paths),
            "UNINSTALL_KEEP", f"Uninstall --keep-state failed: {(kept.stdout + kept.stderr)[-400:]}")
    prefix = install_candidate(context.package, root, environment)
    verify_state("after --keep-state and reinstall")
    removed = subprocess.run([str(prefix / "bin/toolsenabled"), "uninstall"], input="yes\n",
                             env=environment, text=True, capture_output=True, timeout=30)
    require(removed.returncode == 0 and not prefix.exists()
            and all(not item.exists() and not item.is_symlink() for item in state_paths),
            "UNINSTALL_DELETE", f"Confirmed uninstall failed: {(removed.stdout + removed.stderr)[-400:]}")
    prefix = install_candidate(context.package, root, environment)
    version = run_cli(prefix, environment, "--version")
    require(version.returncode == 0 and context.candidate.commit in version.stdout,
            "REINSTALL_VERSION", "Reinstall did not restore this candidate")


def _descendants(pid: int) -> set[int]:
    found = set()
    pending = [pid]
    while pending:
        current = pending.pop()
        try:
            children = (Path(f"/proc/{current}/task/{current}/children").read_text()).split()
        except FileNotFoundError:
            continue
        for child in children:
            value = int(child)
            if value not in found:
                found.add(value)
                pending.append(value)
    return found


def _pid_start(pid: int) -> str | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except (FileNotFoundError, IndexError):
        return None


def k9_leaks(context: Iteration) -> None:
    require(context.prefix is not None and bool(context.server_env), "K9_ORDER", "K2 did not set up the server", "harness")
    watcher = context.leak_watch or LeakWatch(context.candidate,
        installed=(context.prefix, context.server_env, context.root))
    try:
        context.measures["k9"] = watcher.sample()
    finally:
        if watcher.latest is not None:
            context.measures["k9"] = watcher.latest
        # Direct scenario callers retain a bounded one-shot API; the runner
        # supplies and owns the long-lived watcher and its separate state.
        if context.leak_watch is None:
            watcher.close()
