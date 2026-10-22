import { Fragment, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Play, RefreshCw } from "lucide-react";
import { GazeCalibrateStep } from "@/components/gaze/GazeCalibrateStep";
import {
  GazeSheetMarkStep, type SheetBlock, type SheetTarget, type Timeline,
} from "@/components/gaze/GazeSheetMarkStep";
import type { CalibrationPoint, GazeAnalysisState, RecordingMeta } from "@/types";

import { API_BASE as API } from "@/lib/apiBase";

interface PointResult {
  target_id: number;
  paper_x?: number;
  paper_y?: number;
  target_x?: number;
  target_y?: number;
  n_samples: number;
  n_used: number;
  n_tracked: number;
  overlaps_calibration?: boolean;
  accuracy_deg?: number;
  median_error_deg?: number;
  precision_rms_deg?: number | null;
  bias_x_px?: number;
  bias_y_px?: number;
}

interface Summary {
  n_points: number;
  n_points_valid: number;
  accuracy_deg?: number;
  precision_rms_deg?: number | null;
  accuracy_deg_per_point_mean?: number;
  accuracy_deg_per_point_max?: number;
  bias_x_px?: number;
  bias_y_px?: number;
  bias_deg?: number;
  samples_used_frac?: number;
  sample_rate_hz?: number | null;
}

interface BlockResult {
  id: string;
  label: string;
  kind: "sheet" | "free";
  summary: Summary;
  points: PointResult[];
}

interface SourceResult {
  label: string;
  input: string;
  blocks: BlockResult[];
  sheets_overall: Summary | null;
}

interface ValidationResult {
  window_ms: number;
  window_mode: "after" | "centered";
  outlier_deg: number;
  track_scene: boolean;
  intrinsics: "calibration.bin" | "fallback";
  sheet_targets_source: string;
  sources: Record<string, SourceResult>;
}

interface ValidationDoc {
  blocks: SheetBlock[];
  free_points: CalibrationPoint[];
  sheet: { targets: SheetTarget[]; source: string };
  timeline: Timeline;
}

interface Props {
  recording: RecordingMeta;
  targetsDone: boolean;
  onStateChange: (state: GazeAnalysisState) => void;
}

type Tab = "sheets" | "free" | "results";

const TAB_LABELS: Record<Tab, string> = {
  sheets: "1. Metric sheets",
  free: "Clicked targets",
  results: "2. Results",
};

