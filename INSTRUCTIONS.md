# Running GazeAnalyzer on Windows

Running the app from source, in two console windows — no packaging step. For the
Linux setup, and for building a distributable installer, see
[README.md](README.md).

## 1. Install the prerequisites

| Tool | Download | Notes |
|---|---|---|
| Git for Windows | https://git-scm.com/download/win | Includes Credential Manager, needed if the repository is private |
| Node.js LTS | https://nodejs.org/en/download | Any version from 18 up |
| **Python 3.12.10** | https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe | Must be 3.12 — the pinned torch wheels are cp312. 3.12.10 is the last 3.12 with a Windows installer. Tick **"Add python.exe to PATH"** |
| Rust (rustup) | https://win.rustup.rs/x86_64 | Direct `rustup-init.exe`; installs the MSVC toolchain by default |
| Visual Studio Build Tools 2022 | https://aka.ms/vs/17/release/vs_BuildTools.exe | In the installer, tick the **"Desktop development with C++"** workload — Rust links through MSVC |

The last two build the desktop window itself: the shell is a Rust program, and
Rust links through MSVC. Both are required.

## 2. Get the code

```powershell
git clone --depth 1 https://github.com/vdmchaykin/GazeAnalyser.git
cd GazeAnalyser
npm install
```

`--depth 1` matters: an early commit added `backend/venv/` to the repository, so
the full history is around 800 MB of Linux `.so` files that are useless here. The
working tree itself is under 3 MB, and nothing here needs history.

## 3. Set up the Python environment

```powershell
cd backend
py -3.12 -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

This pulls the CUDA 11.8 build of torch — roughly 3 GB.

## 4. Add the HeatmapNet weights

`openeds_finetuned_lpw_validated.pth` (55.8 MB) is deliberately not in git.
Copy it from 
https://drive.google.com/drive/folders/1q4V-uZfO_Bv0GTsOS2rA_50cKDvj189-?usp=sharing

```powershell
mkdir backend\app\vendor\checkpoints
copy D:\transfer\openeds_finetuned_lpw_validated.pth backend\app\vendor\checkpoints\
```

Without it everything else runs, but pupil detection fails with an
"HeatmapNet checkpoint not found" error.

## 5. Start it — two console windows

The backend and the desktop window are separate processes here. Only the
packaged app starts the backend for you; a development build deliberately does
not, so that you can restart the backend without restarting the app.

**Console 1 — backend:**

```powershell
cd backend
venv\Scripts\activate
uvicorn app.main:app --port 8765 --reload
```

Port 8765 is not optional in this mode: a development build of the shell looks
there and nowhere else. Check it with http://127.0.0.1:8765/api/health, which
also reports where the data directory ended up.

**Console 2 — app:**

```powershell
npm run tauri dev
```

The first run compiles the Rust shell and takes a few minutes; later runs are
fast. If the window opens before the backend is up, it waits on a "Starting the
analysis backend…" screen and continues on its own.

Data — imported recordings, projects, `app.db` — is written to
`%APPDATA%\GazeAnalyzer`, the same place the installed app uses. Set
`GAZEANALYZER_DATA_DIR` before starting the backend to point somewhere else.

## Common problems

**`py` is not recognised** — Python was installed without "Add python.exe to
PATH". Either re-run the installer, or call the interpreter directly:

```powershell
C:\Users\<you>\AppData\Local\Programs\Python\Python312\python.exe -m venv venv
```

**The linker fails during `npm run tauri dev`** — the "Desktop development with
C++" workload is missing from Visual Studio Build Tools.

**The window stays on "Could not reach the backend"** — console 1 is not running,
or not listening on port 8765. Check http://127.0.0.1:8765/api/health.
