"""Where the application keeps its data.

A bundled app cannot write next to its own code — the install directory is
read-only (an AppImage is a read-only mount, Program Files needs admin). So the
data directory is resolved at import time, in this order:

1. ``GAZEANALYZER_DATA_DIR`` — set by the Tauri shell for the bundled sidecar,
   and useful by hand for pointing a dev run at a scratch dataset.
2. The per-OS application-data directory.

Everything the app writes (SQLite file, imported recordings, per-project AoI
state) hangs off ``DATA_DIR``, so a fresh install starts empty and nothing is
ever written into the source tree.
"""

import os
import sys
from pathlib import Path

APP_NAME = "GazeAnalyzer"


def _default_data_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        return Path(base) / APP_NAME if base else Path.home() / "AppData" / "Roaming" / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    base = os.environ.get("XDG_DATA_HOME")
    return Path(base) / APP_NAME if base else Path.home() / ".local" / "share" / APP_NAME


def _resolve_data_dir() -> Path:
    override = os.environ.get("GAZEANALYZER_DATA_DIR")
    return Path(override).expanduser().resolve() if override else _default_data_dir()


DATA_DIR = _resolve_data_dir()
RECORDINGS_DIR = DATA_DIR / "recordings"
PROJECTS_DIR = DATA_DIR / "projects"
DB_PATH = DATA_DIR / "app.db"


# ── model weights ──────────────────────────────────────────────────────────

HEATMAP_CKPT_NAME = "openeds_finetuned_lpw_validated.pth"


def _resolve_heatmap_ckpt() -> Path:
    """Locate the HeatmapNet weights.

    Order: an explicit override, then the copy PyInstaller unpacks beside the
    frozen backend, then the working copy in the source tree. The file is ~107 MB
    and therefore lives outside git — see backend/README for how to place it.
    """
    override = os.environ.get("GAZEANALYZER_HEATMAP_CKPT")
    if override:
        return Path(override).expanduser()
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "checkpoints" / HEATMAP_CKPT_NAME
    return Path(__file__).parent / "vendor" / "checkpoints" / HEATMAP_CKPT_NAME


HEATMAP_CKPT = _resolve_heatmap_ckpt()


def ensure_dirs() -> None:
    """Create the data directories. Called once on startup."""
    for d in (DATA_DIR, RECORDINGS_DIR, PROJECTS_DIR):
        d.mkdir(parents=True, exist_ok=True)
