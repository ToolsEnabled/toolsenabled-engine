# Strict product test lifecycle

`npm run test:strict` invokes the package's actual `npm run test` lifecycle,
including declared pretest/posttest hooks. It does not run census `--all`,
choose a replacement subset, accept quick/waiver arguments, or update a test
baseline. An inherited positive-only requirement strengthens every nested
check-chain and isolated child. Ordinary developer ratchets are unchanged.

The wrapper creates its own temporary test state, scrubs ambient provider
billing credentials, isolates npm user configuration/cache, disables npm's
update check, and records a lifecycle report before spawning. A refused,
interrupted or incomplete lifecycle is nonpassing. This is not an OS/network
sandbox; arbitrary test code still needs review for side effects. The temporary
report/state directory is retained for diagnosis, not written over owner state.

## Evidence and exclusions

TAP-producing children must reconcile plans, result sequences, counts and exit
status. Cancelled, TODO, zero-completed, truncated, contradictory and oversized
captures are nonpassing. Within-suite platform/optional skips remain explicitly
UNEXECUTED, not passed tests. An entire requested file skipped, timed out or not
run is nonpassing. Legacy standalone assertion programs retain process-exit
evidence, with no invented assertion count; this cannot prove how many assertions
their program actually executed.

Four explicitly named smokes were previously reached by ordinary npm test.
They remain discoverable and executable by deliberate opt-in scripts, but are
reported UNEXECUTED outside unattended strict proof:

| Files | Deliberate script | Side effect |
| --- | --- | --- |
| `tests/agent-engine/{claude,codex}-live-turn.js` | `test:agent-engine:live` | Real provider turns when CLI/credentials are present |
| `tests/scheduler-windows{,-legacy}-mutation.js` | `test:scheduler:mutation` | Real Windows Scheduler mutations; existing opt-in flags still required |

No other deterministic declared test was removed. Root-admission,
owner-host-root-assertion and hidden-spawn-root-guard tests are now npm-reachable.

## Exact current-lifecycle receipts

Before execution, the strict wrapper requires this exact clean Git checkout,
measures HEAD/tree, and expands the actual declared npm recipe (including nested
pre/body/post hooks). Unsupported command syntax, opaque npm boundaries, and a
metadata verifier that is not last in posttest refuse immediately. Package,
list, command and selected test-file SHA-256 identities belong to a fresh run
contract. Duplicate selections retain separate occurrence IDs; no denominator
is inferred from the files that happen to return a result.

Chain/isolated runners write exclusive start/end receipts. Parent envelopes
report their actual command verdict/exit; they do not manufacture child-file
coverage. File receipts retain their own process result and completion evidence
under a separate result field. Arbitrary test bodies and ordinary direct checks
retain strict verdict semantics but receive no enclosing receipt-writer scope.
Harness self-tests create their own disposable fixture contracts.

The metadata ratchet is now last in posttest. In strict mode it reads only this
invocation's source/selection-bound receipts, never an unrelated census summary,
regardless of that summary's age or apparent pass count. Only its still-running
ancestor envelopes may remain open at that point. The outer wrapper then
requires actual npm terminal success and every terminal receipt, rechecks clean
source and recipe identities, and persists `completed: true` only if all agree.
Missing, duplicate, foreign, stale-source and nonpassing receipts refuse.

Ordinary developer mode still uses its explicit legacy summary and baselines.
The exact existing `test-ratchet` baseline record moves from test to posttest
with its command; strict grants it no tolerance. The adversarial and
repo-protocol array runners now share checked-in lists with npm, preserving all
11 and 8 previously declared tests respectively. Four direct npm checks have
instrumented envelopes without changing their underlying commands.

`test:key-custody` was exactly `node tests/run-isolated.js` with zero files: a
never-populated placeholder whose standalone invocation refuses usage. Its empty
default step and stale baseline entry are retired, not replaced by a fake test.
The alias remains unchanged and every strict report names **UNIMPLEMENTED / no
key-custody coverage**. Populating or otherwise changing that retired alias
requires explicit recipe reconciliation; it cannot silently disappear.

These receipts are trusted-harness accounting, not adversarial attestation.
Git cleanliness checks tracked/index drift and nonignored untracked files;
ignored runtime outputs and installed dependency closure are not independently
attested. Pre/post identities do not prove in-run immutability. Clearing an
environment scope is not an OS security boundary against malicious same-user
code. A complete protocol fixture is not a passing product lifecycle: any real
mandatory product test failure or missing installation fixture still blocks.

## First actual product run and invocation reconciliation

The 2026-09-05 full attempt at clean source
`23762fcd2f6bc263308cf09bceda7f3875f77a01` terminated with exit 1: pretest
completed all 14 declared steps, with 8 passing and 6 failing. npm did not run
test or posttest. The retained strict report is nonpassing; the selected 1,356
file occurrences are not a claim that those files executed.

One measured failure was inventory bookkeeping: a program-removal commit had
also erased two entries from the immutable original 242-tool audit and left
category counts stale. Reconciliation restores those exact historical identities
as retired-stale, retains the original capture date, and recomputes only current
invocation evidence. The regression pins the original identity-list digest,
not merely its size. No baseline or manual registry entry is added or erased.

The external LIVE promoter genuinely starts `npm:test:strict`, so that release
entry is declared without labelling the harness customer-runtime code. The
persistent vault worker's computed PowerShell spawn has one reviewed dynamic
edge; its runtime host is not excluded. The new courier timing experiment is
classified developer-only without inventing an invocation path. Removing the
strict root or vault edge in an in-memory negative control loses the respective
path. Unregistered-tool and test-only-library probes still refuse, and the
remaining real unregistered findings keep the complete guard nonpassing.

## Shared-configuration safety adoption

The isolated runner never restores repository config from Git or deletes new
configuration. Hash drift cannot identify its author. It preserves files and
the index, records the contaminated test, stops that batch and marks remaining
requests not-run. Ordinary assertion failures still allow independent tests.
The regression runs the real runner in disposable repositories, not against
the active checkout's config.

This safety change and the contention test's non-spinning shared barrier,
hidden bounded workers and all-settled cleanup were reviewed from the external
working diff in `wt-engine-1.0.41-next` at HEAD
`d0ec1f35a3051e03c182122aea800231ff6c5155`. That source was dirty; these are
file-byte identities, not a claim that an external commit contained the edits:

- `tests/run-isolated.js`: `ced90f1bba15207dcf056653466bfb97859f495db91eee5613b16ad0dcb16200`
- `tests/run-isolated-config-integrity.js`: `cbf81510220fb10ab6e65a7b69f2c98db8b8be0c1a31ca456161dc78851ae68f`
- `tests/tree-directory-lock-contention.test.js`: `6309d0065015c586e1f253305f093390cfc5ee6d0d6e7cec09bc34bf460f29b5`

Adoption preserves this lane's strict evidence fields and copies the actual
strict helper closure into disposable config fixtures. The contention suite
was already selected by this lane's 0903 manifest; no duplicate was added.
The external checkouts were left untouched.
