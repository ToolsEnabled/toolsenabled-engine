# Use another model (work in progress)

Run the agents in your OpenShell sandbox on a model of your choice: a hosted
OpenAI-compatible API (NVIDIA's API catalog, OpenAI, OpenRouter, Together,
DeepInfra and others) or a model server on your own machine (NIM, vLLM,
Ollama, SGLang, LM Studio, llama.cpp).

Everything here uses OpenShell's and Codex's own mechanisms. ToolsEnabled only
writes Codex's configuration for you and never sees a key.

> **Status:** work in progress, not released. Tested on the setup in
> [README.md](README.md#supported-versions), with local stand-in servers, not
> with a paid hosted API. Read [Known gaps](#known-gaps).

---

## How it fits together

| Piece | Who owns it | What it does |
|---|---|---|
| Provider profile | OpenShell, imported by you on the host | Names the endpoint's host, port and path, the programs allowed to reach it, and the key variable. The key is bound to that endpoint only. |
| Provider | OpenShell, created by you on the host | Holds the key. The sandbox gets an `openshell:resolve:...` placeholder in the key variable; OpenShell's proxy swaps in the real key on requests to the bound endpoint and refuses the placeholder anywhere else. |
| Codex model provider | Codex's own `config.toml`, written by `model add` | `[model_providers.<name>]` with `base_url`, `env_key` (the placeholder variable) and `wire_api = "responses"`, plus a `<name>.config.toml` profile file so `codex --profile <name>` uses it. `--default` also sets the top-level `model` and `model_provider`. |
| ToolsEnabled's model tool | ToolsEnabled | Inside a sandbox, `model.customer_complete` uses the default endpoint and sends only the placeholder. It never reads the vault or desktop settings there. |

**One requirement on the model server:** Codex 0.158 speaks only the OpenAI
**Responses API** (`POST <base_url>/responses`). It refuses `wire_api =
"chat"` ("no longer supported"). A server that offers only
`/chat/completions` cannot be used by Codex; ToolsEnabled's own model tool,
which uses `/chat/completions`, still can. Check a server before you start:

```shell
curl -sS <base_url>/responses -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" -d '{"model":"<model id>","input":"Say hello"}'
```

## The command

The recommended command is `toolsenabled-openshell model`:

```text
toolsenabled-openshell model add <name> --base-url URL --model ID [--key-env VAR] [--display-name TEXT] [--default]
toolsenabled-openshell model list [--json]
toolsenabled-openshell model use <name>
toolsenabled-openshell model remove <name>
toolsenabled-openshell model profile <name> --base-url URL [--key-env VAR] [--display-name TEXT] [--binary PATH]...
```

Inside the sandbox it is also available as `toolsenabled model`.

On the host, `profile` runs from your checkout of this repository:
`node src/lib/openshell-models.js profile ...`.

- `add`, `use` and `remove` run only inside an OpenShell sandbox. They change
  `config.toml` in the sandbox's `CODEX_HOME` (default `/sandbox/.codex`) and
  leave every other line as it was.
- `add` refuses a key variable that holds a real value inside the sandbox. The
  key belongs in an OpenShell provider.
- With a default endpoint set (`add --default` or `use`), Codex workers on the
  agent tree (`setup --agents`) run that endpoint's model instead of their
  tier's, and `agent.set_model` for a Codex worker is refused with the
  endpoint's name. Claude workers are unaffected.
- `profile` prints an OpenShell provider profile for the endpoint, for you to
  review and import on the host. It binds the key to the base URL's host, port
  and path, and allows Codex's binaries and curl.
- `<name>` is lowercase letters, digits and hyphens. Codex's built-in names
  (`openai`, `ollama`, `lmstudio`, `amazon-bedrock`) are refused. Using the
  same name for the OpenShell profile, the provider and the endpoint keeps
  things easy to follow.

Below, `te` is your sandbox's name.

---

## A. NVIDIA API catalog

OpenShell's own example profile
[`providers/nvidia.yaml`](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/providers/nvidia.yaml)
is used **unchanged**. Its endpoint (`integrate.api.nvidia.com:443`) is right,
but its `binaries` list only curl, so one sandbox rule lets Codex reach the
same endpoint (step 4).

On the host:

```shell
# 1. Import OpenShell's example profile (review it first).
openshell profile lint   --url https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/providers/nvidia.yaml
openshell profile import --url https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/providers/nvidia.yaml

# 2. Create the provider. The key is read from your shell, not the command line.
read -rs NVIDIA_API_KEY && export NVIDIA_API_KEY      # paste your nvapi-... key
openshell provider create --name nvidia --type nvidia --credential NVIDIA_API_KEY
unset NVIDIA_API_KEY

# 3. Attach it (or pass --provider nvidia to `openshell sandbox create`).
openshell sandbox provider attach te nvidia --wait

# 4. Let Codex's binaries reach the endpoint the profile binds the key to.
openshell policy update te --rule-name codex_nvidia \
  --binary '/usr/local/lib/node_modules/@openai/**' \
  --add-endpoint 'integrate.api.nvidia.com:443:read-write:rest:enforce' --wait
```

Inside the sandbox, in a **new** shell (a process started before the
attachment does not have the placeholder):

```shell
toolsenabled model add nvidia --base-url https://integrate.api.nvidia.com/v1 \
  --model nvidia/nemotron-3-super-120b-a12b --key-env NVIDIA_API_KEY --default
toolsenabled model list
curl -sS -H "authorization: Bearer $NVIDIA_API_KEY" https://integrate.api.nvidia.com/v1/models | head -c 300; echo
codex --profile nvidia          # or plain `codex`, since --default was given
```

Choose a model from build.nvidia.com that serves the Responses API; OpenShell's
own inference guide uses `nvidia/nemotron-3-super-120b-a12b` that way.

**Why step 4, and the alternative.** In OpenShell 0.1.2 a profile's `binaries`
decide which programs may reach its endpoints, while the key is bound to the
endpoint, not to a program. Step 4 therefore admits Codex without editing the
profile; this was measured (see [What was run](#what-was-run)). OpenShell lists
"binary-scoped credential injection" as planned; if that lands, a key would
resolve only for the profile's own `binaries`, and step 4 would stop being
enough. The forward-compatible alternative is a profile that names Codex
itself:

```shell
node src/lib/openshell-models.js profile nvidia-codex \
  --base-url https://integrate.api.nvidia.com/v1 --key-env NVIDIA_API_KEY \
  --display-name "NVIDIA API catalog" > nvidia-codex.yaml
# review, then: openshell profile lint/import -f nvidia-codex.yaml,
# openshell provider create --name nvidia-codex --type nvidia-codex --credential NVIDIA_API_KEY
```

It uses a new id (OpenShell's advice for an edited copy), keeps the same
host, adds the `/v1/**` path, and needs no step 4.

---

## B. A model server on your own machine (NIM, vLLM, Ollama)

`host.openshell.internal` is OpenShell's name for the machine that runs your
gateway. With the Docker driver it reaches that machine's loopback, so a
server listening only on `127.0.0.1` is reachable and you do not need to
expose it on your network. (With other drivers, bind the server to an address
the gateway runtime can reach. It is never your laptop when the gateway is
remote.)

| Server | Usual base URL from the sandbox | Responses API |
|---|---|---|
| vLLM | `http://host.openshell.internal:8000/v1` | documented by vLLM (`/v1/responses`) |
| NIM for LLMs | `http://host.openshell.internal:8000/v1` | check with the `curl` above; a release that serves only `/chat/completions` cannot serve Codex |
| Ollama | `http://host.openshell.internal:11434/v1` | documented from Ollama 0.13.3, without stored conversations |
| SGLang, LM Studio, llama.cpp | port 30000, 1234, 8080 | check with the `curl` above |

These support notes come from each project's documentation, not from runs
here; only stand-in servers were run (see [What was run](#what-was-run)).

Plain `http` is accepted only for `host.openshell.internal` (and loopback
inside the sandbox): that traffic never leaves your machine. Any other host
must use `https`.

On the host, for a server that takes **no key** (vLLM's example port 8000):

```shell
node src/lib/openshell-models.js profile vllm-host \
  --base-url http://host.openshell.internal:8000/v1 --display-name "vLLM on this machine" > vllm-host.yaml
openshell profile lint   -f vllm-host.yaml
openshell profile import -f vllm-host.yaml
openshell provider create --name vllm-host --type vllm-host
openshell sandbox provider attach te vllm-host --wait
```

([`providers/host-model-server.template.yaml`](providers/host-model-server.template.yaml)
is the same profile with placeholders, if you prefer to edit a file.)

Inside the sandbox, in a new shell:

```shell
toolsenabled model add vllm-host --base-url http://host.openshell.internal:8000/v1 --model <served model id> --default
curl -sS http://host.openshell.internal:8000/v1/models
codex
```

For **Ollama** use port 11434 and an installed model tag, for example
`--model qwen3.5:9b`. For a server that **takes a key** (vLLM `--api-key`, a
secured NIM), add `--key-env VLLM_API_KEY` to both `profile` and `add`, and
create the provider with `--credential VLLM_API_KEY` as in section A.

---

## C. Any other OpenAI-compatible endpoint

**If OpenShell has an example profile for the service,** follow section A with
that profile, its key variable and its host:

| Service | OpenShell example profile (v0.1.2) | Key variable | Host for step 4 | `--base-url` |
|---|---|---|---|---|
| NVIDIA API catalog | `providers/nvidia.yaml` | `NVIDIA_API_KEY` | `integrate.api.nvidia.com` | `https://integrate.api.nvidia.com/v1` |
| OpenAI API (API key) | `providers/openai.yaml` | `OPENAI_API_KEY` | `api.openai.com` | `https://api.openai.com/v1` |
| OpenRouter | `providers/openrouter.yaml` | `OPENROUTER_API_KEY` | `openrouter.ai` | `https://openrouter.ai/api/v1` |
| DeepInfra | `providers/deepinfra.yaml` | `DEEPINFRA_API_KEY` | `api.deepinfra.com` | `https://api.deepinfra.com/v1/openai` |

For the OpenAI API, name the endpoint something other than `openai` (Codex
reserves it), for example `toolsenabled model add openai-api ...`. Your ChatGPT sign-in
through the `codex` provider is separate and keeps working.

**Otherwise** (Together, a company gateway, anything else), generate a
profile for it on the host and follow the rest of section A without step 4:

```shell
node src/lib/openshell-models.js profile together-ai \
  --base-url https://api.together.xyz/v1 --key-env TOGETHER_API_KEY --display-name "Together AI" > together-ai.yaml
openshell profile lint -f together-ai.yaml && openshell profile import -f together-ai.yaml
read -rs TOGETHER_API_KEY && export TOGETHER_API_KEY
openshell provider create --name together-ai --type together-ai --credential TOGETHER_API_KEY
unset TOGETHER_API_KEY
openshell sandbox provider attach te together-ai --wait
```

Then inside the sandbox:

```shell
toolsenabled model add together-ai --base-url https://api.together.xyz/v1 --model <model id> --key-env TOGETHER_API_KEY
codex --profile together-ai
```

([`providers/model-endpoint.template.yaml`](providers/model-endpoint.template.yaml)
is the same profile with placeholders.)

---

## Upstream profiles against this image

OpenShell's examples live in
[`providers/`](https://github.com/NVIDIA/OpenShell/tree/v0.1.2/providers)
(identical at `v0.1.2` and `main` on 2026-09-29). Each passed `openshell profile lint`
on OpenShell 0.1.2.

| Profile | Endpoint | `binaries` | Used unchanged here? |
|---|---|---|---|
| `nvidia.yaml` | `integrate.api.nvidia.com:443` | `/usr/bin/curl`, `/usr/local/bin/curl` | Yes, with one sandbox rule for Codex's binaries (section A, step 4). |
| `openai.yaml` | `api.openai.com:443` | curl | Yes, the same way. |
| `deepinfra.yaml` | `api.deepinfra.com:443` | curl | Yes, the same way. |
| `openrouter.yaml` | `openrouter.ai:443` | `/usr/local/bin/opencode` (not in this image) | Yes, the same way; only the rule's programs reach it. |
| `anthropic.yaml`, `claude-code.yaml` | Anthropic | | Not for this: Codex speaks the OpenAI Responses API. |
| `codex.yaml` | OpenAI and ChatGPT | | The ChatGPT sign-in from [README.md](README.md), not a model endpoint. |

The edit needed to use one **without** a sandbox rule: give it a new `id`,
and set `binaries` to `/usr/local/lib/node_modules/@openai/**` (Codex's
native binaries, real paths in this image's npm global layout; the
`/usr/local/bin/codex` symlink is not a real path) plus curl if you want the
smoke test. `model profile` writes exactly that.

---

## Managing endpoints

```shell
toolsenabled model list                 # * marks the default; shows whether the key is a placeholder
toolsenabled model use vllm-host        # make another endpoint the default
toolsenabled model remove vllm-host     # its table, its profile file, and the default if it was one
```

`--default` and `use` keep a top-level `model` or `model_provider` line you
had set yourself as a comment (`# Saved by toolsenabled-openshell model
use: ...`); removing the endpoint puts it back. `model` refuses to edit a
table it did not write, a legacy `[profiles.<name>]` table (Codex refuses one
next to a profile file), and model providers written as dotted keys or inline
tables.

To take the key away, detach the provider on the host
(`openshell sandbox provider detach te <name> --wait`); the placeholder stops
resolving.

---

## ToolsEnabled's own model tool

Inside a sandbox, `model.customer_complete` uses the endpoint set with
`--default` and calls `<base_url>/chat/completions`:

- The key is sent only as the provider's placeholder. A missing placeholder,
  or a real key in the sandbox's environment, is refused before any request.
- The vault and desktop settings are never read in a sandbox.
- A server on `host.openshell.internal` gets the longer local timeout
  (120 s) that covers loading a model.
- Like any program, it reaches the endpoint only under a rule that covers it.
  Started by Codex (as the registered ToolsEnabled server is), it shares
  Codex's rule.

The local-model engine (`src/lib/agent-engine/local-node-*.js`) is unchanged.
It speaks Ollama's native chat route and runs in the desktop app, not in a
sandbox.

---

## What was run

2026-09-29, on the setup in [README.md](README.md#supported-versions), in a
sandbox built from this branch with `cli-sign-in.yaml`. The "hosted" and
"local" servers were small OpenAI-compatible stand-ins on the host
(`tests/helpers/openai-compatible-stub.js`) that record whether each request's
authorization header carried the expected made-up key, an unresolved
placeholder, or nothing.

- **Codex through a keyed endpoint.** Profile from `model profile` for
  `http://host.openshell.internal:18431/v1`, provider created with a made-up
  key, `model add stub ... --key-env STUB_API_KEY`: `codex exec --profile stub`
  answered with the server's reply; the server saw `POST /v1/responses` with
  the made-up key. Inside the sandbox `STUB_API_KEY` began
  `openshell:resolve:env:`, and the made-up key appeared nowhere under
  `/sandbox`, `/tmp` or the process environment.
- **Default and workers.** After `model use stub`, plain `codex exec`
  answered through the server, and so did a Codex worker started through the
  OpenShell agent host with the model id from `codexSelection()`.
- **Endpoint binding.** curl with the placeholder to `/v1/models`: 200, key
  resolved. To `/admin/models` on the same host and port: 403
  `policy_denied` (outside the profile's `/v1/**`). To another port: refused.
- **Program binding.** Plain `node` (not in the profile's `binaries`) could
  not reach the endpoint; the same model tool code started by Codex could,
  and answered with `source: "openshell"`.
- **Upstream-shaped profile.** A profile shaped exactly like OpenShell's
  `nvidia.yaml` (curl-only `binaries`, whole-host endpoint) pointed at a
  second stand-in: curl got 200; Codex was refused ("Reconnecting... waiting
  for network") until the section A step 4 rule was added, then answered, and
  the server saw the made-up key.
- **No key.** Profile with `credentials: []` for a third stand-in,
  `model add host-server` without `--key-env`: Codex answered; the server saw
  no authorization header.

Not run: a real hosted API with a real key, an `https` endpoint through the
proxy for this feature (the `codex` provider's `https` path is the same
proxy), and real vLLM, NIM or Ollama servers.

---

## Known gaps

- **The model tool is not offered in a sandbox yet.** `model.customer_complete`
  is not in the OpenShell tool list, and Codex starts MCP servers with a reduced
  environment. Offering it needs the tool added to the list and the server
  entry to pass the key variable through (Codex's `env_vars`), plus the CA
  bundle variables for an `https` endpoint.
- **Claude Code is not covered.** It speaks Anthropic's API, which these
  endpoints do not serve.
- **Codex warns about unknown models** ("Model metadata for `<id>` not found")
  and uses fallback metadata such as the context window.
- **Plain http to other machines on your network is refused.** Put such a
  server behind https.
- **Hosted services were not called for real** (no keys were used).
- If OpenShell scopes keys to a profile's own `binaries` in a later release,
  section A step 4 stops being enough; use a profile from `model profile`.

## Files

| Path | Purpose |
|---|---|
| `src/lib/openshell-models.js` | `model add/list/use/remove/profile`; exports `addModel`, `listModels`, `useModel`, `removeModel`, `defaultModelEndpoint`, `codexSelection`, `renderProviderProfile`, `modelCommand` |
| `providers/model-endpoint.template.yaml` | Profile template for an endpoint that takes a key |
| `providers/host-model-server.template.yaml` | Profile template for a keyless server on the gateway's machine |
| `src/lib/providers/customer-model.js` | ToolsEnabled's model tool; its OpenShell path |

OpenShell's example profiles are Apache-2.0, by NVIDIA; this page links to
them and does not copy them.
