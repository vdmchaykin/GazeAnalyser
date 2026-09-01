import base64
import csv
import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.database import get_db
from app.services.recording_service import RECORDINGS_DIR
from app.paths import PROJECTS_DIR

try:
    import pupil_apriltags as apriltag
    _APRILTAG_AVAILABLE = True
except ImportError:
    _APRILTAG_AVAILABLE = False

router = APIRouter(prefix="/api/recordings/{recording_id}/aoi", tags=["aoi"])

# A4 at 96 dpi
OUTPUT_W, OUTPUT_H = 794, 1123

_SEGMENT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
# Project ids are uuid4 strings; the pattern is a path-traversal guard.
_PROJECT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


# ─── Scene camera intrinsics (lens distortion) ────────────────────────────────
# The scene camera is a wide-angle lens: straight lines bow, and AprilTag corners
# detected in the raw frame do NOT lie on a projective image of the paper plane. A
# homography fitted to those corners is therefore exact only at the corners and
# wrong in between — measured on these recordings: ~8 px median, up to 45 px on the
# A4 render, always zero at the tags and bulging in the middle.
#
# Every Neon recording ships the factory lens calibration, so the fix is to work in
# ideal pinhole coordinates: undistort tag corners and gaze before fitting/using the
# homography. Points that must stay drawable on the raw video (surface_positions.csv
# corners, the gaze the player overlays) are distorted back.

_CALIB_DTYPE = np.dtype([
    ("version", "u1"), ("serial", "S6"),
    ("scene_camera_matrix", "(3,3)d"), ("scene_distortion_coefficients", "(8,)d"),
    ("scene_extrinsics_affine_matrix", "(4,4)d"),
    ("right_camera_matrix", "(3,3)d"), ("right_distortion_coefficients", "(8,)d"),
    ("right_extrinsics_affine_matrix", "(4,4)d"),
    ("left_camera_matrix", "(3,3)d"), ("left_distortion_coefficients", "(8,)d"),
    ("left_extrinsics_affine_matrix", "(4,4)d"), ("crc", "u4"),
])

_intrinsics_cache: dict = {}


def scene_intrinsics(folder_path: Optional[str]):
    """``(K, D)`` of the scene camera from the recording's ``calibration.bin``.

    Returns None when the file is absent or unreadable — every caller then falls
    back to treating the raw pixels as ideal, i.e. the previous behaviour."""
    if not folder_path:
        return None
    key = str(folder_path)
    if key in _intrinsics_cache:
        return _intrinsics_cache[key]
    result = None
    try:
        path = next(Path(folder_path).glob("**/calibration.bin"))
        cal = np.fromfile(str(path), dtype=_CALIB_DTYPE)[0]
        K = np.array(cal["scene_camera_matrix"], dtype=np.float64)
        D = np.array(cal["scene_distortion_coefficients"], dtype=np.float64)
        if np.isfinite(K).all() and np.isfinite(D).all() and 200 < K[0, 0] < 5000:
            result = (K, D)
    except (StopIteration, OSError, ValueError, IndexError):
        result = None
    _intrinsics_cache[key] = result
    return result


def undistort_points(folder_path: Optional[str], pts) -> np.ndarray:
    """Raw sensor pixels → ideal pinhole pixels (same camera matrix)."""
    arr = np.asarray(pts, dtype=np.float32).reshape(-1, 1, 2)
    kd = scene_intrinsics(folder_path)
    if kd is None:
        return arr.reshape(-1, 2)
    K, D = kd
    return cv2.undistortPoints(arr, K, D, P=K).reshape(-1, 2)


def distort_points(folder_path: Optional[str], pts) -> np.ndarray:
    """Ideal pinhole pixels → raw sensor pixels (inverse of :func:`undistort_points`)."""
    arr = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    kd = scene_intrinsics(folder_path)
    if kd is None:
        return arr
    K, D = kd
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
    k1, k2, p1, p2, k3, k4, k5, k6 = D[:8]
    x = (arr[:, 0] - cx) / fx
    y = (arr[:, 1] - cy) / fy
    r2 = x * x + y * y
    radial = (1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3) / (1 + k4 * r2 + k5 * r2 ** 2 + k6 * r2 ** 3)
    xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
    yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
    return np.stack([xd * fx + cx, yd * fy + cy], axis=1)


def _undistort_tags(folder_path: Optional[str], tags: List["TagInfo"]) -> List["TagInfo"]:
    """Tags detected in a scene frame, expressed in ideal pinhole pixels."""
    if scene_intrinsics(folder_path) is None:
        return tags
    out = []
    for t in tags:
        pts = undistort_points(folder_path, np.vstack([np.array(t.corners, dtype=np.float32),
                                                       np.array([t.center], dtype=np.float32)]))
        out.append(TagInfo(tag_id=t.tag_id, center=pts[4].tolist(), corners=pts[:4].tolist()))
    return out


def _tags_from_detections(folder_path: Optional[str], detections) -> List["TagInfo"]:
    """Detector output → TagInfo in ideal pinhole pixels."""
    return _undistort_tags(folder_path, [
        TagInfo(tag_id=int(d.tag_id), center=[float(d.center[0]), float(d.center[1])],
                corners=np.asarray(d.corners, dtype=np.float32).tolist())
        for d in detections
    ])


async def _get_recording(recording_id: str) -> dict:
    """The recording row, plus the project whose shared AoI applies to it.

    The schema allows several memberships, but the workflow assumes one paper per
    project and one project per recording, so the first membership is the one that
    counts. Carrying it on the row lets every sync helper below resolve the shared
    annotation without a database round-trip of its own."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM recordings WHERE id = ?", (recording_id,))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recording not found")
        cur = await db.execute(
            "SELECT project_id FROM project_recordings WHERE recording_id = ? "
            "ORDER BY rowid LIMIT 1",
            (recording_id,),
        )
        member = await cur.fetchone()
    finally:
        await db.close()
    rec = dict(row)
    rec["project_id"] = member["project_id"] if member else None
    return rec


async def _project_recordings(project_id: str) -> List[dict]:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT r.* FROM recordings r JOIN project_recordings pr ON r.id = pr.recording_id "
            "WHERE pr.project_id = ?",
            (project_id,),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()
    return [dict(r) for r in rows]


async def _require_project(project_id: str) -> dict:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return dict(row)


def _aoi_dir(folder_path: str) -> Path:
    d = Path(folder_path) / "aoi"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── project-level AoI ──────────────────────────────────────────────────────
# Every recording in a project looks at the same printed page, so the annotation
# describes the PROJECT, not each recording: the areas (already in normalized page
# coordinates), the warped background, and the marker registry are all properties
# of the paper. What stays with a recording is only what its own video produced —
# the reference frame, surface_positions.csv, the gaze projections.
#
# A recording may still hold a state file of its own, and that OVERRIDES the
# project's — which is what a session shot with a different printout needs. States
# written before projects existed are exactly such overrides, so they keep working
# untouched until the user drops them.



def _project_aoi_dir(project_id: str) -> Path:
    if not _PROJECT_ID_RE.match(project_id):
        raise HTTPException(status_code=400, detail="Invalid project id")
    d = PROJECTS_DIR / project_id / "aoi"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _aoi_dirs(rec: dict) -> List[Path]:
    """Where this recording's AoI state is looked up, in precedence order."""
    dirs = [_aoi_dir(rec["folder_path"])]
    pid = rec.get("project_id")
    if pid:
        dirs.append(_project_aoi_dir(pid))
    return dirs


# ── gaze source ────────────────────────────────────────────────────────────
# A recording can be analysed from three sources. Each keeps its own copy of the
# derived files in a leaf directory, so switching never overwrites another
# source's results and the pipelines stay comparable side by side:
#   own           our pupil detection + calibration + our I-DT fixations
#   cloud         Pupil Cloud's gaze (csv/gaze.csv) + our I-DT fixations
#   cloud_native  Pupil Cloud's gaze + Pupil Cloud's fixations (csv/fixations.csv)
# Filenames inside a leaf are identical across sources, so everything downstream
# only ever needs the right directory.
GAZE_SOURCES = ("own", "cloud", "cloud_native")
_SOURCE_SUBDIR = {"own": "", "cloud": "cloud", "cloud_native": "cloud_native"}
# The two cloud sources share one gaze projection — mapping writes it to both.
CLOUD_SOURCES = ("cloud", "cloud_native")


