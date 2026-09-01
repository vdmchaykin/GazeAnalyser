import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GazeSourceSelector } from "./GazeSourceSelector";
import type { GazeAnalysisState, GazeSource } from "@/types";

/**
 * Which gaze the shown numbers come from, and a way to change it.
 *
 * Every section downstream of the Gaze wizard reads the recording's persisted
 * source, so without this the same page can show three different results with no
 * visible reason. Switching writes the recording's source — exactly what the Gaze
 * page's selector does — and asks the host page to reload from the new one.
 */
export function GazeSourcePicker({
  recordingId, disabled, align, onChanged,
}: {
  recordingId: string;
  disabled?: boolean;
  align?: "left" | "right";
  /** The persisted source changed — reload whatever this page derives from it. */
  onChanged: (source: GazeSource) => void | Promise<void>;
}) {
  const [state, setState] = useState<GazeAnalysisState | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    api.get<GazeAnalysisState>(`/api/recordings/${recordingId}/gaze/state`)
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { /* no gaze state yet — the picker stays hidden */ });
    return () => { cancelled = true; };
  }, [recordingId]);

  const handleChange = async (source: GazeSource) => {
    if (!state || source === state.source) return;
    setSwitching(true);
    try {
      const next = await api.post<GazeAnalysisState>(
        `/api/recordings/${recordingId}/gaze/source`, { source },
      );
      setState(next);
      await onChanged(next.source);
    } finally {
      setSwitching(false);
    }
  };

  if (!state) return null;

  return (
    <GazeSourceSelector
      value={state.source}
      available={state.available_sources}
      onChange={handleChange}
      disabled={disabled || switching}
      align={align}
    />
  );
}
