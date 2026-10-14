# ToolsEnabled Security Disclosure Policy

**Status: DRAFT. Prepared for owner review before publication.** Sections
describing current product state are grounded in direct source verification
(dated below) and are safe to publish as-is once a real contact address
exists (§4). Sections proposing a response process are a reasonable default,
not a commitment the owner has made — he should confirm the timelines before
this goes live.

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
(see `TERMS-OF-SERVICE.md` §1.1) for users who choose it — it is not treated
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
restriction is not currently enforced by any code path — see
`TERMS-OF-SERVICE.md` §5. This is a product/business gap, not by itself a
security vulnerability, but is disclosed here because a researcher probing
"can I bypass the paywall" should know there is, today, no paywall to
bypass.

**No telemetry, analytics, or automatic crash reporting exists.** See
`PRIVACY-POLICY.md` §4. This narrows one class of concern (data
exfiltration through an analytics pipe) but is not itself a security
control.

## 3. Planned, not yet done

An external security review is planned and is one of the largest single line
items in the launch approval queue (`docs/design/LAUNCH-APPROVALS.md`),
estimated at $8,000–$30,000. It has not started. A specific mobile
companion app's own threat model already treats this review as
release-blocking for that component specifically — see
`docs/design/MOBILE-APP-THREAT-MODEL.md`. Until it happens, no claim in this
document or elsewhere should be read as "independently verified security,"
only as "our own engineers checked this."

## 4. How to report a vulnerability

**Open item — cannot be finalized yet.** No company domain is registered
(see `PURCHASE-LIST.md`), so there is no `security@` mailbox to publish.
Until one exists, this section is a placeholder. Recommended shape, for the
owner to approve once a domain exists:

- A dedicated `security@<domain>` address, monitored and answered within a
  stated window (we suggest acknowledging within 3 business days — a
  commitment the owner should set deliberately, not one this document
  invents on his behalf).
- A request that reporters not publicly disclose a finding before we've had
  a reasonable window to address it (a standard coordinated-disclosure ask,
  not yet a legally reviewed safe-harbor commitment — see §5).
- No bug bounty program exists today. This document should not imply one
  until the owner decides to fund it.

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

## 7. Relationship to the Terms of Service and Privacy Policy

This document is the detailed, security-specific version of the disclosures
summarized in `TERMS-OF-SERVICE.md` §10 and referenced from
`PRIVACY-POLICY.md` §9. If any of the three documents is updated to change a
security-relevant fact, the other two must be checked for consistency in the
same change.