def check_source(source: str) -> str:
    if source not in _SOURCE_SUBDIR:
        raise HTTPException(status_code=400, detail=f"Unknown gaze source '{source}'")
    return source


def _gaze_dir(folder_path: str, source: str = "own") -> Path:
    d = Path(folder_path) / "gaze_analysis" / _SOURCE_SUBDIR[check_source(source)]
    d.mkdir(parents=True, exist_ok=True)
    return d


def _source_file(folder_path: str) -> Path:
    """Where the recording's selected source lives (shared by all sources)."""
    return Path(folder_path) / "gaze_analysis" / "source.json"


def read_source(folder_path: str) -> str:
    """The recording's persisted gaze source, defaulting to our own pipeline."""
    f = _source_file(folder_path)
    if f.exists():
        try:
            s = json.loads(f.read_text()).get("source")
        except (json.JSONDecodeError, OSError):
            s = None
        if s in _SOURCE_SUBDIR:
            return s
    return "own"


def write_source(folder_path: str, source: str) -> str:
    check_source(source)
    p = _source_file(folder_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"source": source}))
    return source


def active_source(folder_path: str, override: Optional[str] = None) -> str:
    """Which source a request works on: the explicit one, else the persisted one.

    Everything downstream of the Gaze section (AoI metrics, export, player) reads
    the persisted value, so it follows the selector without threading it through."""
    return check_source(override) if override else read_source(folder_path)


def _upload_source_path(adir: Path, segment_id: str) -> Path:
    """Per-segment raw reference image. Each segment keeps its own upload source so
    re-warping one segment never reads another segment's image."""
    if not _SEGMENT_ID_RE.match(segment_id):
        raise HTTPException(status_code=400, detail="Invalid segment id")
    return adir / f"upload_source_{segment_id}.jpg"


# Per-frame scene→paper homographies cached by gaze mapping so the gaze offset
# correction can re-project without another AprilTag pass. Tied to the surface
# definition, so it dies with it.
FRAME_HOMOGRAPHY_CACHE = "frame_homographies.npz"

# Stamped into surface.json; bumped whenever the surface geometry changes meaning.
SURFACE_GEOMETRY = "undistorted/1"


def _invalidate_surface(adir: Path) -> None:
    """Delete a stale surface_positions.csv (and its cached definition).

    The surface definition changes whenever the user re-detects/re-saves tags, so
    any previously generated positions no longer match and must be regenerated."""
    for name in ("surface_positions.csv", "surface.json", FRAME_HOMOGRAPHY_CACHE):
        p = adir / name
        if p.exists():
            p.unlink()


def _sort_tl_tr_br_bl(pts: np.ndarray) -> np.ndarray:
    """Sort 4 points into [TL, TR, BR, BL] order using coordinate sums/diffs."""
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()
    return np.array([
        pts[np.argmin(s)],   # TL: smallest x+y
        pts[np.argmin(d)],   # TR: smallest x-y (large x, small y)
        pts[np.argmax(s)],   # BR: largest x+y
        pts[np.argmax(d)],   # BL: largest x-y (small x, large y)
    ], dtype=np.float32)


def _outer_corner(corners: np.ndarray, paper_center: np.ndarray) -> np.ndarray:
    """Return the tag corner that is farthest from the paper center."""
    dists = np.linalg.norm(corners - paper_center, axis=1)
    return corners[np.argmax(dists)].astype(np.float32)


class DetectFrameRequest(BaseModel):
    timestamp_s: float


class DetectImageRequest(BaseModel):
    image_b64: str
    segment_id: str = "general"


class TagInfo(BaseModel):
    tag_id: int
    center: List[float]
    corners: List[List[float]]


class AoiStateBody(BaseModel):
    areas: List[Any] = []
    reference_timestamp_s: Optional[float] = None
    warped_image_b64: Optional[str] = None          # active background (video or reference)
    video_warped_image_b64: Optional[str] = None    # baseline warp from the video frame
    reference_image_b64: Optional[str] = None        # warp from an uploaded reference image
    using_reference: bool = False                    # whether the reference image is active
    tag_count: Optional[int] = None
    selected_tags: Optional[List[TagInfo]] = None    # tags defining the surface (for surface_positions.csv)
    # {tag_id: [[u,v]×4]} in normalized page coords, derived from selected_tags at
    # save time. Stored because a shared annotation is used by recordings whose
    # frames never saw these tags — see _build_registry.
    markers: Optional[dict] = None


class CustomSegment(BaseModel):
    id: str
    label: str


class SegmentsManifest(BaseModel):
    custom_segments: List[CustomSegment] = []


def _detect_and_warp(frame: np.ndarray, timestamp_s: float,
                     folder_path: Optional[str] = None) -> dict:
    """Run AprilTag detection on a BGR frame and auto-warp using all detected tags.

    Shared by the video-frame and uploaded-image entry points so both return the
    exact same payload shape. The auto-warp here is only a first preview — the
    frontend recomputes it via /warp-from-selection whenever tags are toggled.

    `folder_path` is set only for scene-video frames, whose lens distortion is
    corrected before warping; an uploaded reference image is a flat scan/render
    with no distortion of ours to undo. Tag coordinates are reported RAW either
    way — the frontend draws them on the frame it was given.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    with TagDetector() as detector:
        detections = detector.detect(gray)

    annotated = frame.copy()
    tag_infos = []
    warp_tags = []
    for i, det in enumerate(detections):
        corners = det.corners.astype(int)
        cv2.polylines(annotated, [corners.reshape(-1, 1, 2)], True, (0, 220, 70), 2)
        cx, cy = int(det.center[0]), int(det.center[1])
        cv2.circle(annotated, (cx, cy), 6, (0, 220, 70), -1)
        cv2.putText(
            annotated, f"ID:{det.tag_id}",
            (cx - 15, cy - 14),
            cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 220, 70), 2,
        )
        tag_infos.append({
            "index": i,
            "tag_id": int(det.tag_id),
            "center": [float(det.center[0]), float(det.center[1])],
            "corners": det.corners.tolist(),
        })
        warp_tags.append(TagInfo(
            tag_id=int(det.tag_id),
            center=[float(det.center[0]), float(det.center[1])],
            corners=det.corners.tolist(),
        ))

    warped_b64 = _warp_frame(frame, warp_tags, folder_path) if len(warp_tags) >= 3 else None

    _, ann_buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
    frame_b64 = base64.b64encode(ann_buf).decode()

    return {
        "tag_count": len(detections),
        "tags": tag_infos,
        "frame_b64": frame_b64,
        "warped_image_b64": warped_b64,
        "timestamp_s": timestamp_s,
        "success": warped_b64 is not None,
        "frame_width": frame.shape[1],
        "frame_height": frame.shape[0],
    }


@router.post("/detect-frame")
async def detect_frame(recording_id: str, req: DetectFrameRequest):
    if not _APRILTAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="pupil-apriltags not installed")

    rec = await _get_recording(recording_id)
    video_path = rec.get("scene_video")
    if not video_path or not Path(video_path).exists():
        raise HTTPException(status_code=404, detail="Scene video not found")

    cap = cv2.VideoCapture(video_path)
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, req.timestamp_s * 1000)
        ok, frame = cap.read()
        if not ok:
            raise HTTPException(status_code=400, detail="Could not read frame at given timestamp")
    finally:
        cap.release()

    return _detect_and_warp(frame, req.timestamp_s, rec["folder_path"])


@router.post("/detect-image")
async def detect_image(recording_id: str, req: DetectImageRequest):
    """Detect AprilTags on a user-uploaded reference image (base64-encoded).

    The raw image is cached at aoi/upload_source.jpg so /warp-from-selection can
    re-warp it when the user toggles tags, without re-uploading the file."""
    if not _APRILTAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="pupil-apriltags not installed")

    rec = await _get_recording(recording_id)

    raw = req.image_b64.split(",", 1)[-1]  # tolerate a data-URI prefix
    try:
        img_bytes = base64.b64decode(raw)
        buf = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except Exception:
        frame = None
    if frame is None:
        raise HTTPException(status_code=400, detail="Could not decode uploaded image")

    adir = _aoi_dir(rec["folder_path"])
    cv2.imwrite(str(_upload_source_path(adir, req.segment_id)), frame)

    # timestamp_s = -1 signals an uploaded source rather than a video position
    return _detect_and_warp(frame, -1.0)


@router.get("/state")
async def get_state(recording_id: str):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    state_file = adir / "state.json"
    if not state_file.exists():
        return {"areas": [], "reference_timestamp_s": None, "warped_image_b64": None, "tag_count": None}
    return json.loads(state_file.read_text())


@router.post("/state")
async def save_state(recording_id: str, body: AoiStateBody):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    state_file = adir / "state.json"
    state_file.write_text(json.dumps(body.model_dump()))
    _invalidate_surface(adir)
    _invalidate_aoi_metrics(adir)
    return {"ok": True}


@router.get("/segments")
async def get_segments(recording_id: str):
    """Custom (non-event) segments this recording shows — its own plus its project's."""
    rec = await _get_recording(recording_id)
    seen, merged = set(), []
    for d in _aoi_dirs(rec):
        path = d / "segments.json"
        if not path.exists():
            continue
        for seg in json.loads(path.read_text()).get("custom_segments", []):
            if seg.get("id") not in seen:
                seen.add(seg.get("id"))
                merged.append(seg)
    return {"custom_segments": merged}


