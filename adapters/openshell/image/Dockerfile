# syntax=docker/dockerfile:1.7
#
# Recipe for a ToolsEnabled sandbox image for NVIDIA OpenShell.
#
# Build it yourself with build.sh; do not publish the resulting image. It
# installs third-party agent CLIs (Claude Code, Codex) exactly as their vendors
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
ARG CLAUDE_CODE_VERSION=2.1.284
ARG CODEX_VERSION=0.158.0

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

# The agent CLIs, unmodified, pinned to the versions this recipe was tested with.
RUN npm install --global \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && claude --version \
    && codex --version

# /usr/local is read-only inside the sandbox, so Claude Code's self-updater
# cannot work there; update by rebuilding with a newer CLAUDE_CODE_VERSION.
# OpenShell starts sandbox commands with its own environment rather than the
# image's, so pass `--env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to
# `openshell sandbox create` (it also stops telemetry and error reporting).

# The ToolsEnabled engine: only its runtime files and production dependencies.
WORKDIR /opt/toolsenabled/engine
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY LICENSE NOTICE THIRD-PARTY-LICENSES.md registry.json ./
COPY bin ./bin
COPY config ./config
COPY schemas ./schemas
COPY src ./src
COPY tools ./tools
COPY packages ./packages
COPY sidecars ./sidecars
COPY adapters ./adapters

COPY --chmod=0755 adapters/openshell/image/codex-openshell-auth /usr/local/bin/codex-openshell-auth
RUN ln -s /opt/toolsenabled/engine/bin/toolsenabled-openshell.js /usr/local/bin/toolsenabled-openshell \
    && ln -s /opt/toolsenabled/engine/bin/toolsenabled-openshell.js /usr/local/bin/toolsenabled

RUN useradd --create-home --home-dir /sandbox --shell /bin/bash sandbox

ENV HOME=/sandbox
USER sandbox
WORKDIR /sandbox
