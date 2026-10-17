# syntax=docker/dockerfile:1.7
#
# Recipe for a ToolsEnabled sandbox image for NVIDIA OpenShell.
#
# Build it yourself with build.sh; do not publish the resulting image. It
# installs third-party agent CLIs (Claude Code, Codex, Gemini CLI, OpenCode) exactly as their vendors
# publish them, and each stays under its own licence and terms.
#
# The CLIs are installed unmodified from the npm registry. Nothing here signs
# in, reads, copies or stores a provider credential. Credentials come from
# OpenShell providers attached to the sandbox, or, for a Claude subscription
# until OpenShell's provider can hold one, from Claude Code's own sign-in inside
# the sandbox. See ../policy/cli-sign-in.yaml.

FROM nvcr.io/nvidia/base/ubuntu:24.04

ARG TARGETARCH
ARG NODE_VERSION=22.19.0

ENV DEBIAN_FRONTEND=noninteractive

# git for the agents' own work; python3 because the engine's Linux process
# supervisor (src/lib/linux-process-supervisor.py) runs under /usr/bin/python3.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        git \
        python3 \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js from nodejs.org, checked against the release's published SHA-256 list.
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
        amd64) node_arch=x64 ;; \
        arm64) node_arch=arm64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    file="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${file}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c -; \
    tar -xJf "${file}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "${file}"; \
    node --version

# One reviewed list supplies both the build and the hand-test identity check.
# npm installs the official packages without patches or sign-in configuration.
COPY adapters/openshell/image/agent-versions.json /tmp/agent-versions.json
RUN node -e 'const cp = require("node:child_process"); const agents = require("/tmp/agent-versions.json"); const run = (cmd, args) => { const r = cp.spawnSync(cmd, args, { stdio: "inherit" }); if (r.status !== 0) process.exit(r.status || 1); }; run("npm", ["install", "--global", ...agents.map(a => a.package + "@" + a.version)]); for (const a of agents) run(a.command, ["--version"]);' \
    && npm cache clean --force \
    && rm /tmp/agent-versions.json

# /usr/local is read-only in the sandbox; update by rebuilding the image.

# The ToolsEnabled Fleet development image. Release installations use the
# verified runtime archive, not this image recipe.
WORKDIR /opt/toolsenabled/engine
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --offline --no-audit --no-fund && npm cache clean --force
COPY LICENSE NOTICE THIRD-PARTY-LICENSES.md ./
COPY bin ./bin
COPY config ./config
COPY schemas ./schemas
COPY src ./src
COPY tools ./tools
COPY adapters ./adapters

RUN ln -s /opt/toolsenabled/engine/bin/toolsenabled-openshell.js /usr/local/bin/toolsenabled-openshell \
    && ln -s /opt/toolsenabled/engine/bin/toolsenabled-openshell.js /usr/local/bin/toolsenabled

RUN useradd --create-home --home-dir /sandbox --shell /bin/bash sandbox

ENV HOME=/sandbox
USER sandbox
WORKDIR /sandbox
