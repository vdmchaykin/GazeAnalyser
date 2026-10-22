"""Gaze validation: accuracy and precision against targets with a known position.

The study protocol puts a METRIC SHEET in front of the wearer twice — after
TMT-A and again after TMT-B (events ``metric1_begin/_end``, ``metric2_begin/_end``).
The sheet carries 25 numbered circles in a 5×5 grid between the same four
AprilTags as the test sheets, and the wearer looks at them in order 1 → 25. So
every target's position on the paper is known; the user only marks WHEN the
wearer looks at each one, and the per-frame surface homography says where the
target is in the scene at every gaze sample. Two sheets per recording also show
whether the gaze drifts over the session.

For recordings without a metric sheet there is a fallback: targets clicked in the
scene video, exactly like calibration points but at other moments.

The targets are ground truth about the scene, not about a pipeline, so one set of
marks validates every gaze source and the numbers are directly comparable
(own pipeline vs Pupil Cloud).

Metrics follow Pupil Core's validation:
  accuracy   mean angular distance between gaze samples and the target (°)
  precision  RMS of the angular distance between consecutive samples (°)
Samples further than `outlier_deg` from the target are excluded from both — the
wearer blinked, glanced away, or had not arrived at the target yet.

Angles are measured between camera rays, from undistorted pixels and the scene
camera's own intrinsics, so the error does not depend on where in the frame the
target sits (a pixel at the image edge spans less angle than one at the centre).

Time bases. Both videos start at PTS 0, but the eye camera starts later than the
scene camera (0.9 s on 27c866fe), so the marking views play the eye video offset
to stay in sync (see `video_timeline`). Sheet marks are stored as ABSOLUTE device
timestamps of the marked scene frame; clicked targets come from the calibration
UI and are resolved exactly like calibration points (`mark_abs_ns`).
"""

import base64
import json
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.api.routes.aoi import (
    _get_recording,
    _gaze_dir,
    _aoi_dir,
    _aoi_dirs,
    _RESERVED_AOI_JSON,
    scene_intrinsics,
    undistort_points,
    distort_points,
)
from app.api.routes.events import _read_events
from app.api.routes.gaze import (
    _available_sources,
    _cloud_gaze_path,
    _load_cloud_gaze,
    _load_scene_timestamps,
    _read_prediction_samples,
    _homographies_from_cache,
    _homographies_from_surface_csv,
    _nearest_frame,
    _SCENE_PX_PER_DEG,
    _timeline_t0,
    mark_abs_ns,
    read_offset,
    video_timeline,
)

router = APIRouter(prefix="/api/recordings/{recording_id}/gaze/validation", tags=["validation"])

# Both files live in the recording's gaze_analysis root: the marks belong to the
# recording, and one result covers every source.
_POINTS_FILE = "validation_points.json"
_RESULT_FILE = "validation_result.json"

# Neon's scene camera, for the no-calibration.bin fallback below.
_FALLBACK_FRAME = (1600, 1200)

# Which sources get validated. "cloud" and "cloud_native" carry the same gaze, so
# validating both would only print the same row twice.
_VALIDATED_SOURCES = ("own", "cloud")
_SOURCE_LABELS = {"own": "My pipeline", "cloud": "Pupil Cloud"}

# The metric sheet: 5×5 circle centres in normalised surface coordinates, as
# measured on the printed template (recording 7572b22c, segment metric1). Used
# only when no metric segment's warped image is available to measure them on.
_SHEET_GRID = 5
_TEMPLATE_COLS = (0.1409, 0.3213, 0.5001, 0.6792, 0.8581)
_TEMPLATE_ROWS = (0.0988, 0.2994, 0.4993, 0.7007, 0.9018)

# Event-name prefix of a metric-sheet block: metric1_begin, metric2_begin, …
_SHEET_PREFIX = "metric"

# Gap kept between a window and the next mark, so a window never reaches into the
# saccade towards the next target.
_GUARD_NS = 50_000_000

