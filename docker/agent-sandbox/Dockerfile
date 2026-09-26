# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
#
# The amd64 base is pinned to the immutable Playwright 1.61.0 image digest.
# ToolsEnabled additionally records and verifies the locally-built image ID
# before it will launch a sandbox.
FROM mcr.microsoft.com/playwright:v1.61.0-noble@sha256:111dde95859f2c659291cb60e698f9048a8fc30b35b4ddb7c90f9cb5b73062d9

LABEL org.toolsenabled.sandbox.contract="agent-playwright-v1" \
      org.toolsenabled.sandbox.playwright="1.61.0" \
      org.toolsenabled.sandbox.base-digest="sha256:111dde95859f2c659291cb60e698f9048a8fc30b35b4ddb7c90f9cb5b73062d9"

WORKDIR /opt/toolsenabled

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/sandbox --shell /usr/sbin/nologin sandbox \
    && mkdir -p /workspace /home/sandbox/.cache \
    && chown -R 10001:10001 /workspace /home/sandbox

COPY --chown=10001:10001 bounded-exec.js fixture-server.js hold-open.js ./

ENV HOME=/home/sandbox \
    NODE_PATH=/opt/toolsenabled/node_modules \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER 10001:10001
WORKDIR /workspace

CMD ["node", "/opt/toolsenabled/hold-open.js"]
