"""Private credential entry using GTK 3 and the maintained Linux vault.

The private payload is data, never markup, Python, or a command argument.
GTK signatures: https://docs.gtk.org/gtk3/method.Dialog.run.html
Only explicit Save stores a non-empty value; close, Escape and timeout never save.
"""
import ctypes as C
import json
import importlib.util
import resource
import re
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
    fields = {"mode", "title", "label", "message", "key", "kind", "count", "timeoutSeconds", "vaultFile"}
    if not (isinstance(value, dict) and set(value) == fields
            and value["mode"] in {"start", "capture"} and value["kind"] in {"credential", "payment_card"}
            and all(isinstance(value[key], str) and "\0" not in value[key] for key in ("title", "label", "message", "key", "vaultFile"))
            and 0 < len(value["title"]) <= 200 and 0 < len(value["label"]) <= 120
            and 0 < len(value["message"]) <= 16384
            and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", value["key"])
            and os.path.isabs(value["vaultFile"])
            and type(value["count"]) is int and 1 <= value["count"] <= 100
            and type(value["timeoutSeconds"]) is int and 5 <= value["timeoutSeconds"] <= 900):
        raise Refusal("DESKTOP_PROMPT_INVALID")
    if (value["kind"] == "payment_card" and value["key"] != "payment_card_default") or (
            value["kind"] == "credential" and value["key"].lower() in {"payment_card_default", "owner_legal_identity_v1"}):
        raise Refusal("DESKTOP_PROMPT_INVALID")
    return value


def prompt(value, save=None, receipt=None):
    if value["mode"] == "start":
        return prompt_owned(value, save, receipt)
    vault = load_vault()
    vault.protect_process()
    with vault.native_prompt_lock(value["vaultFile"]) as acquired:
        if not acquired:
            return "deferred"
        return prompt_owned(value, save, receipt)


