---
name: _template
description: TEMPLATE — copy this folder to create a new capability skill. Not a real power. Describe here exactly WHEN Claude should invoke the skill (the trigger), because Claude selects skills by matching this description to the task.
metadata:
  status: template
  phase: 3
---

# <Capability name>

## When to use
<One sentence: the task shape that should trigger this skill.>

## Prerequisites (one-time)
- <accounts, fees, OAuth consent, tokens — the manual gates>
- Secrets live in the vault under key `<service>`; fetch via `tools/secrets.ps1 get <service>`.

## Steps
1. <first action>
2. <second action>
3. Log the outward action to `logs/actions.log`.

## Limits
- <the useful limit: rate caps, ToS, what still needs a human>

## Kill switch
If a file named `KILLSWITCH` exists in the repo root, do not perform any outward or
irreversible action — stop and report.
