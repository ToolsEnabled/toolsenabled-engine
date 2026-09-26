# ToolsEnabled engine drive image.
#
# WHAT THIS IMAGE IS FOR. Running an end-to-end drive of the engine on Linux,
# in a container, so the `docker` column of the cross-surface matrix stops
# reading NOT MEASURED for every tool. It is NOT the agent sandbox image --
# docker/agent-sandbox/ is the confinement boundary an AGENT is put inside, and
# it deliberately contains no ToolsEnabled source. This one is the opposite: it
# is a test bench that the engine source is handed to at run time.
#
# WHY THE SOURCE IS NOT BAKED IN. Nine lanes hold uncommitted work in the
# checkout this image drives. A COPY of the tree would freeze one lane's
# half-finished edit into a layer and then drive that, reporting numbers for a
# tree that never existed. The source arrives at run time instead: bound
# READ-ONLY at /src and copied to a writable /repo inside the container, so a
# drive can never write back into the shared checkout.
#
# WHY THE BASE IS PINNED BY DIGEST. `node:22-bookworm` is a moving tag. A drive
# whose base silently changed between two runs cannot support a comparison, and
# comparing two drives is the entire point of running one.
FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a

LABEL org.toolsenabled.drive.contract="engine-drive-v1" \
      org.toolsenabled.drive.base-digest="sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a"

# THE DEPENDENCY LAYER, AND WHY IT IS THE ONLY THING THE IMAGE OWNS.
#
# package.json/package-lock.json are the only repository files in the image.
# They change rarely, so the expensive layer is cached across source edits, and
# a rebuild is required exactly when the declared dependencies move -- which is
# also exactly when a drive's meaning changes.
#
# --ignore-scripts is not a convenience. `playwright` is a declared dependency
# and its install script downloads browser binaries; a drive that needs a
# browser is a different drive with a different image (see the catalogue in
# tools/docker-drive.js -- browser-backed surfaces are listed as NOT drivable
# here, with that reason). Installing them silently would make this image claim
# a capability the catalogue says it does not have.
WORKDIR /opt/engine-drive
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# A NON-ROOT DRIVE USER.
#
# Root inside the container would make every filesystem-permission assertion in
# the engine vacuously true: a test that proves "the product refuses to read an
# unreadable file" passes for the wrong reason when the reader is root. The
# drive runs as an ordinary uid so those refusals are exercised, not bypassed.
RUN useradd --uid 10002 --create-home --home-dir /home/drive --shell /bin/bash drive \
    && mkdir -p /repo /evidence \
    && chown -R 10002:10002 /repo /evidence /home/drive /opt/engine-drive

COPY drive-entrypoint.sh /usr/local/bin/drive-entrypoint.sh
RUN chmod 0755 /usr/local/bin/drive-entrypoint.sh

# TOOLSENABLED_TEST_RUN_OUTPUT_DIR is set here rather than left to the caller.
#
# tools/test-run.js defaults its output to state/test-runs/ and its own comment
# records why that is dangerous: on 2026-08-10 a live poller read a transient
# dev-run record for about a minute because a non-production invocation
# overwrote the latest.json other lanes treat as authoritative. A drive is a
# non-production invocation by definition, so it is pointed at /evidence before
# any drive command gets a chance to omit the flag.
ENV HOME=/home/drive \
    NODE_PATH=/opt/engine-drive/node_modules \
    TOOLSENABLED_DRIVE_CONTAINER=engine-drive-v1 \
    TOOLSENABLED_TEST_RUN_OUTPUT_DIR=/evidence

USER 10002:10002
WORKDIR /repo
ENTRYPOINT ["/usr/local/bin/drive-entrypoint.sh"]
CMD ["node", "--version"]