@router.post("/segments")
async def save_segments(recording_id: str, body: SegmentsManifest):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    (adir / "segments.json").write_text(json.dumps(body.model_dump()))
    return {"ok": True}


# ─── Per-segment state endpoints ─────────────────────────────────────────────

def _check_segment_id(segment_id: str) -> str:
    if not _SEGMENT_ID_RE.match(segment_id):
        raise HTTPException(status_code=400, detail="Invalid segment id")
    return segment_id


EMPTY_STATE = {
    "areas": [], "reference_timestamp_s": None, "warped_image_b64": None, "tag_count": None,
}


def _state_markers(rec: dict, body: AoiStateBody, previous: dict) -> Optional[dict]:
    """The registry to store with a state being saved, given the recording whose
    frame the tags were detected in.

    A registry the client carried over from the state it loaded WINS over deriving
    one here. That state's tags may have been detected in another recording's frame
    — a recording overriding its project's annotation is exactly that case — and
    re-deriving them against this recording's frame size and lens calibration would
    deform the page. The editor clears `markers` whenever it picks tags anew, which
    is precisely when a fresh derivation is the right answer.

    Failing both, the registry already on disk is kept: an area-only save carries no
    tags and must not drop the surface definition."""
    if body.markers:
        return body.markers
    tags = list(body.selected_tags or [])
    scene_video = rec.get("scene_video")
    if len(tags) >= 3 and scene_video and Path(scene_video).exists():
        cap = cv2.VideoCapture(scene_video)
        try:
            frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        finally:
            cap.release()
        registry = _build_surface_registry(tags, frame_w, frame_h, rec["folder_path"])
        if registry:
            return registry
    return previous.get("markers")


@router.get("/{segment_id}/state")
async def get_segment_state(recording_id: str, segment_id: str):
    """The AoI state in force for this recording: its own override, else its
    project's shared annotation. ``scope`` says which one came back."""
    _check_segment_id(segment_id)
    rec = await _get_recording(recording_id)
    state, scope = _resolve_state_scope(rec, segment_id)
    return {**(state or EMPTY_STATE), "scope": scope, "project_id": rec.get("project_id")}


@router.post("/{segment_id}/state")
async def save_segment_state(recording_id: str, segment_id: str, body: AoiStateBody):
    """Annotate this recording alone, overriding whatever its project defines."""
    _check_segment_id(segment_id)
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    # Resolved, not just this recording's own: overriding an annotation inherited
    # from the project keeps that annotation's registry unless new tags were picked.
    previous, _ = _resolve_state_scope(rec, segment_id)
    state = {**body.model_dump(), "markers": _state_markers(rec, body, previous)}
    (adir / f"{segment_id}.json").write_text(json.dumps(state))
    _invalidate_surface(adir)
    _invalidate_aoi_metrics(adir)
    return {"ok": True, "scope": "recording"}


@router.delete("/{segment_id}/state")
async def clear_segment_state(recording_id: str, segment_id: str):
    """Drop this recording's override so it follows its project's annotation again."""
    _check_segment_id(segment_id)
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    removed = False
    for name in (f"{segment_id}.json", "state.json" if segment_id == "general" else None):
        if name and (adir / name).exists():
            (adir / name).unlink()
            removed = True
    if removed:
        _invalidate_surface(adir)
        _invalidate_aoi_metrics(adir)
    _, scope = _resolve_state_scope(rec, segment_id)
    return {"removed": removed, "scope": scope}


# ─── Project-level AoI ───────────────────────────────────────────────────────
# The annotation the whole project shares. Recordings read it through
# _resolve_state_scope; anything a recording saves for itself wins over it.

project_router = APIRouter(prefix="/api/projects/{project_id}/aoi", tags=["aoi"])


class ProjectAoiStateBody(AoiStateBody):
    # Which recording's frame the tags and the background came from. Needed to turn
    # `selected_tags` (in that recording's scene pixels, with that recording's lens
    # distortion) into the page-normalized registry every other recording will use.
    source_recording_id: Optional[str] = None


async def _invalidate_project_recordings(
    project_id: str, segment_id: str, except_ids: Optional[List[str]] = None,
) -> List[str]:
    """Drop derived files of every recording the changed shared segment reaches.

    A recording that annotates this segment itself is untouched — its surface and
    metrics were built from its own state and are still valid. Regenerating
    surface_positions.csv costs a full video pass, so it is only thrown away for
    recordings the change actually applies to."""
    affected = []
    for rec in await _project_recordings(project_id):
        if except_ids and rec["id"] in except_ids:
            continue
        adir = _aoi_dir(rec["folder_path"])
        if _has_override(adir, segment_id):
            continue
        _invalidate_surface(adir)
        _invalidate_aoi_metrics(adir)
        affected.append(rec["id"])
    return affected


@project_router.get("/segments")
async def get_project_segments(project_id: str):
    await _require_project(project_id)
    pdir = _project_aoi_dir(project_id)
    path = pdir / "segments.json"
    manifest = json.loads(path.read_text()) if path.exists() else {"custom_segments": []}
    return {**manifest, "annotated": _list_aoi_segments(pdir)}


@project_router.post("/segments")
async def save_project_segments(project_id: str, body: SegmentsManifest):
    await _require_project(project_id)
    (_project_aoi_dir(project_id) / "segments.json").write_text(json.dumps(body.model_dump()))
    return {"ok": True}


@project_router.get("/overrides")
async def get_project_overrides(project_id: str):
    """Which recordings annotate segments themselves instead of following the project.

    The AoI editor shows these so a recording that silently ignores the shared
    annotation is visible, and can be put back on it."""
    await _require_project(project_id)
    pdir = _project_aoi_dir(project_id)
    segments = _list_aoi_segments(pdir)
    out = []
    for rec in await _project_recordings(project_id):
        adir = _aoi_dir(rec["folder_path"])
        own = _list_aoi_segments(adir)
        if own:
            out.append({
                "recording_id": rec["id"],
                "name": rec.get("name"),
                "wearer_name": rec.get("wearer_name"),
                "segments": own,
                # Segments where the override actually shadows a shared annotation.
                "shadowing": [sid for sid in own if sid in segments],
            })
    return {"project_segments": segments, "overrides": out}


