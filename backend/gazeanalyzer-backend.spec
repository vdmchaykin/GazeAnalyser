# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build of the backend, shipped inside the desktop app.

Built as a *directory* (onedir), not a single file: with the CUDA build of torch
the payload is a few gigabytes, and a onefile binary would unpack all of it to a
temp directory on every single launch. The Tauri shell therefore carries this
directory as a bundled resource and runs the executable from it.

    ../backend/venv/bin/pyinstaller --clean --noconfirm gazeanalyzer-backend.spec

Output: dist/gazeanalyzer-backend/gazeanalyzer-backend (+ _internal/).
"""

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []

# Packages that load code or data at runtime, which static analysis cannot see:
# torch/torchvision ship their libs and ops, cv2 and pupil_apriltags ship native
# libraries, uvicorn picks its protocol implementations by name.
for pkg in ("torch", "torchvision", "cv2", "pupil_apriltags"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

hiddenimports += collect_submodules("uvicorn")

# The HeatmapNet weights, found at runtime via app.paths (sys._MEIPASS/checkpoints).
datas += [("app/vendor/checkpoints/openeds_finetuned_lpw_validated.pth", "checkpoints")]

a = Analysis(
    ["run.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # torch.compile only; pulling it in costs ~500 MB for a path we never take.
    excludes=["triton", "tkinter", "matplotlib", "IPython", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="gazeanalyzer-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="gazeanalyzer-backend",
)
