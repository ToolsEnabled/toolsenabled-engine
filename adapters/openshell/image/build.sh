#!/usr/bin/env bash
# Build the ToolsEnabled OpenShell sandbox image from this checkout's committed
# files (uncommitted changes are not included).
#
#   adapters/openshell/image/build.sh [tag]
#
# The image must land in the container engine your OpenShell gateway uses. Set
# DOCKER_HOST if that is not your docker CLI's current context.
set -euo pipefail

tag="${1:-toolsenabled-openshell:dev}"
cd "$(git rev-parse --show-toplevel)"

git archive --format=tar HEAD \
    | docker build --file adapters/openshell/image/Dockerfile --tag "${tag}" -

echo "built ${tag} from $(git rev-parse --short HEAD)"
