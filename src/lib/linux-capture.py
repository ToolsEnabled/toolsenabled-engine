"""Bounded image bytes only. No caller paths are opened or written here.
stdout is metadata, fd3 is PNG, stdin is a bounded request plus optional image.
"""
import ctypes as C
import importlib.util
import io
import json
import os
import stat
import sys
import warnings

MAX_PIXELS = 16777216
MAX_BYTES = 20 * 1024 * 1024


class Refusal(Exception):
    pass


def require(value, code="DESKTOP_CAPTURE_UNAVAILABLE"):
    if not value:
        raise Refusal(code)


def pillow():
    # Fixed distro package root, not user site/PYTHONPATH/sitecustomize. The
    # helper keeps -I -S -B and never searches a provider or workspace venv.
    directory = "/usr/lib/python3/dist-packages"
    info = os.lstat(directory)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
        "DESKTOP_NATIVE_UNAVAILABLE")
    sys.path.append(directory)
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    return Image


class XImage(C.Structure):
    # Xlib public ABI prefix, through the RGB masks. XDestroyImage owns the
    # complete native structure and data, including its private function table.
    _fields_ = [("width", C.c_int), ("height", C.c_int), ("xoffset", C.c_int),
        ("format", C.c_int), ("data", C.c_void_p), ("byte_order", C.c_int),
        ("bitmap_unit", C.c_int), ("bitmap_bit_order", C.c_int), ("bitmap_pad", C.c_int),
        ("depth", C.c_int), ("bytes_per_line", C.c_int), ("bits_per_pixel", C.c_int),
        ("red_mask", C.c_ulong), ("green_mask", C.c_ulong), ("blue_mask", C.c_ulong)]


def screen(request, image_module):
    spec = importlib.util.spec_from_file_location("linux_desktop_capture", os.path.join(os.path.dirname(__file__), "linux-desktop.py"))
    desktop = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(desktop)
    require(sys.platform == "linux" and os.getuid() > 0 and os.getuid() == os.geteuid(), "DESKTOP_SESSION_UNAVAILABLE")
    require(not os.environ.get("WAYLAND_DISPLAY") and os.environ.get("XDG_SESSION_TYPE", "x11") == "x11",
        "DESKTOP_PLATFORM_UNSUPPORTED")
    require(desktop.re.fullmatch(r":[0-9]{1,5}(?:\.[0-9]{1,2})?", os.environ.get("DISPLAY", "")), "DESKTOP_SESSION_UNAVAILABLE")
    display = None
    native = None
    pixmap = 0
    try:
        display = desktop.X11()
        bounds = display.geometry(display.root)
        _, _, screen_width, screen_height = bounds
        x, y, width, height = 0, 0, screen_width, screen_height
        monitor = None
        selected_window = None
        drawable = display.root
        if request["operation"] == "window":
            def observe_window():
                candidate = next(iter(display.snapshot(int(request["windowId"]))), None)
                require(candidate is not None and candidate["processId"] == request["expectedProcessId"]
                    and candidate["processStartKey"] == request["expectedProcessStartKey"], "DESKTOP_WINDOW_TARGET_CHANGED")
                return candidate
            selected_window = observe_window()
            require(selected_window["captureEligible"], "DESKTOP_WINDOW_CAPTURE_UNAVAILABLE")
            attributes = display.window_attributes(int(request["windowId"]))
            require(display.capture_format_supported(attributes), "DESKTOP_WINDOW_CAPTURE_UNAVAILABLE")
            visual = attributes.visual.contents
            require(visual.kind == 4 and (visual.red, visual.green, visual.blue) == (0xff0000, 0xff00, 0xff),
                "DESKTOP_PIXEL_FORMAT_UNSUPPORTED")
            pixmap = display.named_pixmap(int(request["windowId"]))
            require(pixmap, "DESKTOP_WINDOW_CAPTURE_UNAVAILABLE")
            require(observe_window() == selected_window, "DESKTOP_WINDOW_TARGET_CHANGED")
            width, height = selected_window["width"], selected_window["height"]
            root, px, py, pw, ph, border, depth = C.c_ulong(), C.c_int(), C.c_int(), C.c_uint(), C.c_uint(), C.c_uint(), C.c_uint()
            require(display.x.XGetGeometry(display.display, pixmap, C.byref(root), C.byref(px), C.byref(py),
                C.byref(pw), C.byref(ph), C.byref(border), C.byref(depth)) and not display.errors)
            require(root.value == display.root and pw.value >= width and ph.value >= height
                and pw.value - width == ph.value - height and (pw.value - width) % 2 == 0
                and pw.value - width <= 256, "DESKTOP_WINDOW_CAPTURE_UNAVAILABLE")
            x = y = (pw.value - width) // 2
            drawable = pixmap
        if request["operation"] == "monitor":
            monitor = next((item for item in display.monitors() if item["monitorId"] == request["monitorId"]), None)
            require(monitor is not None, "DESKTOP_MONITOR_NOT_FOUND")
            x, y, width, height = (monitor[name] for name in ("x", "y", "width", "height"))
        if request["operation"] == "region":
            x, y, width, height = (request[name] for name in ("x", "y", "width", "height"))
        require(all(type(value) is int for value in (x, y, width, height)) and x >= 0 and y >= 0
            and width > 0 and height > 0 and (selected_window is not None
                or (x + width <= screen_width and y + height <= screen_height)),
            "DESKTOP_CAPTURE_REGION_INVALID")
        require(width * height <= MAX_PIXELS, "DESKTOP_CAPTURE_LIMIT")
        display.fn("XGetImage", [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint,
            C.c_uint, C.c_ulong, C.c_int], C.POINTER(XImage))
        display.fn("XDestroyImage", [C.POINTER(XImage)], C.c_int)
        native = display.x.XGetImage(display.display, drawable, x, y, width, height, C.c_ulong(-1), 2)
        require(native and not display.errors)
        value = native.contents
        if selected_window is not None:
            # XGetImage on a pixmap has no associated visual and reports zero
            # masks. Use the verified target visual, never assume pixmap colors.
            require(value.depth == attributes.depth)
            value.red_mask, value.green_mask, value.blue_mask = visual.red, visual.green, visual.blue
        require(value.width == width and value.height == height and value.xoffset == 0 and value.format == 2)
        require(value.depth in (24, 32) and value.bits_per_pixel == 32
            and value.byte_order in (0, 1) and value.red_mask == 0xff0000
            and value.green_mask == 0xff00 and value.blue_mask == 0xff,
            "DESKTOP_PIXEL_FORMAT_UNSUPPORTED")
        require(value.data and width * 4 <= value.bytes_per_line <= width * 4 + 64)
        data = C.string_at(value.data, value.bytes_per_line * height)
        mode = "BGRX" if value.byte_order == 0 else "XRGB"
        image = image_module.frombytes("RGB", (width, height), data, "raw", mode, value.bytes_per_line, 1)
        require(display.geometry(display.root) == bounds and not display.errors, "DESKTOP_SNAPSHOT_CHANGED")
        if selected_window is not None:
            require(observe_window() == selected_window, "DESKTOP_WINDOW_TARGET_CHANGED")
            uniform = all(low == high for low, high in image.getextrema())
            return image, dict(status="blank_or_uniform" if uniform else "captured",
                method="xcomposite_named_pixmap", width=width, height=height,
                window=selected_window, limitations=["client_area_only", "existing_compositor_storage"])
        if monitor:
            after = next((item for item in display.monitors() if item["monitorId"] == request["monitorId"]), None)
            require(after == monitor, "DESKTOP_SNAPSHOT_CHANGED")
        return image, dict(status="captured", method="copy_from_screen", x=x, y=y, width=width, height=height,
            **({"monitorId": request["monitorId"]} if monitor else {}))
    except desktop.Refusal as error:
        raise Refusal(str(error))
    finally:
        if native:
            display.x.XDestroyImage(native)
        if pixmap:
            display.x.XFreePixmap(display.display, pixmap)
        if display:
            display.close()


