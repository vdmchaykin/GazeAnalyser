"""Scene-camera egomotion: one homography per pair of consecutive scene frames.

Overlays that show PAST data (the scanpath's trailing fixations) are drawn in
scene-pixel coordinates that were valid in the frame the data came from. While
the head moves, those coordinates keep pointing at a fixed spot on the SCREEN
instead of the object that was actually looked at. Chaining these per-frame
homographies transports a point from the frame it was measured in into the frame
currently on screen, so it stays on its target.

A homography is exact for pure camera ROTATION or a planar scene; a translating
head introduces parallax between objects at different depths. Over the few
seconds of a scanpath window that error stays small, and gaze targets on the AoI
paper are handled by the exact surface homography anyway (see aoi.py) — this is
the fallback for everything off the surface.

Estimation is plain KLT: features on the previous frame, Lucas-Kanade flow with a
forward-backward consistency check, then RANSAC over the surviving matches. Only
the RANSAC inliers are carried into the next frame, so the tracked set converges
onto the dominant (background) plane instead of drifting onto moving objects.
"""

import csv
import threading
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.api.routes.aoi import _get_recording, _load_scene_timestamps

router = APIRouter(prefix="/api/recordings/{recording_id}/motion", tags=["motion"])

_motion_jobs: dict = {}

_MOTION_COLS = [
    "frame index", "timestamp [ns]",
    "h00", "h01", "h02", "h10", "h11", "h12", "h20", "h21",
    "inliers",
]

# Frames are downscaled before tracking: KLT on a 640 px-wide image is ~6× faster
# than on the native 1600 px scene frame and the homography is recovered at full
# resolution afterwards, so the only cost is sub-pixel precision we don't need.
_TRACK_WIDTH = 640
_MIN_TRACKED = 250        # re-detect features once fewer than this survive
_REDETECT_EVERY = 12      # …and at least this often, so points stay spread out
_FB_ERROR_PX = 1.0        # forward-backward consistency bound (tracking px)
_RANSAC_PX = 2.0
_MIN_MATCHES = 12         # below this a frame pair is left unsolved

_FEATURE_PARAMS = dict(maxCorners=800, qualityLevel=0.01, minDistance=8, blockSize=7)
_LK_PARAMS = dict(
    winSize=(21, 21), maxLevel=3,
    criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
)


def _motion_dir(folder_path: str) -> Path:
    d = Path(folder_path) / "motion"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _prep(frame: np.ndarray, scale: float) -> np.ndarray:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if scale < 1.0:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return gray


def _flow_homography(prev_gray, gray, p0):
    """LK flow prev→cur, forward-backward filtered, then a RANSAC homography.

    Returns ``(H, inliers, kept)`` in TRACKING-image pixels, where `kept` are the
    inlier positions in the CURRENT frame — the seed for the next pair. `H` is
    None when the pair could not be solved reliably."""
    if p0 is None or len(p0) < _MIN_MATCHES:
        return None, 0, None
    p1, st, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, p0, None, **_LK_PARAMS)
    if p1 is None:
        return None, 0, None
    # Track back: a point whose round trip does not land where it started was
    # tracked onto the wrong texture (occlusion, repetitive pattern, motion blur).
    p0r, st2, _ = cv2.calcOpticalFlowPyrLK(gray, prev_gray, p1, None, **_LK_PARAMS)
    if p0r is None:
        return None, 0, None
    fb = np.linalg.norm(p0.reshape(-1, 2) - p0r.reshape(-1, 2), axis=1)
    ok = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < _FB_ERROR_PX)
    a = p0.reshape(-1, 2)[ok]
    b = p1.reshape(-1, 2)[ok]
    if len(a) < _MIN_MATCHES:
        return None, len(a), None

    H, mask = cv2.findHomography(a, b, cv2.RANSAC, _RANSAC_PX)
    if H is None or abs(H[2, 2]) < 1e-12:
        return None, 0, None
    inliers = int(mask.sum()) if mask is not None else len(a)
    if inliers < _MIN_MATCHES:
        return None, inliers, None
    kept = b[mask.ravel() == 1] if mask is not None else b
    return H, inliers, kept.reshape(-1, 1, 2).astype(np.float32)


def _to_full_res(H: np.ndarray, scale: float) -> np.ndarray:
    """Rewrite a tracking-resolution homography in full scene pixels.

    Points relate as ``p_small = S·p_full`` with ``S = diag(scale, scale, 1)``,
    so the full-resolution transform is ``S⁻¹·H·S``."""
    S = np.array([[scale, 0.0, 0.0], [0.0, scale, 0.0], [0.0, 0.0, 1.0]])
    Hf = np.linalg.inv(S) @ H @ S
    return Hf / Hf[2, 2]


