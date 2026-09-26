# Canonical defect-class guard preamble

Every corpus brief must reproduce the block below verbatim before its trailing
`CONTRACT/1` machine-readable section. The sentinels and wording are part of the
contract; `check-corpus.mjs` reads this file and checks the block directly so the
canonical text has one owner.

BEGIN DEFECT-CLASS GUARDS v1
DEFECT-CLASS GUARDS (MANDATORY)

- VOCABULARY_DERIVATION — Derive, never retype: user-visible copy owned by a vocabulary module must come from its canonical export or helper in both production code and tests; never duplicate the literal.
  DETECT — Compare added UI and test literals with vocabulary-module exports; a duplicate governed phrase without the canonical import/helper is a defect.
- PRODUCT_PROBE_SELF_ARMING — Product-probe self-arming only: a skip or conditional test must decide from observed product behavior or capability, never an environment variable, test-only flag, constant, or fixture literal, and must automatically run when the product capability exists.
  DETECT — Trace every skip/conditional-registration predicate; reject it if config or a hardcoded value can keep the test disarmed while the product behavior is present.
- WINDOWS_PATH_PORTABILITY — Filesystem assertions in a Windows-run suite must be separator- and root-neutral, using path-aware normalization/comparison rather than POSIX-only `/...` expectations.
  DETECT — Inspect expected paths and path regexes for a leading POSIX root or mandatory `/` separators that would reject an equivalent Windows path.
- NON_VACUOUS_ASSERTIONS — Assert an independently observed result: never assert only what the test constructed, swallow the failure that should fail the test, or use a regex/predicate that is true for every relevant value.
  DETECT — Trace actual and expected to independent origins, confirm caught errors are rethrown/asserted, and, for each assertion, supply a plausible bad value that would make that assertion fail.

END DEFECT-CLASS GUARDS v1

The vocabulary rule also carries the binding design ruling that shipped words
such as approval decisions and action labels come through their existing
vocabulary contracts. The other three classes are explicit corpus-level guards;
they apply even where a particular design reference does not mention test
mechanics.
