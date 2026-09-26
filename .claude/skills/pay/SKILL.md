---
name: pay
description: Enforce local spend caps and issue Stripe-authorized virtual cards with provider-enforced limits.
---

Use `pay.check` before an anticipated provider charge and `pay.record` after a
provider-authorized charge. For an approved Stripe Issuing account, create a
cardholder with `stripe.cardholder_create` and a restricted online virtual card with
`stripe.virtual_card_create`. Never request or store card PAN/CVC values.
