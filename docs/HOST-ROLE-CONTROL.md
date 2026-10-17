# Explicit host root role control

toolsenabled serve --tree-key host-owner-3 --enable-role-control enables
agent.set_role for this root session. This is explicit operator startup
configuration, not evidence that requests came from a human. The default is off.
It does not change saved role/function settings or native/provider authority.

The flag requires a worker-enabled host root with an unedited installed
organisation-root role (revision zero). Worker-linked invocations, custom or saved
role overrides, and inherited allowlists omitting agent.set_role are refused.
Only agent.set_role is added; existing restrictions and descendant/role admission
checks remain in force. Workers do not inherit this startup opt-in.

Stop a slot through its normal Fleet command, configure its role through
agent.set_role, then resume it. Existing conversations and reports remain in the
slot. The role change takes effect on its next session. Inspect the returned
receipt and the resumed surface before delegating.

An explicit same-role change on a stopped host slot refreshes its tool surface
through current role admission and the actual parent's allowance. The receipt
reports surfaceRefresh and its exact functions. Resume to apply it. Running
same-role requests remain unchanged. This can refresh an older retained manager
surface without editing its role policy or discarding its thread/history.
