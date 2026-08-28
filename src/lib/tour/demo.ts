import type { RecordingMeta } from "@/types";

/**
 * The recording the tour demonstrates on. Once a small purpose-made demo
 * recording ships with the app, point these two at it — nothing else in the
 * tour needs to change.
 */
export const DEMO_RECORDING_LABEL = "Nataly";

export function isDemoRecording(rec: Pick<RecordingMeta, "name" | "wearer_name">): boolean {
  const wanted = DEMO_RECORDING_LABEL.trim().toLowerCase();
  return (rec.wearer_name ?? "").trim().toLowerCase() === wanted
    || rec.name.trim().toLowerCase() === wanted;
}
