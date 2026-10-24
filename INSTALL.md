# Installing Gaze Analyser

- [System requirements](#system-requirements)
- [Installing on Windows](#installing-on-windows)
- [Installing on Linux](#installing-on-linux)
- [First launch](#first-launch)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Troubleshooting](#troubleshooting)
- [Building from source](#building-from-source)

---

## System requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 (64-bit), or Ubuntu 22.04+ / Debian 12+ / Fedora 38+ (x86-64) | Windows 11 / Ubuntu 24.04 |
| RAM | 8 GB | 16 GB |
| Disk | ~6 GB for the app + space for recordings | SSD |
| GPU | none (CPU fallback) | NVIDIA GPU with a current driver |

The app ships with the CUDA build of PyTorch, so it is large, about 5 GB once
installed. Without an NVIDIA GPU the app still runs, but pupil detection falls
back to the CPU and takes hours per recording instead of minutes.

You do **not** need to install Python, Node.js or CUDA separately. Everything is
bundled. For GPU acceleration, only the regular NVIDIA display driver is needed.

---

## Installing on Windows

1. Download `GazeAnalyzer-<version>-x64-setup.exe` from the
   [Releases page](https://github.com/vdmchaykin/GazeAnalyser/releases).
2. Run it. If Windows SmartScreen shows *"Windows protected your PC"*, click
   **More info → Run anyway**. The installer is not code-signed.
3. Choose whether to install for all users (needs administrator rights,
   installs into `Program Files`) or only for yourself.
4. Optionally tick **Create a desktop shortcut**, then click **Install**.
   Unpacking takes a few minutes because of the size of the bundled libraries.
5. If the **WebView2 runtime** is missing (rare on Windows 10/11), the installer
   downloads and installs it automatically. This step needs an internet
   connection.
6. Start **GazeAnalyzer** from the Start menu.

## Installing on Linux

Download the package for your distribution from the
[Releases page](https://github.com/vdmchaykin/GazeAnalyser/releases).

**Debian / Ubuntu (`.deb`)**

```bash
sudo apt install ./GazeAnalyzer_<version>_amd64.deb
```

**Fedora / openSUSE (`.rpm`)**

```bash
sudo dnf install ./GazeAnalyzer-<version>-1.x86_64.rpm
```

The package manager pulls in the required system libraries (WebKitGTK, GTK 3).
The app then appears in the application menu as **GazeAnalyzer**.

For GPU acceleration, install the proprietary NVIDIA driver
(`sudo ubuntu-drivers install` on Ubuntu) and check with `nvidia-smi` that it is
active.

---

## First launch

1. The first start takes a little longer while the bundled backend loads. The
   window shows a loading screen until it is ready.
2. A welcome dialog offers an **interactive tour** of the app. You can restart it
   later from the help menu.
3. Create a project, then use **Import Recording** and select a native
   **Pupil Labs Neon** recording `.zip`. You can download it from Pupil Cloud via
   *Download → Native Recording Data*.
4. Work through the pages from top to bottom: Gaze Estimation, Events, Area of
   Interest, Surface Map, Visualisation, Export. Every page has a **?** button
   with instructions.

Your data is stored outside the program folder:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\GazeAnalyzer` |
| Linux | `~/.local/share/GazeAnalyzer` |

Back up this folder to keep your projects. To use a different location, set the
`GAZEANALYZER_DATA_DIR` environment variable before starting the app.

---

## Updating and uninstalling

- **Update:** install the new version over the old one. Your data folder is kept.
- **Uninstall on Windows:** *Settings → Apps → GazeAnalyzer → Uninstall*.
- **Uninstall on Linux:** `sudo apt remove gaze-analyzer` (Debian/Ubuntu) or
  `sudo dnf remove GazeAnalyzer` (Fedora). Use `apt list --installed | grep -i gaze`
  if the package name differs.

Uninstalling does **not** delete your recordings and projects. Remove the data
folder listed above by hand if you no longer need them.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Pupil detection is extremely slow | The app runs on the CPU. Install or update the NVIDIA driver and restart the app. |
| The window stays on the loading screen | The backend failed to start. Make sure no antivirus quarantined files in the install folder, then reinstall. |
| Blank white window (Windows) | WebView2 is missing or broken. Install it from [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/). |
| Blank window or freezes when scrubbing video (Linux) | Known WebKitGTK/GStreamer issue. Start the app with `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Make sure the GStreamer plugins (`gstreamer1.0-plugins-good`, `-bad`, `gstreamer1.0-libav`) are installed. |
| Import fails with *"No Neon recording files found"* | The selected `.zip` is not a *Native Recording Data* export, e.g. a Timeseries/CSV export. Download the native export from Pupil Cloud. |
| Paper coordinates / visualisations are empty | Gaze was mapped before the AoI surface was drawn. Draw the AoI first, then re-run **Map Gaze**. |

---

## Building from source

This section is for developers.

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 18+ | https://nodejs.org |
| Rust + Cargo | 1.70+ | https://rustup.rs (on Windows: MSVC toolchain) |
| Python | **3.12** | The pinned torch wheels are `cp312` |
| Git | any | |

**Linux** also needs the Tauri system libraries:

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

**Windows** also needs the **Visual Studio Build Tools** with the workload
*"Desktop development with C++"*, because Rust links through MSVC.

### 1. Clone and install frontend dependencies

```bash
git clone https://github.com/vdmchaykin/GazeAnalyser.git
cd GazeAnalyser
npm install
```

### 2. Set up the Python backend

```bash
cd backend
python3.12 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

This installs the CUDA 11.8 build of PyTorch, which is about 3 GB. It also runs
on machines without an NVIDIA GPU, where torch falls back to the CPU.

### 3. Place the pupil detector weights

Pupil detection needs `openeds_finetuned_lpw_validated.pth` (~56 MB). It is not
in the repository, so copy it in by hand:

```bash
mkdir -p backend/app/vendor/checkpoints
cp /path/to/openeds_finetuned_lpw_validated.pth backend/app/vendor/checkpoints/
```

Alternatively, point `GAZEANALYZER_HEATMAP_CKPT` at the file wherever it is.

### 4. Run in development mode

Use two terminals.

```bash
# Terminal 1 — backend (http://localhost:8765, API docs at /docs)
cd backend
source venv/bin/activate        # Windows: venv\Scripts\activate
uvicorn app.main:app --port 8765 --reload
```

```bash
# Terminal 2 — desktop app with hot reload
npm run tauri dev
```

Start the backend first. The first Rust build takes a few minutes.

If you have data from an older checkout in `<repo>/data`, move it to the
per-OS data directory once:

```bash
python backend/migrate_data.py           # dry run
python backend/migrate_data.py --apply
```

### 5. Build the installers

The backend is frozen with PyInstaller first, then Tauri bundles it with the
frontend. PyInstaller cannot cross-compile, so build each platform's installer
on that platform.

**Linux (`.deb`, `.rpm`)**

```bash
cd backend
source venv/bin/activate
pip install pyinstaller
pyinstaller --clean --noconfirm gazeanalyzer-backend.spec
cd ..
npm run tauri build
```

Output: `src-tauri/target/release/bundle/{deb,rpm}/`.

**Windows (`setup.exe`)**

Tauri's NSIS and WiX bundlers fail on payloads above ~2 GB
([tauri#7372](https://github.com/tauri-apps/tauri/issues/7372)), so the
installer is built with [Inno Setup](https://jrsoftware.org/isinfo.php) 6.3+
instead:

```powershell
cd backend
venv\Scripts\activate
pip install pyinstaller
pyinstaller --clean --noconfirm gazeanalyzer-backend.spec
cd ..

npm run tauri build -- --no-bundle
iscc installers\windows\GazeAnalyzer.iss
```

Output: `installers\windows\Output\GazeAnalyzer-<version>-x64-setup.exe`.

`--no-bundle` skips the failing bundlers, but still writes the complete app tree
(the exe plus the `backend\` directory next to it) to `src-tauri\target\release\`.
That tree is what the Inno script packages. It also works as a portable zip.

### Environment variables

| Variable | Purpose |
|---|---|
| `GAZEANALYZER_DATA_DIR` | Use a different data directory, e.g. a scratch dataset for testing. |
| `GAZEANALYZER_HEATMAP_CKPT` | Path to the pupil detector weights, if not in `backend/app/vendor/checkpoints/`. |
