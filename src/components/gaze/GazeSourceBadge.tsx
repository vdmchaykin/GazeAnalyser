import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { api } from "@/lib/api";
import { GAZE_SOURCE_LABELS, type GazeAnalysisState } from "@/types";

/**
 * Which gaze the shown numbers come from.
 *
 * Every section downstream of the Gaze wizard reads the recording's persisted
 * source, so without this the same page can show three different results with no
 * visible reason. Read-only — the source is changed in the Gaze section.
 */
export function GazeSourceBadge({ recordingId }: { recordingId: string }) {
  const [state, setState] = useState<GazeAnalysisState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<GazeAnalysisState>(`/api/recordings/${recordingId}/gaze/state`)
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { /* no gaze state yet — badge stays hidden */ });
    return () => { cancelled = true; };
  }, [recordingId]);

  if (!state) return null;

  return (
    <span
      title="Gaze source for this recording — change it in the Gaze section"
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px]
                 bg-zinc-800/70 border border-zinc-700 text-zinc-400"
    >
      <Database className="w-3 h-3 text-zinc-500" />
      {GAZE_SOURCE_LABELS[state.source]}
    </span>
  );
}
