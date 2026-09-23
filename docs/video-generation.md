# Seedance video generation

The engine exposes the same video tools on Windows and Linux. Seedance runs
through [fal](https://fal.ai), so generation requires your own fal account,
model access, and credits. No local GPU or Python installation is required.

The credential key is `fal_api_key`. On Windows, `system.credential_request`
opens the existing secure capture dialog. Linux uses its native encrypted vault,
but its capture dialogs are not implemented: an owner-controlled local
integration must provision the key through the existing vault write API first.
See [Linux vault support and prerequisites](LINUX-VAULT.md). Do not place the key
in prompts, tool arguments, source files, or logs. `video.models` reports whether
the local vault has a record; it does not claim the provider has accepted it.
The provider uses `providers.falVideo.enabled` in local policy and obeys the
normal tool permission tier, approvals, and kill switch.

## Generate and keep a video

1. Call `video.models` to see supported models and limits.
2. Call `video.generate` with a model, prompt, and a unique stable
   `idempotencyKey`. For example:

   ```json
   {
     "model": "seedance-2.5",
     "prompt": "A paper boat floats down a rain-soaked street. Low camera, soft evening light, gentle ambient sound.",
     "durationSeconds": 5,
     "resolution": "720p",
     "aspectRatio": "16:9",
     "generateAudio": true,
     "idempotencyKey": "paper-boat-take-001"
   }
   ```

3. Call `video.status` with the returned `jobId`. Set `waitSeconds` to at most
   30 for a bounded wait; a pending result remains queued or running.
4. Call `video.download` with that `jobId` when it succeeds. The result gives
   an MP4 path under the engine's `state/artifacts/video` directory, byte count,
   and SHA-256. Each download creates a new file. The default limit is 256 MiB;
   `maxBytes` may raise it to 1 GiB. Downloading does not generate another video.

`video.jobs` retrieves local submission receipts after a restart. These records
describe submission, so use `video.status` for the provider's current state.
The engine persists the request ID and settings, without storing the prompt or
API key in its submission record.

For image-to-video, add `imageUrl` containing a public HTTPS JPEG, PNG, or WebP
URL, and optionally `endImageUrl` for the last frame. The input image is sent
to fal by reference. Seedance 2.5 requires `aspectRatio: "auto"` for this mode.
Local image-file upload is not yet exposed by these tools.

Seedance 2.0 supports 4–15 seconds and resolutions through 4k; Seedance 2.5
supports 4–30 seconds and resolutions through 1080p. The default is a 5-second,
720p clip. Model availability and charges remain controlled by your provider
account. The constraints come from the official
[Seedance 2.0 schema](https://fal.ai/models/bytedance/seedance-2.0/text-to-video/api),
[Seedance 2.5 schema](https://fal.ai/models/bytedance/seedance-2.5/text-to-video/api),
and [image input schema](https://fal.ai/models/bytedance/seedance-2.5/image-to-video/api),
checked on 2026-09-08.

## Interrupted and cancelled jobs

Reuse the same `idempotencyKey` only with identical generation input. A confirmed
submission returns its existing receipt. If the connection failed after the
request began, `video.jobs` reports `submission_uncertain` and the engine refuses
to submit it again automatically. Inspect the fal dashboard before deciding to
start another generation with a new key.

`video.cancel` requests cancellation for a saved job. A running job can still
finish after the provider accepts cancellation, so the response says
`cancellation_requested`, not completed cancellation. Check `video.status`.
Interrupting a status wait only stops waiting; it does not cancel the remote job.
These distinctions follow fal's
[queue API](https://fal.ai/docs/documentation/model-apis/inference/queue).

Generated files have provider-controlled expiration. The download tool refreshes
the completed result before saving. It sends no API credential to the media
host, requires public DNS addresses, refuses redirects, limits streamed bytes,
checks the MP4 file signature, and removes incomplete downloads.

## Verification

Run the focused regression suite with the engine's supported Node version:

```sh
node tests/run-isolated.js tests/video-provider.test.js tests/video-artifacts.test.js tests/http-core-lifecycle.test.js
```

The provider tests exercise real SQLite persistence and HTTP protocol fixtures.
The artifact tests exercise native file operations and bounded streams. These
tests do not spend provider credits or prove a live authenticated generation.
