# Native Linux desktop integration

The first native adapter implements `window.list` on a local X11 display with
an EWMH window manager and XRes 1.2. It uses the existing desktop worker and
shared schema/permission path. Requires `/usr/bin/python3`, `libX11.so.6`,
`libXRes.so.1`, current-owner procfs access and valid display authentication.
The helper uses a minimal environment and a bounded, read-only native query.

The client PID is queried from XRes, not the client-controlled `_NET_WM_PID`
property. Process start ticks are checked across the observation. EWMH names,
classes, bounds and state remain untrusted; snapshot IDs are never authority
to focus, close, capture or signal a process. No process signals, desktop
input, clipboard access, notifications or image capture occur during listing.
The helper does not grab the X server while reading process metadata.

Missing/malformed/stale observations and missing native prerequisites return
typed errors, not an empty successful list. Wayland (including its Xwayland
subset), forwarded/remote displays and unsupported sessions are explicitly
refused. X11 tests are not Wayland qualification. A same-UID compromise of the
desktop session or a malicious X server is not solved by this adapter.

Full-screen and rectangular-region capture now use the local X11 root image,
with actual bounds, TrueColor RGB masks and a16,777,216-pixel/20MiB encoded-image
limit. Unsupported pixel formats refuse rather than guessing colors. Capture
and preview use `/usr/bin/python3 -I -S -B`; Pillow is loaded from the fixed
root-owned `/usr/lib/python3/dist-packages` directory, not user site packages,
provider venvs or Python hooks. Missing dependencies are explicit refusals.

The helper receives no output paths. Metadata and PNG use separate pipes;
captured bytes/dimensions are validated before a parent creates a0600 file
exclusively through a retained approved captures directory. Ancestor symlinks,
foreign ownership, unsafe write permissions and existing destinations refuse.
Original output identity is rechecked. Failed partial output is retained and
reported uncertain, never unlinked through a stale pathname. This does not
certify hostile same-UID filesystem races or future use of a pathname as
immutable authority.

`screen.read_capture` decodes only the already-confined input bytes, checks
pixel/byte limits, and produces an aspect-preserving bounded RGB PNG. The
helper accepts single-frame PNG/JPEG/BMP/GIF/TIFF, not vector/executable formats.
It needs no temporary full-size copy. The desktop worker transfers preview
bytes in its private envelope and restores a bounded non-enumerable image on
the parent result; structured clone alone would drop that attachment. Ordinary
JSON/audit output contains metadata only. A missing or misplaced worker image
is an error, not metadata-only success.

Monitor listing and monitor-specific capture now use XRandR 1.5 active monitor
objects from the local X11 root. `libXrandr.so.2` is required. Monitor IDs are
root/atom observations, not durable authority across display restarts. Queries
compare two bounded topology observations; capture resolves the selected ID
again and compares it after reading pixels. A missing monitor produces
`monitor_not_found` without creating an output file. No fallback captures a
different monitor or the whole desktop. This is not an atomic guarantee against
hostile same-session topology changes between queries.

Linux monitor coordinates are explicitly `x11_root_pixels`, not a promise of
physical panel pixels under arbitrary RandR transforms. DPI is computed from
server-reported millimeters and is not toolkit/UI scale; missing values are
null. Work area is the intersection with the current EWMH desktop work area,
or null when unavailable; malformed properties refuse rather than guessing.
Monitor metadata remains untrusted and grants no authority.

Window-specific capture now retains existing XComposite window storage, using
server-owned PID and process start-time checks before/after acquisition and
after pixel reading. It does not redirect windows, grab the server or fall back
to root pixels. Missing storage or minimized/other-desktop windows refuse;
unknown/mismatched targets create no file. Client-area output may omit window
manager decorations. Uniform output is captured but marked unusable. Listing
checks existing storage and supported TrueColor visual/depth/pixel limits before
reporting captureEligible. That observation does not guarantee a later capture.
Only BadMatch from naming storage becomes unavailable; other X errors refuse.
These checks do not solve same-process XID reuse, ABA races, malicious X servers,
lock-screen policy or arbitrary compositor behavior. No future action authority
is granted by the metadata. Native input and Wayland remain unfinished.
Listed windows have no native monitor ID. Other desktop methods return
`DESKTOP_PLATFORM_UNSUPPORTED` on Linux instead of trying to launch PowerShell.
Their Windows helper payloads use a fresh 0700 temporary directory and exclusive
0600 file creation, independently of the caller's umask. Cleanup removes only
the owned payload and empty directory; a failure after helper success remains
an explicit uncertain outcome. Injected test helpers exercise this common
transport on Linux without claiming the Windows actions themselves ran.
Do not claim full desktop parity,
lock-screen/compositor qualification or enable remote control because this
increment works. Clipboard acquisition must stay tied to an explicit paste.

`tests/linux-desktop.test.js` creates a private Xvfb server with a random
MIT-MAGIC-COOKIE and no TCP listener, plus real X windows driven by a finite
EWMH protocol fixture. It verifies direct and actual worker-thread listing,
server PID versus a spoofed PID property, process ticks, literal title/bounds,
minimized/partial/other-workspace state, malformed/stale/no-manager refusals,
genuine empty list, Wayland/remote display refusal and environment/error
containment. It asserts a real nonempty window, so unconditional empty success
cannot pass. Every fixture process uses retained native lifetime control.
This is real X server/client protocol testing, not a claim to have tested a
complete GNOME/KDE window manager, lock screen or every compositor.

Capture tests use actual black/white fixture pixels reconstructed independently
with Node zlib/PNG row filters, full and region dimensions, owner-only file mode,
no overwrite, out-of-bounds and alias refusals, and real worker-thread preview
bytes. Preview tests sample away from Lanczos' edge-filter support. The result
must contain an actual bounded image, not only an image filename.

The same private native fixture configures two XRandR monitor regions, checks
their distinct IDs/bounds and DPI, captures black and white pixels from the
correct separate regions through the real worker, checks work-area intersection
and malformed-data refusal, then deletes a monitor and verifies no capture
file is created for its stale ID. This is not a physical hotplug, scaling or
multi-GPU hardware qualification.

Primary native contracts: [EWMH](https://specifications.freedesktop.org/wm/latest-single/)
and [X Resource protocol](https://www.x.org/releases/current/doc/resourceproto/resproto.txt).