@project_router.get("/{segment_id}/state")
async def get_project_state(project_id: str, segment_id: str):
    _check_segment_id(segment_id)
    await _require_project(project_id)
    state = _load_segment_state(_project_aoi_dir(project_id), segment_id)
    return {**(state or EMPTY_STATE), "scope": "project" if state else "none"}


@project_router.post("/{segment_id}/state")
async def save_project_state(project_id: str, segment_id: str, body: ProjectAoiStateBody):
    """Annotate the segment once for every recording in the project."""
    _check_segment_id(segment_id)
    await _require_project(project_id)
    pdir = _project_aoi_dir(project_id)
    previous = _load_segment_state(pdir, segment_id)

    source = await _get_recording(body.source_recording_id) if body.source_recording_id else None
    markers = _state_markers(source, body, previous) if source else (
        body.markers or previous.get("markers"))
    if body.selected_tags and not markers:
        raise HTTPException(
            status_code=400,
            detail="Could not derive the surface from those tags. Re-detect them on a "
                   "frame where at least 3 markers are visible.",
        )

    state = {
        **body.model_dump(exclude={"source_recording_id"}),
        "markers": markers,
        "source_recording_id": body.source_recording_id or previous.get("source_recording_id"),
    }
    (pdir / f"{segment_id}.json").write_text(json.dumps(state))
    affected = await _invalidate_project_recordings(project_id, segment_id)
    return {"ok": True, "scope": "project", "invalidated": affected}


@project_router.delete("/{segment_id}/state")
async def clear_project_state(project_id: str, segment_id: str):
    _check_segment_id(segment_id)
    await _require_project(project_id)
    path = _project_aoi_dir(project_id) / f"{segment_id}.json"
    removed = path.exists()
    if removed:
        path.unlink()
        await _invalidate_project_recordings(project_id, segment_id)
    return {"removed": removed}


class SeedProjectRequest(BaseModel):
    recording_id: str
    segment_ids: Optional[List[str]] = None   # default: everything that recording has
    clear_source_override: bool = False


@project_router.post("/seed")
async def seed_project_from_recording(project_id: str, body: SeedProjectRequest):
    """Promote one recording's existing annotation to the whole project.

    The migration path for work done before the annotation was shared: the states
    already carry page-normalized areas, and their registry is derived here from the
    tags with that recording's own frame and calibration — exactly as it was drawn."""
    await _require_project(project_id)
    rec = await _get_recording(body.recording_id)
    adir = _aoi_dir(rec["folder_path"])
    pdir = _project_aoi_dir(project_id)

    seeded, skipped = [], []
    for sid in (body.segment_ids or _list_aoi_segments(adir)):
        _check_segment_id(sid)
        state = _load_segment_state(adir, sid)
        if not state:
            continue
        markers = state.get("markers")
        if not markers:
            tags = state.get("selected_tags") or []
            if len(tags) >= 3:
                markers = _state_markers(
                    rec, AoiStateBody(selected_tags=[TagInfo(**t) for t in tags]), {},
                )
        if not markers:
            # Without a registry the shared state cannot be localized in any other
            # recording, so it is left behind rather than published half-working.
            skipped.append(sid)
            continue
        (pdir / f"{sid}.json").write_text(json.dumps({
            **state, "markers": markers, "source_recording_id": body.recording_id,
        }))
        seeded.append(sid)
        if body.clear_source_override:
            (adir / f"{sid}.json").unlink(missing_ok=True)
            if sid == "general":
                (adir / "state.json").unlink(missing_ok=True)

    for sid in seeded:
        await _invalidate_project_recordings(project_id, sid, except_ids=[body.recording_id])
    return {"seeded": seeded, "skipped": skipped}


# ─── Warp from manually selected tags ────────────────────────────────────────

class WarpSelectionRequest(BaseModel):
    timestamp_s: float
    selected_tags: List[TagInfo]
    source: str = "video"  # "video" reads the scene frame; "upload" reads the segment's upload source
    segment_id: str = "general"


def _surface_corners_from_tags(
    tags: List[TagInfo], frame_w: int, frame_h: int
) -> Optional[np.ndarray]:
    """Estimate the 4 outer paper corners [TL, TR, BR, BL] (in scene px) from tags.

    Uses each tag's outer corner (farthest from the paper centre) rather than its
    centre for accuracy. With 3 tags the missing 4th corner is estimated via a
    parallelogram. Returns a (4, 2) float32 array or None if fewer than 3 tags.
    """
    n = len(tags)
    if n < 3:
        return None

    centers = np.array([[t.center[0], t.center[1]] for t in tags[:4]], dtype=np.float32)

    if n >= 4:
        sorted_centers = _sort_tl_tr_br_bl(centers)
        paper_center = centers.mean(axis=0)
        src_pts = []
        for c in sorted_centers:
            dists = np.linalg.norm(centers - c, axis=1)
            t = tags[int(np.argmin(dists))]
            outer = _outer_corner(np.array(t.corners, dtype=np.float32), paper_center)
            src_pts.append(outer)
    else:
        # 3-tag case: estimate 4th corner via parallelogram
        s = centers.sum(axis=1)
        tl = centers[np.argmin(s)]
        br_est = centers[np.argmax(s)]
        remaining = [i for i in range(3) if i != int(np.argmin(s)) and i != int(np.argmax(s))]
        other = centers[remaining[0]]
        d_tr = np.linalg.norm(other - np.array([frame_w, 0]))
        d_bl = np.linalg.norm(other - np.array([0, frame_h]))
        tr, bl = (other, tl + br_est - other) if d_tr < d_bl else (tl + br_est - other, other)
        four_pts = np.array([tl, tr, br_est, bl], dtype=np.float32)
        paper_center = four_pts.mean(axis=0)
        src_pts = []
        for c in four_pts:
            dists = np.linalg.norm(centers - c, axis=1)
            best = int(np.argmin(dists))
            if dists[best] < 100:
                outer = _outer_corner(np.array(tags[best].corners, dtype=np.float32), paper_center)
                src_pts.append(outer)
            else:
                src_pts.append(c)

    return np.array(src_pts, dtype=np.float32)


def _warp_from_raw(frame: np.ndarray, H: np.ndarray, folder_path: str) -> np.ndarray:
    """Sample the page view straight out of the RAW frame, in one resampling.

    `cv2.undistort` keeps the original camera matrix, so on a lens as wide as the
    scene camera's it pushes the periphery off the canvas: a page lying close to
    the wearer reaches the bottom frame edge, its undistorted corners land BELOW
    row `h`, and those rows come back black — the page's bottom strip, tags
    included, is thrown away before the warp ever runs.

    The pixels are all still in the raw frame, so go there directly: for every
    destination pixel, `H⁻¹` gives the ideal-pinhole scene point and
    :func:`distort_points` turns that into the raw sensor pixel to sample. `H` is
    unchanged — the page geometry is still defined by undistorted tag corners —
    only the sampling avoids the intermediate crop."""
    Hi = np.linalg.inv(H)
    yy, xx = np.mgrid[0:OUTPUT_H, 0:OUTPUT_W].astype(np.float32)
    hom = np.stack([xx.ravel(), yy.ravel(), np.ones(xx.size, dtype=np.float32)])
    ideal = Hi @ hom
    ideal = (ideal[:2] / ideal[2]).T
    raw = distort_points(folder_path, ideal).astype(np.float32)
    return cv2.remap(
        frame, raw[:, 0].reshape(OUTPUT_H, OUTPUT_W), raw[:, 1].reshape(OUTPUT_H, OUTPUT_W),
        cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
    )


