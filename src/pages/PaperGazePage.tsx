import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Eye, EyeOff, Frame, ImageIcon, Pause, Play, RotateCcw, ScanEye, Square } from "lucide-react";
import { api } from "@/lib/api";
import { SurfacePositionsPanel } from "@/components/exports/SurfacePositionsPanel";
import { AoiFixationsPanel } from "@/components/exports/AoiFixationsPanel";
import { EventSeekbar } from "@/components/player/EventSeekbar";
import { RecordingPickerScreen } from "@/components/picker/RecordingPicker";
import { tourAnchor } from "@/lib/tour/anchors";
import { isDemoRecording } from "@/lib/tour/demo";
import { applyMat, nearestIndex, unitSquareToQuad, type Mat3 } from "@/lib/sceneAnchor";
import { drawGazeRing } from "@/lib/gazeMarker";
import { asOrientation, paperSize, PORTRAIT_SIZE, type PaperOrientation, type PaperSize } from "@/lib/paper";
import { makeLens, type Lens } from "@/lib/lensDistortion";
import type {
  RecordingMeta, RecordingEvent, GazePrediction, SurfacePositionsData,
} from "@/types";

import { API_BASE as API } from "@/lib/apiBase";

// Gaze cursor radius, fixed in A4 canvas pixels. The video's radius is DERIVED
// from this one through the frame's surface homography, so the ring covers the
// same patch of the page in both views — on the video it grows as the wearer
// leans in, exactly as a circle drawn on the paper would.
const RING_R_PAPER = 26;
// Fallback for frames where the surface is not localized and there is nothing to
// derive from. Scene-camera pixels, converted to screen pixels when drawn.
const RING_R_SCENE_FALLBACK = 34;

// A gaze sample further than this from the displayed frame is not that frame's
// gaze — better to show no cursor than one left over from seconds ago.
const SAMPLE_TOLERANCE_S = 0.2;

const SURFACE_EDGE = "#3b82f6";
const SURFACE_TOP_EDGE = "#ef4444";  // the TL→TR edge, so the page's orientation is readable
const MARKER_COLOR = "#22c55e";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AoiShape {
  kind: "rect" | "ellipse" | "polygon";
  x: number; y: number; w: number; h: number;
  points?: [number, number][];
}

interface AoiArea {
  id: string; name: string; color: string; visible: boolean;
  shape: AoiShape | null;
}

interface SegmentMeta {
  id: string; label: string; eventPrefix: string | null;
}

/** The two warps the AoI editor can store for a segment — see `BgMode`. */
interface AoiStateResponse {
  areas?: AoiArea[];
  warped_image_b64?: string | null;          // whichever of the two is active
  video_warped_image_b64?: string | null;    // warp of the picked scene frame
  reference_image_b64?: string | null;       // warp of an uploaded reference scan
  using_reference?: boolean;
  orientation?: string | null;               // how the printed sheet is laid out
}

/** Which warp is painted behind the AoI shapes on the A4 canvas. */
type BgMode = "video" | "reference";

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function deriveSegments(events: RecordingEvent[]): SegmentMeta[] {
  const prefixes = [...new Set(
    events.filter(e => e.name.endsWith("_begin")).map(e => e.name.slice(0, -6)),
  )];
  return [
    { id: "general", label: "General", eventPrefix: null },
    ...prefixes.map(p => ({
      id: p,
      label: p.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      eventPrefix: p,
    })),
  ];
}

type SegmentStart = { id: string; start: number };

function deriveSegmentStarts(events: RecordingEvent[], segments: SegmentMeta[]): SegmentStart[] {
  const starts: SegmentStart[] = [];
  for (const seg of segments) {
    if (!seg.eventPrefix) continue;
    const begin = events.find(e => e.name === `${seg.eventPrefix}_begin`);
    if (begin) starts.push({ id: seg.id, start: begin.timestamp_s });
  }
  return starts.sort((a, b) => a.start - b.start);
}

// The segment whose _begin the playhead last passed. A segment's _end does not
// hand back to General — the segment holds until the next one begins.
function segmentAtTime(starts: SegmentStart[], t: number): string {
  let id = "general";
  for (const s of starts) {
    if (s.start > t) break;
    id = s.id;
  }
  return id;
}

