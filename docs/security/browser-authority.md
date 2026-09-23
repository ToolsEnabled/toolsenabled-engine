# Browser authorization at the desktop

The browser's encrypted session proves which introduced key sent a request.
The account service separately establishes whether that browser still has
authority to use this computer. The desktop checks both before forwarding a
new browser request to its authenticated loopback bridge and before returning
a response. The relay is not the desktop's source of browser identity or
authorization freshness.

An account authorization observation is usable for at most **30 seconds**,
and never beyond the shorter account-authorization or transport deadline.
At the deadline a new request must wait for a successful account refresh.
Refreshes use the machine's existing authenticated account channel and do not
count as browser activity. Normal hosted-relay revocation remains an additional
control; this bound applies even when the relay continues forwarding frames.

The account introduction must include positive safe-integer
`authorizationCheckedAtMs`, `authorizationExpiresAtMs` and `expiresAtMs`.
Authorization may not outlive transport. Missing or malformed fields refuse
access; older servers that omit them cannot grant indefinite compatibility.
Deploy the account contract before restarting an endpoint requiring it.

Account observations allow five seconds of clock uncertainty, matching the
existing signed-hello clock tolerance. The endpoint subtracts the oldest
plausible observation age from the available budget. With synchronized clocks,
this normally means refreshing after about 25 seconds; thirty seconds is the
maximum, not a promised cache duration. Delayed responses, including body
reads, consume the budget from request start. A monotonic clock bounds local
elapsed time; forward wall-clock movement also counts to cover suspension.
Previously observed server time remains anchored to monotonic elapsed time
across refresh and invalidation, so replaying a checked timestamp after a wall
clock rollback cannot create a fresh grant. Clock uncertainty can conservatively
refuse access early, including the last few seconds before account expiry.

Each web leg has one account refresh in flight, a five-second fetch/body
deadline and a bounded failure retry interval. At most 32 authenticated browser
requests may be in progress. A delayed or ignored-abort response cannot revive
authority after timeout or connection close. New account fetches are on demand
for handshakes, dispatch and replies; idle machines do not need a timer-driven
background poll solely for this control. Account unavailability beyond a grant
stops new remote operations until authorization can be established again.

Each accepted crypto session records the exact browser ID, public key and
local authority epoch. Requests retain that identity through asynchronous
work. A private in-process dispatch guard rechecks authority after the local
write-permission probe and immediately before loopback dispatch. The guard is
not a tunnel field or forwarded header. An old response is never encrypted
onto the replacement browser's session. Renewal of encryption keys for the
same browser remains supported.

Revocation refuses newly dispatched requests and closes the affected web
session keys. It does not cancel an already dispatched local operation or
durable unattended job, and does not automatically retry an uncertain action.
The dispatch boundary is the engine's handoff to authenticated loopback HTTP;
this is not a guarantee that every downstream effect finishes before an
authorization deadline. Existing local read/write permissions remain separate.
Machine-to-machine session policy is outside this browser-specific control.

Regression coverage includes genuine signed admission/E2E frames through a
synthetic relay that ignores revocation, browser replacement during queued
work and response delivery, continued same-browser key renewal, slow/malformed
account responses, clock rollback/replay, request bounds and an actual
thirty-second wall-clock test using the shipped crypto lease length. All
fixtures use inert local requests and disposable identities. These internal
tests are not an external cryptographic audit or penetration test of customer
computers.
