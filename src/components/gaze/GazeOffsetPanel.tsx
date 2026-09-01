import { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, Loader2, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";

/** Paper coordinates of every mapped sample, in the order the predictions arrive. */
export type PaperPreview = [number | null, number | null][];

interface OffsetState {
  source: string;
  dx: number; dy: number;
  deg_x: number; deg_y: number;
  px_per_deg: number;
  has_mapping: boolean;
  fast_reproject: boolean;
}

const RANGE = 300;     // ±300 scene px ≈ ±19° — enough for a badly slipped headset
const DEBOUNCE_MS = 180;

/**
 * Gaze offset correction for one recording (per gaze source).
 *
 * Neon reports gaze as a ray projected at a far reference depth, so on a page
 * ~50 cm away it lands ~2° above the real target (parallax); a per-wearer
 * calibration bias adds to it. Both are constant within a recording, so a single
 * (dx, dy) in scene pixels fixes them. Dragging previews the result — the backend
 * re-projects from cached per-frame geometry, no video scan — and Apply bakes it
 * into the mapped gaze and rebuilds the fixations.
 */
export function GazeOffsetPanel({
  recordingId, onPreview, onApplied,
}: {
  recordingId: string;
  onPreview: (paper: PaperPreview | null) => void;
  onApplied: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<OffsetState | null>(null);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [onPaper, setOnPaper] = useState<{ n: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    api.get<OffsetState>(`/api/recordings/${recordingId}/gaze/offset`)
      .then(s => { setState(s); setDx(s.dx); setDy(s.dy); })
      .catch(() => setState(null));
  }, [recordingId]);

  const dirty = !!state && (dx !== state.dx || dy !== state.dy);

  // Live preview: the stored offset needs no round-trip, anything else does.
  useEffect(() => {
    if (!open || !state) return;
    if (timer.current) window.clearTimeout(timer.current);
    if (!dirty) { onPreview(null); setOnPaper(null); return; }
    timer.current = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const r = await api.post<{ paper: PaperPreview; n_on_paper: number; n_samples: number }>(
          `/api/recordings/${recordingId}/gaze/offset`, { dx, dy, preview: true },
        );
        onPreview(r.paper);
        setOnPaper({ n: r.n_on_paper, total: r.n_samples });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Preview failed");
      } finally {
        setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [dx, dy, open, dirty, state, recordingId, onPreview]);

  const close = useCallback(() => {
    setOpen(false);
    if (state) { setDx(state.dx); setDy(state.dy); }
    onPreview(null);
    setOnPaper(null);
  }, [state, onPreview]);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const r = await api.post<OffsetState>(
        `/api/recordings/${recordingId}/gaze/offset`, { dx, dy, preview: false },
      );
      setState(s => (s ? { ...s, dx: r.dx, dy: r.dy, deg_x: r.deg_x, deg_y: r.deg_y } : s));
      onPreview(null);
      setOnPaper(null);
      await onApplied();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply the offset");
    } finally {
      setApplying(false);
    }
  };

  if (!state?.has_mapping) return null;

  const perDeg = state.px_per_deg || 15.5;
  const applied = state.dx !== 0 || state.dy !== 0;

  return (
    <div className="relative">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        title="Gaze offset correction"
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer
          ${open || applied ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"}`}
      >
        <Crosshair className="w-3.5 h-3.5" />
        Offset
        {applied && (
          <span className="tabular-nums opacity-80">
            {state.dx >= 0 ? "+" : ""}{Math.round(state.dx)}, {state.dy >= 0 ? "+" : ""}{Math.round(state.dy)}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-20 w-80 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-2xl">
          <p className="text-[11px] text-zinc-400 leading-snug mb-3">
            Shifts the gaze in scene pixels before it is projected onto the paper —
            for the parallax at close reading distance and the wearer's calibration bias.
          </p>

          {([["Horizontal", dx, setDx], ["Vertical", dy, setDy]] as const).map(([label, val, set]) => (
            <label key={label} className="block mb-2.5">
              <span className="flex items-center justify-between text-[11px] text-zinc-400 mb-1">
                {label}
                <span className="tabular-nums text-zinc-300">
                  {val >= 0 ? "+" : ""}{val} px · {(val / perDeg).toFixed(2)}°
                </span>
              </span>
              <input
                type="range" min={-RANGE} max={RANGE} step={1} value={val}
                onChange={e => set(Number(e.target.value))}
                className="w-full cursor-pointer"
              />
            </label>
          ))}

          {!state.fast_reproject && (
            <p className="text-[11px] text-amber-400/90 leading-snug mb-2">
              No cached surface geometry for this recording — the first change has to
              scan the scene video once (a few minutes). It is cached afterwards.
            </p>
          )}

          <div className="flex items-center gap-2 text-[11px] text-zinc-500 h-4 mb-2">
            {busy && <><Loader2 className="w-3 h-3 animate-spin" /> re-projecting…</>}
            {!busy && onPaper && <span>{onPaper.n} of {onPaper.total} samples on the paper</span>}
            {!busy && !onPaper && !dirty && applied && <span>applied offset</span>}
          </div>

          {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={apply}
              disabled={!dirty || applying || busy}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                bg-indigo-600 text-white hover:bg-indigo-500 transition-colors cursor-pointer
                disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {applying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Apply
            </button>
            <button
              onClick={() => { setDx(0); setDy(0); }}
              disabled={applying || (dx === 0 && dy === 0)}
              title="Back to the uncorrected gaze"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium
                bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors cursor-pointer
                disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Zero
            </button>
            <button
              onClick={close}
              className="px-2.5 py-1.5 rounded-md text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>

          <p className="text-[10px] text-zinc-600 mt-2 leading-snug">
            The preview redraws every view — heatmap, scanpath and AoI. Applying rewrites
            the mapped gaze, rebuilds the fixations and clears the AoI metrics export.
          </p>
        </div>
      )}
    </div>
  );
}
