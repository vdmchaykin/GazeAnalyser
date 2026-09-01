import type { SceneIntrinsics } from "@/lib/lensDistortion";

export type Page = "projects" | "gaze" | "player" | "export" | "events" | "aoi" | "surface" | "visualisation";

/** Pages that can be opened for a specific recording. */
export type NavPage = "gaze" | "events" | "aoi" | "surface" | "visualisation";

export interface RecordingEvent {
  index: number;
  timestamp_s: number;
  name: string;
}

export interface NavState {
  page: Page;
  recordingId?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  created_at?: string;
  recording_count: number;
}

export type GazeStep = "detect" | "calibrate" | "map" | "fixations";

/**
 * Which gaze a recording is analysed from. Each source keeps its own copy of the
 * derived files, so switching never overwrites another source's results:
 *   own           our pupil detection + calibration + our I-DT fixations
 *   cloud         Pupil Cloud's gaze + our I-DT fixations
 *   cloud_native  Pupil Cloud's gaze + Pupil Cloud's own fixations
 */
export type GazeSource = "own" | "cloud" | "cloud_native";

export const GAZE_SOURCE_LABELS: Record<GazeSource, string> = {
  own: "My pipeline",
  cloud: "Cloud gaze + my fixations",
  cloud_native: "Pupil Cloud",
};

/** Steps a source actually runs — the cloud ones ship gaze instead of deriving it. */
export const GAZE_SOURCE_STEPS: Record<GazeSource, GazeStep[]> = {
  own: ["detect", "calibrate", "map", "fixations"],
  cloud: ["map", "fixations"],
  cloud_native: ["map", "fixations"],
};

export interface GazeJobStatus {
  status: "idle" | "running" | "done" | "error";
  progress?: number;
  total?: number;
  message?: string;
}

export interface CalibrationPoint {
  point_id: number;
  timestamp_ns: number;
  gaze_x: number;
  gaze_y: number;
}

export interface GazePrediction {
  timestamp_ns: number;
  pred_gaze_x: number;
  pred_gaze_y: number;
  paper_x: number | null;
  paper_y: number | null;
}

/** A gaze sample from Pupil Cloud's own export (csv/gaze.csv), in scene-camera pixels. */
export interface CloudGaze {
  timestamp_ns: number;
  x: number;
  y: number;
}

export interface PupilData {
  timestamp_ns: number;
  xL: number | null;
  yL: number | null;
  diameter_L: number | null;
  // Fitted-ellipse geometry (OpenCV fitEllipse): A/B are full axis lengths in
  // eye-video pixels, angle is the rotation of the A axis in degrees.
  A_L: number | null;
  B_L: number | null;
  angle_L: number | null;
  xR: number | null;
  yR: number | null;
  diameter_R: number | null;
  A_R: number | null;
  B_R: number | null;
  angle_R: number | null;
}

export interface GazeAnalysisState {
  /** The source these flags describe — each has its own set of derived files. */
  source: GazeSource;
  /** Sources this recording has the input data for (always includes "own"). */
  available_sources: GazeSource[];
  pupils_done: boolean;
  calibration_done: boolean;
  mapping_done: boolean;
  fixations_done: boolean;
  blinks_done: boolean;
  cloud_gaze_done: boolean;
  cloud_fixations_done: boolean;
  calibration_points: CalibrationPoint[];
}

export interface Fixation {
  fixation_id: number;
  start_ts_ns: number;
  end_ts_ns: number;
  duration_ms: number;
  x_px: number;
  y_px: number;
  on_surface: boolean;
  norm_x: number | null;
  norm_y: number | null;
}

/** Stats of the blink detection that runs with pupil detection. */
export interface BlinkResult {
  n_blinks: number;
  blinks_per_min: number;
  mean_duration_ms: number;
  median_duration_ms: number;
  /** Fraction of frames where at least one eye was tracked at all. */
  detection_quality: number;
  /** False when the tracking was too poor for the blink count to mean anything. */
  reliable: boolean;
}

export interface FixationResult {
  n_fixations: number;
  mean_duration_ms: number;
  median_duration_ms: number;
  max_duration_ms: number;
  pct_time_fixating: number;
  n_on_surface: number;
  pct_on_surface: number;
  // I-DT parameters — absent when the fixations were imported from Pupil Cloud.
  max_dispersion_deg?: number;
  min_duration_ms?: number;
  max_gap_ms?: number;
  imported_from_cloud?: boolean;
}

/** Per-scene-frame surface corners `[tl,tr,br,bl]` in scene px (null = not localized). */
export interface SurfacePositionsData {
  ts_ns: (number | null)[];
  corners: (number[] | null)[];
  /** Registered tag ids visible in each frame — absent in files served by an older backend. */
  markers?: number[][];
  /** Tag id → its 4 corners `[u,v]` in normalized surface coordinates. */
  registry?: Record<string, [number, number][]>;
  /** Scene-camera intrinsics, needed to reproject the registry accurately (null: none on file). */
  intrinsics?: SceneIntrinsics | null;
  frames: number;
  localized: number;
}

/** Per-frame egomotion: `h[i]` maps frame `i-1` onto frame `i` (null = unsolved). */
export interface SceneMotionData {
  ts_ns: (number | null)[];
  h: (number[] | null)[];
  frames: number;
  solved: number;
}

export interface SceneMotionStatus {
  status: "idle" | "running" | "done" | "error" | "cancelled";
  progress: number;
  total: number;
  solved: number;
  message?: string;
  has_file: boolean;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export interface RecordingMeta {
  id: string;
  name: string;
  wearer_name?: string;
  start_time?: number;
  duration_ns?: number;
  duration_sec?: number;
  gaze_frequency?: number;
  device_serial?: string;
  app_version?: string;
  folder_path: string;
  scene_video?: string;
  eye_video?: string;
  has_gaze_result: boolean;
  imported_at?: string;
  projects?: ProjectRef[];
}
