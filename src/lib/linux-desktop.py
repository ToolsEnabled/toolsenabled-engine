"""Read-only local X11 desktop snapshot. No input, clipboard, capture or effects.

EWMH metadata is untrusted. XRes 1.2 supplies the actual local client PID;
_NET_WM_PID is deliberately never read. Snapshot IDs are not effect authority.
https://specifications.freedesktop.org/wm/latest-single/
https://www.x.org/releases/current/doc/resourceproto/resproto.txt
ABI checked against upstream libXres-1.2.2 include/X11/extensions/XRes.h.
"""
import ctypes as C
import json
import os
import re
import sys


class Refusal(Exception):
    pass


def require(condition, code="DESKTOP_SNAPSHOT_UNAVAILABLE"):
    if not condition:
        raise Refusal(code)


class ClientSpec(C.Structure):
    _fields_ = [("client", C.c_ulong), ("mask", C.c_uint)]


class ClientValue(C.Structure):
    _fields_ = [("spec", ClientSpec), ("length", C.c_long), ("value", C.c_void_p)]


class Visual(C.Structure):
    _fields_ = [("ext", C.c_void_p), ("id", C.c_ulong), ("kind", C.c_int),
        ("red", C.c_ulong), ("green", C.c_ulong), ("blue", C.c_ulong),
        ("bits", C.c_int), ("entries", C.c_int)]


class WindowAttributes(C.Structure):
    # Complete public libX11 XWindowAttributes ABI: Xlib writes the whole struct.
    _fields_ = [(name, C.c_int) for name in ("x", "y", "width", "height", "border", "depth")] + [
        ("visual", C.POINTER(Visual)), ("root", C.c_ulong), ("kind", C.c_int),
        ("bit_gravity", C.c_int), ("win_gravity", C.c_int), ("backing_store", C.c_int),
        ("backing_planes", C.c_ulong), ("backing_pixel", C.c_ulong), ("save_under", C.c_int),
        ("colormap", C.c_ulong), ("map_installed", C.c_int), ("map_state", C.c_int),
        ("all_events", C.c_long), ("your_events", C.c_long), ("do_not_propagate", C.c_long),
        ("override_redirect", C.c_int), ("screen", C.c_void_p)]


class MonitorInfo(C.Structure):
    # Public libXrandr 1.5.4 Xrandr.h ABI. Output names are not commands/paths.
    _fields_ = [("name", C.c_ulong), ("primary", C.c_int), ("automatic", C.c_int),
        ("noutput", C.c_int), ("x", C.c_int), ("y", C.c_int), ("width", C.c_int),
        ("height", C.c_int), ("mwidth", C.c_int), ("mheight", C.c_int),
        ("outputs", C.POINTER(C.c_ulong))]