FREE_BLOCK = "free"


def _root(folder_path: str) -> Path:
    return _gaze_dir(folder_path, "own")


# ── stored marks ───────────────────────────────────────────────────────────
# validation_points.json:
#   {"version": 2,
#    "blocks": [{"id": "metric1", "label": "Metric sheet 1",
#                "start_s": 122.3, "end_s": 156.6,          # video seconds
#                "marks": [{"target_id": 1, "video_s": 123.1, "timestamp_ns": <abs>}]}],
#    "free_points": [<calibration-style points>]}
# A bare list is the first version (clicked targets only).

def _read_doc(folder_path: str) -> dict:
    f = _root(folder_path) / _POINTS_FILE
    doc = {"version": 2, "blocks": [], "free_points": []}
    if not f.exists():
        return doc
    try:
        raw = json.loads(f.read_text())
    except (json.JSONDecodeError, OSError):
        return doc
    if isinstance(raw, list):
        doc["free_points"] = raw
    elif isinstance(raw, dict):
        doc["blocks"] = raw.get("blocks") or []
        doc["free_points"] = raw.get("free_points") or []
    return doc


def _write_doc(folder_path: str, doc: dict) -> None:
    root = _root(folder_path)
    if not doc["blocks"] and not doc["free_points"]:
        (root / _POINTS_FILE).unlink(missing_ok=True)
    else:
        (root / _POINTS_FILE).write_text(json.dumps({**doc, "version": 2}, indent=2))
    # A result computed against other marks would now be misleading.
    (root / _RESULT_FILE).unlink(missing_ok=True)


def has_validation_marks(folder_path: str) -> bool:
    doc = _read_doc(folder_path)
    return bool(doc["free_points"]) or any(b.get("marks") for b in doc["blocks"])


# ── time bases ─────────────────────────────────────────────────────────────

def _scene_abs_ns(rec: dict, video_s: float) -> Optional[int]:
    """Device timestamp of the scene frame shown at `video_s`."""
    ts = _load_scene_timestamps(rec["scene_video"]) if rec.get("scene_video") else np.array([])
    if ts.size:
        rel = video_s * 1e9 + ts[0]
        return int(ts[_nearest_frame(ts, int(rel))])
    t0 = _timeline_t0(rec["folder_path"])
    return int(t0 + video_s * 1e9) if t0 is not None else None


def _block_label(bid: str, i: int) -> str:
    digits = "".join(ch for ch in bid if ch.isdigit())
    return f"Metric sheet {digits or i}"


def _suggested_blocks(rec: dict) -> list:
    """Metric-sheet blocks the recording already names: its ``metricN_begin/_end``
    events, else AoI segments called metric* (which carry no window, only the
    frame the sheet was annotated on — enough to seek to)."""
    events = _read_events(rec["folder_path"])
    begins = {e["name"][:-6]: e["timestamp_s"] for e in events
              if e["name"].startswith(_SHEET_PREFIX) and e["name"].endswith("_begin")}
    ends = {e["name"][:-4]: e["timestamp_s"] for e in events if e["name"].endswith("_end")}
    blocks = [{"id": bid, "label": _block_label(bid, i), "start_s": start, "end_s": ends.get(bid)}
              for i, (bid, start) in enumerate(sorted(begins.items(), key=lambda kv: kv[1]), 1)]
    if blocks:
        return blocks
    segs = []
    for d in _aoi_dirs(rec):
        for p in sorted(d.glob(f"{_SHEET_PREFIX}*.json")) if d.exists() else []:
            if p.stem in {b["id"] for b in segs}:
                continue
            try:
                ref = json.loads(p.read_text()).get("reference_timestamp_s")
            except (json.JSONDecodeError, OSError, AttributeError):
                ref = None
            segs.append({"id": p.stem, "start_s": ref, "end_s": None})
    segs.sort(key=lambda b: (b["start_s"] is None, b["start_s"] or 0))
    return [{**b, "label": _block_label(b["id"], i)} for i, b in enumerate(segs, 1)]


