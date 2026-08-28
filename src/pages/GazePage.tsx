import { useEffect, useState } from "react";
import { ScanEye, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import { GAZE_SOURCE_STEPS, type RecordingMeta, type GazeStep, type GazeAnalysisState, type GazeSource } from "@/types";
import { GazeDetectStep } from "@/components/gaze/GazeDetectStep";
import { GazeCalibrateStep } from "@/components/gaze/GazeCalibrateStep";
import { GazeMapStep } from "@/components/gaze/GazeMapStep";
import { GazeFixationStep } from "@/components/gaze/GazeFixationStep";
import { GazeSourceSelector } from "@/components/gaze/GazeSourceSelector";
import { RecordingThumbnail } from "@/components/player/RecordingThumbnail";
import { tourAnchor, type AnchorId } from "@/lib/tour/anchors";
import { isDemoRecording } from "@/lib/tour/demo";

const STEP_LABELS: Record<GazeStep, string> = {
  detect: "Pupils",
  calibrate: "Calibrate",
  map: "Map",
  fixations: "Fixations",
};

// Which analysis-state flag marks a step complete.
const STEP_DONE_FLAG: Record<GazeStep, keyof GazeAnalysisState> = {
  detect: "pupils_done",
  calibrate: "calibration_done",
  map: "mapping_done",
  fixations: "fixations_done",
};

// Step numbers stay tied to the full pipeline, so "Step 3 — Gaze Mapping" means
// the same thing whichever source is selected.
const STEP_ORDER: GazeStep[] = ["detect", "calibrate", "map", "fixations"];

// Tour hooks on the step indicator — the tour drives the wizard through these.
const STEP_ANCHORS: Record<GazeStep, AnchorId> = {
  detect: "gaze.stepDetect",
  calibrate: "gaze.stepCalibrate",
  map: "gaze.stepMap",
  fixations: "gaze.stepFixations",
};
const stepNumber = (id: GazeStep) => STEP_ORDER.indexOf(id) + 1;

const EMPTY_STATE: GazeAnalysisState = {
  source: "own",
  available_sources: ["own"],
  pupils_done: false,
  calibration_done: false,
  mapping_done: false,
  fixations_done: false,
  cloud_gaze_done: false,
  cloud_fixations_done: false,
  calibration_points: [],
};

/** Which step to open for a recording, based on how far this source has got. */
function stepForState(state: GazeAnalysisState): GazeStep {
  if (state.fixations_done) return "fixations";
  if (state.mapping_done || state.calibration_done) return "map";
  if (state.pupils_done) return "calibrate";
  return GAZE_SOURCE_STEPS[state.source][0];
}

export function GazePage({ onOpenPlayer, initialRecording }: { onOpenPlayer: (id: string) => void; initialRecording?: RecordingMeta }) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [selected, setSelected] = useState<RecordingMeta | null>(initialRecording ?? null);
  const [step, setStep] = useState<GazeStep>("detect");
  const [analysisState, setAnalysisState] = useState<GazeAnalysisState>(EMPTY_STATE);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [loadingRecs, setLoadingRecs] = useState(true);
  // Gate the wizard until the recording's analysis state has loaded. Without
  // this, the "detect" step (the default) mounts before /gaze/state resolves and
  // its own detect-status check fires onDone → setStep("calibrate"), overriding
  // the correct routing on the first deep-link open.
  const [stateLoading, setStateLoading] = useState<boolean>(!!initialRecording);

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .finally(() => setLoadingRecs(false));
  }, []);

  useEffect(() => {
    if (initialRecording) fetchAnalysisState(initialRecording.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchAnalysisState = async (id: string) => {
    setStateLoading(true);
    try {
      const state = await api.get<GazeAnalysisState>(`/api/recordings/${id}/gaze/state`);
      setAnalysisState(state);
      setStep(stepForState(state));
    } catch {
      setAnalysisState(EMPTY_STATE);
      setStep("detect");
    } finally {
      setStateLoading(false);
    }
  };

  // Switching source swaps the whole set of derived files, so the wizard reloads
  // the new source's progress and lands on its first unfinished step.
  const handleSourceChange = async (source: GazeSource) => {
    if (!selected || source === analysisState.source) return;
    setSwitchingSource(true);
    try {
      const state = await api.post<GazeAnalysisState>(
        `/api/recordings/${selected.id}/gaze/source`, { source },
      );
      setAnalysisState(state);
      setStep(stepForState(state));
    } finally {
      setSwitchingSource(false);
    }
  };

  const handleSelectRecording = (rec: RecordingMeta) => {
    setSelected(rec);
    fetchAnalysisState(rec.id);
  };

  // Refresh analysis flags after a stage's data is deleted, without changing
  // which step the user is currently viewing.
  const applyState = (state: GazeAnalysisState) => setAnalysisState(state);

  const steps = GAZE_SOURCE_STEPS[analysisState.source];

  if (!selected) {
    return (
      <div className="flex h-full">
        <div className="w-80 border-r border-zinc-800 flex flex-col" {...tourAnchor("gaze.recordingList")}>
          <div className="flex-1 overflow-auto">
            {loadingRecs ? (
              <p className="text-zinc-500 text-xs p-4">Loading…</p>
            ) : recordings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
                <ScanEye className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-xs">No recordings yet</p>
              </div>
            ) : (
              recordings.map((rec) => (
                <button
                  key={rec.id}
                  {...(isDemoRecording(rec) ? tourAnchor("gaze.demoRecording") : {})}
                  onClick={() => handleSelectRecording(rec)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left
                             border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors
                             group cursor-pointer"
                >
                  <RecordingThumbnail recordingId={rec.id} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{rec.name}</p>
                    <p className="text-xs text-zinc-500">
                      {rec.wearer_name} · {formatDuration(rec.duration_sec)} · {formatDate(rec.start_time)}
                    </p>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-zinc-600" />
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          <p className="text-sm">Select a recording to start gaze analysis</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with back + step indicator */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-zinc-800">
        <button
          onClick={() => setSelected(null)}
          className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          ← All Recordings
        </button>
        <span className="text-zinc-700">|</span>
        <span className="text-sm font-medium text-white">{selected.name}</span>

        <span {...tourAnchor("gaze.sourceSelector")}>
        <GazeSourceSelector
          value={analysisState.source}
          available={analysisState.available_sources}
          onChange={handleSourceChange}
          disabled={stateLoading || switchingSource}
        />
        </span>

        <div className="flex-1" />

        {/* Step indicator — the cloud sources ship gaze instead of deriving it,
            so their wizard starts at Map and steps keep their original numbers. */}
        <div className="flex items-center gap-0" {...tourAnchor("gaze.stepIndicator")}>
          {steps.map((id, i) => {
            // A stage is "done" purely from its completion flag, independent of
            // which step is currently open — so a finished stage stays green
            // even after navigating elsewhere.
            const done = !!analysisState[STEP_DONE_FLAG[id]];
            const current = id === step;
            return (
              <div key={id} className="flex items-center">
                <button
                  {...tourAnchor(STEP_ANCHORS[id])}
                  onClick={() => setStep(id)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium
                              transition-colors cursor-pointer
                              ${current ? "bg-indigo-600 text-white" : done ? "text-emerald-400 hover:bg-zinc-800" : "text-zinc-500 hover:bg-zinc-800"}`}
                >
                  {/* Green circle (no checkmark, keeps the step number)
                      whenever the stage is complete. Number colour is set inline
                      because light theme remaps `.text-white` to dark slate. */}
                  <span
                    style={{ color: "#fff" }}
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold
                    ${done ? "bg-emerald-500" : current ? "bg-indigo-400" : "bg-zinc-700"}`}
                  >
                    {stepNumber(id)}
                  </span>
                  {STEP_LABELS[id]}
                </button>
                {i < steps.length - 1 && (
                  <div className={`w-8 h-px mx-1 ${done ? "bg-emerald-600" : "bg-zinc-700"}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-auto">
        {stateLoading && (
          <div className="p-8 text-sm text-zinc-500">Loading analysis state…</div>
        )}
        {!stateLoading && step === "detect" && (
          <GazeDetectStep
            recording={selected}
            done={analysisState.pupils_done}
            onDone={() => {
              setAnalysisState((s) => ({ ...s, pupils_done: true }));
              setStep("calibrate");
            }}
            onDeleted={applyState}
          />
        )}
        {!stateLoading && step === "calibrate" && (
          <GazeCalibrateStep
            recording={selected}
            existingPoints={analysisState.calibration_points}
            done={analysisState.calibration_done}
            onDone={(points) => {
              setAnalysisState((s) => ({ ...s, calibration_done: true, calibration_points: points }));
              setStep("map");
            }}
            onDeleted={applyState}
          />
        )}
        {!stateLoading && step === "map" && (
          <GazeMapStep
            recording={selected}
            source={analysisState.source}
            calibrationPoints={analysisState.calibration_points}
            done={analysisState.mapping_done}
            onDone={() => setAnalysisState((s) => ({ ...s, mapping_done: true }))}
            onDeleted={applyState}
            onOpenPlayer={onOpenPlayer}
          />
        )}
        {!stateLoading && step === "fixations" && (
          <GazeFixationStep
            recording={selected}
            source={analysisState.source}
            mappingDone={analysisState.mapping_done}
            done={analysisState.fixations_done}
            onDone={() => setAnalysisState((s) => ({ ...s, fixations_done: true }))}
            onDeleted={applyState}
          />
        )}
      </div>
    </div>
  );
}
