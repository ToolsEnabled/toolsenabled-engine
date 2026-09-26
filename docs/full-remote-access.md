# Full Remote Access boundary

ToolsEnabled exposes three distinct remote paths. Their health and authority
must never be treated as interchangeable.

- **Tunnel** is chat-only. It carries owner/agent conversation and does not
  prove that a tool dispatcher or desktop-control session is available.
- **Bridge** is bounded ToolsEnabled capability coverage. It exposes only the
  tool surface allowed by the active permission tier, authenticated peer, and
  current policy.
- **FRA (Full Remote Access)** is complete secure agentic control for a
  customer-authorized paired machine. It additionally requires the encrypted
  session, peer identity, transport binding, capability manifest, runtime/root
  integrity, credential boundary, and desktop readiness checks implemented by
  the FRA lifecycle.

These readiness states are independent: a healthy Tunnel does not prove
Bridge readiness, and a healthy Bridge does not prove FRA readiness. A client
must report the failed layer instead of collapsing all three into “online.”

The direct listeners belong on addresses declared by the customer's service
registry and must remain behind the customer's network boundary. A future
online-server extension may provide authenticated account rendezvous and relay
coordination, but it must not publish 8787, 8788, 8790 or any equivalent direct
listener to the public Internet. Relay admission does not weaken local policy,
peer enrollment, token, audit, or permission-tier checks.

The same lifecycle runs on both machines in a configured pair. The
customer-declared directional topology assigns coordinator and recipient
responsibilities; each role is checked at the operation that requires it.
Machine names and an installation-specific whole-host exception do not grant or
remove FRA lifecycle authority.

Fresh installations ship with one loopback-only machine and no invented peer.
Paired-machine features remain unavailable until the customer declares their
own machines and authorizes the relationship.
