# Gaze Analyser

A desktop application for processing and analysing eye-tracking recordings from Pupil Labs devices. Built with Tauri 2 (Rust), React + TypeScript (Vite), and a Python FastAPI backend.

## Architecture

| Layer | Stack | Dev port |
|---|---|---|
| Desktop shell | Tauri 2 (Rust) | — |
| Frontend | React 19 + TypeScript + Tailwind | 1420 |
| Backend API | Python FastAPI + Uvicorn | 8765 |

---

## Prerequisites

| Tool | Minimum version | Install |
|---|---|---|
| Node.js | 18 | https://nodejs.org |
| Rust + Cargo | 1.70 | https://rustup.rs |
| Python | 3.11+ | https://python.org |

On Linux, Tauri also requires a few system libraries:

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

---

## Setup (first time only)

### 1. Install frontend dependencies

```bash
npm install
```

### 2. Set up the Python backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

> This pulls the CUDA 11.8 build of PyTorch — about 3 GB. It runs on machines
> without an NVIDIA GPU as well; torch simply falls back to the CPU.

### 3. Place the HeatmapNet weights

Pupil detection needs `openeds_finetuned_lpw_validated.pth` (~56 MB). It is too
large for git, so copy it in by hand:

```bash
mkdir -p backend/app/vendor/checkpoints
cp /path/to/openeds_finetuned_lpw_validated.pth backend/app/vendor/checkpoints/
```

Set `GAZEANALYZER_HEATMAP_CKPT` to use a copy from somewhere else instead.

---

## Running in development

You need **two terminals** running at the same time.

### Terminal 1 — Backend

```bash
cd backend
source venv/bin/activate        # Windows: venv\Scripts\activate
uvicorn app.main:app --port 8765 --reload
```

The API will be available at `http://localhost:8765`.  
Interactive docs: `http://localhost:8765/docs`

### Terminal 2 — Desktop app (Tauri)

```bash
npm run tauri dev
```

This compiles the Rust shell and opens the desktop window.  
The first build takes a few minutes; subsequent builds are fast.

> **Note:** Start the backend before the Tauri app, otherwise API calls will fail on startup.

---

## Building for production

Two stages: the Python backend is frozen first, then Tauri bundles it together
with the frontend.

```bash
# 1. Freeze the backend (writes backend/dist/gazeanalyzer-backend/)
cd backend
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install pyinstaller         # build-time only, not in requirements.txt
pyinstaller --clean --noconfirm gazeanalyzer-backend.spec
cd ..

# 2. Bundle the app
npm run tauri build
```

The installer / binary is placed in `src-tauri/target/release/bundle/`.

The frozen backend is a directory, not a single file — with the CUDA build of
torch a one-file binary would unpack gigabytes on every launch — so it ships as a
bundled resource and the Rust shell starts it from there. The shell picks a free
port, passes it to the backend and injects it into the webview, so nothing is
pinned to 8765 outside development.

### Building on Windows

PyInstaller cannot cross-compile, so the Windows installer has to be produced on
Windows — the same two commands, in a Windows checkout with its own venv.

Besides Node and Python 3.12 (the pinned torch wheels are cp312), the machine
needs the Rust MSVC toolchain from [rustup](https://rustup.rs) and the **Visual
Studio Build Tools** with "Desktop development with C++" — Rust links through
MSVC. WebView2 ships with Windows 11 and current Windows 10; the generated
installer bootstraps it otherwise.

The backend is a console program, but the shell starts it with `CREATE_NO_WINDOW`
(and with its stdin piped, which is what `--exit-with-parent` listens on), so no
console window appears.

Tauri's own Windows bundlers are not usable here: NSIS and WiX both fail above a
~2 GB payload ([tauri#7372](https://github.com/tauri-apps/tauri/issues/7372),
open upstream), and the CUDA build of torch puts the app at roughly 5 GB. The
installer is therefore built with [Inno Setup](https://jrsoftware.org/isinfo.php)
(6.3+), which carries up to 4.2 GB of compressed data in a single setup.exe:

```powershell
cd backend
venv\Scripts\activate
pip install pyinstaller
pyinstaller --clean --noconfirm gazeanalyzer-backend.spec
cd ..

npm run tauri build -- --no-bundle
iscc installers\windows\GazeAnalyzer.iss
```

`--no-bundle` skips the bundlers that would fail; the build still writes the
whole tree to `src-tauri\target\release\` — the exe with the `backend\`
resource directory beside it — because resources are copied there by the build
script, not by the bundler. That is exactly the layout the app expects at
runtime, so the same tree also works as a portable zip if you ever want one.

The installer lands in `installers\windows\Output\`. It installs WebView2 if
the machine lacks it, and needs an NVIDIA driver on the target machine for the
GPU path — without one torch silently falls back to the CPU, which takes hours
per recording.

## Where the data lives

Recordings, projects and `app.db` are written to the per-OS application data
directory, never into the source tree:

| OS | Path |
|---|---|
| Linux | `~/.local/share/GazeAnalyzer` |
| Windows | `%APPDATA%\GazeAnalyzer` |
| macOS | `~/Library/Application Support/GazeAnalyzer` |

Set `GAZEANALYZER_DATA_DIR` to point somewhere else — useful for testing against
a scratch dataset. Recordings are always stored as `<data dir>/recordings/<id>`,
so the paths in `app.db` are re-rooted automatically on startup if the directory
moves.

---

## Project structure

```
PupilLabsReplacer/
├── src/                  # React frontend (TypeScript)
│   ├── pages/            # Page components (Projects, Gaze, Events, AoI, …)
│   ├── components/       # Shared UI components
│   └── lib/api.ts        # API client (base URL: http://localhost:8765)
├── src-tauri/            # Tauri / Rust shell
├── backend/
│   ├── app/
│   │   ├── main.py       # FastAPI entry point
│   │   ├── paths.py      # Data directory + checkpoint resolution
│   │   ├── api/routes/   # REST endpoints
│   │   ├── services/     # Business logic
│   │   ├── database.py   # SQLite via aiosqlite
│   │   └── vendor/       # Vendored Gaze_estimation pipeline (see its __init__)
│   ├── run.py            # Entry point used by the packaged app
│   ├── gazeanalyzer-backend.spec   # PyInstaller build
│   ├── migrate_data.py   # One-time move of a legacy in-repo data/ directory
│   ├── requirements.txt
│   └── venv/             # Python virtual environment (not committed)
```

---

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with the following extensions:

- [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
- [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) — point the interpreter to `backend/venv`
