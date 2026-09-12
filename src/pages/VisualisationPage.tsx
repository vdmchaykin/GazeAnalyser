import { useEffect, useMemo, useState } from "react";
import { ChartScatter, Download, Flame, Grid3x3, Loader2, Route } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import { RecordingPickerScreen } from "@/components/picker/RecordingPicker";
import { tourAnchor } from "@/lib/tour/anchors";
import { asOrientation, paperSize, type PaperOrientation, type PaperSize } from "@/lib/paper";
import { isDemoRecording } from "@/lib/tour/demo";
import { GazeSourcePicker } from "@/components/gaze/GazeSourcePicker";
import { GazeOffsetPanel, type PaperPreview } from "@/components/gaze/GazeOffsetPanel";
import type { RecordingMeta, RecordingEvent, GazePrediction, Fixation, GazeSource } from "@/types";

// The surface (warped paper) canvas resolution comes from the annotation's sheet
// orientation — shared with AoI / Surface Map so normalized surface coords (0..1)
// map the same way everywhere.

type Mode = "heatmap" | "aoi" | "scanpath";
type AoiMetric = "dwell" | "count";

// ─── Local types (mirror the AoI editor's persisted shapes) ────────────────────

interface AoiShape {
  kind: "rect" | "ellipse" | "polygon";
  x: number; y: number; w: number; h: number;
  points?: [number, number][];
}
interface AoiArea {
  id: string; name: string; color: string; visible: boolean;
  shape: AoiShape | null;
}
interface SegmentMeta { id: string; label: string; eventPrefix: string | null; }

// ─── Palette (blue→cyan→green→yellow→red), shared by canvas + colorbar ──────────

const PALETTE_CSS =
  "linear-gradient(to top, #0000ff 0%, #00ffff 25%, #00ff00 50%, #ffff00 75%, #ff0000 100%)";

let _palette: Uint8ClampedArray | null = null;
function getPalette(): Uint8ClampedArray {
  if (_palette) return _palette;
  const c = document.createElement("canvas");
  c.width = 256; c.height = 1;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0.0, "#0000ff");
  g.addColorStop(0.25, "#00ffff");
  g.addColorStop(0.5, "#00ff00");
  g.addColorStop(0.75, "#ffff00");
  g.addColorStop(1.0, "#ff0000");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1);
  _palette = ctx.getImageData(0, 0, 256, 1).data;
  return _palette;
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

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

// [startNs, endNs] device-timestamp window for a segment. General (no prefix)
// spans the whole recording. Uses the same proportional map as Surface Map.
function segWindowNs(
  preds: GazePrediction[], events: RecordingEvent[], seg: SegmentMeta | undefined, dur: number,
): [number, number] | null {
  if (!preds.length) return null;
  const t0 = preds[0].timestamp_ns;
  const t1 = preds[preds.length - 1].timestamp_ns;
  if (!seg?.eventPrefix || !dur) return [t0, t1];
  const begin = events.find(e => e.name === `${seg.eventPrefix}_begin`);
  const end = events.find(e => e.name === `${seg.eventPrefix}_end`);
  if (!begin) return [t0, t1];
  const startNs = t0 + (begin.timestamp_s / dur) * (t1 - t0);
  const endNs = end ? t0 + (end.timestamp_s / dur) * (t1 - t0) : t1;
  return [startNs, endNs];
}