# ── sheet targets ──────────────────────────────────────────────────────────

def _template_targets() -> list:
    return [{"target_id": r * _SHEET_GRID + c + 1, "x": x, "y": y}
            for r, y in enumerate(_TEMPLATE_ROWS) for c, x in enumerate(_TEMPLATE_COLS)]


def _detect_sheet_targets(img: np.ndarray) -> Optional[list]:
    """The 25 circle centres on a warped (surface-space) image of the metric sheet.

    Hough finds each circle to within ~2 page px; the printed grid is regular, so
    every column's x and every row's y is then averaged over its five circles,
    which also numbers them 1 → 25 row by row, as printed."""
    h, w = img.shape[:2]
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    found = cv2.HoughCircles(
        cv2.GaussianBlur(gray, (5, 5), 1.5), cv2.HOUGH_GRADIENT, dp=1,
        minDist=w * 0.08, param1=120, param2=30,
        minRadius=int(w * 0.02), maxRadius=int(w * 0.05),
    )
    n = _SHEET_GRID * _SHEET_GRID
    if found is None or len(found[0]) != n:
        return None
    pts = found[0][:, :2] / np.array([w, h], dtype=np.float64)
    xs, ys = np.sort(pts[:, 0]), np.sort(pts[:, 1])
    cols = xs.reshape(_SHEET_GRID, _SHEET_GRID).mean(axis=1)
    rows = ys.reshape(_SHEET_GRID, _SHEET_GRID).mean(axis=1)
    # A real grid has five well-separated columns and rows; anything else means the
    # detector picked up something other than the printed circles.
    spread = max(np.ptp(xs.reshape(_SHEET_GRID, -1), axis=1).max(),
                 np.ptp(ys.reshape(_SHEET_GRID, -1), axis=1).max())
    if spread > 0.5 * min(np.diff(cols).min(), np.diff(rows).min()):
        return None
    return [{"target_id": r * _SHEET_GRID + c + 1, "x": float(x), "y": float(y)}
            for r, y in enumerate(rows) for c, x in enumerate(cols)]


def _decode_b64_image(b64: str) -> Optional[np.ndarray]:
    if not b64:
        return None
    try:
        data = base64.b64decode(b64.split(",", 1)[-1])
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
        return img if img is not None and img.size else None
    except (ValueError, TypeError, cv2.error):
        return None


def _sheet_targets(rec: dict) -> tuple:
    """``(targets, source)`` — measured on a metric segment's warped image when one
    exists (this recording's own, then its project's), else the template."""
    for d in _aoi_dirs(rec):
        if not d.exists():
            continue
        names = sorted(
            (p.stem for p in d.glob("*.json") if p.stem not in _RESERVED_AOI_JSON),
            key=lambda s: (not s.startswith(_SHEET_PREFIX), s),
        )
        for seg in names:
            try:
                state = json.loads((d / f"{seg}.json").read_text())
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(state, dict):
                continue
            for key in ("warped_image_b64", "reference_image_b64"):
                img = _decode_b64_image(state.get(key) or "")
                targets = _detect_sheet_targets(img) if img is not None else None
                if targets:
                    return targets, f"measured on segment '{seg}'"
    return _template_targets(), "template"


# ── geometry ───────────────────────────────────────────────────────────────

def _camera_matrix(folder_path: str) -> np.ndarray:
    """Scene camera matrix; without calibration.bin, a pinhole with Neon's measured
    angular scale centred on the frame."""
    kd = scene_intrinsics(folder_path)
    if kd is not None:
        return kd[0]
    f = _SCENE_PX_PER_DEG / np.tan(np.deg2rad(1.0))
    w, h = _FALLBACK_FRAME
    return np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1]], dtype=np.float64)


