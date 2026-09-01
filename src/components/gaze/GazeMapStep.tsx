import { useEffect, useState } from "react";
import { Play, RefreshCw, CheckCircle2, PlayCircle, Trash2 } from "lucide-react";
import { confirmDialog } from "@/components/ConfirmDialog";
import { tourAnchor } from "@/lib/tour/anchors";
import type { CalibrationPoint, GazeAnalysisState, GazeSource, RecordingMeta } from "@/types";

import { API_BASE as API } from "@/lib/apiBase";

interface ResidualRow {
  point_id: number;
  true_x: number;
  true_y: number;
  pred_x: number;
  pred_y: number;
  error_px: number;
}

interface MapResult {
  // null for the cloud sources: no model is fitted, so there is no calibration error.
  mean_rmse: number | null;
  frames_with_gaze: number;
  frames_on_paper: number;
  total_frames: number;
  residuals: ResidualRow[];
  n_cloud_samples?: number;
  resampled?: boolean;
}

interface Props {
  recording: RecordingMeta;
  source: GazeSource;
  calibrationPoints: CalibrationPoint[];
  done: boolean;
  onDone: () => void;
  onDeleted: (state: GazeAnalysisState) => void;
  onOpenPlayer: (id: string) => void;
}

export function GazeMapStep({ recording, source, calibrationPoints, done: initialDone, onDone, onDeleted, onOpenPlayer }: Props) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(initialDone);
  const [result, setResult] = useState<MapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pupil Cloud samples at ~200 Hz; our own pipeline predicts on a 30-fps grid.
  // Resampling puts both on the same timestamps so the sources stay comparable.
  const [resample, setResample] = useState(true);

  const isCloud = source !== "own";

  // Load the last mapping's stats when arriving on an already-mapped recording.
  useEffect(() => {
    if (!initialDone) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/map/result`);
        if (!res.ok) return;
        const data: MapResult | null = await res.json();
        if (!cancelled && data) setResult(data);
      } catch {
        /* leave result null — falls back to the "already done" notice */
      }
    })();
    return () => { cancelled = true; };
  }, [recording.id, initialDone]);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/map?resample_30fps=${resample}`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? `HTTP ${res.status}`);
      }
      const data: MapResult = await res.json();
      setResult(data);
      setDone(true);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = async () => {
    const message = isCloud
      // Both cloud sources read the same projection, so it goes for both of them.
      ? "Delete the mapped Pupil Cloud gaze (and the fixations derived from it) for this recording?"
      : "Delete gaze mapping results for this recording?";
    if (!(await confirmDialog({ title: "Delete gaze mapping", message }))) return;
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/data/mapping`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const state: GazeAnalysisState = await res.json();
      setDone(false);
      setResult(null);
      setError(null);
      onDeleted(state);
    } catch (e) {
      setError(String(e));
    }
  };

  const pct = (n: number, d: number) => d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—";

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white">
          {isCloud ? "Step 3 — Map Gaze to Surface" : "Step 3 — Gaze Mapping"}
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          {isCloud
            ? "Pupil Cloud's gaze already lives in scene-camera pixels, so no model is fitted here — "
              + "it is only projected onto the paper surface with the AoI marker homography."
            : "Train polynomial regression on calibration points and predict gaze for all frames."}
        </p>
      </div>

      {isCloud ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Input</p>
          <p className="text-sm text-zinc-400">
            Gaze samples from <span className="text-zinc-300">csv/gaze.csv</span>, shipped with the recording.
          </p>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={resample}
              onChange={(e) => setResample(e.target.checked)}
              className="mt-0.5 accent-indigo-500 cursor-pointer"
            />
            <span>
              <span className="text-sm text-zinc-300">Resample to 30 fps</span>
              <span className="block text-xs text-zinc-500 mt-0.5">
                Puts Pupil Cloud's ~200 Hz gaze on the same timestamps our own pipeline predicts on.
                Turn it off only to work at full rate — fixation counts then are not comparable
                with the other sources.
              </span>
            </span>
          </label>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-2"
             {...tourAnchor("gaze.mapSummary")}>
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Calibration Summary</p>
          <div className="flex items-center gap-6 text-sm">
            <span className="text-zinc-400">Points collected:</span>
            <span className={`font-medium ${calibrationPoints.length === 9 ? "text-emerald-400" : "text-amber-400"}`}>
              {calibrationPoints.length} / 9
            </span>
          </div>
          {calibrationPoints.length === 0 && (
            <p className="text-xs text-amber-400">⚠ No calibration points — go back to Step 2</p>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      {done && result && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4"
             {...tourAnchor("gaze.mapResults")}>
          <div className="flex items-center gap-2 text-emerald-400">
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm font-medium">Mapping complete</span>
          </div>

          <div className="grid grid-cols-3 gap-4">
            {result.mean_rmse !== null ? (
              <Stat label="Mean RMSE" value={`${result.mean_rmse.toFixed(1)} px`} />
            ) : (
              <Stat label="Gaze samples" value={String(result.total_frames)} />
            )}
            <Stat label="Frames with gaze" value={pct(result.frames_with_gaze, result.total_frames)} />
            <Stat label="Frames on paper" value={pct(result.frames_on_paper, result.total_frames)} />
          </div>

          {isCloud && result.n_cloud_samples !== undefined && (
            <p className="text-xs text-zinc-500">
              {result.resampled
                ? `${result.n_cloud_samples} Pupil Cloud samples reduced to ${result.total_frames} at 30 fps.`
                : `${result.total_frames} Pupil Cloud samples used at their full rate.`}
            </p>
          )}

          {result.residuals.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Residuals per point</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800">
                    <th className="text-left py-1.5 font-normal">Point</th>
                    <th className="text-right py-1.5 font-normal">True</th>
                    <th className="text-right py-1.5 font-normal">Predicted</th>
                    <th className="text-right py-1.5 font-normal">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.residuals.map((r) => (
                    <tr key={r.point_id} className="border-b border-zinc-800/50 text-zinc-300">
                      <td className="py-1.5">{r.point_id}</td>
                      <td className="py-1.5 text-right">{r.true_x.toFixed(0)}, {r.true_y.toFixed(0)}</td>
                      <td className="py-1.5 text-right">{r.pred_x.toFixed(0)}, {r.pred_y.toFixed(0)}</td>
                      <td className={`py-1.5 text-right font-medium
                        ${r.error_px < 10 ? "text-emerald-400" : r.error_px < 25 ? "text-amber-400" : "text-red-400"}`}>
                        {r.error_px.toFixed(1)} px
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {done && !result && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center gap-2 text-emerald-400">
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm">Gaze mapping already done. Re-run to see residuals.</span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          {...tourAnchor("gaze.mapRun")}
          onClick={handleRun}
          disabled={running || (!isCloud && calibrationPoints.length === 0)}
          className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500
                     disabled:opacity-40 disabled:cursor-not-allowed
                     text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          {running ? (
            <><RefreshCw className="w-4 h-4 animate-spin" /> Running…</>
          ) : (
            <><Play className="w-4 h-4" />{done ? "Re-run Mapping" : "Run Gaze Mapping"}</>
          )}
        </button>
        {done && (
          <button
            {...tourAnchor("gaze.mapOpenPlayer")}
            onClick={() => onOpenPlayer(recording.id)}
            className="flex items-center gap-2 px-5 py-2 bg-emerald-700 hover:bg-emerald-600
                       text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            <PlayCircle className="w-4 h-4" />
            Open in Player
          </button>
        )}
        {done && !running && (
          <button
            onClick={handleDelete}
            className="ml-auto flex items-center gap-2 px-4 py-2 text-red-400 hover:text-red-300
                       hover:bg-red-950/40 text-sm rounded-lg transition-colors cursor-pointer"
          >
            <Trash2 className="w-4 h-4" /> Delete data
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-800 rounded-lg p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-semibold text-white mt-1">{value}</p>
    </div>
  );
}