/** The prediction closest in time to `targetNs`, or null for an empty list. */
function findNearest(preds: GazePrediction[], targetNs: number): GazePrediction | null {
  if (preds.length === 0) return null;
  let lo = 0, hi = preds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (preds[mid].timestamp_ns < targetNs) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(preds[lo - 1].timestamp_ns - targetNs) < Math.abs(preds[lo].timestamp_ns - targetNs)) lo--;
  return preds[lo];
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function drawBg(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  areas: AoiArea[],
  paper: PaperSize,
) {
  const { w: PAPER_W, h: PAPER_H } = paper;
  ctx.clearRect(0, 0, PAPER_W, PAPER_H);
  if (img) {
    ctx.drawImage(img, 0, 0, PAPER_W, PAPER_H);
  } else {
    ctx.fillStyle = "#e0e0e0";
    ctx.fillRect(0, 0, PAPER_W, PAPER_H);
  }
  for (const area of areas) {
    if (!area.visible || !area.shape) continue;
    const s = area.shape;
    ctx.fillStyle = area.color;
    ctx.strokeStyle = area.color;
    ctx.lineWidth = 2;
    if (s.kind === "rect") {
      ctx.globalAlpha = 0.3;
      ctx.fillRect(s.x * PAPER_W, s.y * PAPER_H, s.w * PAPER_W, s.h * PAPER_H);
      ctx.globalAlpha = 1;
      ctx.strokeRect(s.x * PAPER_W, s.y * PAPER_H, s.w * PAPER_W, s.h * PAPER_H);
    } else if (s.kind === "ellipse") {
      const cx = (s.x + s.w / 2) * PAPER_W;
      const cy = (s.y + s.h / 2) * PAPER_H;
      ctx.beginPath();
      ctx.ellipse(cx, cy, (s.w / 2) * PAPER_W, (s.h / 2) * PAPER_H, 0, 0, Math.PI * 2);
      ctx.globalAlpha = 0.3; ctx.fill();
      ctx.globalAlpha = 1; ctx.stroke();
    } else if (s.kind === "polygon" && s.points) {
      ctx.beginPath();
      s.points.forEach(([px, py], i) =>
        i === 0 ? ctx.moveTo(px * PAPER_W, py * PAPER_H) : ctx.lineTo(px * PAPER_W, py * PAPER_H),
      );
      ctx.closePath();
      ctx.globalAlpha = 0.3; ctx.fill();
      ctx.globalAlpha = 1; ctx.stroke();
    }
  }
}

/**
 * `RING_R_PAPER` A4-canvas pixels expressed in scene pixels, measured at `(u,v)`
 * on the page — perspective makes the answer depend on where you ask.
 *
 * `H` maps normalized page coordinates to IDEAL pinhole pixels, so each probe is
 * distorted back to raw sensor pixels before the distance is taken; that is the
 * space the overlay is drawn in.
 */
function ringRadiusInScenePx(H: Mat3, lens: Lens, u: number, v: number, paper: PaperSize): number {
  const at = (a: number, b: number): [number, number] => lens.distort(...applyMat(H, a, b));
  const [x0, y0] = at(u, v);
  const [xu, yu] = at(u + RING_R_PAPER / paper.w, v);
  const [xv, yv] = at(u, v + RING_R_PAPER / paper.h);
  const du = Math.hypot(xu - x0, yu - y0);
  const dv = Math.hypot(xv - x0, yv - y0);
  return (du + dv) / 2;
}