def prompt_owned(value, save=None, receipt=None):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    parent = os.getppid()
    if parent <= 1:
        raise Refusal("DESKTOP_PROMPT_INTERRUPTED")
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
    entry = None
    entries = {}
    card = value["kind"] == "payment_card"
    vault = load_vault() if card else None
    identity = vault.owner_identity_for_payment_prompt(value["vaultFile"]) if card and value["mode"] == "capture" else None
    timed_out = False
    try:
        function(gtk, "gtk_window_set_title", [P, S])(dialog, value["title"].encode("utf-8"))
        function(gtk, "gtk_window_set_default_size", [P, I, I])(dialog, 640, 640 if card and value["mode"] == "capture" else 420)
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
        explanation = ("A quiet, one-at-a-time check-in\n" + str(value["count"]) + " private steps are ready.\nNothing opens until you choose Begin securely."
                       if value["mode"] == "start" else value["label"] + "\nCredential value\nPaste or type the complete value. Do not add surrounding quotes or explanatory text.\nOnly Save securely writes to this product's encrypted local vault. Nothing is returned to chat.")
        if card and value["mode"] == "capture":
            explanation = ("Add your payment method\nEnter the names on the card, its number (spaces accepted), expiration as MM/YY, and billing postal code. "
                           "Save validates the card structure and an unexpired date. No security code is requested or stored. "
                           "The record is encrypted in this computer's persistent GNOME keyring-backed owner vault; other software with access to that unlocked keyring can open it. "
                           "Nothing in ToolsEnabled reads this record yet, so saving it does not itself enable a purchase. Cancel leaves the vault unchanged. "
                           + ("Your name is pre-filled from your private identity profile; confirm it matches the card." if identity
                              else "No usable private identity profile was found, so enter the name exactly as it appears on the card."))
        message = (explanation + "\n\n" + value["message"]).encode("utf-8")
        function(gtk, "gtk_text_buffer_set_text", [P, S, I])(buffer, message, len(message))
        function(gtk, "gtk_container_add", [P, P])(scroller, text)
        function(gtk, "gtk_box_pack_start", [P, P, I, I, C.c_uint])(content, scroller, 1, 1, 0)
        if value["mode"] == "capture" and not card:
            entry = function(gtk, "gtk_entry_new", [], P)()
            function(gtk, "gtk_entry_set_visibility", [P, I])(entry, 0)
            function(gtk, "gtk_entry_set_input_purpose", [P, I])(entry, 8)  # GTK_INPUT_PURPOSE_PASSWORD
            function(gtk, "gtk_entry_set_activates_default", [P, I])(entry, 0)
            function(gtk, "gtk_box_pack_start", [P, P, I, I, C.c_uint])(content, entry, 0, 0, 10)
        if value["mode"] == "capture" and card:
            grid = function(gtk, "gtk_grid_new", [], P)()
            function(gtk, "gtk_grid_set_column_homogeneous", [P, I])(grid, 1)
            function(gtk, "gtk_grid_set_column_spacing", [P, C.c_uint])(grid, 12)
            function(gtk, "gtk_grid_set_row_spacing", [P, C.c_uint])(grid, 6)
            attach = function(gtk, "gtk_grid_attach", [P, P, I, I, I, I])
            for key, label, column, row, span, masked in [
                    ("given_name", "First / given name", 0, 0, 1, False),
                    ("family_name", "Last / family name", 1, 0, 1, False),
                    ("card_number", "Card number", 0, 2, 2, True),
                    ("expiration", "Expiration (MM/YY)", 0, 4, 1, True),
                    ("postal_code", "Billing postal code", 1, 4, 1, True)]:
                label_widget = function(gtk, "gtk_label_new", [S], P)(label.encode("utf-8"))
                function(gtk, "gtk_widget_set_halign", [P, I])(label_widget, 1)
                widget = function(gtk, "gtk_entry_new", [], P)()
                function(gtk, "gtk_entry_set_visibility", [P, I])(widget, not masked)
                function(gtk, "gtk_entry_set_activates_default", [P, I])(widget, 0)
                function(gtk, "gtk_entry_set_max_length", [P, I])(widget, 1024)
                attach(grid, label_widget, column, row, span, 1)
                attach(grid, widget, column, row + 1, span, 1)
                entries[key] = widget
                if identity and key in {"given_name", "family_name"}:
                    name = identity["givenName" if key == "given_name" else "familyName"]
                    function(gtk, "gtk_entry_set_text", [P, S])(widget, name.encode("utf-8"))
            function(gtk, "gtk_box_pack_start", [P, P, I, I, C.c_uint])(content, grid, 0, 0, 10)
        add_button = function(gtk, "gtk_dialog_add_button", [P, S, I], P)
        refuse = add_button(dialog, b"Not now", -9)
        approve = add_button(dialog, b"Begin securely" if value["mode"] == "start" else b"Save securely", -8)
        if entry or entries:
            sensitive = function(gtk, "gtk_widget_set_sensitive", [P, I])
            get_text = function(gtk, "gtk_entry_get_text", [P], S)
            sensitive(approve, 0)
            changed_type = C.CFUNCTYPE(None, P, P)

            @changed_type
            def changed(widget, _):
                valid = False
                try:
                    if entries:
                        vault.normalize_payment_card({key: get_text(control).decode("utf-8") for key, control in entries.items()})
                        valid = True
                    else:
                        valid = bool(get_text(widget).decode("utf-8").strip())
                except Exception:
                    pass  # Invalid input is private and never printed by ctypes.
                sensitive(approve, valid)

            gobject = C.CDLL("libgobject-2.0.so.0")
            connect = function(gobject, "g_signal_connect_data", [P, S, changed_type, P, P, I], C.c_ulong)
            for widget in list(entries.values()) if entries else [entry]:
                connect(widget, b"changed", changed, None, None, 0)
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
        if timed_out:
            return "timeout"
        if answer != -8:
            return "cancelled"
        if value["mode"] == "start":
            return "begin"
        entered = None
        try:
            if card:
                entered = vault.normalize_payment_card({key: get_text(control).decode("utf-8") for key, control in entries.items()})
            else:
                entered = function(gtk, "gtk_entry_get_text", [P], S)(entry).decode("utf-8")
                if not entered.strip():
                    return "cancelled"
            # Plaintext stays inside the native input process. Only the exact
            # created/updated metadata may accompany a completed card outcome.
            saved = save(value["vaultFile"], value["key"], entered) if save else save_to_vault(
                value["vaultFile"], value["key"], entered, kind=value["kind"])
            if card and receipt is not None:
                receipt["recordStatus"] = saved["status"]
            return "completed"
        finally:
            entered = None
    finally:
        identity = None
        if timer:
            function(glib, "g_source_remove", [C.c_uint], I)(timer)
        for widget in list(entries.values()) if entries else ([entry] if entry else []):
            function(gtk, "gtk_entry_set_text", [P, S])(widget, b"")
        destroy(dialog)



def load_vault():
    filename = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "linux-vault.py"))
    spec = importlib.util.spec_from_file_location("toolsenabled_private_vault", filename)
    vault = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vault)
    return vault


def save_to_vault(file, key, value, kind="credential"):
    vault = load_vault()
    vault.protect_process()
    if kind == "payment_card":
        if key != "payment_card_default":
            raise Refusal("DESKTOP_PROMPT_INVALID")
        return vault.save_payment_card(file, value)
    if kind != "credential":
        raise Refusal("DESKTOP_PROMPT_INVALID")
    vault.request_result({"action": "set-many", "file": file, "entries": [{"key": key, "value": value}]})


def main():
    try:
        if len(sys.argv) != 2:
            raise Refusal("DESKTOP_PROMPT_INVALID")
        receipt = {}
        outcome = prompt(load_payload(sys.argv[1]), receipt=receipt)
        result = {"ok": True, "outcome": outcome, **receipt}
    except Exception:
        # Never forward an exception, GTK output or vault diagnostic containing
        # the entered value. The shared runner reports the fixed failed status.
        result = {"ok": False, "code": "OWNER_PROMPT_RUNNER_UNAVAILABLE"}
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