def _warp_frame(frame: np.ndarray, tags: List[TagInfo],
                folder_path: Optional[str] = None) -> Optional[str]:
    """Compute perspective warp from a list of tag infos; returns base64 JPEG or None.

    For a scene-video frame (`folder_path` given) the tag corners are undistorted
    first, so this background lives in the same undistorted page geometry the gaze
    is mapped into; the pixels are then sampled from the raw frame (see
    :func:`_warp_from_raw`)."""
    kd = scene_intrinsics(folder_path)
    if kd is not None:
        tags = _undistort_tags(folder_path, tags)

    src_pts = _surface_corners_from_tags(tags, frame.shape[1], frame.shape[0])
    if src_pts is None:
        return None

    dst_pts = np.array([[0, 0], [OUTPUT_W, 0], [OUTPUT_W, OUTPUT_H], [0, OUTPUT_H]], dtype=np.float32)
    H, _ = cv2.findHomography(src_pts, dst_pts, method=0)
    if H is None:
        return None
    warped = (_warp_from_raw(frame, H, folder_path) if kd is not None
              else cv2.warpPerspective(frame, H, (OUTPUT_W, OUTPUT_H)))
    _, buf = cv2.imencode(".jpg", warped, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return base64.b64encode(buf).decode()


@router.post("/warp-from-selection")
async def warp_from_selection(recording_id: str, req: WarpSelectionRequest):
    if len(req.selected_tags) < 3:
        return {"warped_image_b64": None, "success": False}

    rec = await _get_recording(recording_id)

    if req.source == "upload":
        adir = _aoi_dir(rec["folder_path"])
        src_file = _upload_source_path(adir, req.segment_id)
        if not src_file.exists():
            # Fall back to the legacy shared filename for older uploads
            legacy = adir / "upload_source.jpg"
            src_file = legacy if legacy.exists() else src_file
        if not src_file.exists():
            raise HTTPException(status_code=404, detail="Uploaded source image not found")
        frame = cv2.imread(str(src_file))
        if frame is None:
            raise HTTPException(status_code=400, detail="Could not read uploaded source image")
    else:
        video_path = rec.get("scene_video")
        if not video_path or not Path(video_path).exists():
            raise HTTPException(status_code=404, detail="Scene video not found")
        cap = cv2.VideoCapture(video_path)
        try:
            cap.set(cv2.CAP_PROP_POS_MSEC, req.timestamp_s * 1000)
            ok, frame = cap.read()
        finally:
            cap.release()
        if not ok:
            raise HTTPException(status_code=400, detail="Could not read frame")

    # Only a scene frame carries our lens distortion; an uploaded image does not.
    warped_b64 = _warp_frame(frame, req.selected_tags,
                             None if req.source == "upload" else rec["folder_path"])
    return {"warped_image_b64": warped_b64, "success": warped_b64 is not None}


# ─── Surface positions (Pupil-compatible surface_positions.csv) ───────────────
# For every scene-camera frame, localise the AoI surface and record its 4 corners
# in scene pixels. The surface is defined once (from the user-selected reference
# tags) as a per-marker registry of normalised surface coordinates; each frame is
# then localised independently from whichever registered markers are visible.

_surface_jobs: dict = {}

_SURFACE_COLS = [
    "section id", "timestamp [ns]", "detected markers",
    "tl x [px]", "tl y [px]", "tr x [px]", "tr y [px]",
    "br x [px]", "br y [px]", "bl x [px]", "bl y [px]",
]


def _load_scene_timestamps(scene_path: str) -> np.ndarray:
    """Per-frame device timestamps (ns) from the scene camera's sibling .time file.

    One uint64 entry per video frame — the authoritative timestamp source, exactly
    as used for the eye stream in gaze.py."""
    time_file = Path(scene_path).with_suffix(".time")
    if time_file.exists():
        return np.fromfile(str(time_file), dtype=np.uint64).astype(np.int64)
    return np.array([], dtype=np.int64)


def _build_surface_registry(
    selected_tags: List[TagInfo], frame_w: int, frame_h: int,
    folder_path: Optional[str] = None,
) -> Optional[dict]:
    """Map each selected tag's 4 corners into normalised surface coords [0,1]².

    Returns {tag_id: [[u,v]×4]} keyed by int tag id, or None if the surface plane
    could not be established from the given tags. `folder_path` marks the tags as
    coming from a scene frame, whose distortion is removed first so the registry
    describes the true page geometry."""
    selected_tags = _undistort_tags(folder_path, selected_tags)
    corners = _surface_corners_from_tags(selected_tags, frame_w, frame_h)
    if corners is None:
        return None
    dst_pts = np.array([[0, 0], [OUTPUT_W, 0], [OUTPUT_W, OUTPUT_H], [0, OUTPUT_H]], dtype=np.float32)
    H, _ = cv2.findHomography(corners, dst_pts, method=0)  # scene px -> A4 px
    if H is None:
        return None
    registry: dict = {}
    for t in selected_tags:
        pts = np.array(t.corners, dtype=np.float32).reshape(-1, 1, 2)
        mapped = cv2.perspectiveTransform(pts, H).reshape(-1, 2)  # A4 px
        norm = mapped / np.array([OUTPUT_W, OUTPUT_H], dtype=np.float32)
        registry[int(t.tag_id)] = norm.tolist()
    return registry


def _surface_scene_homography(detections, registry: dict,
                              folder_path: Optional[str] = None) -> Optional[np.ndarray]:
    """Robust homography normalized-paper [0,1]² → scene pixels for one frame.

    Correspondences are (registered normalized corner → detected scene corner) for
    every visible registered marker. RANSAC (threshold in SCENE PIXELS) rejects
    wrong-plane detections — crucially, a DUPLICATE tag id from another physical
    paper reprojects to a scene location far from where it actually is, so its
    corners fall out as outliers. Needs ≥1 registered marker (4 correspondences).

    With `folder_path` the detected corners are undistorted first, so the result
    maps to IDEAL PINHOLE pixels — the space a homography can actually represent.
    Callers that need raw sensor pixels distort the result back."""
    tags = _tags_from_detections(folder_path, detections)
    src, dst = [], []
    for det in tags:
        reg = registry.get(int(det.tag_id))
        if reg is None:
            continue
        reg = np.array(reg, dtype=np.float32)
        cor = np.asarray(det.corners, dtype=np.float32)
        for k in range(4):
            src.append(reg[k])
            dst.append(cor[k])
    if len(src) < 4:
        return None
    src = np.array(src, dtype=np.float32)
    dst = np.array(dst, dtype=np.float32)
    method = cv2.RANSAC if len(src) > 4 else 0
    H, _ = cv2.findHomography(src, dst, method=method, ransacReprojThreshold=3.0)
    return H  # surface (norm) -> scene px


def _localize_surface(detections, registry: dict,
                      folder_path: Optional[str] = None) -> Optional[np.ndarray]:
    """Surface corners [TL, TR, BR, BL] in RAW scene pixels (or None if not localized).

    Raw, not undistorted: these corners are drawn over the scene video in the
    player and exported as Pupil's surface_positions.csv."""
    H = _surface_scene_homography(detections, registry, folder_path)
    if H is None:
        return None
    unit = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32).reshape(-1, 1, 2)
    corners = cv2.perspectiveTransform(unit, H).reshape(-1, 2)
    return distort_points(folder_path, corners).astype(np.float32)


