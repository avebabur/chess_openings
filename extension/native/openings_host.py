"""Starts the openings app when the Lichess extension asks.

Chrome runs this (native messaging) for the extension only; install.sh
copies it to ~/Library/Application Support/OpeningsForLichess. It asks launchd
to start the app (the com.openings.app job install.sh registered), so the app
does not belong to Chrome's process tree, and stops it with the app's own
stop.sh.

Protocol: one message per run.
  {"cmd": "start"} -> {"state": "running" | "starting" | "error"}
  {"cmd": "stop"}  -> {"state": "stopped" | "not_ours" | "error"}
                      Sent when the last Lichess tab closes. If Chrome quits
                      or crashes first, the app stops itself instead
                      (backend/idle_exit.py).
                      Only when launchd started it: an app you started yourself
                      in Terminal is left alone. Stopping runs the app's own
                      stop.sh (start.sh ignores SIGTERM when launchd runs it,
                      so a plain signal left the server running).
"""
import json
import os
import socket
import struct
import subprocess
import sys

LABEL = "com.openings.app"


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("@I", raw)
    return json.loads(sys.stdin.buffer.read(length) or b"null")


def send_message(message):
    data = json.dumps(message).encode()
    sys.stdout.buffer.write(struct.pack("@I", len(data)) + data)
    sys.stdout.buffer.flush()


def app_running():
    try:
        with socket.create_connection(("127.0.0.1", 8001), timeout=0.5):
            return True
    except OSError:
        return False


def start_app():
    if app_running():
        return {"state": "running"}
    result = subprocess.run(
        ["/bin/launchctl", "kickstart", f"gui/{os.getuid()}/{LABEL}"],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        return {"state": "error", "detail": (result.stderr or result.stdout).strip()[:200]}
    return {"state": "starting"}


def launchd_running():
    result = subprocess.run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"],
                            capture_output=True, text=True, timeout=10)
    return "\tstate = running" in result.stdout


def stop_app():
    if not launchd_running():
        return {"state": "not_ours"}
    root = os.environ.get("OPENINGS_ROOT", "")
    stop_script = os.path.join(root, "stop.sh")
    if not (root and os.path.isfile(stop_script)):
        return {"state": "error", "detail": "OPENINGS_ROOT is not set; re-run install.sh"}
    subprocess.run(["/bin/sh", stop_script], cwd=root, capture_output=True, timeout=60)
    return {"state": "stopped"}


def main():
    message = read_message()
    command = message.get("cmd") if isinstance(message, dict) else None
    if command in ("start", "stop"):
        try:
            send_message(start_app() if command == "start" else stop_app())
        except Exception as exc:  # always answer, or Chrome reports a vague error
            send_message({"state": "error", "detail": str(exc)[:200]})
    else:
        send_message({"state": "unknown"})


if __name__ == "__main__":
    main()
