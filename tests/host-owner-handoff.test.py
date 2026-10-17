"""Value-based owner handoff failure propagation; lifecycle commands are stubs."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "installer/host"))
import owner_handoff as subject

class OwnerHandoffChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="owner-handoff-", dir=os.environ["F1_OWNER_TEST_ROOT"])
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.spec = {name: str(root / name) for name in
            ["candidate_archive","rollback_archive","candidate_stage","rollback_stage",
             "prefix","state_root","workspace","codex","node"]}
        self.spec.update(candidate_sha256="a"*64, rollback_sha256="b"*64,
                         tier="guided", tree_key="retained-fixture", actor="codex")
        self.calls=[]
        self.plan = json.dumps({"effects":"none","preflightOnly":True,
                                "installArgv":["env","PATH=/selected/cli:/selected/node"]})
    def runner(self, failure=None, malformed=False):
        def run(step):
            self.calls.append(step)
            output = self.plan if step.capture else ""
            if malformed and step.capture: output = "invalid JSON"
            return SimpleNamespace(returncode=37 if step.name==failure else 0, stdout=output)
        return run
    def names(self):
        return [step.name for step in self.calls]
    def assert_failed_once(self, operation, step):
        with self.assertRaises(subject.HandoffFailure): operation(self.runner(step))
        self.assertEqual(self.names()[-1], step)
        self.assertEqual(self.names().count(step), 1)
    def test_checksum_failure_prevents_extraction_preflight_and_lifecycle(self):
        self.assert_failed_once(lambda runner:subject.prepare(self.spec,runner), "candidate-checksum")
        self.assertEqual(self.names(),["candidate-checksum"])
    def test_rollback_checksum_failure_also_prevents_extraction(self):
        self.assert_failed_once(lambda runner:subject.prepare(self.spec,runner), "rollback-checksum")
        self.assertEqual(self.names(),["candidate-checksum","rollback-checksum"])
    def test_extraction_failure_prevents_second_extraction_and_preflight(self):
        self.assert_failed_once(lambda runner:subject.prepare(self.spec,runner), "candidate-extraction")
        self.assertNotIn("rollback-extraction", self.names())
    def test_preflight_failure_prevents_uninstall_install_and_reconnect(self):
        self.assert_failed_once(lambda runner:subject.transition(self.spec,drained=True,runner=runner), "candidate-preflight")
        self.assertFalse(any("uninstall" in name or "install"==name.rsplit("-",1)[-1] or "reconnect" in name for name in self.names()))
    def test_uninstall_failure_prevents_install_verification_and_reconnect(self):
        self.assert_failed_once(lambda runner:subject.transition(self.spec,drained=True,runner=runner), "rollback-uninstall")
        self.assertNotIn("candidate-install",self.names())
        self.assertNotIn("candidate-installed-verification",self.names())
    def test_install_failure_prevents_final_verification(self):
        self.assert_failed_once(lambda runner:subject.transition(self.spec,drained=True,runner=runner), "candidate-install")
        self.assertNotIn("candidate-installed-verification",self.names())
    def test_rollback_uninstall_failure_prevents_old_install(self):
        self.assert_failed_once(lambda runner:subject.transition(self.spec,rollback=True,drained=True,runner=runner), "candidate-uninstall")
        self.assertNotIn("rollback-install",self.names())
    def test_missing_drain_attestation_runs_no_commands(self):
        with self.assertRaises(subject.HandoffFailure):
            subject.transition(self.spec,runner=self.runner())
        self.assertEqual(self.calls,[])
    def test_invalid_preflight_plan_prevents_lifecycle(self):
        with self.assertRaises(subject.HandoffFailure):
            subject.transition(self.spec,drained=True,runner=self.runner(malformed=True))
        self.assertEqual(self.names()[-1],"candidate-preflight")
    def test_failed_installed_verification_prevents_reconnect(self):
        self.assert_failed_once(lambda runner:subject.reconnect(self.spec,runner=runner),"candidate-installed-verification")
        self.assertNotIn("candidate-reconnect",self.names())
    def test_failed_current_receipt_verification_prevents_uninstall(self):
        self.assert_failed_once(lambda runner:subject.transition(self.spec,drained=True,runner=runner),"rollback-installed-verification")
        self.assertNotIn("rollback-uninstall",self.names())
    def test_success_preserves_selected_tier_paths_and_separates_reconnect(self):
        subject.transition(self.spec,drained=True,runner=self.runner())
        self.assertEqual(self.names()[-3:],["rollback-uninstall","candidate-install","candidate-installed-verification"])
        install=next(step for step in self.calls if step.name=="candidate-install")
        self.assertEqual(install.argv[install.argv.index("--tier")+1],"guided")
        self.assertEqual(install.argv[install.argv.index("--archive")+1],self.spec["candidate_archive"])
        self.assertEqual(install.env["PATH"],"/selected/cli:/selected/node")
        self.assertNotIn("candidate-reconnect",self.names())
    def test_role_control_is_only_added_for_explicit_owner_choice(self):
        for opted in [False,True]:
            self.calls=[]
            subject.reconnect(self.spec,role_control=opted,runner=self.runner())
            argv=self.calls[-1].argv
            self.assertEqual("--enable-role-control" in argv,opted)
            self.assertEqual(argv[argv.index("--tree-key")+1],"retained-fixture")
    def test_unbound_root_reconnect_omits_actor(self):
        self.spec.pop("actor")
        subject.reconnect(self.spec, role_control=True, runner=self.runner())
        argv = self.calls[-1].argv
        self.assertNotIn("--actor", argv)
        self.assertEqual(argv[argv.index("--tree-key") + 1], "retained-fixture")
    def test_existing_explicit_actor_is_preserved(self):
        subject.reconnect(self.spec, runner=self.runner())
        argv = self.calls[-1].argv
        self.assertEqual(argv[argv.index("--actor") + 1], "codex")
    def extract_fixture(self, stage_in_runtime=False, archive_in_runtime=False):
        root=Path(self.temp.name)
        runtime=root/"runtime";runtime.mkdir(mode=0o700)
        work=root/"work";work.mkdir(mode=0o700)
        stage=runtime/"stage" if stage_in_runtime else root/"stage"
        archive=Path(os.environ["F1_NATIVE_ARCHIVE"])
        if archive_in_runtime:
            copied=runtime/"archive.tar.gz";shutil.copyfile(archive,copied);copied.chmod(0o600);archive=copied
        argv=[sys.executable,"-B","-c",subject.EXTRACT_PROGRAM,
            os.environ["F1_NATIVE_INSTALLER"],str(stage),str(archive),
            os.environ["F1_NATIVE_SHA256"],str(runtime),str(root/"state"),str(work)]
        result=subprocess.run(argv,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return result,stage
    def test_fresh_stage_cannot_modify_current_runtime(self):
        result,stage=self.extract_fixture(stage_in_runtime=True)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(stage.exists())
    def test_archive_inside_current_runtime_is_refused_before_stage_creation(self):
        result,stage=self.extract_fixture(archive_in_runtime=True)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(stage.exists())
    def receipt_fixture(self, status, sha):
        root=Path(self.temp.name)
        prefix=root/"materialized";state=root/"state";state.mkdir(mode=0o700)
        work=root/"work";work.mkdir(mode=0o700)
        backend=os.environ["F1_NATIVE_INSTALLER"];archive=os.environ["F1_NATIVE_ARCHIVE"]
        pin=os.environ["F1_NATIVE_SHA256"]
        extract=[sys.executable,"-B","-c",subject.EXTRACT_PROGRAM,backend,
            str(prefix),archive,pin,str(root/"other-runtime"),str(state),str(work)]
        subprocess.run(extract,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        (state/"install-receipt.json").write_text(json.dumps({"status":status,"sha256":sha}))
        verify=[sys.executable,"-B","-c",subject.VERIFY_PROGRAM,backend,
            archive,pin,str(prefix),str(state),str(work),"yes"]
        return subprocess.run(verify,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    def test_unfinished_receipt_refuses_an_otherwise_matching_materialized_tree(self):
        result=self.receipt_fixture("registration-pending",os.environ["F1_NATIVE_SHA256"])
        self.assertNotEqual(result.returncode,0)
    def test_wrong_receipt_hash_refuses_an_otherwise_matching_materialized_tree(self):
        result=self.receipt_fixture("installed","0"*64)
        self.assertNotEqual(result.returncode,0)

def suite(names=None):
    if names is None:return unittest.defaultTestLoader.loadTestsFromTestCase(OwnerHandoffChecks)
    return unittest.TestSuite(OwnerHandoffChecks(name) for name in names)

if __name__=="__main__":
    result=unittest.TextTestRunner(verbosity=2).run(suite())
    if not result.wasSuccessful():raise SystemExit(1)
    checks=[
        ("checksum_failure","test_checksum_failure_prevents_extraction_preflight_and_lifecycle","stop_on_failure",lambda step,result:None),
        ("preflight_failure","test_preflight_failure_prevents_uninstall_install_and_reconnect","stop_on_failure",lambda step,result:None),
        ("uninstall_failure","test_uninstall_failure_prevents_install_verification_and_reconnect","stop_on_failure",lambda step,result:None),
        ("drain_attestation","test_missing_drain_attestation_runs_no_commands","require_drain",lambda drained:None),
        ("invalid_plan","test_invalid_preflight_plan_prevents_lifecycle","plan_environment",lambda result:{"PATH":"/fixture"}),
        ("stage_runtime_overlap","test_fresh_stage_cannot_modify_current_runtime","EXTRACT_PROGRAM",subject.EXTRACT_PROGRAM.replace("if h.overlaps(stage,h.absolute(prefix)):","if False:")),
        ("archive_runtime_overlap","test_archive_inside_current_runtime_is_refused_before_stage_creation","EXTRACT_PROGRAM",subject.EXTRACT_PROGRAM.replace("h.validate(original)","pass"))
        ,("current_receipt_failure","test_failed_current_receipt_verification_prevents_uninstall","stop_on_failure",lambda step,result:None)
        ,("unfinished_receipt","test_unfinished_receipt_refuses_an_otherwise_matching_materialized_tree","VERIFY_PROGRAM",subject.VERIFY_PROGRAM.replace("if receipt.get('status')!='installed' or receipt.get('sha256')!=sha:","if False:"))
        ,("receipt_hash","test_wrong_receipt_hash_refuses_an_otherwise_matching_materialized_tree","VERIFY_PROGRAM",subject.VERIFY_PROGRAM.replace("if receipt.get('status')!='installed' or receipt.get('sha256')!=sha:","if False:"))
    ]
    for label,name,symbol,mutation in checks:
        output=io.StringIO()
        with patch.object(subject,symbol,mutation):
            red=unittest.TextTestRunner(stream=output).run(suite([name]))
        green=unittest.TextTestRunner(stream=io.StringIO()).run(suite([name]))
        if red.wasSuccessful() or red.errors or not green.wasSuccessful():
            print("MUTATION_CHECK_FAILED",label,output.getvalue());raise SystemExit(1)
        print(f"MUTATION {label}: RED failures={len(red.failures)} errors={len(red.errors)}; restored GREEN")