class X11:
    def __init__(self):
        self.x = C.CDLL("libX11.so.6")
        self.res = C.CDLL("libXRes.so.1")
        self.errors = False
        self.error_codes = set()
        self.handler = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p)(self.error)
        self.fn("XSetErrorHandler", [C.c_void_p], C.c_void_p)(self.handler)
        self.fn("XOpenDisplay", [C.c_char_p], C.c_void_p)
        self.fn("XCloseDisplay", [C.c_void_p], C.c_int)
        self.fn("XDefaultRootWindow", [C.c_void_p], C.c_ulong)
        self.fn("XInternAtom", [C.c_void_p, C.c_char_p, C.c_int], C.c_ulong)
        self.fn("XFree", [C.c_void_p], C.c_int)
        self.fn("XSync", [C.c_void_p, C.c_int], C.c_int)
        self.fn("XGetWindowProperty", [C.c_void_p, C.c_ulong, C.c_ulong, C.c_long,
            C.c_long, C.c_int, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int),
            C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.c_void_p)], C.c_int)
        self.fn("XGetGeometry", [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong),
            C.POINTER(C.c_int), C.POINTER(C.c_int), *[C.POINTER(C.c_uint)] * 4], C.c_int)
        self.fn("XTranslateCoordinates", [C.c_void_p, C.c_ulong, C.c_ulong, C.c_int,
            C.c_int, C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_ulong)], C.c_int)
        self.res.XResQueryVersion.argtypes = [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)]
        self.res.XResQueryVersion.restype = C.c_int
        self.res.XResQueryClientIds.argtypes = [C.c_void_p, C.c_long, C.POINTER(ClientSpec),
            C.POINTER(C.c_long), C.POINTER(C.POINTER(ClientValue))]
        self.res.XResQueryClientIds.restype = C.c_int
        self.res.XResGetClientPid.argtypes = [C.POINTER(ClientValue)]
        self.res.XResGetClientPid.restype = C.c_int
        self.res.XResClientIdsDestroy.argtypes = [C.c_long, C.POINTER(ClientValue)]
        self.res.XResClientIdsDestroy.restype = None
        self.display = self.x.XOpenDisplay(os.environ["DISPLAY"].encode("ascii"))
        require(self.display, "DESKTOP_SESSION_UNAVAILABLE")
        self.root = self.x.XDefaultRootWindow(self.display)

    def fn(self, name, args, result):
        function = getattr(self.x, name)
        function.argtypes, function.restype = args, result
        return function

    def error(self, _display, _event):
        self.errors = True
        class XErrorEvent(C.Structure):
            _fields_ = [("type", C.c_int), ("display", C.c_void_p), ("resource", C.c_ulong),
                ("serial", C.c_ulong), ("code", C.c_ubyte), ("request", C.c_ubyte), ("minor", C.c_ubyte)]
        self.error_codes.add(C.cast(_event, C.POINTER(XErrorEvent)).contents.code)
        return 0

    def atom(self, name):
        return self.x.XInternAtom(self.display, name.encode("ascii"), 0)

    def prop(self, window, name, kind, limit=4096, optional=False):
        actual, fmt, count, after, data = C.c_ulong(), C.c_int(), C.c_ulong(), C.c_ulong(), C.c_void_p()
        status = self.x.XGetWindowProperty(self.display, window, self.atom(name), 0,
            (limit + 3) // 4, 0, 0, C.byref(actual), C.byref(fmt), C.byref(count), C.byref(after), C.byref(data))
        try:
            require(status == 0 and not self.errors)
            if actual.value == 0 and optional:
                return b"" if kind in ("UTF8_STRING", "STRING") else []
            require(actual.value == self.atom(kind) and after.value == 0)
            if kind in ("UTF8_STRING", "STRING"):
                require(fmt.value == 8 and count.value <= limit)
                return C.string_at(data, count.value)
            require(fmt.value == 32 and count.value <= limit // 4)
            return list(C.cast(data, C.POINTER(C.c_ulong))[:count.value])
        finally:
            if data.value:
                self.x.XFree(data)

    def geometry(self, window):
        root, child = C.c_ulong(), C.c_ulong()
        x, y, w, h, border, depth = C.c_int(), C.c_int(), C.c_uint(), C.c_uint(), C.c_uint(), C.c_uint()
        require(self.x.XGetGeometry(self.display, window, C.byref(root), C.byref(x), C.byref(y),
            C.byref(w), C.byref(h), C.byref(border), C.byref(depth)) and root.value == self.root)
        require(self.x.XTranslateCoordinates(self.display, window, self.root, 0, 0,
            C.byref(x), C.byref(y), C.byref(child)) and not self.errors)
        require(w.value > 0 and h.value > 0)
        return x.value, y.value, w.value, h.value

    def pid(self, window):
        spec, count, values = ClientSpec(window, 2), C.c_long(), C.POINTER(ClientValue)()
        status = self.res.XResQueryClientIds(self.display, 1, C.byref(spec), C.byref(count), C.byref(values))
        try:
            require(status == 0 and not self.errors and count.value == 1, "DESKTOP_PROCESS_IDENTITY_UNAVAILABLE")
            pid = self.res.XResGetClientPid(C.byref(values[0]))
            require(values[0].spec.mask == 2 and pid > 0, "DESKTOP_PROCESS_IDENTITY_UNAVAILABLE")
            return pid
        finally:
            if values:
                self.res.XResClientIdsDestroy(count, values)

    def window_attributes(self, window):
        self.fn("XGetWindowAttributes", [C.c_void_p, C.c_ulong, C.POINTER(WindowAttributes)], C.c_int)
        attributes = WindowAttributes()
        require(self.x.XGetWindowAttributes(self.display, window, C.byref(attributes))
            and not self.errors and attributes.visual)
        return attributes

    def capture_format_supported(self, attributes):
        visual = attributes.visual.contents
        return (attributes.map_state == 2 and attributes.depth in (24, 32)
            and attributes.width * attributes.height <= 16777216 and visual.kind == 4
            and (visual.red, visual.green, visual.blue) == (0xff0000, 0xff00, 0xff))

    def named_pixmap(self, window):
        # Retain existing compositor storage only. Never redirect a customer's
        # window, grab the server, or substitute root pixels on failure.
        if not hasattr(self, "composite"):
            self.composite = None
            try:
                lib = C.CDLL("libXcomposite.so.1")
                lib.XCompositeQueryVersion.argtypes = [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)]
                lib.XCompositeQueryVersion.restype = C.c_int
                lib.XCompositeNameWindowPixmap.argtypes = [C.c_void_p, C.c_ulong]
                lib.XCompositeNameWindowPixmap.restype = C.c_ulong
                major, minor = C.c_int(), C.c_int()
                if lib.XCompositeQueryVersion(self.display, C.byref(major), C.byref(minor)) and (major.value, minor.value) >= (0, 2):
                    self.composite = lib
                self.fn("XFreePixmap", [C.c_void_p, C.c_ulong], C.c_int)
            except (OSError, AttributeError):
                pass
        if self.composite is None:
            return 0
        self.x.XSync(self.display, 0)
        require(not self.errors)
        pixmap = self.composite.XCompositeNameWindowPixmap(self.display, window)
        self.x.XSync(self.display, 0)
        if self.errors:
            # The usual BadMatch means no existing redirected/viewable storage.
            # No pixmap was created; the returned XID must not be freed as one.
            require(self.error_codes == {8})  # BadMatch only; never swallow BadWindow/access errors.
            self.errors = False
            self.error_codes.clear()
            return 0
        return pixmap

    def snapshot(self, target=None):
        major, minor = C.c_int(1), C.c_int(2)
        require(self.res.XResQueryVersion(self.display, C.byref(major), C.byref(minor))
            and (major.value, minor.value) >= (1, 2), "DESKTOP_NATIVE_UNAVAILABLE")
        wm = self.prop(self.root, "_NET_SUPPORTING_WM_CHECK", "WINDOW", optional=True)
        require(len(wm) == 1 and self.prop(wm[0], "_NET_SUPPORTING_WM_CHECK", "WINDOW") == wm,
            "DESKTOP_WINDOW_MANAGER_UNSUPPORTED")
        supported = self.prop(self.root, "_NET_SUPPORTED", "ATOM")
        require(self.atom("_NET_CLIENT_LIST") in supported, "DESKTOP_WINDOW_MANAGER_UNSUPPORTED")
        windows = self.prop(self.root, "_NET_CLIENT_LIST", "WINDOW", limit=2004)
        require(len(windows) <= 500, "DESKTOP_WINDOW_LIMIT")
        require(len(set(windows)) == len(windows) and all(windows))
        _, _, screen_w, screen_h = self.geometry(self.root)
        current_desktop = self.prop(self.root, "_NET_CURRENT_DESKTOP", "CARDINAL", optional=True)
        require(len(current_desktop) <= 1)
        result = []
        for window in windows:
            if target is not None and window != target:
                continue
            pid = self.pid(window)
            # The PID is a server observation, not a kill handle. Never probe a
            # different account's process to turn a snapshot into authority.
            require(os.stat("/proc/%d" % pid).st_uid == os.getuid(), "DESKTOP_PROCESS_IDENTITY_UNAVAILABLE")
            with open("/proc/%d/stat" % pid, encoding="utf-8") as stream:
                before = stream.read(8192)
            start = before[before.rfind(")") + 2:].split()[19]
            require(start.isdigit() and len(start) <= 19, "DESKTOP_PROCESS_IDENTITY_UNAVAILABLE")
            process_name = before[before.find("(") + 1:before.rfind(")")]
            title = self.prop(window, "_NET_WM_NAME", "UTF8_STRING", optional=True)
            if not title:
                title = self.prop(window, "WM_NAME", "STRING", optional=True)
            classes = self.prop(window, "WM_CLASS", "STRING", optional=True).split(b"\0")
            label = next((item for item in reversed(classes) if item), b"")
            x, y, width, height = self.geometry(window)
            states = self.prop(window, "_NET_WM_STATE", "ATOM", optional=True)
            minimized = self.atom("_NET_WM_STATE_HIDDEN") in states
            desktop = self.prop(window, "_NET_WM_DESKTOP", "CARDINAL", optional=True)
            require(len(desktop) <= 1 and (not desktop or current_desktop), "DESKTOP_WINDOW_MANAGER_UNSUPPORTED")
            cloaked = bool(desktop and desktop[0] != 0xffffffff and desktop != current_desktop)
            offscreen = minimized or cloaked or x + width <= 0 or y + height <= 0 or x >= screen_w or y >= screen_h
            partial = not offscreen and (x < 0 or y < 0 or x + width > screen_w or y + height > screen_h)
            attributes = self.window_attributes(window)
            pixmap = self.named_pixmap(window) if not minimized and not cloaked and self.capture_format_supported(attributes) else 0
            if pixmap:
                self.x.XFreePixmap(self.display, pixmap)
            with open("/proc/%d/stat" % pid, encoding="utf-8") as stream:
                after = stream.read(8192)
            require(self.pid(window) == pid and after[after.rfind(")") + 2:].split()[19] == start,
                "DESKTOP_SNAPSHOT_CHANGED")
            result.append(dict(windowId=str(window), processId=pid, processStartKey=start,
                processName=process_name[:300], appLabel=label.decode("utf-8", "replace")[:300],
                title=title.decode("utf-8", "replace")[:1000], x=x, y=y, width=width, height=height,
                monitorId=None, isMinimized=minimized, isOffscreen=offscreen, isPartial=partial,
                isCloaked=cloaked, captureEligible=bool(pixmap)))
        require(self.prop(self.root, "_NET_CLIENT_LIST", "WINDOW", limit=2004) == windows,
            "DESKTOP_SNAPSHOT_CHANGED")
        require(self.prop(self.root, "_NET_CURRENT_DESKTOP", "CARDINAL", optional=True) == current_desktop,
            "DESKTOP_SNAPSHOT_CHANGED")
        self.x.XSync(self.display, 0)
        require(not self.errors)
        return result

    def monitors(self):
        try:
            rr = C.CDLL("libXrandr.so.2")
            rr.XRRQueryVersion.argtypes = [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)]
            rr.XRRQueryVersion.restype = C.c_int
            rr.XRRGetMonitors.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.POINTER(C.c_int)]
            rr.XRRGetMonitors.restype = C.POINTER(MonitorInfo)
            rr.XRRFreeMonitors.argtypes = [C.POINTER(MonitorInfo)]
            rr.XRRFreeMonitors.restype = None
        except (OSError, AttributeError):
            raise Refusal("DESKTOP_NATIVE_UNAVAILABLE")
        major, minor = C.c_int(), C.c_int()
        require(rr.XRRQueryVersion(self.display, C.byref(major), C.byref(minor))
            and (major.value, minor.value) >= (1, 5), "DESKTOP_MONITOR_UNSUPPORTED")

        def observe():
            bounds = self.geometry(self.root)
            current = self.prop(self.root, "_NET_CURRENT_DESKTOP", "CARDINAL", optional=True)
            work = self.prop(self.root, "_NET_WORKAREA", "CARDINAL", limit=4096, optional=True)
            require(len(current) <= 1 and (not work or (current and len(work) % 4 == 0
                and current[0] < len(work) // 4)))
            area = work[current[0] * 4:current[0] * 4 + 4] if work else None
            if area:
                require(area[2] > 0 and area[3] > 0)
            count = C.c_int()
            values = rr.XRRGetMonitors(self.display, self.root, 1, C.byref(count))
            try:
                require(values and 1 <= count.value <= 32, "DESKTOP_MONITOR_UNSUPPORTED")
                result, signature, names = [], [], set()
                for index in range(count.value):
                    item = values[index]
                    require(item.name > 0 and item.name not in names and 0 <= item.noutput <= 64
                        and item.primary in (0, 1) and item.automatic in (0, 1)
                        and item.x >= 0 and item.y >= 0 and item.width > 0 and item.height > 0
                        and item.x + item.width <= bounds[2] and item.y + item.height <= bounds[3]
                        and (not item.noutput or item.outputs))
                    names.add(item.name)
                    outputs = tuple(item.outputs[n] for n in range(item.noutput))
                    signature.append((item.name, item.primary, item.automatic, item.x, item.y,
                        item.width, item.height, item.mwidth, item.mheight, outputs))
                    wx = wy = ww = wh = None
                    if area:
                        wx, wy = max(item.x, area[0]), max(item.y, area[1])
                        ww = min(item.x + item.width, area[0] + area[2]) - wx
                        wh = min(item.y + item.height, area[1] + area[3]) - wy
                        if ww <= 0 or wh <= 0:
                            wx = wy = ww = wh = None
                    result.append(dict(monitorId="x11-%d-%d" % (self.root, item.name),
                        x=item.x, y=item.y, width=item.width, height=item.height,
                        workX=wx, workY=wy, workWidth=ww, workHeight=wh,
                        dpiX=max(1, round(item.width * 25.4 / item.mwidth)) if item.mwidth > 0 else None,
                        dpiY=max(1, round(item.height * 25.4 / item.mheight)) if item.mheight > 0 else None,
                        primary=bool(item.primary)))
                self.x.XSync(self.display, 0)
                require(not self.errors)
                return result, (bounds, current, work, sorted(signature))
            finally:
                if values:
                    rr.XRRFreeMonitors(values)
        result, before = observe()
        _, after = observe()
        require(before == after, "DESKTOP_SNAPSHOT_CHANGED")
        return result

    def close(self):
        self.x.XCloseDisplay(self.display)


def main():
    require(sys.platform == "linux" and len(sys.argv) == 2
        and sys.argv[1] in ("window-list", "monitor-list"), "DESKTOP_PLATFORM_UNSUPPORTED")
    require(os.getuid() > 0 and os.getuid() == os.geteuid(), "DESKTOP_SESSION_UNAVAILABLE")
    require(not os.environ.get("WAYLAND_DISPLAY") and os.environ.get("XDG_SESSION_TYPE", "x11") == "x11",
        "DESKTOP_PLATFORM_UNSUPPORTED")
    require(re.fullmatch(r":[0-9]{1,5}(?:\.[0-9]{1,2})?", os.environ.get("DISPLAY", "")),
        "DESKTOP_SESSION_UNAVAILABLE")
    try:
        display = X11()
    except OSError:
        raise Refusal("DESKTOP_NATIVE_UNAVAILABLE")
    try:
        return {"windows": display.snapshot()} if sys.argv[1] == "window-list" else {"monitors": display.monitors()}
    finally:
        display.close()


if __name__ == "__main__":
    try:
        print(json.dumps(dict(ok=True, **main()), separators=(",", ":")))
    except Refusal as error:
        print(json.dumps(dict(ok=False, code=str(error)), separators=(",", ":")))
        sys.exit(1)
    except BaseException:
        print('{"ok":false,"code":"DESKTOP_SNAPSHOT_UNAVAILABLE"}')
        sys.exit(1)