export function GazeValidateStep({ recording, targetsDone, onStateChange }: Props) {
  const [tab, setTab] = useState<Tab>(targetsDone ? "results" : "sheets");
  const [doc, setDoc] = useState<ValidationDoc | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState(800);
  const [windowMode, setWindowMode] = useState<"after" | "centered">("after");
  const [outlierDeg, setOutlierDeg] = useState(5);
  const [trackScene, setTrackScene] = useState(true);

  // The marking views keep their marks in local state seeded once, so they only
  // mount after the saved marks have loaded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, res] = await Promise.all([
          fetch(`${API}/api/recordings/${recording.id}/gaze/validation`).then((r) => r.json()),
          fetch(`${API}/api/recordings/${recording.id}/gaze/validation/result`).then((r) => r.json()),
        ]);
        if (cancelled) return;
        setDoc(d);
        if (res) {
          setResult(res);
          setWindowMs(res.window_ms);
          setWindowMode(res.window_mode ?? "centered");
          setOutlierDeg(res.outlier_deg);
          setTrackScene(res.track_scene);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [recording.id]);

  // Any change of marks drops the stored result on the backend, and may flip the
  // step's done flag — so both are refreshed.
  const afterMarksChanged = async () => {
    setResult(null);
    try {
      const state: GazeAnalysisState = await (await fetch(`${API}/api/recordings/${recording.id}/gaze/state`)).json();
      onStateChange(state);
    } catch {
      /* the flag catches up on the next visit */
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/validation/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          window_ms: windowMs, window_mode: windowMode, outlier_deg: outlierDeg, track_scene: trackScene,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const nSheetMarks = doc?.blocks.reduce((n, b) => n + b.marks.length, 0) ?? 0;
  const nFree = doc?.free_points.length ?? 0;
  const sources = result ? Object.entries(result.sources) : [];
  const overlapping = sources.some(([, s]) => s.blocks.some((b) => b.points.some((p) => p.overlaps_calibration)));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-6 py-2 border-b border-zinc-800">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer
              ${tab === t ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"}
              ${t === "free" ? "ml-auto" : ""}`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {!doc && !error && <div className="p-8 text-sm text-zinc-500">Loading…</div>}

        {tab === "sheets" && doc && (
          <GazeSheetMarkStep
            recording={recording}
            blocks={doc.blocks}
            targets={doc.sheet.targets}
            targetsSource={doc.sheet.source}
            onSaved={(blocks) => {
              setDoc((d) => (d ? { ...d, blocks } : d));
              afterMarksChanged();
            }}
          />
        )}

        {tab === "free" && doc && (
          <GazeCalibrateStep
            kind="validation"
            recording={recording}
            existingPoints={doc.free_points}
            done={nFree > 0}
            onDone={(pts) => {
              setDoc((d) => (d ? { ...d, free_points: pts } : d));
              afterMarksChanged();
              setTab("results");
            }}
            onDeleted={(state) => {
              setDoc((d) => (d ? { ...d, free_points: [] } : d));
              setResult(null);
              onStateChange(state);
            }}
          />
        )}

        {tab === "results" && (
          <div className="p-8 max-w-5xl mx-auto space-y-8">
            <div>
              <h2 className="text-lg font-semibold text-white">Step 5 — Validation</h2>
              <p className="text-sm text-zinc-400 mt-1">
                Accuracy and precision of every gaze source against the metric sheet's 25 targets
                (and any clicked targets). Each sheet is reported separately, so a drift between the
                first and the second sheet shows up directly.
              </p>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wider">Settings</p>
              <div className="flex flex-wrap items-end gap-6">
                <NumberField label="Window per target" unit="ms" value={windowMs} step={100} onChange={setWindowMs} />
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-zinc-400">Window position</span>
                  <select
                    value={windowMode}
                    onChange={(e) => setWindowMode(e.target.value as "after" | "centered")}
                    className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-md text-sm text-white cursor-pointer"
                  >
                    <option value="after">Starts at the mark</option>
                    <option value="centered">Centred on the mark</option>
                  </select>
                </label>
                <NumberField label="Outlier threshold" unit="°" value={outlierDeg} step={0.5} onChange={setOutlierDeg} />
                <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer pb-1.5">
                  <input type="checkbox" checked={trackScene} onChange={(e) => setTrackScene(e.target.checked)}
                         className="accent-indigo-500 cursor-pointer" />
                  Clicked targets follow the paper
                </label>
              </div>
              <p className="text-xs text-zinc-500">
                A window never reaches the next mark, so it cannot take in the next target's fixation.
                Samples further than the threshold from the target are dropped (blinks, glances away);
                neighbouring sheet targets are only ~4° apart, so a threshold above that lets a
                look at the wrong target through.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleRun}
                disabled={running || (nSheetMarks === 0 && nFree === 0)}
                className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500
                           disabled:opacity-40 disabled:cursor-not-allowed
                           text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                {running
                  ? <><RefreshCw className="w-4 h-4 animate-spin" /> Running…</>
                  : <><Play className="w-4 h-4" />{result ? "Re-run Validation" : "Run Validation"}</>}
              </button>
              <span className="text-xs text-zinc-500">
                {nSheetMarks + nFree > 0
                  ? [
                      nSheetMarks > 0 && `${nSheetMarks} sheet mark${nSheetMarks === 1 ? "" : "s"}`,
                      nFree > 0 && `${nFree} clicked target${nFree === 1 ? "" : "s"}`,
                    ].filter(Boolean).join(" · ")
                  : "Nothing marked yet — start in “Metric sheets”"}
              </span>
            </div>

            {error && (
              <div className="px-4 py-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm">{error}</div>
            )}

            {result && (
              <>
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
                  <div className="flex items-center gap-2 text-emerald-400">
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="text-sm font-medium">Validation complete</span>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-zinc-500 border-b border-zinc-800">
                        <th className="text-left py-1.5 font-normal">Source</th>
                        <th className="text-left py-1.5 font-normal">Targets</th>
                        <th className="text-right py-1.5 font-normal">Accuracy</th>
                        <th className="text-right py-1.5 font-normal">Worst target</th>
                        <th className="text-right py-1.5 font-normal">Precision (RMS)</th>
                        <th className="text-right py-1.5 font-normal">Bias (x, y)</th>
                        <th className="text-right py-1.5 font-normal">Samples used</th>
                        <th className="text-right py-1.5 font-normal">Targets valid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.map(([id, s]) => {
                        const rows: [string, Summary, boolean][] = s.blocks.map((b) => [b.label, b.summary, false]);
                        if (s.sheets_overall) rows.push(["All sheets", s.sheets_overall, true]);
                        return rows.map(([label, sm, total], i) => (
                          <tr key={`${id}-${label}`}
                              className={`border-zinc-800/50 text-zinc-300 ${i === rows.length - 1 ? "border-b border-zinc-700" : "border-b"}`}>
                            <td className="py-1.5 align-top">
                              {i === 0 && (
                                <>
                                  {s.label}
                                  <span className="block text-[10px] text-zinc-500">{s.input}</span>
                                </>
                              )}
                            </td>
                            <td className={`py-1.5 ${total ? "font-medium text-white" : ""}`}>{label}</td>
                            <td className={`py-1.5 text-right font-medium ${accuracyColor(sm.accuracy_deg)}`}>
                              {deg(sm.accuracy_deg)}
                            </td>
                            <td className="py-1.5 text-right">{deg(sm.accuracy_deg_per_point_max)}</td>
                            <td className="py-1.5 text-right">
                              {deg(sm.precision_rms_deg)}
                              {sm.sample_rate_hz != null && i === 0 && (
                                <span className="block text-[10px] text-zinc-500">at {sm.sample_rate_hz.toFixed(0)} Hz</span>
                              )}
                            </td>
                            <td className="py-1.5 text-right">
                              {sm.bias_x_px != null ? `${sm.bias_x_px.toFixed(0)}, ${sm.bias_y_px!.toFixed(0)} px` : "—"}
                              {sm.bias_deg != null && (
                                <span className="block text-[10px] text-zinc-500">{deg(sm.bias_deg)}</span>
                              )}
                            </td>
                            <td className="py-1.5 text-right">
                              {sm.samples_used_frac != null ? `${(sm.samples_used_frac * 100).toFixed(0)}%` : "—"}
                            </td>
                            <td className="py-1.5 text-right">{sm.n_points_valid} / {sm.n_points}</td>
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>

                  <DriftNote sources={sources} />

                  <p className="text-xs text-zinc-500">
                    Accuracy is the mean angle between gaze and target over every kept sample; precision is
                    the RMS of the angle between consecutive samples and depends on the sample rate. Bias is
                    gaze minus target (negative y = gaze above the target). Sheet target positions:{" "}
                    {result.sheet_targets_source}.
                    {result.intrinsics === "fallback" &&
                      " No calibration.bin in this recording — angles use Neon's nominal 15.5 px/°."}
                  </p>
                  {overlapping && (
                    <div className="flex items-start gap-2 text-xs text-amber-400">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>
                        Some clicked targets fall next to a calibration point (⚠ below). There the own pipeline
                        is tested on its training data — its error is optimistic.
                      </span>
                    </div>
                  )}
                </div>

                {sources.map(([id, s]) => (
                  <div key={id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-5">
                    <p className="text-xs text-zinc-500 uppercase tracking-wider">{s.label} — per target</p>
                    {s.blocks.map((b) => (
                      <div key={b.id} className="space-y-3">
                        <p className="text-sm text-zinc-300">{b.label}</p>
                        {b.kind === "sheet" && <SheetGrid points={b.points} />}
                        <details className="text-xs">
                          <summary className="text-zinc-500 cursor-pointer select-none">Table</summary>
                          <PointTable block={b} />
                        </details>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Accuracy change from the first sheet to the last, per source. */
function DriftNote({ sources }: { sources: [string, SourceResult][] }) {
  const lines = sources.flatMap(([id, s]) => {
    const sheets = s.blocks.filter((b) => b.kind === "sheet" && b.summary.accuracy_deg != null);
    if (sheets.length < 2) return [];
    const a = sheets[0].summary.accuracy_deg!;
    const b = sheets[sheets.length - 1].summary.accuracy_deg!;
    const d = b - a;
    return [(
      <span key={id} className="block">
        {s.label}: {sheets[0].label} {deg(a)} → {sheets[sheets.length - 1].label} {deg(b)}{" "}
        <span className={d > 0.25 ? "text-amber-400" : "text-zinc-400"}>
          ({d >= 0 ? "+" : ""}{d.toFixed(2)}°)
        </span>
      </span>
    )];
  });
  if (!lines.length) return null;
  return (
    <div className="text-xs text-zinc-300 bg-zinc-800/50 rounded-lg px-3 py-2">
      <span className="text-zinc-500 uppercase tracking-wider text-[10px]">Drift across the session</span>
      {lines}
    </div>
  );
}

/** The sheet's 5×5 layout, each target coloured by its accuracy — shows where on
 *  the page (centre vs. edges) a source loses accuracy. */
function SheetGrid({ points }: { points: PointResult[] }) {
  const byId = new Map(points.map((p) => [p.target_id, p]));
  return (
    <div className="grid grid-cols-5 gap-1 w-full max-w-sm">
      {Array.from({ length: 25 }, (_, i) => i + 1).map((id) => {
        const p = byId.get(id);
        const acc = p?.accuracy_deg;
        return (
          <div
            key={id}
            title={p ? `Target ${id}: ${deg(acc)} · ${p.n_used}/${p.n_samples} samples` : `Target ${id}: not marked`}
            className={`rounded-md px-1 py-1.5 text-center ${cellColor(p)}`}
          >
            <span className="block text-[9px] opacity-70">{id}</span>
            <span className="block text-[11px] font-medium tabular-nums">
              {p ? (acc != null ? acc.toFixed(1) : p.n_samples === 0 ? "no gaze" : ">thr") : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PointTable({ block }: { block: BlockResult }) {
  return (
    <table className="w-full text-xs mt-2">
      <thead>
        <tr className="text-zinc-500 border-b border-zinc-800">
          <th className="text-left py-1.5 font-normal">Target</th>
          {block.kind === "free" && <th className="text-right py-1.5 font-normal">Position</th>}
          <th className="text-right py-1.5 font-normal">Accuracy</th>
          <th className="text-right py-1.5 font-normal">Median</th>
          <th className="text-right py-1.5 font-normal">Precision</th>
          <th className="text-right py-1.5 font-normal">Bias (x, y)</th>
          <th className="text-right py-1.5 font-normal">Samples used</th>
        </tr>
      </thead>
      <tbody>
        {block.points.map((p) => (
          <Fragment key={p.target_id}>
            <tr className="border-b border-zinc-800/50 text-zinc-300">
              <td className="py-1.5">
                {p.target_id}
                {p.overlaps_calibration && (
                  <span className="ml-1 text-amber-400" title="Next to a calibration point">⚠</span>
                )}
              </td>
              {block.kind === "free" && <td className="py-1.5 text-right">{p.target_x}, {p.target_y}</td>}
              <td className={`py-1.5 text-right font-medium ${accuracyColor(p.accuracy_deg)}`}>{deg(p.accuracy_deg)}</td>
              <td className="py-1.5 text-right">{deg(p.median_error_deg)}</td>
              <td className="py-1.5 text-right">{deg(p.precision_rms_deg)}</td>
              <td className="py-1.5 text-right">
                {p.bias_x_px != null ? `${p.bias_x_px.toFixed(0)}, ${p.bias_y_px!.toFixed(0)} px` : "—"}
              </td>
              <td className="py-1.5 text-right">
                {p.n_samples === 0
                  ? <span className="text-red-400">no gaze</span>
                  : p.n_tracked === 0
                    ? <span className="text-red-400">no surface</span>
                    : `${p.n_used} / ${p.n_samples}`}
              </td>
            </tr>
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

const deg = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2)}°`);

function accuracyColor(v: number | null | undefined) {
  if (v == null) return "text-zinc-500";
  return v < 1 ? "text-emerald-400" : v < 2 ? "text-amber-400" : "text-red-400";
}

function cellColor(p: PointResult | undefined) {
  if (!p) return "bg-zinc-800 text-zinc-500";
  const v = p.accuracy_deg;
  if (v == null) return "bg-red-950 text-red-300";
  return v < 1 ? "bg-emerald-900/70 text-emerald-200" : v < 2 ? "bg-amber-900/60 text-amber-200" : "bg-red-900/60 text-red-200";
}

function NumberField({ label, unit, value, step, onChange }: {
  label: string; unit: string; value: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-400">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          min={step}
          step={step}
          value={value}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v) && v > 0) onChange(v);
          }}
          className="w-24 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-md text-sm text-white"
        />
        <span className="text-xs text-zinc-500">{unit}</span>
      </span>
    </label>
  );
}
