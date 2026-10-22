import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Crosshair, Pause, Play, Undo2 } from "lucide-react";
import { confirmDialog } from "@/components/ConfirmDialog";
import { useContainSize } from "@/lib/useContainSize";
import { useEyeSync } from "@/lib/useEyeSync";
import type { RecordingMeta } from "@/types";

import { API_BASE as API } from "@/lib/apiBase";
import { seekVideo, targetTime } from "@/lib/seekVideo";

export interface SheetMark {
  target_id: number;
  video_s: number;
  timestamp_ns?: number;
}

export interface SheetBlock {
  id: string;
  label: string;
  start_s: number | null;
  end_s: number | null;
  marks: SheetMark[];
}

export interface SheetTarget {
  target_id: number;
  x: number;
  y: number;
}

export interface Timeline {
  scene0_ns: number | null;
  eye0_ns: number | null;
  /** Eye video starts this many seconds after the scene video (may be negative). */
  eye_offset_s: number;
}

interface Overlay {
  t_s: number[];
  pos: ([number, number][] | null)[];
}

interface Props {
  recording: RecordingMeta;
  blocks: SheetBlock[];
  targets: SheetTarget[];
  targetsSource: string;
  onSaved: (blocks: SheetBlock[]) => void;
}

const FRAME_S = 1 / 30;
// How much video around a block's window gets target positions for the overlay
// — blocks found from AoI segments have no end, only the frame they were drawn on.
const OVERLAY_PAD_S = 5;
const OVERLAY_OPEN_END_S = 90;
// Marks are saved this long after the last change, so a crash or a closed window
// loses at most the last few seconds of work.
const AUTOSAVE_MS = 800;

/**
 * Marking the metric sheet: the 25 targets' positions are known on the paper, so
 * only the moment the wearer looks at each one is marked — in order 1 → 25, the
 * order the protocol has them looked at.
 *
 * The eye video is kept in sync with the scene by the cameras' real start times:
 * the eye camera starts later (0.9 s on some recordings), so playing both at the
 * same currentTime would show the eye almost a second away from the scene.
 */
