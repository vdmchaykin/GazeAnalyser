import { useEffect, useState } from "react";
import { ArrowLeft, Play } from "lucide-react";
import { api } from "@/lib/api";
import { tourAnchor } from "@/lib/tour/anchors";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import { RecordingPickerScreen } from "@/components/picker/RecordingPicker";
import type { RecordingMeta } from "@/types";

interface PlayerPageProps {
  /** When provided, the player opens directly on this recording (overlay mode). */
  recordingId?: string;
  /** Pre-selected recording when navigating in from another page. */
  initialRecording?: RecordingMeta;
  /** Shown as a "Back" button in overlay mode; when absent, a recording picker is used instead. */
  onBack?: () => void;
}

export function PlayerPage({ recordingId, initialRecording, onBack }: PlayerPageProps) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(recordingId ?? initialRecording?.id ?? null);
  const [recording, setRecording] = useState<RecordingMeta | null>(initialRecording ?? null);

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .catch(console.error)
      .finally(() => setLoadingRecs(false));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setRecording(null);
      return;
    }
    api.get<RecordingMeta>(`/api/recordings/${selectedId}`)
      .then(setRecording)
      .catch(console.error);
  }, [selectedId]);

  // In overlay mode (opened from another flow), the parent controls dismissal.
  const overlay = !!onBack;
  const handleBack = () => {
    if (onBack) onBack();
    else setSelectedId(null);
  };

  if (!selectedId) {
    return (
      <RecordingPickerScreen
        recordings={recordings}
        loading={loadingRecs}
        onSelect={(rec) => setSelectedId(rec.id)}
        containerProps={tourAnchor("player.recordingList")}
        emptyIcon={Play}
        placeholder="Select a recording to play the video"
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-zinc-800 shrink-0">
        <button
          {...tourAnchor("player.back")}
          onClick={handleBack}
          className="flex items-center gap-1.5 text-zinc-400 hover:text-white
                     transition-colors text-sm cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          {overlay ? "Back" : "All Recordings"}
        </button>
        {recording && (
          <>
            <span className="text-zinc-700">|</span>
            <span className="text-sm text-white font-medium">{recording.name}</span>
            {recording.wearer_name && (
              <span className="text-xs text-zinc-500">{recording.wearer_name}</span>
            )}
          </>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        {recording ? (
          <VideoPlayer
            recordingId={selectedId}
            hasEyeVideo={!!recording.eye_video}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
