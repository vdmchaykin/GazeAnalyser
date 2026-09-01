"""Move the in-repo ``data/`` directory into the application data directory.

Up to now the backend read and wrote ``<repo>/data`` — fine while everything ran
from a source checkout, impossible once the app is installed (the install
directory is read-only). ``app.paths`` now resolves the data directory per OS,
so the existing recordings have to move there once.

    python backend/migrate_data.py            # show what would happen
    python backend/migrate_data.py --apply    # do it

The move is a rename when source and target are on one filesystem, so 3 GB of
recordings move instantly. Stored paths in app.db are re-rooted by the backend
itself on its next start (see database._reroot_recording_paths), so nothing here
has to touch SQLite.
"""

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.paths import DATA_DIR  # noqa: E402

LEGACY_DIR = Path(__file__).parent.parent / "data"
ENTRIES = ("recordings", "projects", "app.db")


def _size(path: Path) -> str:
    if path.is_file():
        n = path.stat().st_size
    else:
        n = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="perform the move (default: dry run)")
    args = ap.parse_args()

    print(f"source: {LEGACY_DIR}")
    print(f"target: {DATA_DIR}")

    if not LEGACY_DIR.exists():
        print("\nNothing to migrate — the legacy data directory does not exist.")
        return 0

    planned, skipped = [], []
    for name in ENTRIES:
        src = LEGACY_DIR / name
        if not src.exists():
            continue
        dst = DATA_DIR / name
        (skipped if dst.exists() else planned).append((src, dst))

    print()
    for src, dst in planned:
        print(f"  move  {src.name:<12} {_size(src):>9}  ->  {dst}")
    for src, dst in skipped:
        print(f"  SKIP  {src.name:<12} {_size(src):>9}  ->  target already exists, left untouched")

    if not planned:
        print("\nNothing left to move.")
        return 1 if skipped else 0

    if not args.apply:
        print("\nDry run. Re-run with --apply to move.")
        return 0

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for src, dst in planned:
        shutil.move(str(src), str(dst))
        print(f"  moved {src.name}")

    leftovers = [p.name for p in LEGACY_DIR.iterdir()] if LEGACY_DIR.exists() else []
    print(f"\nDone. Start the backend once to re-root the paths stored in app.db.")
    if leftovers:
        print(f"Left in {LEGACY_DIR}: {', '.join(leftovers)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
