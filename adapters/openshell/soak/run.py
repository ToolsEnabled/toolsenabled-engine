#!/usr/bin/env python3
"""Continuously test the newest installed OpenShell candidate in scratch state.

Run from the checkout: python3 adapters/openshell/soak/run.py
`--once --through K2` is for developing an unfinished scenario; it is always
reported as partial and never counts toward release soak time.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import time
import traceback

from core import Candidate, SoakError, discover_candidates, scratch_directory
from leak_watch import LeakWatch, candidate_identity
from scenarios import Iteration
import scenarios


SCENARIO_NAMES = {
    1: "install", 2: "setup", 3: "surface", 4: "ledger_tasks", 5: "concurrent_edits",
    6: "tree", 7: "restart", 8: "upgrade", 9: "leaks",
}
SUMMARY_INTERVAL = 300
ITERATION_PAUSE = 60


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class Recorder:
    def __init__(self, channel: Path):
        self.directory = channel / "soak"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.errors = self.directory / "errors.jsonl"
        self.summary = self.directory / "summary.json"
        self.started = utc_now()
        self.last_summary = 0.0
        self.iterations = 0
        self.scenario_passes = Counter()
        self.scenario_failures = Counter()
        self.error_classes = Counter()
        self.current_candidate = None
        self.current_scenario = None
        self.last_result = None
        self.partial = False
        self.measurements = {}
        self.verification_coverage = {}
        self.leak_watch = None

    def watcher(self, candidate: Candidate) -> LeakWatch:
        if self.leak_watch is not None and self.leak_watch.identity != candidate_identity(candidate):
            self.close()
        if self.leak_watch is None:
            self.leak_watch = LeakWatch(candidate)
            # Per-process baselines belong to LeakWatch. Retain only this
            # candidate's latest row in summaries, not an unbounded history.
            self.measurements = {}
        return self.leak_watch

    def close(self) -> None:
        if self.leak_watch is not None:
            try:
                self.leak_watch.close()
            except SoakError as error:
                self.error(self.leak_watch.candidate.name, self.iterations, "K9", error.category, error.code, str(error))
            except Exception as error:
                self.error(self.leak_watch.candidate.name, self.iterations, "K9", "harness", "LEAK_CLEANUP", str(error))
            finally:
                self.leak_watch = None

    def error(self, candidate: str | None, iteration: int, scenario: str, category: str,
              code: str, message: str) -> None:
        # Error text is bounded. Never serialize process environments or inputs.
        record = {"at": utc_now(), "candidate": candidate, "iteration": iteration,
                  "scenario": scenario, "class": category, "code": code, "message": str(message)[:600]}
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        fd = os.open(self.errors, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        self.error_classes[category] += 1
        self.scenario_failures[scenario] += 1
        self.last_result = record
        print(f"{record['at']} {candidate or '-'} {scenario} {category}/{code}: {record['message']}", flush=True)

    def pass_scenario(self, candidate: str, iteration: int, scenario: str, milliseconds: float) -> None:
        self.scenario_passes[scenario] += 1
        self.last_result = {"at": utc_now(), "candidate": candidate, "iteration": iteration,
                            "scenario": scenario, "status": "pass", "ms": round(milliseconds, 2)}
        print(f"{self.last_result['at']} {candidate} {scenario} PASS {milliseconds:.0f} ms", flush=True)

    def write_summary(self, *, force: bool = False) -> None:
        if not force and time.monotonic() - self.last_summary < SUMMARY_INTERVAL:
            return
        document = {"generatedAt": utc_now(), "startedAt": self.started, "candidate": self.current_candidate,
                    "iteration": self.iterations, "scenario": self.current_scenario, "partial": self.partial,
                    "passes": dict(self.scenario_passes), "failures": dict(self.scenario_failures),
                    "errorClasses": dict(self.error_classes), "lastResult": self.last_result}
        document["latestMetrics"] = {name: rows[-1] for name, rows in self.measurements.items() if rows}
        document["metricSamples"] = {name: rows[-1]["sampleCount"] for name, rows in self.measurements.items() if rows}
        document["verificationCoverage"] = self.verification_coverage
        temporary = self.summary.with_suffix(f".json.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(document, indent=2) + "\n")
        temporary.replace(self.summary)
        self.last_summary = time.monotonic()


def newest(channel: Path) -> Candidate | None:
    candidates = discover_candidates(channel / "candidates")
    return candidates[-1] if candidates else None


def run_iteration(candidate: Candidate, recorder: Recorder, channel: Path, through: int = 9) -> bool:
    root = scratch_directory()
    context = Iteration(candidate, root)
    recorder.current_candidate = candidate.name
    recorder.partial = through < 9
    completed = True
    try:
        context.leak_watch = recorder.watcher(candidate) if through == 9 else None
        for number in range(1, through + 1):
            # A new archive is accepted between scenarios, without restarting
            # this long-lived process. Start its own clean K1 on the next pass.
            try:
                next_candidate = newest(channel)
            except SoakError as error:
                recorder.error(None, recorder.iterations, "discovery", error.category, error.code, str(error))
                return False
            except Exception as error:
                recorder.error(None, recorder.iterations, "discovery", "harness", type(error).__name__, str(error))
                return False
            if next_candidate and candidate_identity(next_candidate) != candidate_identity(candidate):
                print(f"{utc_now()} switching {candidate.name} → {next_candidate.name} at K{number}", flush=True)
                recorder.close()
                return False
            scenario = f"K{number}"
            recorder.current_scenario = scenario
            method = getattr(scenarios, f"k{number}_{SCENARIO_NAMES[number]}", None)
            started = time.monotonic()
            try:
                if method is None:
                    raise SoakError("harness", "SCENARIO_MISSING", f"{scenario} has no implementation")
                method(context)
            except SoakError as error:
                recorder.error(candidate.name, recorder.iterations, scenario, error.category, error.code, str(error))
                completed = False
                if number <= 2:
                    break  # Later scenarios cannot run without install/setup.
            except TimeoutError as error:
                recorder.error(candidate.name, recorder.iterations, scenario, "product", "SCENARIO_TIMEOUT", str(error))
                completed = False
            except Exception as error:
                recorder.error(candidate.name, recorder.iterations, scenario, "harness", type(error).__name__, str(error))
                completed = False
                traceback.print_exc(limit=6)
            else:
                elapsed = (time.monotonic() - started) * 1000
                context.timings_ms[scenario] = elapsed
                recorder.pass_scenario(candidate.name, recorder.iterations, scenario, elapsed)
            if number == 9 and "k9" in context.measures:
                recorder.measurements[candidate.name] = [context.measures["k9"]]
            if number == 7 and "k7" in context.measures:
                recorder.verification_coverage[candidate.name] = {"K7": context.measures["k7"]}
            recorder.write_summary()
        return completed and through == 9
    finally:
        recorder.current_scenario = None
        try:
            recorder.write_summary(force=True)
        finally:
            shutil.rmtree(root)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", type=Path, default=Path("/sandbox/port-channel"))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--through", choices=[f"K{n}" for n in range(1, 10)], default="K9")
    args = parser.parse_args()
    recorder = Recorder(args.channel)
    try:
        fields = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
        priority = int(fields[16])  # Linux stat field 19, process nice value.
        if priority < 10:
            os.nice(10 - priority)
    except (AttributeError, OSError, ValueError, IndexError) as error:
        if not args.once:
            recorder.error(None, 0, "startup", "env", "NICE_UNAVAILABLE",
                           f"The sandbox cannot set nice 10 for continuous soak: {type(error).__name__}")
            recorder.write_summary(force=True)
            return 2
    lock_file = (args.channel / "soak" / "runner.lock").open("a+")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another soak runner holds the channel lock")
    stop = False

    def stopping(*_: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGINT, stopping)
    through = int(args.through[1:])
    recorder.write_summary(force=True)
    exit_code = 0
    try:
        while not stop:
            if (args.channel / "soak/PAUSE").exists():
                recorder.last_result = {"at": utc_now(), "status": "paused-by-coordinator"}
                recorder.write_summary()
                if args.once:
                    exit_code = 2
                    break
                time.sleep(5)
                continue
            try:
                candidate = newest(args.channel)
            except SoakError as error:
                recorder.error(None, recorder.iterations, "discovery", error.category, error.code, str(error))
                candidate = None
            except Exception as error:
                recorder.error(None, recorder.iterations, "discovery", "harness", type(error).__name__, str(error))
                candidate = None
            if candidate is None:
                recorder.write_summary()
                if args.once:
                    exit_code = 2
                    break
                time.sleep(10)
                continue
            recorder.iterations += 1
            success = run_iteration(candidate, recorder, args.channel, through)
            recorder.write_summary(force=True)
            if args.once:
                exit_code = 0 if success or (through < 9 and recorder.error_classes.total() == 0) else 1
                break
            # Check PAUSE and new candidates during the minimum thermal delay.
            deadline = time.monotonic() + ITERATION_PAUSE
            while not stop and time.monotonic() < deadline:
                recorder.write_summary()
                time.sleep(min(5, deadline - time.monotonic()))
        recorder.write_summary(force=True)
    finally:
        errors_before_close = recorder.error_classes.total()
        recorder.close()
        if recorder.error_classes.total() != errors_before_close:
            exit_code = 1
        try:
            recorder.write_summary(force=True)
        finally:
            lock_file.close()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
