import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Anchor, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { SceneMotionStatus } from "@/types";

/** How many of the currently drawn fixations each anchoring path is handling. */
export interface AnchorStats {
  surface: number;
  flow: number;
  fixed: number;
}

/**
 * Controls for the scanpath overlay's scene anchoring, plus the scene-motion job
 * that the fallback path depends on.
 *
 * Two transports are available and the overlay picks per fixation: the AoI
 * surface homography (exact, needs surface_positions.csv) and scene egomotion
 * (approximate, needs scene_motion.csv). The live counters show which one is
 * actually carrying each frame, so a poor result is attributable rather than
 * mysterious.
 */
export function ScanpathPanel({
  recordingId, anchor, onAnchorChange, surfaceLocalized, motionSolved,
  statsRef, onMotionReady,
}: {
  recordingId: string;
  anchor: boolean;
  onAnchorChange: (v: boolean) => void;
  /** Frames with a localized AoI surface, or null when the file is absent. */
  surfaceLocalized: number | null;
  /** Frame pairs with a solved homography, or null when the file is absent. */
  motionSolved: number | null;
  statsRef: React.MutableRefObject<AnchorStats>;
  onMotionReady: () => void;
}) {
  const [status, setStatus] = useState<SceneMotionStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<AnchorStats>({ surface: 0, flow: 0, fixed: 0 });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const base = `/api/recordings/${recordingId}/motion`;

  // The overlay writes its per-frame counts into a ref at 60 Hz; sample them at a
  // readable rate instead of re-rendering the panel on every animation frame.
  useEffect(() => {
    const id = setInterval(() => setStats({ ...statsRef.current }), 300);
    return () => clearInterval(id);
  }, [statsRef]);

  const fetchStatus = useCallback(async (): Promise<SceneMotionStatus | null> => {
    try {
      const s = await api.get<SceneMotionStatus>(base);
      setStatus(s);
      if (s.status !== "running" && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        if (s.status === "done") onMotionReady();
      }
      return s;
    } catch {
      return null;
    }
  }, [base, onMotionReady]);

  useEffect(() => {
    setError(null);
    fetchStatus();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId]);

  const handleCompute = async () => {
    setStarting(true);
    setError(null);
    try {
      await api.post(`${base}`, {});
      setStatus({ status: "running", progress: 0, total: 0, solved: 0, has_file: false });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(fetchStatus, 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    try { await api.post(`${base}/cancel`, {}); } catch { /* ignore */ }
    fetchStatus();
  };

  const running = status?.status === "running";
  const pct = running && status.total > 0
    ? Math.min(100, Math.round((status.progress / status.total) * 100))
    : 0;

  return (
    <div
      className="absolute bottom-4 left-4 w-60 rounded-lg border border-zinc-700
                 bg-zinc-900/90 backdrop-blur px-3 py-2.5 shadow-xl shadow-black/50"
      style={{ zIndex: 20 }}
    >
      <p className="text-[11px] font-medium text-zinc-300 mb-2 flex items-center gap-1.5">
        <Anchor className="w-3 h-3 text-amber-400" />
        Scanpath anchoring
      </p>

      <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
        <input
          type="checkbox"
          checked={anchor}
          onChange={(e) => onAnchorChange(e.target.checked)}
          className="accent-amber-500 cursor-pointer"
        />
        Keep fixations on objects
      </label>
      <p className="text-[10px] text-zinc-600 mt-0.5 mb-2 leading-snug">
        {anchor
          ? "Past fixations are transported into the current frame."
          : "Past fixations stay at their original screen position."}
      </p>

      {anchor && (
        <div className="flex flex-col gap-0.5 text-[10px] tabular-nums mb-2">
          <span className="flex items-center justify-between text-zinc-400">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              Surface homography
            </span>
            <span>{stats.surface}</span>
          </span>
          <span className="flex items-center justify-between text-zinc-400">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
              Optical flow
            </span>
            <span>{stats.flow}</span>
          </span>
          <span className="flex items-center justify-between text-zinc-500">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
              Not anchored
            </span>
            <span>{stats.fixed}</span>
          </span>
        </div>
      )}

      <div className="border-t border-zinc-800 pt-2 flex flex-col gap-1.5">
        <p className="text-[10px] text-zinc-500">
          {surfaceLocalized === null
            ? "AoI surface: not generated"
            : `AoI surface: ${surfaceLocalized} frames`}
        </p>

        {running ? (
          <>
            <div className="relative h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div className="absolute inset-y-0 left-0 bg-amber-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex items-center justify-between text-[10px] text-zinc-500">
              <span className="tabular-nums">{status.progress} / {status.total || "…"} frames</span>
              <button onClick={handleCancel} className="text-zinc-500 hover:text-red-400 cursor-pointer">
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[10px] text-zinc-500">
              {motionSolved === null
                ? "Scene motion: not computed"
                : `Scene motion: ${motionSolved} frame pairs`}
            </p>
            <button
              onClick={handleCompute}
              disabled={starting}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 w-full
                         bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed
                         text-zinc-200 text-[11px] rounded-md transition-colors cursor-pointer"
            >
              {starting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Anchor className="w-3 h-3" />}
              {motionSolved === null ? "Compute scene motion" : "Recompute scene motion"}
            </button>
          </>
        )}

        {(error || status?.status === "error") && (
          <div className="flex items-start gap-1.5 text-[10px] text-red-400">
            <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
            <span>{error || status?.message || "Computation failed"}</span>
          </div>
        )}
      </div>
    </div>
  );
}