def _run_scene_motion(recording_id: str, scene_video: str, folder_path: str) -> None:
    job = _motion_jobs[recording_id]
    try:
        out_csv = _motion_dir(folder_path) / "scene_motion.csv"
        part = out_csv.with_suffix(".part")
        timestamps = _load_scene_timestamps(scene_video)

        cap = cv2.VideoCapture(scene_video)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or len(timestamps)
        job["total"] = total

        prev_gray = None
        p0 = None
        scale = 1.0
        solved = 0

        with open(part, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(_MOTION_COLS)
            idx = 0
            while True:
                if job.get("cancelled"):
                    break
                ok, frame = cap.read()
                if not ok:
                    break
                if idx == 0:
                    scale = min(1.0, _TRACK_WIDTH / float(frame.shape[1]))
                gray = _prep(frame, scale)
                ts = int(timestamps[idx]) if idx < len(timestamps) else ""

                if prev_gray is None:
                    # Frame 0 has no predecessor — no transform to write.
                    writer.writerow([idx, ts, *[""] * 8, 0])
                else:
                    if p0 is None or len(p0) < _MIN_TRACKED or idx % _REDETECT_EVERY == 0:
                        p0 = cv2.goodFeaturesToTrack(prev_gray, mask=None, **_FEATURE_PARAMS)
                    H, inliers, kept = _flow_homography(prev_gray, gray, p0)
                    if H is None:
                        writer.writerow([idx, ts, *[""] * 8, inliers])
                        p0 = None  # force a fresh detection on the next pair
                    else:
                        Hf = _to_full_res(H, scale)
                        vals = [f"{v:.9g}" for v in Hf.ravel()[:8]]
                        writer.writerow([idx, ts, *vals, inliers])
                        p0 = kept
                        solved += 1

                prev_gray = gray
                idx += 1
                job["progress"] = idx
                job["solved"] = solved
        cap.release()

        if job.get("cancelled"):
            part.unlink(missing_ok=True)
            job["status"] = "cancelled"
            job["message"] = "Cancelled"
        else:
            part.replace(out_csv)
            job["solved"] = solved
            job["status"] = "done"
    except Exception as e:  # pragma: no cover - surfaced via the status endpoint
        job["status"] = "error"
        job["message"] = str(e)


@router.post("")
async def start_scene_motion(recording_id: str):
    rec = await _get_recording(recording_id)
    scene_video = rec.get("scene_video")
    if not scene_video or not Path(scene_video).exists():
        raise HTTPException(status_code=404, detail="Scene video not found")

    job = _motion_jobs.get(recording_id)
    if job and job["status"] == "running":
        raise HTTPException(status_code=409, detail="Scene motion is already being computed")

    _motion_jobs[recording_id] = {
        "status": "running", "progress": 0, "total": 0,
        "cancelled": False, "message": "Starting…", "solved": 0,
    }
    threading.Thread(
        target=_run_scene_motion,
        args=(recording_id, scene_video, rec["folder_path"]),
        daemon=True,
    ).start()
    return {"started": True}


@router.get("")
async def scene_motion_status(recording_id: str):
    rec = await _get_recording(recording_id)
    has_file = (_motion_dir(rec["folder_path"]) / "scene_motion.csv").exists()
    job = _motion_jobs.get(recording_id)
    if not job:
        return {"status": "done" if has_file else "idle", "progress": 0, "total": 0,
                "solved": 0, "message": "", "has_file": has_file}
    return {
        "status": job["status"],
        "progress": job.get("progress", 0),
        "total": job.get("total", 0),
        "solved": job.get("solved", 0),
        "message": job.get("message", ""),
        "has_file": has_file,
    }


@router.post("/cancel")
async def cancel_scene_motion(recording_id: str):
    job = _motion_jobs.get(recording_id)
    if job and job["status"] == "running":
        job["cancelled"] = True
    return {"ok": True}


@router.get("/data")
async def scene_motion_data(recording_id: str):
    """Per-frame transforms for the player overlay.

    ``h[i]`` maps a point in frame ``i-1`` onto frame ``i`` (8 numbers, row-major,
    with the implicit ``h22 = 1``), or null where the pair was unsolved. Index 0
    is always null."""
    rec = await _get_recording(recording_id)
    path = _motion_dir(rec["folder_path"]) / "scene_motion.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="scene_motion.csv not found")

    ts_ns: list = []
    hs: list = []
    solved = 0
    with open(path) as f:
        for row in csv.DictReader(f):
            ts_ns.append(int(row["timestamp [ns]"]) if row["timestamp [ns]"] else None)
            if row["h00"] == "":
                hs.append(None)
                continue
            hs.append([float(row[c]) for c in _MOTION_COLS[2:10]])
            solved += 1
    return {"ts_ns": ts_ns, "h": hs, "frames": len(hs), "solved": solved}


@router.get("/file")
async def download_scene_motion(recording_id: str):
    rec = await _get_recording(recording_id)
    path = _motion_dir(rec["folder_path"]) / "scene_motion.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="scene_motion.csv not found")
    return FileResponse(str(path), media_type="text/csv", filename="scene_motion.csv")
