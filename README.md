# Gaze Analyser

A desktop application for processing and analysing eye-tracking recordings from
**Pupil Labs Neon** glasses, fully offline. It takes a native Neon recording,
runs its own pupil detection and gaze calibration, maps the gaze onto
AprilTag-marked paper stimuli, and exports the results as Pupil-compatible
CSV files.

It was developed as part of a Master's thesis at the University of Bonn, where it is
used for paper-based neuropsychological tests such as the Trail Making Test
(TMT-A / TMT-B), but the pipeline works for any flat stimulus with AprilTags.

> **Installation:** see **[INSTALL.md](INSTALL.md)**. It covers the ready-made
> installers for Windows and Linux, as well as building from source.

---

## Features

| Area | What it does |
|---|---|
| **Projects & recordings** | Group recordings into projects; import native Neon `.zip` exports directly (binary sensor files are converted to CSV on import). |
| **Player** | Scene video playback with gaze overlay and eye-camera picture-in-picture. |
| **Gaze estimation** | Step-by-step wizard: **Detect pupils** (CNN-based HeatmapNet detector on both eye videos) → **Calibrate** → **Map gaze** → **Fixations** (I-DT) → **Validate**. Blinks are derived from pupil confidence. Pupil Cloud gaze can be used as an alternative source. |
| **Gaze offset correction** | Correct a systematic gaze shift (e.g. parallax) and apply it to all downstream data. |
| **Events** | Annotate time points and intervals on the timeline (TMT-A / TMT-B start/end, custom events). Events define the segments used in later analyses. |
| **Areas of Interest** | Pick a frame, rectify the stimulus via AprilTags, and draw rectangular or free-form AoIs per segment. |
| **Surface map** | Scene video and the flattened paper side by side, with gaze, page outline and detected markers. |
| **Visualisation** | Gaze heatmap, AoI heatmap (dwell time / fixation count) and scanpath on the paper surface. |
| **Export** | Pupil-format CSVs per recording or merged per project: `pupils`, `blinks`, `gaze_predictions`, `fixations`, `fixations_on_surface`, `surface_positions`, `aoi_fixations`, `aoi_metrics`, `events`. |

The app also includes an interactive guided tour and a help panel on every page.

## Typical workflow

```
Import recording ─► Detect pupils ─► Calibrate ─► Map gaze ─► Fixations
                                                     │
            Events (segments) ─► AoI (draw areas) ───┤
                                                     ▼
                              Surface map / Visualisation / Export
```

Draw the AoI surface **before** mapping gaze. Gaze is projected onto the paper
using the surface defined there, so if you map first, the paper coordinates
stay empty until you re-run the mapping.

## Architecture

| Layer | Stack |
|---|---|
| Desktop shell | [Tauri 2](https://tauri.app) (Rust) |
| Frontend | React 19 + TypeScript + Tailwind CSS (Vite) |
| Backend | Python 3.12, FastAPI + Uvicorn, SQLite |
| Processing | PyTorch (pupil detection), OpenCV, `pupil-apriltags`, SciPy |

In the installed app the Python backend is frozen with PyInstaller and shipped
inside the bundle. The Rust shell starts it on a free local port and stops it
when the window closes. All processing runs locally. Recordings never leave
the machine.

```
PupilLabsReplacer/
├── src/                 # React frontend (pages, components, API client)
├── src-tauri/           # Tauri / Rust shell
├── backend/
│   ├── app/             # FastAPI app: routes, services, DB, vendored gaze pipeline
│   ├── run.py           # Entry point of the packaged backend
│   └── gazeanalyzer-backend.spec   # PyInstaller build
└── installers/windows/  # Inno Setup script for the Windows installer
```

## Data location

Projects, recordings and the database are stored in the per-user application
data directory, not in the install folder:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\GazeAnalyzer` |
| Linux | `~/.local/share/GazeAnalyzer` |
| macOS | `~/Library/Application Support/GazeAnalyzer` |

Override it with the `GAZEANALYZER_DATA_DIR` environment variable.

## Hardware notes

- An **NVIDIA GPU** is strongly recommended. Pupil detection runs on CUDA if
  available. On CPU it still works, but takes hours per recording.
- Imported recordings take roughly as much disk space as the original `.zip`,
  plus generated intermediate files.

## Development

See [INSTALL.md → Building from source](INSTALL.md#building-from-source) for
setting up the development environment, running the app with hot reload, and
producing installers.