def _run_surface_positions(
    recording_id: str, scene_video: str, folder_path: str,
    section_id: str, registry: dict,
) -> None:
    job = _surface_jobs[recording_id]
    try:
        adir = _aoi_dir(folder_path)
        out_csv = adir / "surface_positions.csv"
        timestamps = _load_scene_timestamps(scene_video)

        cap = cv2.VideoCapture(scene_video)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or len(timestamps)
        frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        job["total"] = total

        detector = TagDetector(_BULK_QUAD_DECIMATE, _BULK_NTHREADS)

        localized = 0
        dropped = 0
        misses = 0
        part = out_csv.with_suffix(".part")
        with open(part, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(_SURFACE_COLS)
            idx = 0
            while True:
                if job.get("cancelled"):
                    break
                if total and idx >= total:
                    break
                ok, frame = cap.read()
                if not ok:
                    # An undecodable frame, not the end of the file (see
                    # MAX_CONSECUTIVE_READ_FAILURES). Record it as unlocalized so
                    # row index keeps meaning scene frame index — every consumer
                    # addresses this file by frame — and read on.
                    misses += 1
                    if misses > MAX_CONSECUTIVE_READ_FAILURES:
                        break
                    dropped += 1
                    ts = int(timestamps[idx]) if idx < len(timestamps) else ""
                    writer.writerow([section_id, ts, "", *[""] * 8])
                    idx += 1
                    job["progress"] = idx
                    continue
                misses = 0
                ts = int(timestamps[idx]) if idx < len(timestamps) else ""
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                dets = detector.detect(gray)
                matched = sorted({int(d.tag_id) for d in dets if int(d.tag_id) in registry})
                corners = _localize_surface(dets, registry, folder_path)
                if corners is not None:
                    vals = [f"{v:.3f}" for p in corners for v in p]
                    localized += 1
                else:
                    vals = [""] * 8
                writer.writerow([section_id, ts, ";".join(map(str, matched)), *vals])
                idx += 1
                job["progress"] = idx
        cap.release()
        detector.close()

        _ = (frame_w, frame_h)  # available for future validation/debug
        job["dropped"] = dropped
        if job.get("cancelled"):
            part.unlink(missing_ok=True)
            job["status"] = "idle"
        elif total and idx < total:
            # Never publish a short file as a finished one: it would come back
            # from the status endpoint as "done" and every frame past the cut
            # would silently have no surface.
            part.unlink(missing_ok=True)
            job["status"] = "error"
            job["message"] = (f"Scene video could not be decoded past frame {idx} of {total} — "
                              f"the file may be damaged")
        else:
            part.replace(out_csv)
            job["localized"] = localized
            job["message"] = f"{dropped} undecodable frame(s) skipped" if dropped else ""
            job["status"] = "done"
    except Exception as e:  # pragma: no cover - surfaced via status endpoint
        job["status"] = "error"
        job["message"] = str(e)


def _load_segment_state(adir: Path, segment_id: str) -> dict:
    """Read a segment's saved AoI state from ONE directory (no resolution).

    Falls back to the legacy state.json, which held "general" before per-segment
    files existed."""
    path = adir / f"{segment_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    if segment_id == "general":
        legacy = adir / "state.json"
        if legacy.exists():
            return json.loads(legacy.read_text())
    return {}


def _has_override(adir: Path, segment_id: str) -> bool:
    """Does this recording annotate the segment itself, rather than via its project?"""
    return (adir / f"{segment_id}.json").exists() or (
        segment_id == "general" and (adir / "state.json").exists()
    )


def _resolve_state_scope(rec: dict, segment_id: str) -> tuple:
    """``(state, scope)`` — the AoI state that applies to this recording.

    ``scope`` is "recording" for the recording's own override, "project" for the
    shared annotation, "none" when the segment is not annotated anywhere. Callers
    that must not re-derive geometry from another recording's frame check it."""
    adir = _aoi_dir(rec["folder_path"])
    own = _load_segment_state(adir, segment_id)
    if own:
        return own, "recording"
    pid = rec.get("project_id")
    if pid:
        shared = _load_segment_state(_project_aoi_dir(pid), segment_id)
        if shared:
            return shared, "project"
    return {}, "none"


def _resolve_state(rec: dict, segment_id: str) -> dict:
    return _resolve_state_scope(rec, segment_id)[0]


class TagDetector:
    """A pupil-apriltags detector pinned to a worker thread of its own.

    Detecting on the process's MAIN thread segfaults this build of
    pupil-apriltags. Measured on this machine: 12 of 12 runs died with SIGSEGV
    (exit 139) across every nthreads / quad_decimate combination tried, while the
    identical work on a plain worker thread ran clean 12 of 12. It takes the whole
    server down with it, and FastAPI runs ``async def`` handlers on the event loop
    — the main thread — so one interactive "Detect AprilTags" click could kill a
    session mid-analysis.

    Each instance owns its thread rather than sharing one pool, so an interactive
    request gets its own (creating a thread costs far less than one detection)
    instead of queueing behind a full-video pass. The detector is built on that
    same thread it is used from, since only that combination is known to be safe.
    """

    def __init__(self, quad_decimate: float = 1.0, nthreads: int = 2):
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="apriltag")
        self._detector = self._pool.submit(_make_apriltag_detector, quad_decimate, nthreads).result()

    def detect(self, gray: np.ndarray):
        return self._pool.submit(self._detector.detect, gray).result()

    def close(self) -> None:
        self._pool.shutdown(wait=False)

    def __enter__(self) -> "TagDetector":
        return self

    def __exit__(self, *exc) -> bool:
        self.close()
        return False


def _make_apriltag_detector(quad_decimate: float = 1.0, nthreads: int = 2):
    """The tag36h11 detector configuration used throughout this module.

    Per-frame detection MUST use the same corner winding as the reference
    detection so the surface registry matches corners by index — ``quad_decimate``
    only trades corner precision for speed (the quad is found on a downscaled image
    then refined via ``refine_edges``), it does NOT change corner order. Reference/
    interactive detection keeps ``quad_decimate=1.0`` for precision; the bulk
    per-frame video passes bump it (≈3× faster on 1600×1200) since RANSAC over many
    corners absorbs the small precision loss."""
    return apriltag.Detector(
        families="tag36h11", nthreads=nthreads, quad_decimate=quad_decimate,
        quad_sigma=0.0, refine_edges=1, decode_sharpening=0.25,
    )


# quad_decimate/nthreads for the full-video per-frame passes (gaze mapping,
# surface_positions) — the reference detection stays at the precise default.
_BULK_QUAD_DECIMATE = 2.0
_BULK_NTHREADS = 4

# A single corrupt access unit in the H.264 stream makes OpenCV's read() return
# False, and the decoder picks straight back up on the very next call — ffmpeg
# skips exactly that one frame and decodes the rest of the file. Treating the
# first failure as end-of-file silently truncates a whole-video pass (one 9961-
# frame recording stopped at 702 and still reported "done"), so a pass tolerates
# isolated failures and only gives up once this many land in a row.
MAX_CONSECUTIVE_READ_FAILURES = 30


def _scene_to_paper_H(detections, registry: dict,
                      folder_path: Optional[str] = None) -> Optional[np.ndarray]:
    """Homography mapping scene pixels → normalized paper [0,1]² from the surface.

    Built by inverting the robust normalized→scene homography (see
    :func:`_surface_scene_homography`) so the same scene-pixel RANSAC rejects
    wrong-plane / duplicate-id tags. This is the SAME surface plane the AoI editor
    warps onto, so mapped gaze lands in the AoI coordinate system.

    With `folder_path` the input side is UNDISTORTED pixels, so callers must
    undistort the gaze sample before applying it."""
    H_ns = _surface_scene_homography(detections, registry, folder_path)
    if H_ns is None:
        return None
    try:
        return np.linalg.inv(H_ns)  # scene px -> paper norm
    except np.linalg.LinAlgError:
        return None