export function GazeSheetMarkStep({ recording, blocks: initialBlocks, targets, targetsSource, onSaved }: Props) {
  const sceneRef = useRef<HTMLVideoElement>(null);
  const eyeRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoAreaRef = useRef<HTMLDivElement>(null);

  const [blocks, setBlocks] = useState<SheetBlock[]>(initialBlocks);
  const [blockIdx, setBlockIdx] = useState(0);
  const [currentTarget, setCurrentTarget] = useState(1);
  const [seekTime, setSeekTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [naturalSize, setNaturalSize] = useState({ w: 1600, h: 1200 });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Bumped on every change, so a save that lands after a newer change does not
  // report the newer one as saved.
  const versionRef = useRef(0);
  // A failed save pauses autosaving until the next change, instead of retrying
  // (and failing) every AUTOSAVE_MS.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const videoBox = useContainSize(videoAreaRef, naturalSize.w / naturalSize.h);
  const syncEye = useEyeSync(recording.id, sceneRef, eyeRef, playing);

  const block = blocks[blockIdx] as SheetBlock | undefined;
  const markOf = useMemo(() => {
    const m = new Map<number, SheetMark>();
    block?.marks.forEach((k) => m.set(k.target_id, k));
    return m;
  }, [block]);

  // ── video metadata + state sync ──────────────────────────────────────────
  useEffect(() => {
    const v = sceneRef.current;
    if (!v) return;
    const onMeta = () => {
      if (v.duration) setDuration(v.duration);
      if (v.videoWidth > 0) setNaturalSize({ w: v.videoWidth, h: v.videoHeight });
    };
    const onTime = () => setSeekTime(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    if (v.readyState >= 1) onMeta();
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
    };
  }, []);

  const seek = useCallback((t: number) => {
    const v = sceneRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(t, v.duration || t));
    seekVideo(v, clamped);
    setSeekTime(clamped);
    syncEye();
  }, [syncEye]);

  // Opening a block jumps to its start.
  useEffect(() => {
    if (!block) return;
    const first = block.marks.length ? Math.min(...block.marks.map((m) => m.video_s)) : block.start_s;
    if (first != null) {
      const v = sceneRef.current;
      if (v && v.readyState >= 1) seek(first);
      else v?.addEventListener("loadedmetadata", () => seek(first), { once: true });
    }
    const next = Array.from({ length: targets.length }, (_, i) => i + 1).find((id) => !markOf.has(id));
    setCurrentTarget(next ?? 1);
    // Only on switching blocks — not on every new mark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockIdx]);

  // Target positions for the overlay, over this block's stretch of video.
  useEffect(() => {
    if (!block || block.start_s == null) {
      setOverlay(null);
      return;
    }
    const start = block.start_s - OVERLAY_PAD_S;
    const end = block.end_s != null ? block.end_s + OVERLAY_PAD_S : block.start_s + OVERLAY_OPEN_END_S;
    let cancelled = false;
    fetch(`${API}/api/recordings/${recording.id}/gaze/validation/overlay?start_s=${start}&end_s=${end}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Overlay | null) => { if (!cancelled) setOverlay(d && d.t_s.length ? d : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [recording.id, block?.id, block?.start_s, block?.end_s]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── overlay drawing ───────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!overlay) return;
    const t = sceneRef.current?.currentTime ?? seekTime;
    // Nearest frame by time (the overlay is sorted).
    const ts = overlay.t_s;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(ts[lo - 1] - t) < Math.abs(ts[lo] - t)) lo -= 1;
    if (Math.abs(ts[lo] - t) > 0.1) return;
    const pos = overlay.pos[lo];
    if (!pos) return;

    const sx = canvas.width / naturalSize.w;
    const sy = canvas.height / naturalSize.h;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    pos.forEach(([x, y], i) => {
      const id = targets[i]?.target_id ?? i + 1;
      const cx = x * sx;
      const cy = y * sy;
      const marked = markOf.has(id);
      const current = id === currentTarget;
      ctx.beginPath();
      ctx.arc(cx, cy, current ? 13 : 7, 0, Math.PI * 2);
      ctx.fillStyle = marked ? "rgba(34, 197, 94, 0.45)" : current ? "rgba(99, 102, 241, 0.25)" : "rgba(245, 158, 11, 0.15)";
      ctx.fill();
      ctx.lineWidth = current ? 3 : 1.5;
      ctx.strokeStyle = current ? "#818cf8" : marked ? "#22c55e" : "rgba(245, 158, 11, 0.8)";
      ctx.stroke();
      if (current) {
        ctx.font = "bold 12px sans-serif";
        ctx.fillStyle = "#fff";
        ctx.fillText(String(id), cx, cy - 22);
      }
    });
  }, [overlay, seekTime, naturalSize, targets, markOf, currentTarget]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, draw]);

  // ── actions ──────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = sceneRef.current;
    const e = eyeRef.current;
    if (!v) return;
    if (playing) {
      v.pause();
      e?.pause();
    } else {
      if (v.playbackRate !== speed) v.playbackRate = speed;
      if (e && e.playbackRate !== speed) e.playbackRate = speed;
      syncEye();
      v.play();
      e?.play().catch(() => {});
    }
  }, [playing, speed, syncEye]);

  const setSpeedBoth = (s: number) => {
    setSpeed(s);
    if (sceneRef.current) sceneRef.current.playbackRate = s;
    if (eyeRef.current) eyeRef.current.playbackRate = s;
  };

  const updateMarks = (fn: (marks: SheetMark[]) => SheetMark[]) => {
    setBlocks((prev) => prev.map((b, i) => (i === blockIdx ? { ...b, marks: fn(b.marks) } : b)));
    versionRef.current += 1;
    setDirty(true);
    setSaveError(null);
  };

  const markCurrent = useCallback(() => {
    if (!block) return;
    const t = sceneRef.current?.currentTime ?? seekTime;
    const id = currentTarget;
    updateMarks((marks) => [...marks.filter((m) => m.target_id !== id), { target_id: id, video_s: t }]
      .sort((a, b) => a.target_id - b.target_id));
    if (id < targets.length) setCurrentTarget(id + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block, currentTarget, seekTime, targets.length, blockIdx]);

  const undoLast = () => {
    if (!block?.marks.length) return;
    // "Last" in the protocol's order — the highest target marked so far.
    const last = block.marks.reduce((a, b) => (b.target_id > a.target_id ? b : a));
    updateMarks((marks) => marks.filter((m) => m.target_id !== last.target_id));
    setCurrentTarget(last.target_id);
  };

  const clearBlock = async () => {
    if (!block?.marks.length) return;
    if (!(await confirmDialog({ title: `Clear ${block.label}`, message: "Remove every mark of this sheet?" }))) return;
    updateMarks(() => []);
    setCurrentTarget(1);
  };

  const save = useCallback(async () => {
    const version = versionRef.current;
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/validation/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? `HTTP ${res.status}`);
      }
      if (versionRef.current === version) setDirty(false);
      setSaveError(null);
      onSaved(blocks);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [recording.id, blocks, onSaved]);

  useEffect(() => {
    if (!dirty || saving || saveError) return;
    const id = window.setTimeout(save, AUTOSAVE_MS);
    return () => window.clearTimeout(id);
  }, [dirty, saving, save]);

  // Keyboard: Space play/pause · ←/→ one frame · M or Enter marks the current target.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target !== document.body) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); seek((sceneRef.current ? targetTime(sceneRef.current) : 0) - FRAME_S); }
      else if (e.code === "ArrowRight") { e.preventDefault(); seek((sceneRef.current ? targetTime(sceneRef.current) : 0) + FRAME_S); }
      else if (e.code === "KeyM" || e.code === "Enter") { e.preventDefault(); markCurrent(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, seek, markCurrent]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

  if (blocks.length === 0) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-sm text-zinc-400 space-y-2">
        <p>No metric sheet found in this recording.</p>
        <p className="text-xs text-zinc-500">
          Sheets are taken from <span className="text-zinc-300">metric1_begin / metric1_end</span> (and metric2_…)
          events, or from AoI segments named metric…. Add the events on the Events page, or use
          “Clicked targets” instead.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left panel — sheets + target list */}
      <div className="w-60 shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-800 flex flex-wrap gap-1">
          {blocks.map((b, i) => (
            <button
              key={b.id}
              onClick={() => setBlockIdx(i)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer
                ${i === blockIdx ? "bg-indigo-600 text-white" : "text-zinc-400 hover:bg-zinc-800"}`}
            >
              {b.label}
              <span className="ml-1 opacity-70">{b.marks.length}/{targets.length}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto py-1">
          {targets.map(({ target_id: id }) => {
            const m = markOf.get(id);
            const isCurrent = id === currentTarget;
            return (
              <button
                key={id}
                onClick={() => {
                  setCurrentTarget(id);
                  if (m) seek(m.video_s);
                }}
                className={`w-full flex items-center gap-3 px-3 py-1.5 text-left text-xs transition-colors cursor-pointer
                  ${isCurrent ? "bg-indigo-950 text-white" : "text-zinc-400 hover:bg-zinc-900"}`}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0
                  ${m ? "bg-emerald-500 text-white" : isCurrent ? "bg-indigo-600 text-white" : "bg-zinc-700 text-zinc-400"}`}>
                  {id}
                </span>
                <span className="tabular-nums">{m ? fmt(m.video_s) : isCurrent ? "← mark now" : "—"}</span>
              </button>
            );
          })}
        </div>

        <div className="p-3 border-t border-zinc-800 space-y-2">
          <button
            onClick={undoLast}
            disabled={!block?.marks.length}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700
                       disabled:opacity-40 text-zinc-300 text-xs rounded-lg transition-colors cursor-pointer"
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo last
          </button>
          <button
            onClick={clearBlock}
            disabled={!block?.marks.length}
            className="w-full px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40
                       text-zinc-300 text-xs rounded-lg transition-colors cursor-pointer"
          >
            Clear this sheet
          </button>
          <p className="text-[10px] text-zinc-500 leading-snug">
            Target positions: {targetsSource}.
          </p>
        </div>
      </div>

      {/* Right panel — video + controls */}
      <div className="flex-1 flex flex-col min-w-0">
        <div ref={videoAreaRef} className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
          {/* Exactly the video's pixels, so the overlay canvas lines up (see useContainSize) */}
          <div className="relative" style={videoBox ?? { visibility: "hidden" }}>
            <video
              ref={sceneRef}
              src={`${API}/api/recordings/${recording.id}/video/scene`}
              className="absolute inset-0 w-full h-full"
              muted
              playsInline
              preload="metadata"
            />
            <canvas ref={canvasRef} width={960} height={720} className="absolute inset-0 w-full h-full pointer-events-none" />
          </div>

          <div className="absolute top-3 left-3 bg-black/70 text-white text-xs px-3 py-1.5 rounded-lg" style={{ zIndex: 20 }}>
            {block?.label}: target <span className="font-bold">{currentTarget}</span> / {targets.length} —
            find the moment the eye lands on it, then press M
          </div>
          {!overlay && (
            <div className="absolute top-12 left-3 bg-amber-950/80 border border-amber-800 text-amber-300 text-[11px] px-3 py-1 rounded-lg"
                 style={{ zIndex: 20 }}>
              No surface geometry here — targets are not drawn. Run gaze mapping with the AoI surface defined.
            </div>
          )}

          {recording.eye_video && (
            <div className="absolute right-3 bottom-3 w-64 rounded-lg overflow-hidden border-2 border-zinc-600 shadow-xl shadow-black/50"
                 style={{ aspectRatio: "192 / 96", zIndex: 15 }}>
              <video
                ref={eyeRef}
                src={`${API}/api/recordings/${recording.id}/video/eye`}
                className="w-full h-full object-cover"
                muted
                playsInline
                preload="metadata"
              />
              <div className="absolute top-1 left-2 text-[10px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded">
                Eye camera · synced
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 space-y-2">
          <div className="flex items-center gap-3">
            <button onClick={togglePlay} className="text-white hover:text-indigo-400 transition-colors cursor-pointer shrink-0">
              {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>
            <button onClick={() => seek(seekTime - FRAME_S)} title="Previous frame (←)"
                    className="text-zinc-400 hover:text-white cursor-pointer"><ChevronLeft className="w-4 h-4" /></button>
            <button onClick={() => seek(seekTime + FRAME_S)} title="Next frame (→)"
                    className="text-zinc-400 hover:text-white cursor-pointer"><ChevronRight className="w-4 h-4" /></button>
            <div className="flex items-center gap-1">
              {[0.1, 0.25, 0.5, 1].map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeedBoth(s)}
                  className={`text-xs px-2 py-0.5 rounded transition-colors cursor-pointer
                    ${speed === s ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
                >
                  {s}×
                </button>
              ))}
            </div>
            <span className="text-xs text-zinc-400 tabular-nums w-16">{fmt(seekTime)}</span>
            <input
              type="range"
              min={0}
              max={duration}
              step={FRAME_S}
              value={seekTime}
              onChange={(e) => seek(parseFloat(e.target.value))}
              className="flex-1 accent-indigo-500 cursor-pointer"
            />
            <span className="text-xs text-zinc-400 tabular-nums w-16 text-right">{fmt(duration)}</span>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-zinc-500">Space: play/pause · ←/→: one frame · M / Enter: mark the current target</p>
            <div className="flex items-center gap-3">
              {saveError && <span className="text-xs text-red-400">Not saved: {saveError}</span>}
              <button
                onClick={markCurrent}
                className="flex items-center gap-2 px-4 py-1.5 bg-amber-600 hover:bg-amber-500
                           text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                <Crosshair className="w-4 h-4" /> Mark target {currentTarget}
              </button>
              <button
                onClick={save}
                disabled={!dirty || saving}
                className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
                           disabled:opacity-40 disabled:cursor-not-allowed
                           text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                {saving ? "Saving…" : dirty ? "Save now" : <><CheckCircle2 className="w-4 h-4" /> Saved</>}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