def _rays(K_inv: np.ndarray, und_px: np.ndarray) -> np.ndarray:
    """Unit viewing rays for undistorted pixel positions, shape (n, 3)."""
    h = np.hstack([und_px, np.ones((len(und_px), 1))])
    r = h @ K_inv.T
    return r / np.linalg.norm(r, axis=1, keepdims=True)


def _angle_deg(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.degrees(np.arccos(np.clip(np.sum(a * b, axis=1), -1.0, 1.0)))


def _scene_homographies(folder_path: str):
    """Per-frame scene→paper homographies (undistorted px → normalised paper), only
    from what gaze mapping / surface positions already produced — validation never
    starts an AprilTag pass over the video on its own."""
    adir = _aoi_dir(folder_path)
    for got in (_homographies_from_cache(adir), _homographies_from_surface_csv(adir, folder_path)):
        if got and got[0] is not None and len(got[0]) > 0 and got[1]:
            return got
    return None


def _paper_to_scene(homs, paper_xy, sample_ts: np.ndarray) -> np.ndarray:
    """A paper point in each sample's frame, undistorted px; NaN where the surface
    is not localised in that frame."""
    scene_ts, H = homs
    out = np.full((len(sample_ts), 2), np.nan)
    p = np.array([paper_xy[0], paper_xy[1], 1.0])
    for i, t in enumerate(sample_ts):
        H_s = H.get(_nearest_frame(scene_ts, int(t)))
        if H_s is None:
            continue
        try:
            q = np.linalg.solve(H_s, p)
        except np.linalg.LinAlgError:
            continue
        if abs(q[2]) > 1e-12:
            out[i] = q[:2] / q[2]
    return out


def _scene_to_paper(homs, xy_und, t: int):
    scene_ts, H = homs
    H_m = H.get(_nearest_frame(scene_ts, t))
    if H_m is None:
        return None
    q = H_m @ np.array([xy_und[0], xy_und[1], 1.0])
    return q[:2] / q[2] if abs(q[2]) > 1e-12 else None


# ── inputs ─────────────────────────────────────────────────────────────────

def _source_samples(folder_path: str, source: str):
    """``(ts, xy_raw_px, input_description)`` for one source, or None if it has no gaze.

    The mapped predictions are preferred: they are what every later stage reads,
    including any offset correction. Pupil Cloud's raw export is the fallback, so
    the cloud gaze can be validated before it is mapped onto a surface."""
    pred = _gaze_dir(folder_path, source) / "gaze_predictions.csv"
    if pred.exists():
        s = _read_prediction_samples(pred)
        dx, dy = read_offset(_gaze_dir(folder_path, source))
        desc = "mapped gaze"
        if dx or dy:
            desc += f" (offset {dx:+.0f}, {dy:+.0f} px applied)"
        return (np.array([r[0] for r in s], dtype=np.int64),
                np.array([[r[1], r[2]] for r in s], dtype=np.float64), desc)
    if source in ("cloud", "cloud_native") and _cloud_gaze_path(folder_path).exists():
        s = _load_cloud_gaze(folder_path)
        return (np.array([r[0] for r in s], dtype=np.int64),
                np.array([[r[1], r[2]] for r in s], dtype=np.float64), "raw csv/gaze.csv")
    return None


def _window_bounds(ts_marks: list, win_ns: int, mode: str) -> list:
    """Per-mark analysis window ``(lo, hi)``.

    "after": from the mark forward — the mark is when the eye lands on the target.
    "centered": ±half the window around the mark.
    Either way a window stops short of the neighbouring marks, so it never takes in
    the fixation on the previous or next target (only ~4° away on the sheet — close
    enough to pass the outlier threshold)."""
    ordered = sorted(ts_marks)
    bounds = []
    for t in ts_marks:
        prev = [u for u in ordered if u < t]
        nxt = [u for u in ordered if u > t]
        if mode == "after":
            lo, hi = t, t + win_ns
            if nxt:
                hi = min(hi, nxt[0] - _GUARD_NS)
        else:
            lo, hi = t - win_ns // 2, t + win_ns // 2
            if prev:
                lo = max(lo, (prev[-1] + t) // 2 + _GUARD_NS)
            if nxt:
                hi = min(hi, (t + nxt[0]) // 2 - _GUARD_NS)
        bounds.append((lo, hi))
    return bounds


# ── core ───────────────────────────────────────────────────────────────────

def _measure(folder_path: str, K_inv: np.ndarray, ts: np.ndarray, xy: np.ndarray,
             marks: list, win_ns: int, mode: str, outlier_deg: float, target_fn) -> tuple:
    """Per-mark metrics for one block of one source.

    `marks` are ``(row_info, t_mark_abs)``; `target_fn(row_info, t_mark, sample_ts)`
    returns the target in every sample's frame (undistorted px, NaN = unknown).
    Returns ``(rows, pooled)`` where `pooled` keeps the per-sample arrays so blocks
    can be combined into one figure."""
    rows = []
    pooled = {"err": [], "s2s": [], "bias": [], "n_total": 0}
    for (info, t_mark), (lo, hi) in zip(marks, _window_bounds([m[1] for m in marks], win_ns, mode)):
        a, b = np.searchsorted(ts, lo, "left"), np.searchsorted(ts, hi, "right")
        row = {**info, "n_samples": int(b - a), "n_used": 0, "n_tracked": 0}
        pooled["n_total"] += int(b - a)
        if b <= a:
            rows.append(row)
            continue

        gaze_und = undistort_points(folder_path, xy[a:b]).astype(np.float64)
        tgt = target_fn(info, t_mark, ts[a:b])
        tracked = ~np.isnan(tgt[:, 0])
        row["n_tracked"] = int(tracked.sum())
        if not tracked.any():
            rows.append(row)
            continue

        g_rays = _rays(K_inv, gaze_und)
        err = np.full(len(gaze_und), np.inf)
        err[tracked] = _angle_deg(g_rays[tracked], _rays(K_inv, tgt[tracked]))
        keep = err <= outlier_deg
        row["n_used"] = int(keep.sum())
        if not keep.any():
            row["median_error_deg"] = float(np.median(err[tracked]))
            rows.append(row)
            continue

        # Consecutive kept samples — a pair straddling an outlier is skipped, so a
        # glance away does not show up as two huge jumps in the precision.
        idx = np.flatnonzero(keep)
        pairs = idx[1:][np.diff(idx) == 1]
        s2s = _angle_deg(g_rays[pairs], g_rays[pairs - 1]) if len(pairs) else np.array([])

        bias = gaze_und[keep] - tgt[keep]   # undistorted px, gaze minus target
        row.update({
            "accuracy_deg": float(err[keep].mean()),
            "median_error_deg": float(np.median(err[keep])),
            "precision_rms_deg": float(np.sqrt(np.mean(s2s ** 2))) if len(s2s) else None,
            "bias_x_px": float(bias[:, 0].mean()),
            "bias_y_px": float(bias[:, 1].mean()),
            "error_px": float(np.linalg.norm(bias, axis=1).mean()),
        })
        rows.append(row)
        pooled["err"].append(err[keep])
        pooled["s2s"].append(s2s)
        pooled["bias"].append(bias)
    return rows, pooled


def _summary(rows: list, pooled: dict, K: np.ndarray, sample_rate: Optional[float]) -> dict:
    valid = [r for r in rows if r["n_used"] > 0]
    out = {"n_points": len(rows), "n_points_valid": len(valid)}
    if not valid:
        return out
    err = np.concatenate(pooled["err"])
    s2s = np.concatenate(pooled["s2s"])
    bias = np.vstack(pooled["bias"])
    out.update({
        # Pooled over every kept sample, as Pupil Core reports it ...
        "accuracy_deg": float(err.mean()),
        "precision_rms_deg": float(np.sqrt(np.mean(s2s ** 2))) if len(s2s) else None,
        # ... and per point, so one long dwell cannot dominate the figure.
        "accuracy_deg_per_point_mean": float(np.mean([r["accuracy_deg"] for r in valid])),
        "accuracy_deg_per_point_max": float(np.max([r["accuracy_deg"] for r in valid])),
        "bias_x_px": float(bias[:, 0].mean()),
        "bias_y_px": float(bias[:, 1].mean()),
        "bias_deg": float(np.degrees(np.arctan(np.hypot(*bias.mean(axis=0)) / K[0, 0]))),
        "samples_used_frac": float(len(err) / pooled["n_total"]) if pooled["n_total"] else 0.0,
        # Precision depends on the sample rate (more samples → smaller steps),
        # so the rate is reported next to it.
        "sample_rate_hz": sample_rate,
    })
    return out


def _merge_pooled(items: list) -> dict:
    return {
        "err": [a for p in items for a in p["err"]],
        "s2s": [a for p in items for a in p["s2s"]],
        "bias": [a for p in items for a in p["bias"]],
        "n_total": sum(p["n_total"] for p in items),
    }


# ── routes ─────────────────────────────────────────────────────────────────

class BlocksSaveRequest(BaseModel):
    blocks: list[dict]


class FreePointsSaveRequest(BaseModel):
    points: list[dict]


class ValidationRunRequest(BaseModel):
    window_ms: float = 800.0       # analysis window per mark
    window_mode: str = "after"     # "after" the mark, or "centered" on it
    outlier_deg: float = 5.0       # samples further than this from the target are dropped
    track_scene: bool = True       # clicked targets: carry them along with the paper surface


@router.get("")
async def get_validation(recording_id: str):
    """Everything the marking UI needs: saved marks, suggested sheet blocks from the
    events, the sheet's target layout, and the two videos' time offset."""
    rec = await _get_recording(recording_id)
    folder_path = rec["folder_path"]
    doc = _read_doc(folder_path)
    targets, source = _sheet_targets(rec)
    # Saved blocks win; event-derived ones the user has not started are appended.
    saved = {b["id"] for b in doc["blocks"]}
    suggested = [{**b, "marks": []} for b in _suggested_blocks(rec) if b["id"] not in saved]
    return {
        "blocks": doc["blocks"] + suggested,
        "free_points": doc["free_points"],
        "sheet": {"targets": targets, "source": source},
        "timeline": video_timeline(rec),
    }


@router.post("/blocks")
async def save_blocks(recording_id: str, req: BlocksSaveRequest):
    """Save the metric-sheet blocks. Each mark's video position is turned into the
    absolute timestamp of the scene frame shown there."""
    rec = await _get_recording(recording_id)
    blocks = []
    for b in req.blocks:
        marks = []
        for m in b.get("marks") or []:
            ts = _scene_abs_ns(rec, float(m["video_s"]))
            if ts is None:
                raise HTTPException(status_code=400, detail="This recording has no timestamps to place marks on")
            marks.append({"target_id": int(m["target_id"]), "video_s": float(m["video_s"]), "timestamp_ns": ts})
        marks.sort(key=lambda m: m["target_id"])
        blocks.append({
            "id": str(b["id"]), "label": str(b.get("label") or b["id"]),
            "start_s": b.get("start_s"), "end_s": b.get("end_s"), "marks": marks,
        })
    doc = _read_doc(rec["folder_path"])
    # Blocks without marks are not stored — they come back from the events anyway.
    doc["blocks"] = [b for b in blocks if b["marks"]]
    _write_doc(rec["folder_path"], doc)
    return {"saved": sum(len(b["marks"]) for b in doc["blocks"])}


@router.post("/free")
async def save_free_points(recording_id: str, req: FreePointsSaveRequest):
    rec = await _get_recording(recording_id)
    doc = _read_doc(rec["folder_path"])
    doc["free_points"] = req.points
    _write_doc(rec["folder_path"], doc)
    return {"saved": len(req.points)}


@router.delete("/free")
async def delete_free_points(recording_id: str):
    rec = await _get_recording(recording_id)
    doc = _read_doc(rec["folder_path"])
    doc["free_points"] = []
    _write_doc(rec["folder_path"], doc)
    return {"ok": True}


@router.delete("")
async def delete_validation(recording_id: str):
    rec = await _get_recording(recording_id)
    root = _root(rec["folder_path"])
    removed = []
    for name in (_POINTS_FILE, _RESULT_FILE):
        f = root / name
        if f.exists():
            f.unlink()
            removed.append(name)
    return {"removed": removed}


@router.get("/overlay")
async def get_overlay(recording_id: str, start_s: float, end_s: float):
    """The sheet targets in every scene frame of [start_s, end_s], in RAW scene px,
    for drawing over the video while marking. ``null`` where the surface is not
    localised."""
    rec = await _get_recording(recording_id)
    folder_path = rec["folder_path"]
    homs = _scene_homographies(folder_path)
    if homs is None or not rec.get("scene_video"):
        return {"t_s": [], "pos": []}
    scene_ts, H = homs
    ts = _load_scene_timestamps(rec["scene_video"])
    if not ts.size:
        return {"t_s": [], "pos": []}
    targets, _ = _sheet_targets(rec)
    paper = np.array([[t["x"], t["y"], 1.0] for t in targets]).T   # 3×25
    rel = (ts - ts[0]) / 1e9
    a, b = np.searchsorted(rel, max(0.0, start_s), "left"), np.searchsorted(rel, end_s, "right")
    t_out, pos_out = [], []
    for i in range(a, min(b, len(ts))):
        H_s = H.get(_nearest_frame(scene_ts, int(ts[i])))
        t_out.append(round(float(rel[i]), 4))
        if H_s is None:
            pos_out.append(None)
            continue
        try:
            q = np.linalg.solve(H_s, paper)
        except np.linalg.LinAlgError:
            pos_out.append(None)
            continue
        raw = distort_points(folder_path, (q[:2] / q[2]).T)
        pos_out.append(np.round(raw, 1).tolist())
    return {"t_s": t_out, "pos": pos_out}


@router.get("/result")
async def get_validation_result(recording_id: str):
    rec = await _get_recording(recording_id)
    f = _root(rec["folder_path"]) / _RESULT_FILE
    if not f.exists():
        return None
    return json.loads(f.read_text())


@router.post("/run")
async def run_validation(recording_id: str, req: ValidationRunRequest):
    rec = await _get_recording(recording_id)
    folder_path = rec["folder_path"]
    doc = _read_doc(folder_path)
    blocks = [b for b in doc["blocks"] if b.get("marks")]
    free = doc["free_points"]
    if not blocks and not free:
        raise HTTPException(status_code=400, detail="Mark validation targets first")
    if req.window_ms <= 0 or req.outlier_deg <= 0:
        raise HTTPException(status_code=400, detail="Window and outlier threshold must be positive")
    if req.window_mode not in ("after", "centered"):
        raise HTTPException(status_code=400, detail="window_mode must be 'after' or 'centered'")

    available = _available_sources(folder_path)
    inputs = {}
    for s in _VALIDATED_SOURCES:
        if s not in available:
            continue
        got = _source_samples(folder_path, s)
        if got is not None and len(got[0]) > 0:
            inputs[s] = got
    if not inputs:
        raise HTTPException(status_code=400, detail="No gaze to validate — run gaze mapping first")

    homs = _scene_homographies(folder_path)
    if blocks and homs is None:
        raise HTTPException(
            status_code=400,
            detail="Metric-sheet validation needs the surface geometry — define the AoI surface and run gaze mapping first.",
        )

    targets, targets_source = _sheet_targets(rec)
    target_xy = {t["target_id"]: (t["x"], t["y"]) for t in targets}

    t0 = _timeline_t0(folder_path)
    if t0 is None:
        t0 = int(min(int(v[0][0]) for v in inputs.values()))
    scene_ts = _load_scene_timestamps(rec["scene_video"]) if rec.get("scene_video") else np.array([], dtype=np.int64)
    calib_marks = []
    calib_file = _root(folder_path) / "calibration_points.json"
    if calib_file.exists():
        try:
            calib_marks = [mark_abs_ns(scene_ts, t0, c) for c in json.loads(calib_file.read_text())]
        except (json.JSONDecodeError, OSError, KeyError, TypeError, ValueError):
            calib_marks = []

    K = _camera_matrix(folder_path)
    K_inv = np.linalg.inv(K)
    win_ns = int(req.window_ms * 1e6)

    def sheet_target(info, t_mark, sample_ts):
        return _paper_to_scene(homs, target_xy[info["target_id"]], sample_ts)

    free_homs = homs if req.track_scene else None

    def free_target(info, t_mark, sample_ts):
        und = undistort_points(folder_path, [(info["target_x"], info["target_y"])])[0].astype(np.float64)
        static = np.repeat(und[None, :], len(sample_ts), axis=0)
        if free_homs is None:
            return static
        # Carried along with the paper where both frames see it, else left in place.
        paper = _scene_to_paper(free_homs, und, t_mark)
        if paper is None:
            return static
        moved = _paper_to_scene(free_homs, paper, sample_ts)
        return np.where(np.isnan(moved), static, moved)

    sources = {}
    for s, (ts, xy, desc) in inputs.items():
        order = np.argsort(ts)
        ts, xy = ts[order], xy[order]
        dt = np.diff(ts)
        rate = float(1e9 / np.median(dt[dt > 0])) if (dt > 0).any() else None

        out_blocks, sheet_pooled = [], []
        for b in blocks:
            marks = [({"target_id": m["target_id"],
                       "paper_x": target_xy[m["target_id"]][0], "paper_y": target_xy[m["target_id"]][1]},
                      int(m["timestamp_ns"]))
                     for m in b["marks"] if m["target_id"] in target_xy]
            rows, pooled = _measure(folder_path, K_inv, ts, xy, marks, win_ns, req.window_mode,
                                    req.outlier_deg, sheet_target)
            sheet_pooled.append(pooled)
            out_blocks.append({"id": b["id"], "label": b.get("label", b["id"]), "kind": "sheet",
                               "summary": _summary(rows, pooled, K, rate), "points": rows})
        if free:
            marks = []
            for p in free:
                t_mark = mark_abs_ns(scene_ts, t0, p)
                info = {"target_id": p["point_id"], "target_x": p["gaze_x"], "target_y": p["gaze_y"],
                        # Validation measured on a calibration point's own fixation is
                        # not independent of the fit — flagged so it can be re-marked.
                        "overlaps_calibration": s == "own" and any(abs(c - t_mark) < win_ns for c in calib_marks)}
                marks.append((info, t_mark))
            rows, pooled = _measure(folder_path, K_inv, ts, xy, marks, win_ns, req.window_mode,
                                    req.outlier_deg, free_target)
            out_blocks.append({"id": FREE_BLOCK, "label": "Clicked targets", "kind": "free",
                               "summary": _summary(rows, pooled, K, rate), "points": rows})

        overall = None
        if len(sheet_pooled) > 1:
            all_rows = [r for blk in out_blocks if blk["kind"] == "sheet" for r in blk["points"]]
            overall = _summary(all_rows, _merge_pooled(sheet_pooled), K, rate)
        sources[s] = {"label": _SOURCE_LABELS[s], "input": desc, "blocks": out_blocks, "sheets_overall": overall}

    result = {
        "window_ms": req.window_ms,
        "window_mode": req.window_mode,
        "outlier_deg": req.outlier_deg,
        "track_scene": req.track_scene,
        "intrinsics": "calibration.bin" if scene_intrinsics(folder_path) is not None else "fallback",
        "sheet_targets_source": targets_source,
        "sources": sources,
    }
    (_root(folder_path) / _RESULT_FILE).write_text(json.dumps(result, indent=2))
    return result
