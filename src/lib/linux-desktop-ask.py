"""Bounded local confirmation using the installed GTK 3 runtime.

The private payload is data, never markup, Python, or a command argument.
GTK signatures: https://docs.gtk.org/gtk3/method.Dialog.run.html
Only an explicit Yes response approves; close, Escape, timeout and failure do not.
"""
import ctypes as C
import json
import os
import signal
import stat
import sys


class Refusal(Exception):
    pass


def load_payload(filename):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not (stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid()
                and stat.S_IMODE(metadata.st_mode) == 0o600 and metadata.st_nlink == 1
                and 0 < metadata.st_size <= 131072):
            raise Refusal("DESKTOP_PROMPT_INVALID")
        value = json.loads(stream.read(131073).decode("utf-8"))
    if not (isinstance(value, dict) and set(value) == {"title", "message", "timeoutSeconds"}
            and isinstance(value["title"], str) and len(value["title"]) <= 200
            and isinstance(value["message"], str) and value["message"].strip() and len(value["message"]) <= 16384
            and "\0" not in value["title"] + value["message"]
            and type(value["timeoutSeconds"]) is int and 5 <= value["timeoutSeconds"] <= 900):
        raise Refusal("DESKTOP_PROMPT_INVALID")
    return value


def confirm(value):
    parent = os.getppid()
    libc = C.CDLL(None)
    # An interrupted agent must not leave an orphan confirmation on the desktop.
    libc.prctl.argtypes = [C.c_int, C.c_ulong, C.c_ulong, C.c_ulong, C.c_ulong]
    libc.prctl.restype = C.c_int
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != parent:
        raise Refusal("DESKTOP_PROMPT_INTERRUPTED")
    try:
        gtk = C.CDLL("libgtk-3.so.0")
        glib = C.CDLL("libglib-2.0.so.0")
    except OSError:
        raise Refusal("DESKTOP_NATIVE_UNAVAILABLE")

    def function(library, name, args, result=None):
        fn = getattr(library, name)
        fn.argtypes, fn.restype = args, result
        return fn

    P, I, S = C.c_void_p, C.c_int, C.c_char_p
    init = function(gtk, "gtk_init_check", [P, P], I)
    if not init(None, None):
        raise Refusal("DESKTOP_SESSION_UNAVAILABLE")
    dialog = function(gtk, "gtk_dialog_new", [], P)()
    destroy = function(gtk, "gtk_widget_destroy", [P])
    timer = 0
    timed_out = False
    try:
        function(gtk, "gtk_window_set_title", [P, S])(dialog, value["title"].encode("utf-8"))
        function(gtk, "gtk_window_set_default_size", [P, I, I])(dialog, 640, 420)
        function(gtk, "gtk_window_set_position", [P, I])(dialog, 1)  # GTK_WIN_POS_CENTER
        function(gtk, "gtk_window_set_modal", [P, I])(dialog, 1)
        content = function(gtk, "gtk_dialog_get_content_area", [P], P)(dialog)
        function(gtk, "gtk_container_set_border_width", [P, C.c_uint])(content, 12)
        scroller = function(gtk, "gtk_scrolled_window_new", [P, P], P)(None, None)
        function(gtk, "gtk_scrolled_window_set_policy", [P, I, I])(scroller, 2, 1)
        text = function(gtk, "gtk_text_view_new", [], P)()
        function(gtk, "gtk_text_view_set_editable", [P, I])(text, 0)
        function(gtk, "gtk_text_view_set_cursor_visible", [P, I])(text, 0)
        function(gtk, "gtk_text_view_set_wrap_mode", [P, I])(text, 3)  # GTK_WRAP_WORD_CHAR
        buffer = function(gtk, "gtk_text_view_get_buffer", [P], P)(text)
        message = value["message"].encode("utf-8")
        function(gtk, "gtk_text_buffer_set_text", [P, S, I])(buffer, message, len(message))
        function(gtk, "gtk_container_add", [P, P])(scroller, text)
        function(gtk, "gtk_box_pack_start", [P, P, I, I, C.c_uint])(content, scroller, 1, 1, 0)
        add_button = function(gtk, "gtk_dialog_add_button", [P, S, I], P)
        refuse = add_button(dialog, b"No", -9)
        add_button(dialog, b"Yes", -8)
        function(gtk, "gtk_dialog_set_default_response", [P, I])(dialog, -9)
        respond = function(gtk, "gtk_dialog_response", [P, I])
        callback_type = C.CFUNCTYPE(I, P)

        @callback_type
        def expire(_):
            nonlocal timed_out, timer
            timed_out, timer = True, 0
            respond(dialog, -6)
            return 0

        timer = function(glib, "g_timeout_add", [C.c_uint, callback_type, P], C.c_uint)(
            value["timeoutSeconds"] * 1000, expire, None)
        function(gtk, "gtk_widget_show_all", [P])(dialog)
        function(gtk, "gtk_widget_grab_focus", [P])(refuse)
        function(gtk, "gtk_window_present", [P])(dialog)
        answer = function(gtk, "gtk_dialog_run", [P], I)(dialog)
        return "timeout" if timed_out else "yes" if answer == -8 else "no"
    finally:
        if timer:
            function(glib, "g_source_remove", [C.c_uint], I)(timer)
        destroy(dialog)


try:
    if len(sys.argv) != 2:
        raise Refusal("DESKTOP_PROMPT_INVALID")
    result = {"ok": True, "answer": confirm(load_payload(sys.argv[1]))}
except Refusal as error:
    result = {"ok": False, "code": str(error)}
except (ValueError, TypeError, KeyError, UnicodeError, OSError):
    result = {"ok": False, "code": "DESKTOP_PROMPT_INVALID"}
except Exception:
    result = {"ok": False, "code": "DESKTOP_PROMPT_FAILED"}
print(json.dumps(result, separators=(",", ":")))
sys.exit(0 if result["ok"] else 1)
