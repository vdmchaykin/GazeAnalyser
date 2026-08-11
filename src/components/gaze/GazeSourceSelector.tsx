import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Database } from "lucide-react";
import { GAZE_SOURCE_LABELS, type GazeSource } from "@/types";

const DESCRIPTIONS: Record<GazeSource, string> = {
  own: "Pupil detection, calibration and I-DT fixations from this app.",
  cloud: "Pupil Cloud's gaze, resampled to 30 fps, with our own I-DT fixations.",
  cloud_native: "Pupil Cloud's gaze and Pupil Cloud's own fixations, projected onto the surface.",
};

// Why a source is unavailable — the recording simply does not ship the export.
const REQUIREMENTS: Record<GazeSource, string> = {
  own: "",
  cloud: "Needs csv/gaze.csv in the recording",
  cloud_native: "Needs csv/gaze.csv and csv/fixations.csv in the recording",
};

const ALL: GazeSource[] = ["own", "cloud", "cloud_native"];

interface Props {
  value: GazeSource;
  available: GazeSource[];
  onChange: (source: GazeSource) => void;
  disabled?: boolean;
}

/** Picks which gaze a recording is analysed from — see GazeSource. */
export function GazeSourceSelector({ value, available, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Which gaze data every step below works on"
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium
                   border border-zinc-700 text-zinc-300 hover:bg-zinc-800
                   disabled:opacity-40 disabled:cursor-not-allowed
                   transition-colors cursor-pointer"
      >
        <Database className="w-3.5 h-3.5 text-zinc-500" />
        <span className="text-zinc-500">Source:</span>
        <span style={{ color: "#fff" }}>{GAZE_SOURCE_LABELS[value]}</span>
        <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-80 z-30 bg-zinc-900 border border-zinc-700
                        rounded-lg shadow-xl overflow-hidden">
          {ALL.map((s) => {
            const usable = available.includes(s);
            return (
              <button
                key={s}
                disabled={!usable}
                onClick={() => { onChange(s); setOpen(false); }}
                className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/70 last:border-b-0
                            transition-colors ${usable ? "hover:bg-zinc-800 cursor-pointer" : "opacity-40 cursor-not-allowed"}`}
              >
                <div className="flex items-center gap-2">
                  <Check className={`w-3.5 h-3.5 ${s === value ? "text-emerald-400" : "text-transparent"}`} />
                  <span className="text-xs font-medium" style={{ color: "#fff" }}>
                    {GAZE_SOURCE_LABELS[s]}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 mt-0.5 ml-5.5 pl-0.5">
                  {usable ? DESCRIPTIONS[s] : REQUIREMENTS[s]}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
