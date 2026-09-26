# ToolsEnabled Security Disclosure Policy

**Status: draft, not yet in effect.** The sections describing current product
state were checked against the source on the date below. The reporting
process in §4 is a proposed default, not a commitment: no security contact
mailbox exists yet, and no response timelines have been committed.

Last updated: 2026-08-10

---

## 1. What this document is

This is where security researchers, customers, and anyone else who finds a
vulnerability in ToolsEnabled should report it, and where we say plainly
what our current security posture actually is — including its gaps, per our
own internal doctrine: *"where the system falls short of the bar... the
answer is to say so plainly, in the settings UI, in status readouts, in
documentation. Never let a limitation go unstated"*
(`docs/design/SECURITY-POSTURE-DOCTRINE.md` §4).

## 2. Current security posture — verified, not asserted

The claims below were checked directly against the product's source code on
the date at the top of this document.

**No independent, external security review has occurred.** This is the
single most important fact in this document. ToolsEnabled has not been
audited by an outside security firm. An internal engineering review found
several categories of gap (see below); none of those findings are a
substitute for independent review, and none of the fixes made in response to
them have themselves been independently verified.

**The product can run with no sandboxing at all, by design.** In its most
permissive configuration, ToolsEnabled agents can read, modify, or delete
any file on the host machine and execute arbitrary programs, without a
per-action confirmation. This is a deliberate, disclosed product capability
for users who choose it — it is not treated
here as a vulnerability, but it materially changes what "secure" can mean
for this product, and any report that assumes sandboxing is always active
should account for that.

**The local audit ledger is tamper-evident, not tamper-proof against a
same-account attacker.** It is a signed, hash-chained local log
(`src/lib/audit-store.js`) that detects after-the-fact tampering by an
outside actor, but a process running under the same Windows account that can
already read the ledger and its signing key is, in our own documentation's
words, "outside the guarantee." This is not a defect we are hiding — it is
the honest boundary of what a local, single-machine log can promise.

**No network surface is currently internet-reachable.** The product's
cross-machine features (an authenticated relay, a bounded remote-tool
bridge, and a full-remote-access lane) are opt-in, restricted to a direct
link between specifically paired machines, and — as of this writing —
physically disconnected. A further public-internet extension of this exists
only as explicitly disabled, undeployed code with its own written deployment
prohibition pending independent verification of several security
preconditions. Nothing in the current shipping product listens on a public
address.

**License enforcement is offline and currently unwired.** Paid-tier
restriction is not currently enforced by any code path. This is a
product/business gap, not by itself a
security vulnerability, but is disclosed here because a researcher probing
"can I bypass the paywall" should know there is, today, no paywall to
bypass.

**No telemetry, analytics, or automatic crash reporting exists.** See
`PRIVACY-POLICY.md` §4. This narrows one class of concern (data
exfiltration through an analytics pipe) but is not itself a security
control.

## 3. Planned, not yet done

An external security review is planned. It has not started. A mobile
companion app's own threat model already treats this review as
release-blocking for that component specifically. Until it happens, no claim in this
document or elsewhere should be read as "independently verified security,"
only as "our own engineers checked this."

## 4. How to report a vulnerability

**Open item — cannot be finalized yet.** There is no `security@` mailbox to
publish yet. Until one exists, this section is a placeholder. The intended
shape:

- A dedicated `security@<domain>` address, monitored and answered within a
  stated window (the acknowledgement window will be set when the mailbox
  exists; this document does not invent one).
- A request that reporters not publicly disclose a finding before we've had
  a reasonable window to address it (a standard coordinated-disclosure ask,
  not yet a legally reviewed safe-harbor commitment — see §5).
- No bug bounty program exists today. This document should not imply one
  until one is funded.

## 5. Safe harbor **[LAWYER]**

A real safe-harbor clause (a promise not to pursue legal action against a
good-faith security researcher who follows responsible-disclosure rules) is
standard practice and something we recommend adding, but it is legal
language that needs a lawyer's review before publication — an unreviewed
safe-harbor clause can create liability or fail to actually protect a
researcher the way it's meant to. Flagged for counsel, not drafted here.

## 6. Scope

Once a contact address exists, this section should state plainly what's in
scope (the local runtime, the desktop application, the hosted relay once it
exists) and what's out of scope (third-party AI provider infrastructure,
which is covered by the provider's own program; and unrelated products,
which require their own policies).

## 7. Relationship to the Privacy Policy

This document is the detailed, security-specific version of the disclosures
referenced from `PRIVACY-POLICY.md` §9. If either document is updated to
change a security-relevant fact, the other must be checked for consistency in
the same change.
