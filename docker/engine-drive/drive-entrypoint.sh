#!/bin/sh
# Populate the writable drive tree from the read-only source bind, then run the
# drive command.
#
# WHY A COPY AND NOT A DIRECT BIND. /src is the live checkout that nine lanes
# are editing. If the drive ran directly against a writable bind, a test that
# writes a fixture, a runner that rewrites state/, or a failed cleanup would
# land in somebody's uncommitted work -- and the repository's own rule is that
# reversing an edit by discarding a tree destroys another actor's only copy.
# Binding read-only makes that impossible at the kernel, and copying to /repo
# gives the drive the writable tree it genuinely needs.
#
# WHY IT IS NOT `cp -a`. The three excluded paths below each break a drive in a
# different way, and cp cannot express them:
#   .git          -- 22MB of history the drive never reads, and a worktree
#                    pointer that would make in-container git commands resolve
#                    against the host checkout.
#   node_modules  -- the host tree's modules are installed for win32. Copying
#                    them over the Linux install in /opt/engine-drive would
#                    hand the drive native binaries that cannot load here.
#   state/test-runs -- the authoritative ledger other lanes poll. A drive must
#                    start with no prior verdict in reach, so that "no record"
#                    can never be misread as this drive's own result.
set -eu

if [ ! -d /src ]; then
  echo 'engine-drive: /src is not mounted; the source bind is required (mount the checkout read-only at /src).' >&2
  exit 78
fi

if [ ! -e /repo/.drive-populated ]; then
  tar -C /src -cf - \
      --exclude=./.git \
      --exclude=./node_modules \
      --exclude=./state/test-runs \
      . | tar -C /repo -xf -

  # The Linux dependency install is placed where the engine looks for it. It is
  # copied rather than symlinked because a symlink out of /repo makes
  # require.resolve report a realpath outside the repository root, and the
  # repository has checks that read a module's resolved path to decide whether
  # it is in-tree.
  cp -a /opt/engine-drive/node_modules /repo/node_modules

  # Records WHAT populated this tree, not merely THAT something did. A drive
  # that finds a stale marker from a different image would otherwise reuse a
  # tree it cannot account for.
  printf '%s\n' "${TOOLSENABLED_DRIVE_CONTAINER:-unknown}" > /repo/.drive-populated
fi

exec "$@"
