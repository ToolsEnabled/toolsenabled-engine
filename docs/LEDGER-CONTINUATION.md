# Assigned ledger continuation in the standalone host

The owner T ledger and `task.*` worker queues are separate existing systems.
This controller schedules only explicitly enrolled T records. The persistent
continuation setting allows this feature; choosing Autonomous+ or filing a task
alone does not create a worker, wake the external lead client, or consume a queue.

1. Start a worker through the normal `agent.spawn` path. It must already
   have `ledger.read`, `t_ledger.progress` and `t_ledger.complete`. Its manager
   needs the explicit `agent.continue` role function. Existing custom roles do
   not receive new capabilities implicitly.
2. File a one-shot T task with scope `tree` and key equal to the worker's returned
   nodeId. Existing authoritative ownerNodeId assignment also works. Global or
   other-worker records are refused; no task text becomes standing authority.
3. Call `agent.continue` with nodeId, a unique runId and exact taskIds. There is
   no turn limit unless the manager asks for one with maxTurns (any whole number
   from 1). Enrollment during a turn takes effect at its end. Repeating the same
   runId is idempotent and does not reset turn counts or pauses.
4. The worker reads the task, checks existing results, then records verified
   completion, concrete progress or an external blocker through the T ledger.
   Completion selects the next eligible task without another manager prompt.

The scheduler filters terminal, recurring, reset, handoff, wrong-owner, blocked,
and dependency-unready tasks. Three attempts with an unchanged semantic task
checkpoint hold that task while other eligible work continues. Repeated prose,
timestamps and unrelated ledger revisions do not count as progress. A new
checkpoint or satisfied dependency wakes waiting work at the normal worker
watch interval, without polling a model. A maxTurns the manager set still applies.

`agent.continue` with enabled:false disables future automatic turns; the current
turn is preserved. `agent.stop` interrupts the existing worker through its normal
stop path. Provider failure, cancellation, approval interaction and the kill
switch pause continuation. Answering a provider interaction or clearing a kill
switch does not silently resume it. Direct-user-only worker roles cannot enroll.
Provider account and permission settings, model speed and logins are unchanged.

Per-node receipts are saved in the existing tree document before dispatch.
The roster and tree show continuation state, turns and pause/wait reason.
After a host restart, workers remain stopped and continuation is marked
restart-review-required. Resume the saved worker through its usual permission
checks. Inspect the saved conversation, reconcile any uncertain attempt by
recording its actual outcome/checkpoint, then enroll a new runId. An unresolved
attempt with unchanged checkpoint is refused rather than replayed. Automatic
restart recovery, root-client wake, recurring scheduling and global work stealing
are not implemented. This is assigned-task continuation, not full profile parity.

The standalone command is available to local full-tier management surfaces and
host management surfaces that already grant it. Standard host surfaces route only
continuation through a confined tree adapter; descendant, role and assigned-task
checks still apply. Global objectives must first be linked from an execution
record scoped to the assigned worker node. Its manager enrolls those exact record
IDs; each manager can likewise file a scoped delivery record for its parent.
The enrolled worker still runs at its existing inherited permission level.
