"""Entry point for the packaged backend.

In development uvicorn is started by hand against ``app.main:app``. In a bundled
app there is no shell to do that: the Tauri process picks a free port, decides
where the data lives, and execs this module (frozen by PyInstaller) with those
values on the command line.

Both settings arrive as arguments rather than being read from a config file so
that the shell stays the single authority on them — and ``--data-dir`` has to be
applied to the environment *before* ``app.paths`` is imported, since that module
resolves the data directory once at import time.
"""

import argparse
import os
import sys
import threading


def _exit_when_parent_dies() -> None:
    """Shut down once the process that started us is gone.

    The shell kills the backend when the window closes, but that only covers the
    orderly path — if the app crashes or is killed outright, a multi-gigabyte
    Python process would be left holding its port. Our stdin is a pipe held open
    by the parent, so reading it blocks for as long as the parent lives and
    reports EOF the moment it does not.
    """

    def watch() -> None:
        try:
            while sys.stdin.buffer.read(1):
                pass
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the GazeAnalyzer backend.")
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind (default: loopback only)")
    ap.add_argument("--port", type=int, default=8765, help="port to listen on")
    ap.add_argument("--data-dir", help="override the application data directory")
    ap.add_argument(
        "--exit-with-parent",
        action="store_true",
        help="shut down when the parent process closes our stdin (used by the app shell)",
    )
    args = ap.parse_args()

    if args.exit_with_parent:
        _exit_when_parent_dies()

    if args.data_dir:
        os.environ["GAZEANALYZER_DATA_DIR"] = args.data_dir

    import uvicorn  # noqa: E402 — deliberately after the env is set

    from app.main import app  # noqa: E402

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
