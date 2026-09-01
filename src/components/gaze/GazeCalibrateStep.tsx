import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Pause, Play, Trash2, Undo2 } from "lucide-react";
import { confirmDialog } from "@/components/ConfirmDialog";
import { SceneAnchorPanel, type AnchorStats } from "@/components/anchor/SceneAnchorPanel";
import { useSceneAnchor, type AnchorMode } from "@/lib/useSceneAnchor";
import { tourAnchor } from "@/lib/tour/anchors";
import type { CalibrationPoint, GazeAnalysisState, RecordingMeta } from "@/types";

import { API_BASE as API } from "@/lib/apiBase";
const TOTAL_POINTS = 9;

interface Props {
  recording: RecordingMeta;
  existingPoints: CalibrationPoint[];
  done: boolean;
  onDone: (points: CalibrationPoint[]) => void;
  onDeleted: (state: GazeAnalysisState) => void;
}

export function GazeCalibrateStep({ recording, existingPoints, done: initialDone, onDone, onDeleted }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLVideoElement>(null);
  const eyeRef = useRef<HTMLVideoElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });

  const [currentPointId, setCurrentPointId] = useState(1);
  const [points, setPoints] = useState<CalibrationPoint[]>(existingPoints);
  const [seekTime, setSeekTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [naturalSize, setNaturalSize] = useState({ w: 1920, h: 1080 });
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(initialDone);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [eyePos, setEyePos] = useState({ x: null as number | null, y: null as number | null });
  const [dragging, setDragging] = useState(false);

  // A calibration point is a scene-pixel position that is only true in the frame
  // it was clicked in. Drawn unchanged it sticks to the SCREEN, drifting off the
  // paper as soon as the head-mounted camera moves — so each dot is transported
  // into the frame currently on screen, exactly as the player's scanpath does.
  const [anchorScene, setAnchorScene] = useState(true);
  const anchorStatsRef = useRef<AnchorStats>({ surface: 0, flow: 0, fixed: 0 });
  const { frameAt, makeTransport, inputsVersion, surfaceLocalized, motionSolved, loadMotion } =
    useSceneAnchor(recording.id);

  // Get duration + naturalSize from scene video metadata
  useEffect(() => {
    const v = sceneRef.current;
    if (!v) return;
    const handler = () => {
      if (v.duration) setDuration(v.duration);
      if (v.videoWidth > 0) setNaturalSize({ w: v.videoWidth, h: v.videoHeight });
    };
    v.addEventListener("loadedmetadata", handler);
    if (v.readyState >= 1) handler();
    return () => v.removeEventListener("loadedmetadata", handler);
  }, []);

  // Scene video events → sync seekTime and playing state
  useEffect(() => {
    const v = sceneRef.current;
    if (!v) return;
    const onTime = () => setSeekTime(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
    };
  }, []);

  // Canvas: transparent overlay — only draws calibration dots
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scaleX = canvas.width / naturalSize.w;
    const scaleY = canvas.height / naturalSize.h;

    // One transport per rendered frame, shared by all nine dots. Without
    // anchoring (or without the files it needs) every dot reports "fixed" and
    // stays at the pixel it was clicked at.
    const t = sceneRef.current?.currentTime ?? 0;
    const curIdx = anchorScene ? frameAt(t, duration) : -1;
    const transport = anchorScene ? makeTransport(curIdx) : null;
    const stats: AnchorStats = { surface: 0, flow: 0, fixed: 0 };

    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    points.forEach((p) => {
      let x = p.gaze_x;
      let y = p.gaze_y;
      let mode: AnchorMode = "fixed";
      if (transport) {
        [x, y, mode] = transport(p.gaze_x, p.gaze_y, frameAt(p.timestamp_ns / 1e9, duration));
      }
      stats[mode]++;

      const cx = x * scaleX;
      const cy = y * scaleY;
      // An unanchored dot is drawn hollow and dashed: it is still at its clicked
      // screen position, which is only where it belongs in its own frame.
      const anchored = mode !== "fixed";
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = anchored ? "rgba(34, 197, 94, 0.4)" : "rgba(34, 197, 94, 0.12)";
      ctx.fill();
      ctx.setLineDash(anchored ? [] : [3, 3]);
      ctx.strokeStyle = anchored ? "#22c55e" : "rgba(34, 197, 94, 0.5)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = anchored ? "#fff" : "rgba(255, 255, 255, 0.5)";
      ctx.fillText(String(p.point_id), cx, cy);
    });

    anchorStatsRef.current = stats;
    // `inputsVersion` is not read here — it is in the dependency list so the
    // dots are redrawn once the anchoring files finish loading.
  }, [points, naturalSize, anchorScene, duration, frameAt, makeTransport, inputsVersion]);

  // Redraw on any input change, and on every animation frame while the video is
  // running — the dots follow the camera, so they have to keep up with it.
  useEffect(() => { drawCanvas(); }, [drawCanvas, seekTime]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      drawCanvas();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, drawCanvas]);

  const handleScrub = (t: number) => {
    if (sceneRef.current) sceneRef.current.currentTime = t;
    if (eyeRef.current) eyeRef.current.currentTime = t;
    setSeekTime(t);
  };

  const togglePlay = useCallback(() => {
    const v = sceneRef.current;
    const e = eyeRef.current;
    if (!v) return;
    if (playing) {
      v.pause();
      e?.pause();
    } else {
      v.playbackRate = speed;
      if (e) e.playbackRate = speed;
      v.play();
      e?.play();
    }
  }, [playing, speed]);

  const handleSpeedChange = (s: number) => {
    setSpeed(s);
    if (sceneRef.current) sceneRef.current.playbackRate = s;
    if (eyeRef.current) eyeRef.current.playbackRate = s;
  };

  // Spacebar play/pause
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay]);

  const EYE_W = 200;
  const EYE_H = 133;

  const onEyePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const container = canvasContainerRef.current?.getBoundingClientRect();
    if (!container) return;
    const cur = eyePos.x !== null
      ? eyePos
      : { x: container.width - EYE_W - 12, y: container.height - EYE_H - 12 };
    dragOffset.current = {
      x: e.clientX - container.left - (cur.x ?? 0),
      y: e.clientY - container.top - (cur.y ?? 0),
    };
  };

  const onEyePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !canvasContainerRef.current) return;
    const container = canvasContainerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - dragOffset.current.x - container.left, container.width - EYE_W));
    const y = Math.max(0, Math.min(e.clientY - dragOffset.current.y - container.top, container.height - EYE_H));
    setEyePos({ x, y });
  };

  const onEyePointerUp = () => setDragging(false);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (done) setDone(false); // re-editing a saved calibration
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const gaze_x = Math.round((cx / canvas.clientWidth) * naturalSize.w);
    const gaze_y = Math.round((cy / canvas.clientHeight) * naturalSize.h);

    // The frame on screen, not the last `timeupdate` — that event only fires a
    // few times a second, and the point is anchored from the frame it names.
    const clickTime = sceneRef.current?.currentTime ?? seekTime;

    const newPoint: CalibrationPoint = {
      point_id: currentPointId,
      timestamp_ns: Math.round(clickTime * 1e9),
      gaze_x,
      gaze_y,
    };

    setPoints((prev) => {
      const filtered = prev.filter((p) => p.point_id !== currentPointId);
      return [...filtered, newPoint].sort((a, b) => a.point_id - b.point_id);
    });

    if (currentPointId < TOTAL_POINTS) setCurrentPointId((id) => id + 1);
  };

  const handleUndo = () => {
    setPoints((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setCurrentPointId(last.point_id);
      return prev.slice(0, -1);
    });
  };

  const handleDelete = async () => {
    if (!(await confirmDialog({ title: "Delete calibration", message: "Delete saved calibration? This also clears the gaze mapping for this recording." }))) return;
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/data/calibration`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const state: GazeAnalysisState = await res.json();
      setPoints([]);
      setCurrentPointId(1);
      setDone(false);
      onDeleted(state);
    } catch (e) {
      alert("Failed to delete calibration: " + String(e));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`${API}/api/recordings/${recording.id}/gaze/calibration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points }),
      });
      setDone(true);
      onDone(points);
    } catch (e) {
      alert("Failed to save calibration: " + String(e));
    } finally {
      setSaving(false);
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex h-full">
      {/* Left panel — point list */}
      <div className="w-56 shrink-0 border-r border-zinc-800 flex flex-col"
           {...tourAnchor("gaze.calibPoints")}>
        <div className="px-4 py-3 border-b border-zinc-800">
          <p className="text-xs font-medium text-white uppercase tracking-wider">Calibration Points</p>
        </div>

        <div className="flex-1 overflow-auto py-2">
          {Array.from({ length: TOTAL_POINTS }, (_, i) => i + 1).map((id) => {
            const pt = points.find((p) => p.point_id === id);
            const isCurrent = id === currentPointId && !done;
            return (
              <button
                key={id}
                onClick={() => setCurrentPointId(id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm
                            transition-colors cursor-pointer
                            ${isCurrent ? "bg-indigo-950 text-white" : "text-zinc-400 hover:bg-zinc-900"}`}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0
                  ${pt ? "bg-emerald-500 text-white" : isCurrent ? "bg-indigo-600 text-white" : "bg-zinc-700 text-zinc-400"}`}>
                  {pt ? "✓" : id}
                </span>
                <span className="truncate">
                  {pt ? `t=${formatTime(pt.timestamp_ns / 1e9)}` : id === currentPointId ? "← click here" : "—"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="p-3 border-t border-zinc-800 space-y-2">
          <button
            onClick={handleUndo}
            disabled={points.length === 0}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5
                       bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40
                       text-zinc-300 text-xs rounded-lg transition-colors cursor-pointer"
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo last
          </button>
          <button
            onClick={() => { setPoints([]); setCurrentPointId(1); }}
            disabled={points.length === 0}
            className="w-full px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40
                       text-zinc-300 text-xs rounded-lg transition-colors cursor-pointer"
          >
            Clear all
          </button>
          {done && (
            <button
              onClick={handleDelete}
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5
                         text-red-400 hover:text-red-300 hover:bg-red-950/40
                         text-xs rounded-lg transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete saved data
            </button>
          )}
        </div>

        {/* Anchoring controls + the scene-motion job the fallback path needs */}
        <SceneAnchorPanel
          recordingId={recording.id}
          anchor={anchorScene}
          onAnchorChange={setAnchorScene}
          surfaceLocalized={surfaceLocalized}
          motionSolved={motionSolved}
          statsRef={anchorStatsRef}
          onMotionReady={loadMotion}
          title="Point anchoring"
          label="Keep points on the paper"
          hintOn="Marked points follow the scene as the camera moves."
          hintOff="Marked points stay at their original screen position."
          className="border-t border-zinc-800 px-3 py-2.5"
        />
      </div>

      {/* Right panel — video + canvas overlay + controls */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Video area */}
        <div
          ref={canvasContainerRef}
          className="flex-1 relative bg-black flex items-center justify-center overflow-hidden"
          onPointerMove={onEyePointerMove}
          onPointerUp={onEyePointerUp}
        >
          {/* Aspect-ratio wrapper — video and canvas overlay are the same size */}
          <div
            className="relative"
            style={{
              aspectRatio: `${naturalSize.w} / ${naturalSize.h}`,
              maxWidth: "100%",
              maxHeight: "100%",
              width: "100%",
            }}
          >
            <video
              ref={sceneRef}
              src={`${API}/api/recordings/${recording.id}/video/scene`}
              className="absolute inset-0 w-full h-full"
              muted
              playsInline
              preload="metadata"
            />
            <canvas
              {...tourAnchor("gaze.calibCanvas")}
              ref={canvasRef}
              width={960}
              height={540}
              onClick={handleCanvasClick}
              className="absolute inset-0 w-full h-full cursor-crosshair"
            />
          </div>

          {/* Overlays */}
          {!done && (
            <div className="absolute top-3 left-3 bg-black/70 text-white text-xs px-3 py-1.5 rounded-lg" style={{ zIndex: 20 }}>
              Point {currentPointId} / {TOTAL_POINTS} — scrub to the right moment, then click
            </div>
          )}
          {done && (
            <div className="absolute top-3 left-3 flex items-center gap-2 bg-emerald-950/80
                            border border-emerald-700 text-emerald-300 text-xs px-3 py-1.5 rounded-lg"
                 style={{ zIndex: 20 }}>
              <CheckCircle2 className="w-4 h-4" /> Calibration saved
            </div>
          )}

          {/* Eye video PiP — draggable */}
          {recording.eye_video && (
            <div
              className={`absolute rounded-lg overflow-hidden border-2 border-zinc-600 shadow-xl shadow-black/50 select-none
                          ${dragging ? "cursor-grabbing border-indigo-400" : "cursor-grab"}`}
              style={{
                width: EYE_W,
                height: EYE_H,
                zIndex: 15,
                right: eyePos.x === null ? 12 : undefined,
                bottom: eyePos.y === null ? 12 : undefined,
                left: eyePos.x !== null ? eyePos.x : undefined,
                top: eyePos.y !== null ? eyePos.y : undefined,
              }}
              onPointerDown={onEyePointerDown}
            >
              <video
                ref={eyeRef}
                src={`${API}/api/recordings/${recording.id}/video/eye`}
                className="w-full h-full object-cover pointer-events-none"
                muted
                playsInline
                preload="metadata"
              />
              <div className="absolute top-1 left-2 text-[10px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded pointer-events-none">
                Eye Camera
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 space-y-2"
             {...tourAnchor("gaze.calibControls")}>
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="text-white hover:text-indigo-400 transition-colors cursor-pointer shrink-0"
            >
              {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>
            <div className="flex items-center gap-1">
              {[0.1, 0.25, 0.5, 1, 2].map((s) => (
                <button
                  key={s}
                  onClick={() => handleSpeedChange(s)}
                  className={`text-xs px-2 py-0.5 rounded transition-colors cursor-pointer
                    ${speed === s ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
                >
                  {s}×
                </button>
              ))}
            </div>
            <span className="text-xs text-zinc-400 tabular-nums w-10">{formatTime(seekTime)}</span>
            <input
              type="range"
              min={0}
              max={duration}
              step={1 / 30}
              value={seekTime}
              onChange={(e) => handleScrub(parseFloat(e.target.value))}
              className="flex-1 accent-indigo-500 cursor-pointer"
            />
            <span className="text-xs text-zinc-400 tabular-nums w-10 text-right">{formatTime(duration)}</span>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-zinc-500">
              Space: play/pause · scrub to find the right frame, then click on the scene
            </p>
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500">
                {points.length} / {TOTAL_POINTS} points marked
              </span>
              <button
                {...tourAnchor("gaze.calibSave")}
                onClick={handleSave}
                disabled={points.length === 0 || saving}
                className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
                           disabled:opacity-40 disabled:cursor-not-allowed
                           text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                {saving ? "Saving…" : done ? "Re-save" : "Save & Next →"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