/** The surface quad, blue all round except the TL→TR edge, which is red. */
function drawSurfaceOutline(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % 4];
    ctx.strokeStyle = i === 0 ? SURFACE_TOP_EDGE : SURFACE_EDGE;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PaperGazePage({ initialRecording }: { initialRecording?: RecordingMeta }) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(true);
  const [recording, setRecording] = useState<RecordingMeta | null>(initialRecording ?? null);
  const [loading, setLoading] = useState(false);

  const [predictions, setPredictions] = useState<GazePrediction[]>([]);
  const [events, setEvents] = useState<RecordingEvent[]>([]);
  const [segments, setSegments] = useState<SegmentMeta[]>([]);
  const [activeSegId, setActiveSegId] = useState("general");
  const [hasSurface, setHasSurface] = useState(false);
  // Which of the segment's two warps is painted behind the AoI shapes, and which
  // of them this segment actually has (the button only appears with both).
  const [bgMode, setBgMode] = useState<BgMode>("video");
  // How the annotated sheet is laid out. The canvas and every normalized→pixel
  // conversion follow it; the imperative draws read the ref, the JSX the state.
  const [orientation, setOrientation] = useState<PaperOrientation>("portrait");
  const paperRef = useRef<PaperSize>(PORTRAIT_SIZE);
  /** What the AoI state says, used while no background has been decoded yet. */
  const storedOrientationRef = useRef<PaperOrientation>("portrait");
  const paper = paperSize(orientation);
  const [bgAvailable, setBgAvailable] = useState<{ video: boolean; reference: boolean }>(
    { video: false, reference: false },
  );
  // null while unknown; false when surface_positions.csv has not been generated,
  // which is exactly what the video overlay is drawn from.
  const [surfaceLocalized, setSurfaceLocalized] = useState<number | null>(null);
  const [hasSurfacePositions, setHasSurfacePositions] = useState<boolean | null>(null);

  // Playback UI state. The scene video is the clock; these only mirror it.
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // Overlay toggles
  const [showOutline, setShowOutline] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showVideoGaze, setShowVideoGaze] = useState(true);
  const [showEye, setShowEye] = useState(true);

  // Eye PiP position (inside the video area)
  const [eyePos, setEyePos] = useState({ x: 12, y: 12 });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Canvas / media elements
  const canvasRef = useRef<HTMLCanvasElement>(null);          // warped A4 surface
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null); // offscreen A4 background
  const overlayRef = useRef<HTMLCanvasElement>(null);         // over the scene video
  const videoRef = useRef<HTMLVideoElement>(null);
  const eyeVideoRef = useRef<HTMLVideoElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);

  // Stable data refs for the RAF loop (avoid stale closures)
  const predsRef = useRef<GazePrediction[]>([]);
  // Both warps decoded once per segment, keyed by the base64 they came from so a
  // tab switch back does not decode them again. `bgModeRef` picks the painted one.
  const paperImgsRef = useRef<Record<BgMode, HTMLImageElement | null>>({ video: null, reference: null });
  const paperSrcRef = useRef<Record<BgMode, string | null>>({ video: null, reference: null });
  const bgModeRef = useRef<BgMode>("video");
  const aoiAreasRef = useRef<AoiArea[]>([]);
  const durationRef = useRef(0);

  // Scene-frame clock and the per-frame surface geometry indexed by it
  const sceneTsRef = useRef<Float64Array>(new Float64Array(0));   // device ns
  const sceneRelRef = useRef<Float64Array>(new Float64Array(0));  // seconds from frame 0
  const cornersRef = useRef<(number[] | null)[]>([]);
  const seenMarkersRef = useRef<number[][]>([]);
  const registryRef = useRef<Record<string, [number, number][]>>({});
  const lensRef = useRef<Lens>(makeLens(null));

  // Overlay toggles as refs, read inside the RAF loop
  const showOutlineRef = useRef(true);
  const showMarkersRef = useRef(true);
  const showVideoGazeRef = useRef(true);

  const rafRef = useRef<number | null>(null);
  const lastDrawnRef = useRef(-1);   // playback position of the last painted frame
  const dirtyRef = useRef(true);     // forces a repaint when data, not time, changed

  // Re-sizing the visible canvas for a new orientation clears it, so ask for a
  // repaint once React has applied the new width/height.
  useEffect(() => { dirtyRef.current = true; }, [orientation]);

  // Segment the playhead was last inside; null forces the first check to apply
  const timeSegRef = useRef<string | null>(null);

  useEffect(() => { showOutlineRef.current = showOutline; dirtyRef.current = true; }, [showOutline]);
  useEffect(() => { showMarkersRef.current = showMarkers; dirtyRef.current = true; }, [showMarkers]);
  useEffect(() => { showVideoGazeRef.current = showVideoGaze; dirtyRef.current = true; }, [showVideoGaze]);
  useEffect(() => { durationRef.current = videoDuration || recording?.duration_sec || 0; },
    [videoDuration, recording]);

  // ─── Data loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .finally(() => setLoadingRecs(false));
  }, []);

  /** Decode one warp into its slot, or clear the slot when the segment has none. */
  const setBgImage = useCallback((slot: BgMode, b64: string | null) => {
    if (b64 === paperSrcRef.current[slot]) return;   // already decoded
    paperSrcRef.current[slot] = b64;
    if (!b64) {
      paperImgsRef.current[slot] = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      // A tab switch during the decode may have replaced this slot's source.
      if (paperSrcRef.current[slot] !== b64) return;
      paperImgsRef.current[slot] = img;
      rebuildBgCanvas();
      dirtyRef.current = true;
    };
    img.src = `data:image/jpeg;base64,${b64}`;
  }, []);

  const loadAoiState = useCallback(async (recId: string, segId: string) => {
    try {
      const state = await api.get<AoiStateResponse>(
        `/api/recordings/${recId}/aoi/${segId}/state`,
      );
      aoiAreasRef.current = state.areas ?? [];
      storedOrientationRef.current = asOrientation(state.orientation);
      applyOrientation(storedOrientationRef.current);
      const active = state.warped_image_b64 ?? null;
      // States saved before the editor kept the two warps apart carry only the
      // active one; `using_reference` says which of the two that is.
      const video = state.video_warped_image_b64 ?? (state.using_reference ? null : active);
      const reference = state.reference_image_b64 ?? (state.using_reference ? active : null);
      setHasSurface(!!active);
      setBgAvailable({ video: !!video, reference: !!reference });

      setBgImage("video", video);
      setBgImage("reference", reference);
      // Follow the editor's choice, falling back to whichever warp exists.
      const mode: BgMode = state.using_reference && reference ? "reference"
        : video ? "video"
        : reference ? "reference"
        : "video";
      bgModeRef.current = mode;
      setBgMode(mode);

      rebuildBgCanvas();
      dirtyRef.current = true;
    } catch {
      aoiAreasRef.current = [];
      setBgImage("video", null);
      setBgImage("reference", null);
      setBgAvailable({ video: false, reference: false });
      setHasSurface(false);
      rebuildBgCanvas();
      dirtyRef.current = true;
    }
  // rebuildBgCanvas is stable (no deps) so it is safe to omit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBgImage]);

  // Only switchable when the segment actually stored both warps.
  const canToggleBg = bgAvailable.video && bgAvailable.reference;

  /** Swap the painted warp — the AoI editor keeps both for the same page. */
  const handleToggleBackground = () => {
    const next: BgMode = bgModeRef.current === "reference" ? "video" : "reference";
    if (!paperImgsRef.current[next]) return;
    bgModeRef.current = next;
    setBgMode(next);
    rebuildBgCanvas();
    dirtyRef.current = true;
  };

  /** The per-frame surface geometry the video overlay is drawn from.
   *
   * Re-read whenever surface_positions.csv is (re)generated, so the outline and
   * the derived gaze ring appear without leaving the page. */
  const loadSurfacePositions = useCallback(async (recId: string) => {
    try {
      const d = await api.get<SurfacePositionsData>(
        `/api/recordings/${recId}/aoi/surface-positions/data`,
      );
      cornersRef.current = d.corners ?? [];
      seenMarkersRef.current = d.markers ?? [];
      registryRef.current = d.registry ?? {};
      lensRef.current = makeLens(d.intrinsics);
      setSurfaceLocalized(d.localized);
      setHasSurfacePositions(true);
    } catch {
      cornersRef.current = [];
      seenMarkersRef.current = [];
      registryRef.current = {};
      lensRef.current = makeLens(null);
      setSurfaceLocalized(null);
      setHasSurfacePositions(false);
    }
    dirtyRef.current = true;
  }, []);

  const loadAll = useCallback(async (rec: RecordingMeta) => {
    setLoading(true);
    setIsPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
    timeSegRef.current = null;
    lastDrawnRef.current = -1;
    try {
      const [preds, evts] = await Promise.all([
        api.get<GazePrediction[]>(`/api/recordings/${rec.id}/gaze/predictions`)
          .catch(() => [] as GazePrediction[]),
        api.get<RecordingEvent[]>(`/api/recordings/${rec.id}/events`)
          .catch(() => [] as RecordingEvent[]),
      ]);
      predsRef.current = preds;
      setPredictions(preds);
      setEvents(evts);

      // Scene-frame timestamps: the bridge from a playback position to the gaze
      // clock and to the per-frame surface corners. Both are addressed by frame.
      api.get<{ ts_ns: number[] }>(`/api/recordings/${rec.id}/gaze/scene-timestamps`)
        .then(({ ts_ns }) => {
          if (!ts_ns?.length) return;
          const ts = Float64Array.from(ts_ns);
          const rel = new Float64Array(ts.length);
          for (let i = 0; i < ts.length; i++) rel[i] = (ts[i] - ts[0]) / 1e9;
          sceneTsRef.current = ts;
          sceneRelRef.current = rel;
          dirtyRef.current = true;
        })
        .catch(() => { /* recordings without a scene .time file fall back to fractions */ });

      loadSurfacePositions(rec.id);

      const segs = deriveSegments(evts);
      try {
        const manifest = await api.get<{ custom_segments: { id: string; label: string }[] }>(
          `/api/recordings/${rec.id}/aoi/segments`,
        );
        const ids = new Set(segs.map(s => s.id));
        for (const cs of manifest.custom_segments) {
          if (!ids.has(cs.id)) segs.push({ id: cs.id, label: cs.label, eventPrefix: null });
        }
      } catch { /* no manifest */ }

      setSegments(segs);
      setActiveSegId(segs[0].id);
      await loadAoiState(rec.id, segs[0].id);
    } finally {
      setLoading(false);
    }
  }, [loadAoiState, loadSurfacePositions]);

  useEffect(() => {
    if (initialRecording) loadAll(initialRecording);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetRecordingState = () => {
    setPredictions([]); predsRef.current = [];
    setEvents([]);
    setSegments([]);
    aoiAreasRef.current = [];
    paperImgsRef.current = { video: null, reference: null };
    paperSrcRef.current = { video: null, reference: null };
    setBgAvailable({ video: false, reference: false });
    bgModeRef.current = "video"; setBgMode("video");
    sceneTsRef.current = new Float64Array(0);
    sceneRelRef.current = new Float64Array(0);
    cornersRef.current = []; seenMarkersRef.current = []; registryRef.current = {};
    lensRef.current = makeLens(null);
    setSurfaceLocalized(null);
    setHasSurfacePositions(null);
    lastDrawnRef.current = -1;
    dirtyRef.current = true;
  };

  const handleSelectRecording = async (rec: RecordingMeta) => {
    setRecording(rec);
    resetRecordingState();
    await loadAll(rec);
  };

  const handleBack = () => {
    setIsPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
    timeSegRef.current = null;
    setRecording(null);
    resetRecordingState();
    setHasSurface(false);
  };

  const handleTabChange = async (segId: string) => {
    setActiveSegId(segId);
    if (recording) await loadAoiState(recording.id, segId);
  };

  // Follow the playhead: switch tabs when it passes a segment's _begin. Only a
  // crossing switches, so a manual tab choice sticks until the next one.
  const segmentStarts = useMemo(() => deriveSegmentStarts(events, segments), [events, segments]);

  useEffect(() => {
    if (!segments.length) return;
    const segAtTime = segmentAtTime(segmentStarts, currentTime);
    if (segAtTime === timeSegRef.current) return;
    timeSegRef.current = segAtTime;
    if (segAtTime !== activeSegId) handleTabChange(segAtTime);
  // handleTabChange is recreated each render; the crossing guard above keeps this from looping
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, segmentStarts, segments, activeSegId]);

  // ─── Drawing ───────────────────────────────────────────────────────────────

  /** Point both the imperative draws (ref) and the JSX (state) at one geometry. */
  function applyOrientation(o: PaperOrientation) {
    paperRef.current = paperSize(o);
    setOrientation(o);
  }

  // Rebuild the offscreen background (paper + AoI areas) into bgCanvasRef
  function rebuildBgCanvas() {
    if (!bgCanvasRef.current) bgCanvasRef.current = document.createElement("canvas");
    // The decoded background is the ground truth: it was warped into a canvas of
    // one orientation, and drawing it at the other squeezes the page. The stored
    // flag only has to answer for a segment that has no background yet.
    const img = paperImgsRef.current[bgModeRef.current];
    applyOrientation(
      img && img.naturalWidth && img.naturalHeight
        ? (img.naturalWidth > img.naturalHeight ? "landscape" : "portrait")
        : storedOrientationRef.current,
    );
    const { w, h } = paperRef.current;
    // Assigning the size clears the canvas, so only do it when it changed.
    if (bgCanvasRef.current.width !== w) bgCanvasRef.current.width = w;
    if (bgCanvasRef.current.height !== h) bgCanvasRef.current.height = h;
    const ctx = bgCanvasRef.current.getContext("2d");
    if (ctx) drawBg(ctx, paperImgsRef.current[bgModeRef.current], aoiAreasRef.current, paperRef.current);
  }

  /** The scene frame shown at playback position `t`, or -1 without a .time file. */
  const frameAt = useCallback((t: number): number => {
    const rel = sceneRelRef.current;
    return rel.length ? nearestIndex(rel, t) : -1;
  }, []);

  /** The gaze sample belonging to playback position `t` (null if none is close). */
  const sampleAt = useCallback((t: number, frameIdx: number): GazePrediction | null => {
    const preds = predsRef.current;
    if (!preds.length) return null;

    if (frameIdx >= 0) {
      const tsNs = sceneTsRef.current[frameIdx];
      const near = findNearest(preds, tsNs);
      if (!near) return null;
      return Math.abs(near.timestamp_ns - tsNs) / 1e9 <= SAMPLE_TOLERANCE_S ? near : null;
    }

    // No scene .time file: fall back to matching by fraction of each clock's span.
    const dur = durationRef.current;
    if (!dur) return null;
    const t0 = preds[0].timestamp_ns;
    const t1 = preds[preds.length - 1].timestamp_ns;
    return findNearest(preds, t0 + (t / dur) * (t1 - t0));
  }, []);

  /** Paint the warped-A4 canvas: saved surface image, AoI shapes, gaze cursor. */
  const drawPaper = useCallback((sample: GazePrediction | null) => {
    const canvas = canvasRef.current;
    const bg = bgCanvasRef.current;
    if (!canvas || !bg) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(bg, 0, 0);
    if (sample && sample.paper_x !== null && sample.paper_y !== null) {
      const { w, h } = paperRef.current;
      drawGazeRing(ctx, sample.paper_x * w, sample.paper_y * h, RING_R_PAPER);
    }
  }, []);

  /** Paint the overlay over the scene video: surface quad, markers, gaze cursor. */
  const drawOverlay = useCallback((frameIdx: number, sample: GazePrediction | null) => {
    const canvas = overlayRef.current;
    const wrap = videoWrapRef.current;
    const video = videoRef.current;
    if (!canvas || !wrap || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    // The video is object-contain, so the same letterboxed fit maps scene pixels
    // onto the overlay.
    const scale = Math.min(cw / vw, ch / vh);
    const ox = (cw - vw * scale) / 2;
    const oy = (ch - vh * scale) / 2;
    const toScreen = (x: number, y: number): [number, number] =>
      [ox + x * scale, oy + y * scale];

    const corners = frameIdx >= 0 ? cornersRef.current[frameIdx] ?? null : null;
    // The surface→scene map for this frame, fitted in undistorted pixels: a
    // homography cannot express the lens, and one fitted onto the raw corners
    // would slide everything reprojected through it ~20 px off near the page
    // corners. Every projected point is distorted back on the way out.
    const lens = lensRef.current;
    let H: Mat3 | null = null;
    if (corners) {
      const ideal = new Array<number>(8);
      for (let k = 0; k < 4; k++) {
        const [ux, uy] = lens.undistort(corners[k * 2], corners[k * 2 + 1]);
        ideal[k * 2] = ux;
        ideal[k * 2 + 1] = uy;
      }
      H = unitSquareToQuad(ideal);
    }

    if (corners) {
      const quad: [number, number][] = [
        toScreen(corners[0], corners[1]),
        toScreen(corners[2], corners[3]),
        toScreen(corners[4], corners[5]),
        toScreen(corners[6], corners[7]),
      ];
      if (showOutlineRef.current) drawSurfaceOutline(ctx, quad);

      // Markers, reprojected rather than re-detected: the registry holds every
      // tag's corners in normalized surface coordinates and this frame's quad is
      // the surface→scene map, so the tags land where the localization put them.
      // Only the tags this frame actually saw are drawn.
      if (showMarkersRef.current) {
        const seen = seenMarkersRef.current[frameIdx];
        const ids = seen ?? Object.keys(registryRef.current).map(Number);
        if (H && ids.length) {
          ctx.save();
          ctx.lineWidth = 2;
          ctx.strokeStyle = MARKER_COLOR;
          ctx.fillStyle = "rgba(34,197,94,0.35)";
          for (const id of ids) {
            const tag = registryRef.current[String(id)];
            if (!tag || tag.length < 4) continue;
            ctx.beginPath();
            tag.forEach(([u, v], i) => {
              const [ix, iy] = applyMat(H, u, v);
              const [px, py] = toScreen(...lens.distort(ix, iy));
              if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    if (showVideoGazeRef.current && sample) {
      // Where on the page to measure the ring: the gaze itself when it landed
      // there, the page centre otherwise, so a cursor drifting off the paper
      // keeps the size it had on it instead of jumping.
      const u = sample.paper_x ?? 0.5;
      const v = sample.paper_y ?? 0.5;
      const rScene = H
        ? ringRadiusInScenePx(H, lens, Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)), paperRef.current)
        : RING_R_SCENE_FALLBACK;
      const [gx, gy] = toScreen(sample.pred_gaze_x, sample.pred_gaze_y);
      drawGazeRing(ctx, gx, gy, rScene * scale);
    }
  }, []);

  // ─── RAF loop: the video drives everything ─────────────────────────────────

  useEffect(() => {
    if (!recording) return;

    const tick = () => {
      const v = videoRef.current;
      const t = v ? v.currentTime : 0;

      if (dirtyRef.current || t !== lastDrawnRef.current) {
        dirtyRef.current = false;
        lastDrawnRef.current = t;
        const idx = frameAt(t);
        const sample = sampleAt(t, idx);
        drawPaper(sample);
        drawOverlay(idx, sample);
        // Coarser than the frame rate: this only feeds the scrubber, the clock
        // label and the segment-following tabs.
        setCurrentTime(prev => (Math.abs(prev - t) > 0.05 ? t : prev));
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [recording, frameAt, sampleAt, drawPaper, drawOverlay]);

  // Repaint on resize — the overlay is laid out in screen pixels
  useEffect(() => {
    const onResize = () => { dirtyRef.current = true; };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ─── Video wiring ──────────────────────────────────────────────────────────

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => { setVideoDuration(v.duration || 0); dirtyRef.current = true; };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [recording]);

  const syncEye = (t: number) => {
    const e = eyeVideoRef.current;
    if (e && Number.isFinite(t)) e.currentTime = t;
  };

  const handleSeek = (t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
    syncEye(t);
    setCurrentTime(t);
    dirtyRef.current = true;
  };

  const handleTogglePlay = () => {
    const v = videoRef.current;
    const e = eyeVideoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.duration && v.currentTime >= v.duration - 0.01) { v.currentTime = 0; syncEye(0); }
      v.play().catch(() => { /* autoplay policies: the click itself is the gesture */ });
      e?.play().catch(() => {});
    } else {
      v.pause();
      e?.pause();
    }
  };

  const handleReset = () => {
    const v = videoRef.current;
    if (v) { v.pause(); v.currentTime = 0; }
    syncEye(0);
    eyeVideoRef.current?.pause();
    setCurrentTime(0);
    dirtyRef.current = true;
  };

  const setSpeed = (s: number) => {
    setPlaybackSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
    if (eyeVideoRef.current) eyeVideoRef.current.playbackRate = s;
  };

  // Keep the eye PiP from drifting away from the scene video
  useEffect(() => {
    const e = eyeVideoRef.current;
    const v = videoRef.current;
    if (!e || !v || !showEye) return;
    e.currentTime = v.currentTime;
    e.playbackRate = playbackSpeed;
    if (!v.paused) e.play().catch(() => {});
  }, [showEye, playbackSpeed]);

  // ─── Eye PiP dragging ──────────────────────────────────────────────────────

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragOffset.current = { x: e.clientX - eyePos.x, y: e.clientY - eyePos.y };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !videoWrapRef.current) return;
    const box = videoWrapRef.current.getBoundingClientRect();
    const pipW = 180, pipH = 120;
    const x = Math.max(0, Math.min(e.clientX - dragOffset.current.x - box.left, box.width - pipW));
    const y = Math.max(0, Math.min(e.clientY - dragOffset.current.y - box.top, box.height - pipH));
    setEyePos({ x, y });
  };

  const onPointerUp = () => setDragging(false);

  // ─── Derived UI state ──────────────────────────────────────────────────────

  const duration = videoDuration || recording?.duration_sec || 0;
  const hasGaze = predictions.length > 0;
  const hasEyeVideo = !!recording?.eye_video;

  // ─── Recording selector ────────────────────────────────────────────────────

  if (!recording) {
    return (
      <RecordingPickerScreen
        recordings={recordings}
        loading={loadingRecs}
        onSelect={handleSelectRecording}
        containerProps={tourAnchor("surface.recordingList")}
        rowProps={(rec) => (isDemoRecording(rec) ? tourAnchor("surface.demoRecording") : undefined)}
        autoExpand={isDemoRecording}
        emptyIcon={Activity}
        placeholderIcon={Activity}
        placeholder="Select a recording to visualize gaze on paper"
      />
    );
  }

  // Same bare icon toggles the player uses: lit in the overlay's own colour when
  // on, dimmed when off, with the explanation in the tooltip rather than a label.
  const toggleCls = (on: boolean, onCls: string) =>
    `p-1.5 rounded transition-colors cursor-pointer ${
      on ? onCls : "text-zinc-600 hover:text-zinc-400"
    }`;

  // ─── Full layout: scene video + surface, one shared timeline ───────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-zinc-800 shrink-0">
        <button
          onClick={handleBack}
          className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          ← All Recordings
        </button>
        <span className="text-zinc-700">|</span>
        <span className="text-sm font-medium text-white">{recording.name}</span>
        {recording.wearer_name && (
          <span className="text-xs text-zinc-500">{recording.wearer_name}</span>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Segment tabs */}
          {segments.length > 0 && (
            <div className="flex items-center border-b border-zinc-800 px-2 shrink-0 bg-zinc-950"
                 {...tourAnchor("surface.segmentTabs")}>
              {segments.map(seg => (
                <button
                  key={seg.id}
                  onClick={() => handleTabChange(seg.id)}
                  className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer
                    ${activeSegId === seg.id
                      ? "border-indigo-500 text-white"
                      : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
                >
                  {seg.label}
                </button>
              ))}

              {/* Which warp the A4 canvas shows. Both come from the AoI editor:
                  the frame picked out of this recording's video, and the crisp
                  reference image uploaded for the same page. A segment that has
                  only one of them keeps the button visible but inert, so it is
                  clear what it does and why it cannot switch here. */}
              {hasSurface && (
                <button
                  onClick={handleToggleBackground}
                  disabled={!canToggleBg}
                  title={canToggleBg
                    ? "Switch the A4 background between the uploaded reference image and the video frame"
                    : bgMode === "video"
                      ? "This segment has no uploaded reference image — add one in the AoI editor"
                      : "This segment has no warped video frame — pick one in the AoI editor"}
                  className="ml-auto mr-1 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px]
                             font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700
                             transition-colors cursor-pointer
                             disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-zinc-800"
                >
                  <ImageIcon className="w-3.5 h-3.5 text-zinc-500" />
                  {bgMode === "reference" ? "Reference image" : "Video frame"}
                </button>
              )}
            </div>
          )}

          {/* Scene video (left) + warped surface (right) */}
          <div className="flex-1 min-h-0 flex gap-3 p-3 bg-zinc-950">
            {/* Scene video with the AprilTag surface overlay */}
            <div
              ref={videoWrapRef}
              {...tourAnchor("surface.scene")}
              className="relative flex-1 min-w-0 h-full bg-black rounded border border-zinc-800 overflow-hidden"
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              <video
                ref={videoRef}
                src={`${API}/api/recordings/${recording.id}/video/scene`}
                className="w-full h-full object-contain"
                muted
                playsInline
                preload="metadata"
              />
              <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />

              {/* Eye camera PiP */}
              {hasEyeVideo && (
                <div
                  className={`absolute rounded-lg overflow-hidden border-2 border-zinc-600
                              shadow-xl shadow-black/50 select-none
                              ${dragging ? "cursor-grabbing border-indigo-400" : "cursor-grab"}`}
                  style={{
                    left: eyePos.x, top: eyePos.y, width: 180, height: 120, zIndex: 10,
                    display: showEye ? "block" : "none",
                  }}
                  onPointerDown={onPointerDown}
                >
                  <video
                    ref={eyeVideoRef}
                    src={`${API}/api/recordings/${recording.id}/video/eye`}
                    className="w-full h-full object-cover"
                    muted playsInline preload="metadata"
                  />
                  <div className="absolute top-1.5 left-2 text-[10px] text-white/70
                                  bg-black/50 px-1.5 py-0.5 rounded pointer-events-none">
                    Eye Camera
                  </div>
                </div>
              )}

              {/* The overlay is drawn from surface_positions.csv — say so when it is missing */}
              {hasSurfacePositions === false && (
                <div className="absolute bottom-2 left-2 right-2 text-[11px] text-amber-200/90
                                bg-amber-900/40 border border-amber-700/50 rounded px-2 py-1.5">
                  No surface positions yet — generate <span className="font-medium">surface_positions.csv</span>{" "}
                  in the Exports panel to outline the AprilTag surface on the video.
                </div>
              )}
              {hasSurfacePositions === true && surfaceLocalized === 0 && (
                <div className="absolute bottom-2 left-2 right-2 text-[11px] text-amber-200/90
                                bg-amber-900/40 border border-amber-700/50 rounded px-2 py-1.5">
                  Surface never localized in this recording — no frame had enough registered markers.
                </div>
              )}
            </div>

            {/* Warped paper surface.

                The canvas sizes itself: its width/height attributes give it an
                intrinsic ratio, and capping both axes lets it fit whichever way
                round the sheet is. Putting the ratio on the box instead would not
                survive the width cap — with an explicit height, a clamped width
                leaves the box portrait and stretches a landscape sheet into it. */}
            <div
              className="relative shrink-0 h-full flex items-center justify-center"
              style={{ maxWidth: "45%" }}
              {...tourAnchor("surface.paper")}
            >
              {loading ? (
                <div className="flex items-center justify-center h-full gap-2 text-zinc-500 text-sm">
                  <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-400 rounded-full animate-spin" />
                  Loading…
                </div>
              ) : (
                <>
                  <canvas
                    ref={canvasRef}
                    width={paper.w}
                    height={paper.h}
                    className="block max-h-full max-w-full rounded border border-zinc-700 shadow-2xl"
                  />
                  {!hasGaze && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="bg-zinc-900/90 rounded-lg px-5 py-4 text-center border border-zinc-700">
                        <Activity className="w-6 h-6 mx-auto mb-2 text-zinc-500" />
                        <p className="text-sm text-zinc-300">No gaze data</p>
                        <p className="text-xs text-zinc-500 mt-1">Run gaze mapping first</p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Timeline + controls */}
          <div className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-4 pt-3 pb-3 space-y-2"
               {...tourAnchor("surface.timeline")}>
            <EventSeekbar
              events={events}
              duration={duration}
              currentTime={currentTime}
              onSeek={handleSeek}
              disabled={loading || !duration}
            />

            <div className="flex items-center gap-3" {...tourAnchor("surface.controls")}>
              <button
                onClick={handleReset}
                disabled={loading || !duration}
                title="Reset"
                className="p-1 text-zinc-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={handleTogglePlay}
                disabled={loading || !duration}
                className="flex items-center justify-center w-7 h-7 rounded-full bg-indigo-600 hover:bg-indigo-500
                  disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                {isPlaying
                  ? <Pause className="w-3.5 h-3.5 text-white" style={{ fill: "white" }} />
                  : <Play className="w-3.5 h-3.5 text-white ml-px" style={{ fill: "white" }} />}
              </button>

              <span className="text-xs text-zinc-400 font-mono tabular-nums">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              {/* Overlay toggles */}
              <div className="flex items-center gap-3 ml-auto" {...tourAnchor("surface.overlayToggles")}>
                <button
                  onClick={() => setShowOutline(v => !v)}
                  className={toggleCls(showOutline, "text-blue-400 hover:text-blue-300")}
                  title={showOutline ? "Hide surface outline" : "Show surface outline"}
                >
                  <Frame className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowMarkers(v => !v)}
                  className={toggleCls(showMarkers, "text-emerald-400 hover:text-emerald-300")}
                  title={showMarkers ? "Hide AprilTag markers" : "Show AprilTag markers"}
                >
                  <Square className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowVideoGaze(v => !v)}
                  className={toggleCls(showVideoGaze, "text-red-400 hover:text-red-300")}
                  title={showVideoGaze ? "Hide gaze on the scene video" : "Show gaze on the scene video"}
                >
                  <ScanEye className="w-4 h-4" />
                </button>
                {hasEyeVideo && (
                  <button
                    onClick={() => setShowEye(v => !v)}
                    className={toggleCls(showEye, "text-indigo-400 hover:text-indigo-300")}
                    title={showEye ? "Hide eye camera" : "Show eye camera"}
                  >
                    {showEye ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1 ml-3">
                {[0.25, 0.5, 1, 2].map(s => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={`text-xs px-2 py-0.5 rounded cursor-pointer transition-colors
                      ${playbackSpeed === s ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right sidebar: export panels */}
        <aside className="w-64 border-l border-zinc-800 shrink-0 overflow-y-auto bg-zinc-950"
               {...tourAnchor("surface.exports")}>
          <div className="px-2.5 py-2 border-b border-zinc-800">
            <p className="text-[10px] uppercase tracking-wider text-zinc-600">Exports</p>
          </div>
          <div className="flex flex-col gap-2.5 p-2.5">
            <div {...tourAnchor("surface.positionsPanel")}>
              <SurfacePositionsPanel
                recordingId={recording.id}
                segmentId={activeSegId}
                hasSurface={hasSurface}
                onGenerated={() => loadSurfacePositions(recording.id)}
              />
            </div>
            <div {...tourAnchor("surface.aoiFixationsPanel")}>
              <AoiFixationsPanel recordingId={recording.id} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