def thumbnail(request, image_module):
    size = request["sourceBytes"]
    require(type(size) is int and 0 < size <= MAX_BYTES, "DESKTOP_IMAGE_INVALID")
    data = sys.stdin.buffer.read(size + 1)
    require(len(data) == size, "DESKTOP_IMAGE_INVALID")
    width, height = request["maxWidth"], request["maxHeight"]
    require(all(type(v) is int and 32 <= v <= 1024 for v in (width, height)), "DESKTOP_IMAGE_INVALID")
    with image_module.open(io.BytesIO(data), formats=["PNG", "JPEG", "BMP", "GIF", "TIFF"]) as source:
        require(0 < source.width * source.height <= MAX_PIXELS and getattr(source, "n_frames", 1) == 1,
            "DESKTOP_IMAGE_INVALID")
        source.load()
        image = source.convert("RGB")
        image.thumbnail((width, height), image_module.Resampling.LANCZOS)
    return image, dict(status="captured", width=image.width, height=image.height)


def main():
    require(sys.platform == "linux" and sys.argv[1:] == [], "DESKTOP_PLATFORM_UNSUPPORTED")
    line = sys.stdin.buffer.readline(4097)
    require(len(line) <= 4096 and line.endswith(b"\n"), "DESKTOP_IMAGE_INVALID")
    request = json.loads(line)
    require(isinstance(request, dict), "DESKTOP_IMAGE_INVALID")
    operation = request.get("operation")
    fields = {"screen": {"operation"}, "region": {"operation", "x", "y", "width", "height"},
        "monitor": {"operation", "monitorId"},
        "window": {"operation", "windowId", "expectedProcessId", "expectedProcessStartKey"},
        "thumbnail": {"operation", "sourceBytes", "maxWidth", "maxHeight"}}
    require(operation in fields and set(request) == fields[operation], "DESKTOP_IMAGE_INVALID")
    try:
        image_module = pillow()
    except (ImportError, OSError):
        raise Refusal("DESKTOP_NATIVE_UNAVAILABLE")
    image, metadata = thumbnail(request, image_module) if operation == "thumbnail" else screen(request, image_module)
    with image:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        png = buffer.getvalue()
    require(0 < len(png) <= MAX_BYTES, "DESKTOP_CAPTURE_LIMIT")
    offset = 0
    while offset < len(png):
        written = os.write(3, png[offset:])
        require(written > 0)
        offset += written
    print(json.dumps(dict(ok=True, bytes=len(png), **metadata), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Refusal as error:
        print(json.dumps(dict(ok=False, code=str(error)), separators=(",", ":")))
        sys.exit(1)
    except BaseException:
        print('{"ok":false,"code":"DESKTOP_CAPTURE_UNAVAILABLE"}')
        sys.exit(1)
