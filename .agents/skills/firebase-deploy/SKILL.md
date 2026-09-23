---
name: firebase-deploy
description: Create Firebase projects/apps and deploy a Firebase-configured local project through the Firebase CLI.
---

Run `firebase.doctor` and `gcloud.doctor` first. Use `firebase.project_create`,
`firebase.project_enable`, `firebase.firestore_create`, `firebase.app_create`, and
`firebase.deploy` directly, or `launch.execute` to install/build/test before a
Firebase deployment. For IaC, run `terraform.init`, then
`terraform.validate`, then `terraform.plan`, then `terraform.apply` against an explicit local infrastructure
directory. Use `gcloud.service_account_create` and
`gcloud.service_account_key_to_vault` when a deploy-scoped service account is needed;
the latter never returns private key material. Provider authentication must already
exist locally.
