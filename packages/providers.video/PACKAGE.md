# `providers.video` package charter

## Purpose

Video model discovery and durable asynchronous video generation through the
official fal API, with Seedance text and image inputs.

## Public API

`src/lib/providers/video.js`: models, generate, jobs, status, cancel, download.
`src/lib/video-models.js`: supported models and their input bounds.
`src/lib/video-artifacts.js`: bounded, cancellable MP4 downloads into managed artifacts.

## Allowed dependencies

`kernel.runtime`, `kernel.state`, `kernel.policy`,
`surface.policy` provide credentials, durable operations, policy and validation.

## Action classes

`RECORD`, `LOCAL-WORK`, `EXTERNAL-READ`, `EXTERNAL-WRITE`.

## Must not do

Do not accept plaintext API keys or arbitrary API hosts, retry an uncertain paid
submission, follow credentialed redirects, persist prompts, claim successful
generation from a submission acknowledgement, or claim cancellation finished
merely because the provider accepted it.

## Verification

`node tests/run-isolated.js tests/video-provider.test.js`.
Native Linux and Windows checks exercise the same implementation. HTTP fixtures
prove protocol behavior; an authenticated provider generation is separate proof.
