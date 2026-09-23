# Contributing

## The short version

Outside contributions are open. Sign off your commits with `git commit -s`, and
your change is contributed under the MIT License that covers the rest of the
project. There is nothing to sign, nothing to email, and no copyright to hand
over.

## Why there is a rule here at all

A licence is the one property of published software that cannot be corrected
afterwards: every copy already taken keeps the terms it was handed. The same is
true of who owns the code. The moment a contribution is merged from someone who
never said what terms they were offering it under, the project owns a piece of
code whose provenance it cannot state — and that is not fixable later by
policy, only by finding the person and asking, or by deleting the work.

So the requirement is not paperwork. It is the project being able to say, of
every line in it, where it came from and under what terms it arrived.

## What we ask for: the Developer Certificate of Origin

This project uses the **Developer Certificate of Origin, version 1.1** — the
same mechanism the Linux kernel, Git and many others use. You certify it by
adding a `Signed-off-by` line to each commit:

```
git commit -s -m "your message"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must be your own and must match the commit author. Use
`git config user.name` and `git config user.email` to set them.

### What you are certifying

The full text, reproduced verbatim:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
1 Letterman Drive
Suite D4700
San Francisco, CA, 94129

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### A DCO, and not a CLA

This was a real choice, and it is worth stating why, because the two are not
interchangeable and the reasoning depends on the licence.

A **Contributor Licence Agreement** — assignment, or a broad grant back to the
project — is what a project needs when its business depends on holding all the
copyright: classically, one that gives the code away under a copyleft licence
and sells the same code under proprietary terms. That was this project's
position while it was AGPL, and it is why outside contributions were closed.

Under MIT, that dependency is gone, for two separate reasons:

1. **The business does not sell the code.** The client is free and open, and
   what is sold is *operating a server*. Running a paid service does not
   require owning the copyright in the client, so no future contributor can
   block it.

2. **MIT already grants what a CLA would have collected.** MIT permits
   sublicensing. A contribution received under MIT can be redistributed by this
   project under other terms, including in a closed-source product, as long as
   the contributor's copyright notice travels with it. The relicensing headroom
   a CLA exists to preserve is, for the most part, already in the inbound
   licence.

Against that, a CLA has a real cost: it deters contributors, some decline
assignment on principle, and it needs signature infrastructure and a record to
maintain. Paying that cost to buy something MIT largely already provides would
be process for its own sake.

**What the DCO does not give us, stated plainly rather than buried:** it is not
a patent licence, and it does not let the project remove a contributor's
copyright notice or relicense their contribution under terms that contradict
MIT. If the project ever needs an express patent grant from contributors, the
instrument for that is a different inbound licence (Apache-2.0) or a CLA, and
that is a decision to take deliberately rather than discover.

## Credit

Add yourself to `CONTRIBUTORS.md` in the same pull request:

```
- Name (@handle) — what you contributed
```

A handle alone is fine, and you can ask not to be listed. Contributors and
maintainers are never founders; see `CONTRIBUTORS.md` for what that means and
why it is written down.

## Enforcing it locally

The sign-off is checked, not trusted:

```
node tools/check-dco.js              # checks this branch against origin/main
node tools/check-dco.js <range>      # checks any git revision range
```

To have git refuse an unsigned commit before it exists, point git at the
repository's hooks once:

```
git config core.hooksPath .githooks
```

Commits authored before this policy was adopted are grandfathered by date; the
whole history predates it, and rewriting that history to add sign-offs nobody
actually gave would be a worse record than the one we have.

## Security reports

Read `SECURITY.md` and follow the private route it describes rather than
opening a public issue.
