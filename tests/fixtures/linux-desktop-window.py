"""Real X window + finite EWMH protocol fixture, not a desktop/window manager.
No subject import; fixed geometry/title and deliberately spoofed _NET_WM_PID.
"""
import ctypes as C
import json
import os
import sys

x = C.CDLL("libX11.so.6")
def fn(name, args, result):
    f = getattr(x, name)
    f.argtypes, f.restype = args, result
    return f
ptr, ulong, integer = C.c_void_p, C.c_ulong, C.c_int
fn("XOpenDisplay", [C.c_char_p], ptr)
fn("XDefaultRootWindow", [ptr], ulong)
fn("XCreateSimpleWindow", [ptr, ulong, integer, integer, C.c_uint, C.c_uint, C.c_uint, ulong, ulong], ulong)
fn("XInternAtom", [ptr, C.c_char_p, integer], ulong)
fn("XChangeProperty", [ptr, ulong, ulong, ulong, integer, integer, ptr, integer], integer)
fn("XMapWindow", [ptr, ulong], integer)
fn("XMoveWindow", [ptr, ulong, integer, integer], integer)
fn("XDestroyWindow", [ptr, ulong], integer)
fn("XSync", [ptr, integer], integer)
fn("XCloseDisplay", [ptr], integer)
fn("XSetWindowBackground", [ptr, ulong, ulong], integer)
fn("XClearWindow", [ptr, ulong], integer)
d = x.XOpenDisplay(None)
if not d:
    sys.exit(2)
root = x.XDefaultRootWindow(d)
x.XSetWindowBackground(d, root, 0)
x.XClearWindow(d, root)
window = x.XCreateSimpleWindow(d, root, 40, 50, 320, 160, 0, 0, 0xffffff)
manager = x.XCreateSimpleWindow(d, root, 0, 0, 1, 1, 0, 0, 0)
def atom(name):
    return x.XInternAtom(d, name.encode("ascii"), 0)
def prop(w, name, kind, values):
    if isinstance(values, bytes):
        data, fmt, length = C.create_string_buffer(values), 8, len(values)
    else:
        data, fmt, length = (ulong * len(values))(*values), 32, len(values)
    x.XChangeProperty(d, w, atom(name), atom(kind), fmt, 0, data, length)
prop(root, "_NET_SUPPORTING_WM_CHECK", "WINDOW", [manager])
prop(manager, "_NET_SUPPORTING_WM_CHECK", "WINDOW", [manager])
prop(root, "_NET_SUPPORTED", "ATOM", [atom("_NET_CLIENT_LIST")])
prop(root, "_NET_CLIENT_LIST", "WINDOW", [window])
prop(root, "_NET_CURRENT_DESKTOP", "CARDINAL", [0])
prop(window, "_NET_WM_DESKTOP", "CARDINAL", [0])
prop(window, "_NET_WM_NAME", "UTF8_STRING", "Fixture — native Linux".encode("utf-8"))
prop(window, "WM_CLASS", "STRING", b"fixture\0NativeFixture\0")
prop(window, "_NET_WM_PID", "CARDINAL", [1])
x.XMapWindow(d, window)
x.XSync(d, 0)
print(json.dumps(dict(pid=os.getpid(), windowId=str(window))), flush=True)
try:
    for line in sys.stdin:
        command = json.loads(line)["command"]
        if command == "hide":
            prop(window, "_NET_WM_STATE", "ATOM", [atom("_NET_WM_STATE_HIDDEN")])
        elif command == "move":
            prop(window, "_NET_WM_STATE", "ATOM", [])
            x.XMoveWindow(d, window, 750, 50)
        elif command == "invalid":
            prop(root, "_NET_CLIENT_LIST", "STRING", b"not a WINDOW array")
        elif command == "other-desktop":
            prop(window, "_NET_WM_DESKTOP", "CARDINAL", [1])
        elif command == "empty":
            prop(root, "_NET_CLIENT_LIST", "WINDOW", [])
        elif command == "stale":
            prop(root, "_NET_CLIENT_LIST", "WINDOW", [window])
            x.XDestroyWindow(d, window)
        elif command == "no-wm":
            prop(root, "_NET_SUPPORTING_WM_CHECK", "WINDOW", [])
        elif command == "redirect-cover":
            composite = C.CDLL("libXcomposite.so.1")
            composite.XCompositeRedirectWindow.argtypes = [ptr, ulong, integer]
            composite.XCompositeRedirectWindow.restype = None
            composite.XCompositeRedirectWindow(d, window, 0)
            x.XClearWindow(d, window)
            cover = x.XCreateSimpleWindow(d, root, 40, 50, 320, 160, 0, 0, 0)
            x.XMapWindow(d, cover)
        elif command == "uncover":
            x.XDestroyWindow(d, cover)
        elif command == "window-pattern":
            patch = x.XCreateSimpleWindow(d, window, 0, 0, 20, 20, 0, 0, 0)
            x.XMapWindow(d, patch)
        elif command == "unrelated-stale":
            stale = x.XCreateSimpleWindow(d, root, 0, 0, 10, 10, 0, 0, 0)
            x.XDestroyWindow(d, stale)
            prop(root, "_NET_CLIENT_LIST", "WINDOW", [window, stale])
        elif command == "restore-list":
            prop(root, "_NET_CLIENT_LIST", "WINDOW", [window])
        elif command in ("monitors-two", "monitors-workarea", "monitors-invalid-workarea", "monitors-remove"):
            # Independent public Xrandr ABI; no import of the subject adapter.
            class Monitor(C.Structure):
                _fields_ = [("name", ulong), ("primary", integer), ("automatic", integer),
                    ("noutput", integer), ("x", integer), ("y", integer), ("width", integer),
                    ("height", integer), ("mwidth", integer), ("mheight", integer),
                    ("outputs", C.POINTER(ulong))]
            rr = C.CDLL("libXrandr.so.2")
            rr.XRRSetMonitor.argtypes = [ptr, ulong, C.POINTER(Monitor)]
            rr.XRRSetMonitor.restype = None
            rr.XRRDeleteMonitor.argtypes = [ptr, ulong, ulong]
            rr.XRRDeleteMonitor.restype = None
            if command == "monitors-two":
                for name, xpos in [("fixture-left", 0), ("fixture-right", 400)]:
                    monitor = Monitor(atom(name), int(xpos == 0), 0, 0, xpos, 0, 400, 600, 100, 150, None)
                    rr.XRRSetMonitor(d, root, C.byref(monitor))
            elif command == "monitors-workarea":
                prop(root, "_NET_WORKAREA", "CARDINAL", [0, 30, 800, 570])
            elif command == "monitors-invalid-workarea":
                prop(root, "_NET_WORKAREA", "CARDINAL", [0, 30, 800])
            else:
                rr.XRRDeleteMonitor(d, root, atom("fixture-right"))
                prop(root, "_NET_WORKAREA", "CARDINAL", [])
        elif command == "quit":
            break
        else:
            sys.exit(2)
        x.XSync(d, 0)
        print(json.dumps(dict(command=command)), flush=True)
finally:
    x.XCloseDisplay(d)
