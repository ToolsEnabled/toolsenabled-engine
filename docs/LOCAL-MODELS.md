# Local models: engine contract and app integration

Local-model weights are **bring your own**. The engine ships no weights. Setup
may offer `CURATED_MODELS` and each runtime's install/pull command, but download
is an explicit user action.

## What is real

1. **Describe:** real. `local-node-runtime` exports a curated, capability- and
   minimum-free-VRAM-labelled model list plus the supported runtime table.
2. **Detect:** real. `detect()` probes loopback for Ollama, LM Studio,
   llama.cpp, and vLLM, enumerates installed models, and distinguishes a missing
   server from a listening server with no weights.
3. **Spawn and complete:** implemented end to end. Mission bridge `dispatch`
   with `tier: "local"` resolves a serving endpoint before recording a launch,
   starts `tools/local-node-lane-runner.js`, and that process sends an
   OpenAI-compatible chat completion. `tests/local-node-dispatch.test.js --live`
   is the proof command: it fails if no runtime is present and requires a real
   child PID, terminal success, and model verdict. The ordinary test suite does
   not misrepresent a machine without weights as live proof; it reports the live
   case as unmeasured.

## Provider neutrality audit

The generic provider registry previously made the first registered provider the
default. That made module load order a silent provider policy and could cause a
hosted adapter to win. Registration no longer creates an implicit default;
callers must pass a provider ID or explicitly register a deliberate default.

The local completion path does not require an API key, read a vault, or select a
hosted fallback. Mission bridge's `local` tier has its own provider, seats,
runner, and model resolution. If its runtime, weights, capacity, or runner are
missing, it refuses rather than falling through to Codex, Claude, or Gemini.

## Capacity refusal

Before returning a curated model as spawnable, `resolveNode()` measures the
machine's currently free VRAM using the engine resource probe. It refuses an
unknown measurement and refuses insufficient capacity with an error naming the
requested model, required free VRAM, and actual free VRAM. Unknown/community
models remain selectable because the engine has no truthful size figure for
them; the app should label their fit as unknown rather than inventing one.

## What the app must call

* Setup: render `RUNTIMES` and `CURATED_MODELS`; execute an install or pull
  command only after explicit user confirmation. Never package weights.
* Readiness/model picker: call `detect()`. Offer installed models from the
  returned runtime alongside hosted models. `ready: false` must display
  `reason` and `nextCommand`, not an API-key prompt.
* Preflight: call `resolveNode({ runtime, model })`. Surface its typed message
  verbatim for runtime, installation, and VRAM refusals.
* Execution: call mission bridge `dispatch` with `tier: "local"`. Do not call
  `complete()` directly from the app and do not retry through a hosted provider.
* Release verification: on a machine whose owner has installed weights, run
  `node tests/local-node-dispatch.test.js --live`. A skipped non-live suite is
  not evidence that spawning works on that machine.