def _build_registry(rec: dict, segment_id: str, scene_video: str) -> Optional[dict]:
    """Surface marker registry ``{tag_id: [[u,v]×4]}`` in normalized page coords.

    A state saved on this recording is re-derived from its ``selected_tags``, and
    for legacy states without them by re-detecting AprilTags on the stored
    reference frame. Returns None if no surface can be established.

    A SHARED (project) state instead ships the registry it was built with, and
    that one is used as-is: its tags were detected in another recording's frame,
    so re-deriving them here would apply this recording's frame size and lens
    calibration to those pixel coordinates and silently deform the page.

    The saved tags always come from a SCENE FRAME (an uploaded reference image only
    replaces the background picture, never the tag selection), so their lens
    distortion is always corrected here."""
    state, scope = _resolve_state_scope(rec, segment_id)
    if scope == "none":
        return None

    markers = state.get("markers")
    if markers:
        return {int(k): v for k, v in markers.items()}
    if scope == "project":
        # Saved before registries were stored — the annotation has to be re-saved
        # from its source recording before it can be used anywhere else.
        return None

    adir = _aoi_dir(rec["folder_path"])
    folder_path = rec["folder_path"]
    raw_tags = state.get("selected_tags")

    cap = cv2.VideoCapture(scene_video)
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    try:
        if raw_tags and len(raw_tags) >= 3:
            selected_tags = [TagInfo(**t) for t in raw_tags]
        else:
            ref_ts = state.get("reference_timestamp_s")
            if ref_ts is None or ref_ts < 0:
                return None
            cap.set(cv2.CAP_PROP_POS_MSEC, ref_ts * 1000)
            ok, frame = cap.read()
            if not ok:
                return None
            with TagDetector() as detector:
                dets = detector.detect(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
            selected_tags = [
                TagInfo(tag_id=int(d.tag_id), center=[float(d.center[0]), float(d.center[1])],
                        corners=d.corners.tolist())
                for d in dets
            ]
            if len(selected_tags) < 3:
                return None
    finally:
        cap.release()

    return _build_surface_registry(selected_tags, frame_w, frame_h, folder_path)


def _build_recording_registry(rec: dict, scene_video: str) -> Optional[dict]:
    """Registry for the recording's physical surface (shared across segments).

    Every segment is drawn on the same paper, so any segment's tags define the same
    normalized plane. Prefers ``general`` (covers legacy state.json), then scans the
    other segments the recording resolves — its own first, then its project's."""
    if not _APRILTAG_AVAILABLE:
        return None
    for sid in _resolve_segments(rec):
        reg = _build_registry(rec, sid, scene_video)
        if reg:
            return reg
    return None


@router.post("/surface-positions")
async def start_surface_positions(recording_id: str, segment_id: str = "general"):
    if not _APRILTAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="pupil-apriltags not installed")
    if not _SEGMENT_ID_RE.match(segment_id):
        raise HTTPException(status_code=400, detail="Invalid segment id")

    rec = await _get_recording(recording_id)
    scene_video = rec.get("scene_video")
    if not scene_video or not Path(scene_video).exists():
        raise HTTPException(status_code=404, detail="Scene video not found")

    adir = _aoi_dir(rec["folder_path"])
    registry = _build_registry(rec, segment_id, scene_video)
    if registry is None:
        raise HTTPException(
            status_code=400,
            detail="No surface defined. Detect 3+ AprilTags on a frame and Save first.",
        )

    (adir / "surface.json").write_text(json.dumps({
        "OUTPUT_W": OUTPUT_W, "OUTPUT_H": OUTPUT_H,
        "segment_id": segment_id, "markers": registry,
        # Marks which geometry the sibling surface_positions.csv was produced with,
        # so gaze re-projection never reuses corners fitted without distortion
        # correction (they would silently mix coordinate conventions).
        "geometry": SURFACE_GEOMETRY,
    }))

    _surface_jobs[recording_id] = {
        "status": "running", "progress": 0, "total": 0,
        "cancelled": False, "message": "Starting…", "localized": 0,
    }
    t = threading.Thread(
        target=_run_surface_positions,
        args=(recording_id, scene_video, rec["folder_path"], recording_id, registry),
        daemon=True,
    )
    t.start()
    return {"started": True, "markers": len(registry)}


@router.get("/surface-positions")
async def surface_positions_status(recording_id: str):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    has_file = (adir / "surface_positions.csv").exists()
    job = _surface_jobs.get(recording_id)
    if not job:
        return {
            "status": "done" if has_file else "idle",
            "progress": 0, "total": 0, "has_file": has_file,
        }
    return {
        "status": job["status"],
        "progress": job.get("progress", 0),
        "total": job.get("total", 0),
        "localized": job.get("localized", 0),
        "message": job.get("message", ""),
        "has_file": has_file,
    }


@router.post("/surface-positions/cancel")
async def cancel_surface_positions(recording_id: str):
    job = _surface_jobs.get(recording_id)
    if job and job["status"] == "running":
        job["cancelled"] = True
    return {"ok": True}


@router.get("/surface-positions/data")
async def surface_positions_data(recording_id: str):
    """Per-frame surface corners for the player overlay.

    ``corners[i]`` is ``[tl_x, tl_y, tr_x, tr_y, br_x, br_y, bl_x, bl_y]`` in scene
    pixels, or null where the surface was not localizable in that frame.
    ``markers[i]`` lists the registered tag ids actually seen in that frame, and
    ``registry`` maps each registered tag id to its 4 corners in normalized surface
    coordinates — together they let an overlay outline the markers that carried the
    localization, without re-detecting anything. Together
    with a fixation's normalized surface position this pins the fixation to the
    paper exactly, with no drift — the same homography the AoI export is built on,
    just evaluated in the direction normalized → scene."""
    rec = await _get_recording(recording_id)
    path = _aoi_dir(rec["folder_path"]) / "surface_positions.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="surface_positions.csv not found")

    ts_ns: list = []
    corners: list = []
    markers: list = []
    localized = 0
    corner_cols = _SURFACE_COLS[3:]
    with open(path) as f:
        for row in csv.DictReader(f):
            ts_ns.append(int(row["timestamp [ns]"]) if row["timestamp [ns]"] else None)
            seen = row.get("detected markers") or ""
            markers.append([int(m) for m in seen.split(";") if m])
            if row[corner_cols[0]] == "":
                corners.append(None)
                continue
            corners.append([float(row[c]) for c in corner_cols])
            localized += 1
    # The registry the CSV was actually produced with, so an overlay can outline
    # each marker exactly where the localization believed it to be. Read from
    # surface.json rather than the segment state: a state saved before the tags
    # were registered carries no `markers` of its own.
    registry: dict = {}
    surface_json = _aoi_dir(rec["folder_path"]) / "surface.json"
    if surface_json.exists():
        try:
            registry = json.loads(surface_json.read_text()).get("markers") or {}
        except (OSError, ValueError):
            registry = {}

    # Scene-camera intrinsics, so a client can repeat the backend's own geometry:
    # the corners above are RAW sensor pixels, and a homography fitted straight to
    # them cannot express lens distortion — reprojecting the markers through such a
    # fit lands them up to ~20 px off near the page corners. Undistorting first,
    # fitting there and distorting the result back keeps it sub-pixel.
    kd = scene_intrinsics(rec["folder_path"])
    intrinsics = None
    if kd is not None:
        K, D = kd
        d = [float(v) for v in np.ravel(D)[:8]]
        d += [0.0] * (8 - len(d))
        intrinsics = {"fx": float(K[0, 0]), "fy": float(K[1, 1]),
                      "cx": float(K[0, 2]), "cy": float(K[1, 2]), "d": d}

    return {"ts_ns": ts_ns, "corners": corners, "markers": markers,
            "registry": registry, "intrinsics": intrinsics,
            "frames": len(corners), "localized": localized}


@router.get("/surface-positions/file")
async def download_surface_positions(recording_id: str):
    rec = await _get_recording(recording_id)
    path = _aoi_dir(rec["folder_path"]) / "surface_positions.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="surface_positions.csv not found")
    return FileResponse(str(path), media_type="text/csv", filename="surface_positions.csv")


# ─── AOI fixation metrics (aoi_fixations.csv / aoi_metrics.csv) ───────────────
# Assigns each detected fixation to the AoI shapes it falls inside. Fixation
# surface positions and AoI shapes are both in normalised [0,1]² paper space, so
# membership is a plain point-in-shape test with no scaling.
#
# One export per recording covering EVERY segment at once: AoI shapes are drawn
# per segment, so each row carries the segment it belongs to rather than the
# files being split per segment. Every fixation in the recording is considered,
# regardless of any segment's event time range.

# The trailing "segment id" keeps the documented Pupil column order intact as a
# prefix, so readers that index by position still work.
_AOI_FIXATION_COLS = [
    "label id", "aoi label", "section id", "recording id",
    "fixation id", "fixation duration [ms]", "segment id",
]

_AOI_METRICS_COLS = [
    "label id", "recording id", "recording name", "aoi label",
    "average fixation duration [ms]", "total fixations",
    "time to first fixation [ms]", "total fixation duration [ms]", "segment id",
]

