# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues. Report them
privately in either of these ways:

- **Email:** security@toolsenabled.ai
- **GitHub:** open this repository's **Security** tab and choose **Report a
  vulnerability**, or go to
  https://github.com/ToolsEnabled/toolsenabled-engine/security/advisories/new

Please include:

- what you found and what it lets someone do;
- the steps to reproduce it;
- the release tag or commit, and your OpenShell version if it matters.

### What to expect

- We acknowledge a report within **3 business days**.
- We keep you informed while we work on it, and we credit you in the release
  notes unless you ask us not to.
- Please give us a reasonable time to fix a problem before you disclose it
  publicly. We will agree a date with you.
- There is no bug bounty.

### What we ask of you

- Follow this policy and any other relevant agreements. If this policy and
  other applicable terms disagree, this policy prevails.
- Report a vulnerability promptly once you find it.
- Avoid violating the privacy of others, disrupting our systems, destroying
  data or harming anyone's use of the product.
- Discuss vulnerability information with us only through the two reporting
  channels above.
- Give us a reasonable amount of time to resolve the issue before you
  disclose it publicly.
- Test only what is in scope (below), and respect everything that is out of
  scope.
- If a vulnerability gives you unintended access to data, access only the
  minimum needed to demonstrate it. Stop testing and report immediately if you
  come across anyone's personal information, health information, payment card
  data or proprietary information.
- Only use accounts you own, or accounts whose holder has explicitly allowed
  you to use them.
- Do not engage in extortion.

## Safe harbor

When conducting vulnerability research, according to this policy, we
consider this research conducted under this policy to be:

- Authorized concerning any applicable anti-hacking laws, and we will not
  initiate or support legal action against you for accidental, good-faith
  violations of this policy;
- Authorized concerning any relevant anti-circumvention laws, and we will not
  bring a claim against you for circumvention of technology controls;
- Exempt from restrictions in our Terms of Service (TOS) and/or Acceptable
  Usage Policy (AUP) that would interfere with conducting security research,
  and we waive those restrictions on a limited basis; and
- Lawful, helpful to the overall security of the Internet, and conducted in
  good faith.

You are expected, as always, to comply with all applicable laws. If legal
action is initiated by a third party against you and you have complied with
this policy, we will take steps to make it known that your actions were
conducted in compliance with this policy.

If at any time you have concerns or are uncertain whether your security
research is consistent with this policy, please submit a report through one
of the reporting channels above before going any further.

> Note that the Safe Harbor applies only to legal claims under the control of
> ToolsEnabled, Inc., and that the policy does not bind independent third
> parties. In particular, it does not cover research on NVIDIA's, Anthropic's
> or OpenAI's systems; their own policies apply there.

The "What we ask of you" and "Safe harbor" sections are adapted from the
[disclose.io](https://disclose.io) policy templates (CC0 1.0).

## Scope

**In scope:** the ToolsEnabled engine in this repository, including
`adapters/openshell/` (the image recipe, `codex-openshell-auth`, the sandbox
policy) and the `toolsenabled` command (also installed as `toolsenabled-openshell`).

**Report these to their owners instead:**

- **NVIDIA OpenShell** (the sandbox, the gateway and policy enforcement):
  follow NVIDIA's process in
  https://github.com/NVIDIA/OpenShell/blob/main/SECURITY.md
- **The Claude CLI (`claude`):** Anthropic.
- **Codex CLI:** OpenAI.

If you are not sure where a problem belongs, send it to us and we will pass
it on with your permission.

**The ToolsEnabled desktop app is paused.** It gets no new releases or
fixes while paused. You can still report problems in it, and we will read
them.

## Supported versions

Only the latest published release of ToolsEnabled for OpenShell gets
security fixes.

## Where the security boundary is

In ToolsEnabled for OpenShell, **OpenShell is the security boundary.** It
enforces the filesystem and network policy, holds the credentials it
manages, and decides access approvals. ToolsEnabled's own rules (the work
record, actor labels, the tool list) run inside the sandbox as the same user
as the agents, so they are not a security boundary. The "Who enforces what"
table in `adapters/openshell/README.md` lists each part.

No independent security review of ToolsEnabled has taken place yet.
