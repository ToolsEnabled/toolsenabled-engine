---
name: ig-publish
description: Verify an authorized Instagram professional account and publish a public image URL with a caption through the official API.
---

Call `instagram.verify` before the first publishing run. Publish with
`instagram.publish_image`, using an HTTPS image URL. The adapter polls the media
container to completion and records the resulting media ID in the audit log.