_AOI_EXPORT_STEMS = ("aoi_fixations", "aoi_metrics")

# aoi/*.json names that are not segment state.
_RESERVED_AOI_JSON = {"surface", "segments", "state"}


def _aoi_export_path(adir: Path, stem: str, source: str = "own") -> Path:
    """Metrics are gaze-derived, so each source gets its own copy (see GAZE_SOURCES)."""
    return adir / _SOURCE_SUBDIR[check_source(source)] / f"{stem}.csv"


def _invalidate_aoi_metrics(adir: Path) -> None:
    """Drop the exports once any segment's AoI shapes change (they no longer match).

    Shapes are shared by every source, so all of their metrics go stale at once."""
    for source in GAZE_SOURCES:
        for stem in _AOI_EXPORT_STEMS:
            _aoi_export_path(adir, stem, source).unlink(missing_ok=True)


def _list_aoi_segments(adir: Path) -> List[str]:
    """Every segment id with saved AoI state in ONE directory, in stable order.

    A segment only has shapes once its state file exists, so the directory is the
    authoritative list — no need to re-derive segments from events here."""
    ids = [
        p.stem for p in sorted(adir.glob("*.json"))
        if p.stem not in _RESERVED_AOI_JSON and _SEGMENT_ID_RE.match(p.stem)
    ]
    # Legacy layout: state.json held "general" before per-segment files existed.
    if "general" not in ids and (adir / "state.json").exists():
        ids.append("general")
    return ids


def _resolve_segments(rec: dict) -> List[str]:
    """Every segment this recording resolves — its own overrides plus its project's.

    "general" leads, so the callers that only need any one surface (the marker
    registry) hit the segment that is always present first."""
    ids: List[str] = []
    for d in _aoi_dirs(rec):
        for sid in _list_aoi_segments(d):
            if sid not in ids:
                ids.append(sid)
    ids.sort(key=lambda sid: (sid != "general", sid))
    return ids


def _segment_areas(rec: dict) -> List[tuple]:
    """(segment_id, areas) for every segment that actually has drawn shapes."""
    out = []
    for sid in _resolve_segments(rec):
        areas = [a for a in _resolve_state(rec, sid).get("areas", []) if a.get("shape")]
        if areas:
            out.append((sid, areas))
    return out


def _point_in_shape(x: float, y: float, shape: dict) -> bool:
    """Is the normalised paper point (x, y) inside this AoI shape?"""
    kind = shape.get("kind")
    sx, sy = float(shape.get("x", 0.0)), float(shape.get("y", 0.0))
    w, h = float(shape.get("w", 0.0)), float(shape.get("h", 0.0))
    if kind == "rect":
        return sx <= x <= sx + w and sy <= y <= sy + h
    if kind == "ellipse":
        rx, ry = w / 2.0, h / 2.0
        if rx <= 0 or ry <= 0:
            return False
        return ((x - (sx + rx)) / rx) ** 2 + ((y - (sy + ry)) / ry) ** 2 <= 1.0
    if kind == "polygon":
        pts = shape.get("points") or []
        if len(pts) < 3:
            return False
        contour = np.array(pts, dtype=np.float32).reshape(-1, 1, 2)
        return cv2.pointPolygonTest(contour, (float(x), float(y)), False) >= 0
    return False


def _read_surface_fixations(gdir: Path) -> List[dict]:
    """On-surface fixations from fixations_on_surface.csv, ordered by fixation id.

    Rows without a surface position are gaze that missed the paper — they belong
    to no AoI and are dropped here."""
    out: List[dict] = []
    with open(gdir / "fixations_on_surface.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("fixation detected on surface") != "True":
                continue
            nx, ny = row.get("fixation x [normalized]"), row.get("fixation y [normalized]")
            if not nx or not ny:
                continue
            out.append({
                "section_id": row["section id"],
                "fixation_id": int(row["fixation id"]),
                "start_ts": int(row["start timestamp [ns]"]),
                "duration_ms": float(row["duration [ms]"]),
                "x": float(nx), "y": float(ny),
            })
    out.sort(key=lambda r: r["fixation_id"])
    return out


@router.post("/aoi-metrics")
async def generate_aoi_metrics(recording_id: str, source: Optional[str] = None):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    src = active_source(rec["folder_path"], source)
    gdir = _gaze_dir(rec["folder_path"], src)

    if not (gdir / "fixations_on_surface.csv").exists():
        raise HTTPException(
            status_code=400,
            detail="No fixations yet. Run fixation detection in the Gaze section first.",
        )

    segments = _segment_areas(rec)
    if not segments:
        raise HTTPException(
            status_code=400,
            detail="No areas of interest defined. Draw them in the AoI section first.",
        )

    fixations = _read_surface_fixations(gdir)

    # Time-to-first-fixation is measured from the start of the recording, which
    # precedes the first gaze sample — use the device start time, not the first
    # fixation, so the metric matches Pupil's definition.
    t0 = rec.get("start_time")

    # Every segment's shapes are tested against every fixation: a fixation inside
    # two overlapping AoIs is reported once per AoI, in each segment they belong to.
    hits: dict = {}
    for sid, areas in segments:
        for a in areas:
            hits[(sid, a["id"])] = [
                fx for fx in fixations if _point_in_shape(fx["x"], fx["y"], a["shape"])
            ]

    _aoi_export_path(adir, "aoi_fixations", src).parent.mkdir(parents=True, exist_ok=True)
    with open(_aoi_export_path(adir, "aoi_fixations", src), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(_AOI_FIXATION_COLS)
        for sid, areas in segments:
            for a in areas:
                for fx in hits[(sid, a["id"])]:
                    w.writerow([
                        a["id"], a.get("name", ""), fx["section_id"], recording_id,
                        fx["fixation_id"], round(fx["duration_ms"]), sid,
                    ])

    with open(_aoi_export_path(adir, "aoi_metrics", src), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(_AOI_METRICS_COLS)
        for sid, areas in segments:
            for a in areas:
                fxs = hits[(sid, a["id"])]
                durs = [fx["duration_ms"] for fx in fxs]
                # An AoI that was never looked at still gets a row, so an ignored
                # AoI is visible as a zero rather than a missing line.
                ttff = ""
                if fxs and t0:
                    ttff = round((min(fx["start_ts"] for fx in fxs) - int(t0)) / 1e6)
                w.writerow([
                    a["id"], recording_id, rec.get("name", ""), a.get("name", ""),
                    round(float(np.mean(durs))) if durs else 0,
                    len(fxs),
                    ttff,
                    round(sum(durs)),
                    sid,
                ])

    n_areas = sum(len(areas) for _, areas in segments)
    return {
        "source": src,
        "n_segments": len(segments),
        "n_areas": n_areas,
        "n_areas_fixated": sum(1 for v in hits.values() if v),
        "n_fixations": len(fixations),
        "n_aoi_fixations": sum(len(v) for v in hits.values()),
    }


@router.get("/aoi-metrics")
async def aoi_metrics_status(recording_id: str, source: Optional[str] = None):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    src = active_source(rec["folder_path"], source)
    gdir = _gaze_dir(rec["folder_path"], src)
    segments = _segment_areas(rec)
    return {
        "source": src,
        "has_fixations": (gdir / "fixations_on_surface.csv").exists(),
        "n_segments": len(segments),
        "n_areas": sum(len(areas) for _, areas in segments),
        "has_file": all(_aoi_export_path(adir, stem, src).exists() for stem in _AOI_EXPORT_STEMS),
    }


@router.get("/aoi-metrics/file/{name}")
async def download_aoi_metrics(recording_id: str, name: str, source: Optional[str] = None):
    if name not in _AOI_EXPORT_STEMS:
        raise HTTPException(status_code=404, detail="Unknown file")
    rec = await _get_recording(recording_id)
    src = active_source(rec["folder_path"], source)
    path = _aoi_export_path(_aoi_dir(rec["folder_path"]), name, src)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{name}.csv not found")
    return FileResponse(str(path), media_type="text/csv", filename=f"{name}.csv")
