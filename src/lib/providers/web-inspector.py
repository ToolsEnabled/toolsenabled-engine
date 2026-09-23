"""JSON-lines worker for owned Safari tabs. Never adopts existing tabs.

Python 3.10+ and pymobiledevice3 11.x; raw driver exceptions stay private.
"""
import asyncio
import json
import os
import sys
import tempfile

MAX_LINE = 65536
MAX_RESULT = 3 * 1024 * 1024
IDLE_SECONDS = 180


class Refusal(Exception):
    pass


def emit(value):
    encoded = json.dumps(value, ensure_ascii=True, allow_nan=False)
    if len(encoded) > MAX_RESULT:
        encoded = json.dumps({"ok": False, "code": "WEB_INSPECTOR_OUTPUT_LIMIT"})
    print(encoded, flush=True)


def claim_device():
    # Keep the inode; unlinking can admit two simultaneous owners. A nonempty
    # marker survives process death and refuses replacement of an unknown tab.
    directory = tempfile.gettempdir()
    if hasattr(os, "getuid") and os.path.isdir(f"/run/user/{os.getuid()}"):
        directory = f"/run/user/{os.getuid()}"
    filename = os.path.join(directory, "toolsenabled-web-inspector.lock")
    fd = os.open(filename, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.lseek(fd, 0, os.SEEK_SET)
        if os.read(fd, 64).strip(b"\0"):
            raise Refusal("WEB_INSPECTOR_CLEANUP_UNCONFIRMED")
        return fd
    except Exception as error:
        os.close(fd)
        if isinstance(error, Refusal):
            raise
        raise Refusal("WEB_INSPECTOR_BUSY") from None


def mark_remote(lease, pending):
    # Fixed-size state only, never a device id, URL, account or credential.
    os.lseek(lease, 0, os.SEEK_SET)
    if os.write(lease, b"pending" if pending else b"\0" * 7) != 7:
        raise Refusal("WEB_INSPECTOR_CLEANUP_UNCONFIRMED")
    os.fsync(lease)


class Inspector:
    def __init__(self):
        self.device = self.inspector = self.session = self.driver = None
        self.lease = None
        self.cleanup_failed = False
        self.remote_pending = False

    async def connect(self):
        try:
            from pymobiledevice3.usbmux import list_devices
            from pymobiledevice3.lockdown import create_using_usbmux
            from pymobiledevice3.services.webinspector import WebinspectorService
        except ImportError:
            raise Refusal("WEB_INSPECTOR_DEPENDENCY_MISSING") from None
        devices = [d for d in await list_devices() if d.connection_type == "USB"]
        if len(devices) != 1:
            raise Refusal("WEB_INSPECTOR_NO_DEVICE" if not devices else "WEB_INSPECTOR_MULTIPLE_DEVICES")
        self.device = await create_using_usbmux(serial=devices[0].serial, connection_type="USB", autopair=False)
        self.inspector = WebinspectorService(self.device)
        await self.inspector.connect()

    async def open(self):
        if self.driver or self.lease is not None or self.cleanup_failed:
            raise Refusal("WEB_INSPECTOR_ALREADY_OPEN")
        self.lease = claim_device()
        await self.connect()
        from pymobiledevice3.services.web_protocol.driver import WebDriver
        app = await self.inspector.open_app("com.apple.mobilesafari")
        self.session = await self.inspector.automation_session(app)
        self.driver = WebDriver(self.session)
        mark_remote(self.lease, True)
        self.remote_pending = True
        await self.driver.start_session()
        return {"ownedTab": True, "transport": "ios-web-inspector", "idleTimeoutSeconds": IDLE_SECONDS}

    async def close(self):
        failures = 0
        for name, method in [("driver", "close"), ("session", "stop_session"),
                             ("inspector", "close"), ("device", "close")]:
            obj = getattr(self, name)
            if obj is not None:
                succeeded = False
                try:
                    result = getattr(obj, method)()
                    if hasattr(result, "__await__"):
                        await asyncio.wait_for(result, 5)
                    succeeded = True
                except Exception as error:
                    # Driver.close addresses one current window. The SDK's
                    # stop_session loops MANY contexts and aborts on its first
                    # exception: WindowNotFound there proves nothing about
                    # the remaining contexts, and must retain custody.
                    if name == "driver" and "WindowNotFound" in str(error):
                        succeeded = True
                    else:
                        failures += 1
                if succeeded:
                    setattr(self, name, None)
                    if name == "driver":
                        self.remote_pending = False
                if name == "session" and not succeeded:
                    # Keep the protocol alive for a same-session close retry.
                    # Releasing it here would strand any surviving contexts.
                    self.cleanup_failed = True
                    return {"closed": False, "cleanupFailures": failures}
        if self.remote_pending and not failures:
            failures += 1
        if not failures and self.lease is not None:
            try:
                mark_remote(self.lease, False)
                os.close(self.lease)
                self.lease = None
            except Exception:
                failures += 1
        self.cleanup_failed = failures != 0
        return {"closed": failures == 0, "cleanupFailures": failures}

    async def call(self, request):
        action = request["action"]
        if action == "status":
            await self.connect()
            return {"available": True, "transport": "ios-web-inspector", "pairing": "existing", "tabOpened": False}
        if action == "open":
            return await self.open()
        if action == "close":
            return await self.close()
        if self.cleanup_failed:
            raise Refusal("WEB_INSPECTOR_CLEANUP_UNCONFIRMED")
        if not self.driver:
            raise Refusal("WEB_INSPECTOR_NOT_OPEN")
        if action == "navigate":
            await self.driver.get(request["url"])
            return {"navigated": True}
        if action == "evaluate":
            result = await self.driver.execute_script(request["script"], *request.get("arguments", []))
            return {"value": result, "inputMethod": "javascript"}
        if action == "screenshot":
            return {"mimeType": "image/png", "base64": await self.driver._get_screenshot_as_base64()}
        if action == "snapshot":
            return await self.driver.execute_script(SNAPSHOT)
        if action == "tap":
            # iOS 26.1 misroutes WebKit touches after page scrolling. Adding
            # scroll offsets instead causes TargetOutOfBounds. Refuse before
            # input rather than silently touching a different control. Inner
            # scroll containers remain usable when the page viewport is stable.
            viewport = await self.driver.execute_script(TOUCH_VIEWPORT)
            if not viewport.get("safe"):
                raise Refusal("WEB_INSPECTOR_UNSAFE_TOUCH_VIEWPORT")
            point = {"sourceId": "inspector-touch", "location": {
                "x": request["x"], "y": request["y"]}, "duration": 80}
            await self.session.perform_interaction_sequence(
                [{"sourceId": "inspector-touch", "sourceType": "Touch"}],
                [{"states": [{**point, "mouseInteraction": "Down", "pressedButton": "Left"}]},
                 {"states": [{**point, "mouseInteraction": "Up"}]}])
            return {"dispatched": True, "inputMethod": "native-touch", "effectVerified": False}
        if action == "type":
            await self.session.perform_keyboard_interactions([
                {"type": "InsertByKey", "text": character} for character in request["text"]])
            return {"dispatched": True, "inputMethod": "native-keyboard", "effectVerified": False}
        if action == "fill":
            # Explicit DOM editing, never a silent fallback for native typing.
            # Pass values as arguments; never return an input's contents.
            result = await self.driver.execute_script(FILL, request["text"])
            if result.get("refusal"):
                raise Refusal("WEB_INSPECTOR_" + result["refusal"])
            return {**result, "inputMethod": "dom-fill"}
        raise Refusal("WEB_INSPECTOR_INVALID_ACTION")


TOUCH_VIEWPORT = """const v=visualViewport;return {safe:scrollX===0&&scrollY===0&&
!!v&&v.scale===1&&v.offsetLeft===0&&v.offsetTop===0};"""


FILL = """const e=document.activeElement, text=arguments[0];
const input=e instanceof HTMLInputElement, area=e instanceof HTMLTextAreaElement;
if ((!input&&!area)||e.disabled||e.readOnly||!e.getClientRects().length||
    (input&&!['text','password','email','search','url','tel'].includes(e.type)))
  return {refusal:'NOT_EDITABLE'};
if (e.maxLength>=0&&text.length>e.maxLength) return {refusal:'INPUT_TOO_LONG'};
if (!e.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,
    inputType:'insertReplacementText',data:text}))) return {refusal:'INPUT_CANCELLED'};
// The page may change focus or disable/remove the target in beforeinput.
if (document.activeElement!==e||!e.isConnected||e.disabled||e.readOnly)
  return {refusal:'NOT_EDITABLE'};
const proto=area?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto,'value').set.call(e,text);
e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:text}));
return {dispatched:true,effectVerified:e.value===text};"""


SNAPSHOT = """return {url:location.origin+location.pathname,title:document.title,
readyState:document.readyState,width:innerWidth,height:innerHeight,
scrollWidth:document.documentElement.scrollWidth,
text:(document.body?.innerText||'').slice(0,12000),
textTruncated:(document.body?.innerText||'').length>12000,
controls:Array.from(document.querySelectorAll('button,a,input,select,textarea,[role=button]')).slice(0,100).map(e=>{
const r=e.getBoundingClientRect();return {tag:e.tagName,type:e.type||null,
label:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||'').slice(0,200),
disabled:!!e.disabled,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})};"""


async def main():
    import queue
    import threading
    inbox = queue.Queue(maxsize=2)

    def read_input():
        while True:
            # A blocked BufferedReader holds an interpreter-shutdown lock.
            # Read the raw pipe so a successful close/status or idle expiry can
            # exit normally even when the parent has not sent EOF yet.
            line = sys.stdin.buffer.raw.readline(MAX_LINE + 1)
            inbox.put(line)
            if not line or len(line) > MAX_LINE:
                return

    # A daemon reader cannot keep the worker alive after its idle deadline.
    threading.Thread(target=read_input, daemon=True).start()
    inspector = Inspector()
    deadline = asyncio.get_running_loop().time() + IDLE_SECONDS
    try:
        while True:
            try:
                line = inbox.get_nowait()
            except queue.Empty:
                if asyncio.get_running_loop().time() >= deadline:
                    break
                await asyncio.sleep(0.05)
                continue
            if not line or len(line) > MAX_LINE:
                break
            request = json.loads(line)
            result = None
            try:
                result = await asyncio.wait_for(inspector.call(request), 45)
                emit({"ok": True, "result": result})
            except Refusal as error:
                emit({"ok": False, "code": str(error)})
            except asyncio.TimeoutError:
                emit({"ok": False, "code": "WEB_INSPECTOR_TIMEOUT"})
                break
            except Exception:
                emit({"ok": False, "code": "WEB_INSPECTOR_DRIVER_ERROR"})
            deadline = asyncio.get_running_loop().time() + IDLE_SECONDS
            if request.get("action") == "status" or (request.get("action") == "close" and result and result.get("closed") is True):
                break
    finally:
        emit({"type": "cleanup", "result": await inspector.close()})


if __name__ == "__main__":
    asyncio.run(main())