function pointInShape(px: number, py: number, s: AoiShape): boolean {
  if (s.kind === "rect") {
    return px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h;
  }
  if (s.kind === "ellipse") {
    const rx = s.w / 2, ry = s.h / 2;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (px - (s.x + rx)) / rx, dy = (py - (s.y + ry)) / ry;
    return dx * dx + dy * dy <= 1;
  }
  if (s.kind === "polygon" && s.points && s.points.length >= 3) {
    let inside = false;
    const pts = s.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      const hit = (yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }
  return false;
}

function shapeCentroid(s: AoiShape): [number, number] {
  if (s.kind === "polygon" && s.points && s.points.length) {
    const n = s.points.length;
    const sx = s.points.reduce((a, [x]) => a + x, 0) / n;
    const sy = s.points.reduce((a, [, y]) => a + y, 0) / n;
    return [sx, sy];
  }
  return [s.x + s.w / 2, s.y + s.h / 2];
}

function shapePath(ctx: CanvasRenderingContext2D, s: AoiShape, paper: PaperSize) {
  const { w: PAPER_W, h: PAPER_H } = paper;
  ctx.beginPath();
  if (s.kind === "rect") {
    ctx.rect(s.x * PAPER_W, s.y * PAPER_H, s.w * PAPER_W, s.h * PAPER_H);
  } else if (s.kind === "ellipse") {
    ctx.ellipse(
      (s.x + s.w / 2) * PAPER_W, (s.y + s.h / 2) * PAPER_H,
      (s.w / 2) * PAPER_W, (s.h / 2) * PAPER_H, 0, 0, Math.PI * 2,
    );
  } else if (s.kind === "polygon" && s.points) {
    s.points.forEach(([x, y], i) =>
      i === 0 ? ctx.moveTo(x * PAPER_W, y * PAPER_H) : ctx.lineTo(x * PAPER_W, y * PAPER_H));
    ctx.closePath();
  }
}


/**
 * The fixations as they would be with the previewed offset applied.
 *
 * A constant scene-pixel shift cannot change the I-DT segmentation (dispersion is
 * translation-invariant), which is why applying an offset only rebuilds the
 * fixation files from the same boundaries. So the preview keeps every fixation's
 * time window and re-aggregates its surface position from the previewed samples
 * inside it — the same mean-of-on-surface-members rule the backend uses.
 */
function reaggregateFixations(
  fixs: Fixation[], preds: GazePrediction[], preview: PaperPreview,
): Fixation[] {
  if (!fixs.length || preds.length !== preview.length) return fixs;

  // First sample at or after `t` (predictions arrive time-ordered).
  const firstAtOrAfter = (t: number): number => {
    let lo = 0, hi = preds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (preds[mid].timestamp_ns < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  return fixs.map(f => {
    let n = 0, on = 0, sx = 0, sy = 0;
    for (let i = firstAtOrAfter(f.start_ts_ns); i < preds.length; i++) {
      if (preds[i].timestamp_ns > f.end_ts_ns) break;
      n++;
      const [px, py] = preview[i];
      if (px !== null && py !== null) { on++; sx += px; sy += py; }
    }
    if (n === 0) return f;   // no sample in the window — leave it as stored
    return {
      ...f,
      on_surface: on >= Math.max(1, n / 2),
      norm_x: on ? sx / on : null,
      norm_y: on ? sy / on : null,
    };
  });
}

// ─── Canvas renderers ──────────────────────────────────────────────────────────

// heatmap.js-style density: accumulate soft radial blobs into a shadow buffer,
// then colorize by intensity relative to the busiest pixel (→ 0..100% colorbar).
function drawHeatmap(ctx: CanvasRenderingContext2D, pts: GazePrediction[], radius: number, paper: PaperSize) {
  if (!pts.length) return;
  const { w: PAPER_W, h: PAPER_H } = paper;
  const shadow = document.createElement("canvas");
  shadow.width = PAPER_W; shadow.height = PAPER_H;
  const sctx = shadow.getContext("2d");
  if (!sctx) return;

  sctx.globalAlpha = 0.2;
  for (const p of pts) {
    if (p.paper_x === null || p.paper_y === null) continue;
    const x = p.paper_x * PAPER_W, y = p.paper_y * PAPER_H;
    const g = sctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = g;
    sctx.beginPath();
    sctx.arc(x, y, radius, 0, Math.PI * 2);
    sctx.fill();
  }

  const img = sctx.getImageData(0, 0, PAPER_W, PAPER_H);
  const d = img.data;
  let maxA = 1;
  for (let i = 3; i < d.length; i += 4) if (d[i] > maxA) maxA = d[i];
  const lut = getPalette();
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const t = Math.min(255, Math.round((a / maxA) * 255));
    d[i] = lut[t * 4];
    d[i + 1] = lut[t * 4 + 1];
    d[i + 2] = lut[t * 4 + 2];
    d[i + 3] = Math.round(Math.min(1, a / maxA) * 255 * 0.82);
  }
  sctx.putImageData(img, 0, 0);
  ctx.drawImage(shadow, 0, 0);
}

interface AoiValue { area: AoiArea; dwell: number; count: number; }

function drawAoi(ctx: CanvasRenderingContext2D, values: AoiValue[], metric: AoiMetric, max: number,
                 paper: PaperSize) {
  const { w: PAPER_W, h: PAPER_H } = paper;
  const lut = getPalette();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const { area, dwell, count } of values) {
    if (!area.shape) continue;
    const v = metric === "dwell" ? dwell : count;
    const t = Math.max(0, Math.min(255, Math.round((v / max) * 255)));
    const r = lut[t * 4], g = lut[t * 4 + 1], b = lut[t * 4 + 2];

    shapePath(ctx, area.shape, paper);
    ctx.fillStyle = `rgba(${r},${g},${b},0.6)`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${r},${g},${b},0.95)`;
    ctx.stroke();

    // Value label at the centroid.
    const [cx, cy] = shapeCentroid(area.shape);
    const label = metric === "dwell" ? `${Math.round(dwell)} ms` : `${count}`;
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.strokeText(label, cx * PAPER_W, cy * PAPER_H);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, cx * PAPER_W, cy * PAPER_H);
  }
}

function drawScanpath(ctx: CanvasRenderingContext2D, fixs: Fixation[], paper: PaperSize) {
  if (!fixs.length) return;
  const { w: PAPER_W, h: PAPER_H } = paper;
  const pt = (f: Fixation): [number, number] => [f.norm_x! * PAPER_W, f.norm_y! * PAPER_H];

  // Saccade lines under the circles.
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(99,102,241,0.55)";
  ctx.beginPath();
  fixs.forEach((f, i) => {
    const [x, y] = pt(f);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fixation circles (radius ∝ √duration) + order number.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  fixs.forEach((f, i) => {
    const [x, y] = pt(f);
    const r = 9 + Math.sqrt(f.duration_ms) * 0.55;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(99,102,241,0.32)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(129,140,248,0.95)";
    ctx.stroke();
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText(String(i + 1), x, y);
  });
}

// Compose the downloadable bitmap: the surface canvas plus, for heatmap / AoI, a
// labelled colorbar on a white margin, so the PNG is a self-contained figure.
function buildExportCanvas(
  source: HTMLCanvasElement, mode: Mode, metric: AoiMetric, max: number, paper: PaperSize,
): HTMLCanvasElement {
  const { w: PAPER_W, h: PAPER_H } = paper;
  const hasBar = mode !== "scanpath";
  const margin = hasBar ? 150 : 0;
  const out = document.createElement("canvas");
  out.width = PAPER_W + margin;
  out.height = PAPER_H;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, 0, 0);
  if (!hasBar) return out;

  const bw = 34;
  const bx = PAPER_W + 34;
  const by = Math.round(PAPER_H * 0.15);
  const bh = Math.round(PAPER_H * 0.7);
  const g = ctx.createLinearGradient(0, by + bh, 0, by);
  g.addColorStop(0.0, "#0000ff");
  g.addColorStop(0.25, "#00ffff");
  g.addColorStop(0.5, "#00ff00");
  g.addColorStop(0.75, "#ffff00");
  g.addColorStop(1.0, "#ff0000");
  ctx.fillStyle = g;
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);

  const unit = mode === "heatmap" ? "%" : metric === "dwell" ? " ms" : "";
  const ticks: [number, string][] = [
    [by, mode === "heatmap" ? "100" : String(Math.round(max))],
    [by + bh / 2, mode === "heatmap" ? "50" : String(Math.round(max / 2))],
    [by + bh, "0"],
  ];
  ctx.fillStyle = "#111";
  ctx.font = "20px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const [y, label] of ticks) ctx.fillText(label + unit, bx + bw + 10, y);
  return out;
}

// ─── Colorbar ──────────────────────────────────────────────────────────────────

function Colorbar({ mode, metric, max }: { mode: Mode; metric: AoiMetric; max: number }) {
  if (mode === "scanpath") return null;
  const unit = mode === "heatmap" ? "%" : metric === "dwell" ? " ms" : "";
  const top = mode === "heatmap" ? "100" : String(Math.round(max));
  const mid = mode === "heatmap" ? "50" : String(Math.round(max / 2));
  return (
    <div className="flex flex-col items-center gap-2 shrink-0 pl-1" {...tourAnchor("vis.colorbar")}>
      <span className="text-[10px] text-zinc-400 tabular-nums">{top}{unit}</span>
      <div className="relative flex-1 w-3 rounded" style={{ background: PALETTE_CSS, minHeight: 120 }}>
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">
          {mid}{unit}
        </span>
      </div>
      <span className="text-[10px] text-zinc-400 tabular-nums">0{unit}</span>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────────

export function VisualisationPage({ initialRecording }: { initialRecording?: RecordingMeta }) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(true);
  const [recording, setRecording] = useState<RecordingMeta | null>(initialRecording ?? null);
  const [loading, setLoading] = useState(false);

  const [predictions, setPredictions] = useState<GazePrediction[]>([]);
  const [fixations, setFixations] = useState<Fixation[]>([]);
  const [events, setEvents] = useState<RecordingEvent[]>([]);
  const [segments, setSegments] = useState<SegmentMeta[]>([]);
  const [activeSegId, setActiveSegId] = useState("general");
  const [areas, setAreas] = useState<AoiArea[]>([]);
  const [paperImg, setPaperImg] = useState<HTMLImageElement | null>(null);
  const [orientation, setOrientation] = useState<PaperOrientation>("portrait");
  const paper = paperSize(orientation);

  const [mode, setMode] = useState<Mode>("heatmap");
  const [aoiMetric, setAoiMetric] = useState<AoiMetric>("dwell");
  const [radius, setRadius] = useState(40);
  const [saving, setSaving] = useState(false);
  // Paper coords the offset panel is previewing; null = the stored mapping.
  const [preview, setPreview] = useState<PaperPreview | null>(null);
  // The source the data on screen came from. Each source keeps its own gaze,
  // fixations and offset, so the offset panel is remounted when it changes.
  const [gazeSource, setGazeSource] = useState<GazeSource | null>(null);

  // Canvas kept in state (not a ref) so the render effect re-runs once it mounts.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  const duration = recording?.duration_sec ?? 0;

  // ─── Data loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .finally(() => setLoadingRecs(false));
  }, []);

  const loadAoiState = async (recId: string, segId: string) => {
    try {
      const state = await api.get<{
        areas: AoiArea[]; warped_image_b64: string | null; orientation?: string | null;
      }>(
        `/api/recordings/${recId}/aoi/${segId}/state`,
      );
      setAreas(state.areas ?? []);
      setOrientation(asOrientation(state.orientation));
      const b64 = state.warped_image_b64 ?? null;
      if (b64) {
        const img = new Image();
        img.onload = () => {
          setPaperImg(img);
          // The background is the ground truth for the geometry: it was warped
          // into a canvas of one orientation, and drawing it at the other
          // squeezes the page. The stored flag only answers for an empty segment.
          if (img.naturalWidth && img.naturalHeight) {
            setOrientation(img.naturalWidth > img.naturalHeight ? "landscape" : "portrait");
          }
        };
        img.src = `data:image/jpeg;base64,${b64}`;
      } else {
        setPaperImg(null);
      }
    } catch {
      setAreas([]);
      setPaperImg(null);
      setOrientation("portrait");
    }
  };

  const loadAll = async (rec: RecordingMeta) => {
    setLoading(true);
    try {
      const [preds, fixs, evts] = await Promise.all([
        api.get<GazePrediction[]>(`/api/recordings/${rec.id}/gaze/predictions`).catch(() => [] as GazePrediction[]),
        api.get<Fixation[]>(`/api/recordings/${rec.id}/gaze/fixations`).catch(() => [] as Fixation[]),
        api.get<RecordingEvent[]>(`/api/recordings/${rec.id}/events`).catch(() => [] as RecordingEvent[]),
      ]);
      setPredictions(preds);
      setFixations(fixs);
      setEvents(evts);

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
  };

  useEffect(() => {
    if (initialRecording) loadAll(initialRecording);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectRecording = async (rec: RecordingMeta) => {
    setRecording(rec);
    setPredictions([]); setFixations([]); setEvents([]); setSegments([]);
    setAreas([]); setPaperImg(null);
    await loadAll(rec);
  };

  const handleBack = () => {
    setRecording(null);
    setPredictions([]); setFixations([]); setEvents([]); setSegments([]);
    setAreas([]); setPaperImg(null);
  };

  // After an offset is applied the mapped gaze and its fixations were rewritten;
  // the AoI shapes and the segment list are untouched, so only these two reload.
  const reloadGaze = async () => {
    if (!recording) return;
    const [preds, fixs] = await Promise.all([
      api.get<GazePrediction[]>(`/api/recordings/${recording.id}/gaze/predictions`).catch(() => [] as GazePrediction[]),
      api.get<Fixation[]>(`/api/recordings/${recording.id}/gaze/fixations`).catch(() => [] as Fixation[]),
    ]);
    setPredictions(preds);
    setFixations(fixs);
    setPreview(null);
  };

  const handleSegment = async (segId: string) => {
    setActiveSegId(segId);
    if (recording) await loadAoiState(recording.id, segId);
  };

  // ─── Derived data (segment-windowed) ─────────────────────────────────────────

  const activeSeg = useMemo(() => segments.find(s => s.id === activeSegId), [segments, activeSegId]);
  const windowNs = useMemo(
    () => segWindowNs(predictions, events, activeSeg, duration),
    [predictions, events, activeSeg, duration],
  );

  // While the offset panel previews a correction, the samples keep their
  // timestamps and only their paper coords change — same order, same length.
  const shownPreds = useMemo(() => {
    if (!preview || preview.length !== predictions.length) return predictions;
    return predictions.map((p, i) => ({ ...p, paper_x: preview[i][0], paper_y: preview[i][1] }));
  }, [predictions, preview]);

  const gazePts = useMemo(() => {
    if (!windowNs) return [];
    const [lo, hi] = windowNs;
    return shownPreds.filter(p =>
      p.paper_x !== null && p.paper_y !== null && p.timestamp_ns >= lo && p.timestamp_ns <= hi);
  }, [shownPreds, windowNs]);

  // The scanpath and the AoI metrics are built from fixations, so the offset
  // preview has to reach them too — otherwise dragging the slider moves only the
  // heatmap and the three modes disagree until Apply.
  const shownFix = useMemo(
    () => (preview ? reaggregateFixations(fixations, predictions, preview) : fixations),
    [fixations, predictions, preview],
  );

  const segFix = useMemo(() => {
    const lo = windowNs?.[0] ?? -Infinity;
    const hi = windowNs?.[1] ?? Infinity;
    return shownFix
      .filter(f => f.on_surface && f.norm_x !== null && f.norm_y !== null
        && f.start_ts_ns >= lo && f.start_ts_ns <= hi)
      .sort((a, b) => a.start_ts_ns - b.start_ts_ns);
  }, [shownFix, windowNs]);

  const aoiValues = useMemo<AoiValue[]>(() => {
    return areas.filter(a => a.shape).map(area => {
      let dwell = 0, count = 0;
      for (const f of segFix) {
        if (f.norm_x === null || f.norm_y === null) continue;
        if (pointInShape(f.norm_x, f.norm_y, area.shape!)) { dwell += f.duration_ms; count++; }
      }
      return { area, dwell, count };
    });
  }, [areas, segFix]);

  const aoiMax = useMemo(
    () => Math.max(1, ...aoiValues.map(v => (aoiMetric === "dwell" ? v.dwell : v.count))),
    [aoiValues, aoiMetric],
  );

  // ─── Render ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, paper.w, paper.h);
    if (paperImg) ctx.drawImage(paperImg, 0, 0, paper.w, paper.h);
    else { ctx.fillStyle = "#e5e5e5"; ctx.fillRect(0, 0, paper.w, paper.h); }

    if (mode === "heatmap") drawHeatmap(ctx, gazePts, radius, paper);
    else if (mode === "aoi") drawAoi(ctx, aoiValues, aoiMetric, aoiMax, paper);
    else if (mode === "scanpath") drawScanpath(ctx, segFix, paper);
  }, [canvas, mode, paperImg, gazePts, segFix, aoiValues, aoiMetric, aoiMax, radius, paper.w, paper.h]);

  // Save the composited figure (surface + overlay + colorbar) as a PNG. Like the
  // CSV export, the Tauri webview can't download directly, so a native save
  // dialog picks the path and the backend writes the decoded bytes.
  const downloadPng = async () => {
    if (!canvas || !recording) return;
    setSaving(true);
    try {
      const out = buildExportCanvas(canvas, mode, aoiMetric, aoiMax, paper);
      const b64 = out.toDataURL("image/png").split(",")[1];
      const safe = `${recording.name}_${mode}_${activeSegId}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
      const dest = await save({
        defaultPath: `${safe}.png`,
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      if (!dest) return; // cancelled
      await api.post("/api/export/save-image", { dest, image_b64: b64 });
    } catch (e) {
      console.error("PNG export failed", e);
    } finally {
      setSaving(false);
    }
  };

  // ─── Recording selector ──────────────────────────────────────────────────────

  if (!recording) {
    return (
      <RecordingPickerScreen
        recordings={recordings}
        loading={loadingRecs}
        onSelect={handleSelectRecording}
        containerProps={tourAnchor("vis.recordingList")}
        rowProps={(rec) => (isDemoRecording(rec) ? tourAnchor("vis.demoRecording") : undefined)}
        autoExpand={isDemoRecording}
        emptyIcon={ChartScatter}
        placeholderIcon={ChartScatter}
        placeholder="Select a recording to visualize gaze"
      />
    );
  }

  const MODES: { id: Mode; label: string; Icon: React.ElementType }[] = [
    { id: "heatmap", label: "Heatmap", Icon: Flame },
    { id: "aoi", label: "AoI Heatmap", Icon: Grid3x3 },
    { id: "scanpath", label: "Scanpath", Icon: Route },
  ];

  const emptyMsg =
    mode === "heatmap" && gazePts.length === 0 ? "No gaze mapped onto the surface for this segment. Define the paper surface in the AoI page and run gaze mapping."
    : mode === "scanpath" && segFix.length === 0 ? "No on-surface fixations for this segment. Needs fixation detection (Gaze page) and a mapped surface."
    : mode === "aoi" && areas.length === 0 ? "No Areas of Interest defined — draw them in the AoI page first."
    : mode === "aoi" && segFix.length === 0 ? "No on-surface fixations for this segment. Run fixation detection in the Gaze page."
    : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-zinc-800 shrink-0">
        <button onClick={handleBack} className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer">
          ← All Recordings
        </button>
        <span className="text-zinc-700">|</span>
        <span className="text-sm font-medium text-white">{recording.name}</span>
        {recording.wearer_name && <span className="text-xs text-zinc-500">{recording.wearer_name}</span>}
        <div className="flex-1" />
        <GazeSourcePicker
          recordingId={recording.id}
          align="right"
          disabled={loading}
          onChanged={(source) => {
            setGazeSource(source);
            setPreview(null);
            return loadAll(recording);
          }}
        />
      </div>

      {/* Mode switch + mode controls */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 shrink-0 bg-zinc-950">
        <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5"
             {...tourAnchor("vis.modeSwitch")}>
          {MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer
                ${mode === id ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center" {...tourAnchor("vis.modeOptions")}>
          {mode === "heatmap" && (
            <label className="flex items-center gap-2 text-[11px] text-zinc-400">
              Radius
              <input
                type="range" min={15} max={80} value={radius}
                onChange={e => setRadius(Number(e.target.value))}
                className="w-28 cursor-pointer"
              />
              <span className="tabular-nums w-6 text-zinc-300">{radius}</span>
            </label>
          )}
          {mode === "aoi" && (
            <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5">
              {(["dwell", "count"] as AoiMetric[]).map(m => (
                <button
                  key={m}
                  onClick={() => setAoiMetric(m)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer
                    ${aoiMetric === m ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
                >
                  {m === "dwell" ? "Dwell time" : "Fixation count"}
                </button>
              ))}
            </div>
          )}
          </span>

          <div {...tourAnchor("vis.offsetPanel")}>
            <GazeOffsetPanel
              key={gazeSource ?? "stored"}
              recordingId={recording.id}
              onPreview={setPreview}
              onApplied={reloadGaze}
            />
          </div>

          <button
            {...tourAnchor("vis.download")}
            onClick={downloadPng}
            disabled={saving || loading || !!emptyMsg}
            title="Download as PNG"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
              bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors cursor-pointer
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            PNG
          </button>
        </div>
      </div>

      {/* Segment tabs */}
      {segments.length > 0 && (
        <div className="flex items-center border-b border-zinc-800 px-2 shrink-0 bg-zinc-950 overflow-x-auto"
             {...tourAnchor("vis.segmentTabs")}>
          {segments.map(seg => (
            <button
              key={seg.id}
              onClick={() => handleSegment(seg.id)}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap
                ${activeSegId === seg.id ? "border-indigo-500 text-white" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
            >
              {seg.label}
            </button>
          ))}
        </div>
      )}

      {/* Canvas + colorbar */}
      <div className="flex-1 overflow-hidden flex items-center justify-center gap-3 p-4 bg-zinc-950 min-h-0">
        {loading ? (
          <div className="flex items-center gap-2 text-zinc-500 text-sm">
            <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-400 rounded-full animate-spin" />
            Loading data…
          </div>
        ) : (
          <>
            {/* The canvas sizes itself from its width/height attributes: capping
                both axes fits either orientation. A ratio on the box with an
                explicit height would stretch a landscape sheet whenever the width
                cap bit first. */}
            <div
              className="relative h-full flex items-center justify-center"
              {...tourAnchor("vis.canvas")}
            >
              <canvas
                ref={setCanvas}
                width={paper.w}
                height={paper.h}
                className="block max-h-full max-w-full rounded border border-zinc-700 shadow-2xl"
              />
              {emptyMsg && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-6">
                  <div className="bg-zinc-900/90 rounded-lg px-5 py-4 text-center border border-zinc-700 max-w-xs">
                    <p className="text-sm text-zinc-300">{emptyMsg}</p>
                  </div>
                </div>
              )}
            </div>
            <Colorbar mode={mode} metric={aoiMetric} max={aoiMax} />
          </>
        )}
      </div>

      {/* Footer counts */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[11px] text-zinc-500 flex items-center gap-4"
           {...tourAnchor("vis.footer")}>
        {mode === "heatmap" && <span>{gazePts.length} gaze points</span>}
        {mode === "scanpath" && <span>{segFix.length} fixations</span>}
        {mode === "aoi" && <span>{areas.length} areas · {segFix.length} fixations</span>}
        <span className="ml-auto text-zinc-600">1 recording · project overlay coming soon</span>
      </div>
    </div>
  );
}
