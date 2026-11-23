"""Run the installed official Hermes engine with its native profile and host permissions.

No changes are made to the Hermes installation or configuration. Stdout is an
Arrodes transport; all incidental native output is redirected to stderr.
"""
import contextlib
import json
import os
from pathlib import Path
import sys
import threading


def main():
    request = json.loads(sys.stdin.readline())
    transport = sys.stdout
    lock = threading.Lock()
    counter = 0

    def emit(event):
        transport.write("ARRODES_NATIVE_EVENT " + json.dumps(event, ensure_ascii=True) + "\n")
        transport.flush()

    def authorize(name, args):
        nonlocal counter
        with lock:
            counter += 1
            call_id = counter
            emit({"type": "tool", "id": call_id, "name": name, "args": args})
            try:
                answer = json.loads(sys.stdin.readline())
                return answer.get("id") == call_id and answer.get("allowed") is True
            except Exception:
                return False

    try:
        with contextlib.redirect_stdout(sys.stderr):
            source = str(Path(sys.argv[1]).resolve())
            # Import Hermes from its installation, never from the task workspace.
            sys.path.insert(0, source)
            sys.path = [entry for entry in sys.path if entry and str(Path(entry).resolve()) != request["cwd"]]
            from hermes_cli.env_loader import load_hermes_dotenv
            from hermes_constants import get_hermes_home
            load_hermes_dotenv(hermes_home=get_hermes_home())
            # Use the normal CLI engine, not run_oneshot (which forces YOLO mode).
            from hermes_cli import plugins
            native_hooks = plugins._dispatch_pre_tool_call_hooks

            def gated_hooks(tool_name, args, **kwargs):
                try:
                    block, modified = native_hooks(tool_name, args, **kwargs)
                    if block:
                        return block, modified
                    allowed = authorize(tool_name, modified if modified is not None else (args or {}))
                except Exception:
                    return "Arrodes native permission check failed.", None
                return (None if allowed else "Arrodes role permission or user approval denied this tool call."), modified

            plugins._dispatch_pre_tool_call_hooks = gated_hooks
            from tools import terminal_tool
            terminal_tool.set_approval_callback(lambda command, description="", **kw:
                "once" if authorize("terminal_approval", {"command": command, "description": description}) else "deny")
            from gateway.session_context import declare_stateless_channel
            declare_stateless_channel()
            os.environ["HERMES_SINGLE_QUERY_SESSION"] = "1"
            os.chdir(request["cwd"])
            # The native terminal and file tools use this shared task context.
            os.environ["TERMINAL_CWD"] = request["cwd"]
            from hermes_cli.oneshot import _run_agent, _oneshot_exit_code
            text, result = _run_agent(request["prompt"], model=request.get("model") or None,
                                      resume=request.get("resume") or None)
            if _oneshot_exit_code(text, result) != 0:
                raise RuntimeError("Native Hermes did not complete the turn")
            emit({"type": "result", "text": text, "sessionId": result.get("session_id")})
            if request.get("sessionFile") and result.get("session_id"):
                pointer = Path(request["sessionFile"])
                pointer.parent.mkdir(parents=True, exist_ok=True)
                pointer.write_text(json.dumps({"session_id": result["session_id"]}), encoding="utf-8")
    except BaseException as error:
        emit({"type": "error", "code": type(error).__name__})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
