import type { Page } from "@/types";
import type { AnchorId } from "./anchors";
import { DEMO_RECORDING_LABEL } from "./demo";
import type { TourEventName } from "./events";

export type Placement = "top" | "bottom" | "left" | "right" | "center";

/** How a step is left behind. */
export type Advance =
  /** The user presses "Next" — informational steps. */
  | { type: "button" }
  /** The user clicks the highlighted element itself. */
  | { type: "click" }
  /** A page reported something happened (see events.ts). */
  | { type: "event"; event: TourEventName }
  /** Some other element showed up — e.g. a list finally has an entry. */
  | { type: "anchor"; anchor: AnchorId };

export interface TourBullet {
  /** Bold lead-in, usually the label of the button being described. */
  title?: string;
  text: string;
}

export interface TourStep {
  id: string;
  /** Tour switches to this page before showing the step. */
  page?: Page;
  /** Element to spotlight. Without one the step is shown centred. */
  anchor?: AnchorId;
  title: string;
  body: string;
  /** Numbered list rendered under `body`. */
  bullets?: TourBullet[];
  /** Closing line rendered under the list. */
  outro?: string;
  placement?: Placement;
  /** Defaults to { type: "button" }. Several conditions race — first one wins. */
  advance?: Advance | Advance[];
  /** Shown while the step waits for the user to act. */
  waitingHint?: string;
  /** Skip the step automatically when its anchor isn't on screen. */
  optional?: boolean;
  /**
   * Whether the rest of the UI is click-blocked while the step is up
   * (default true). Turn it off for steps whose action opens a dialog or
   * needs the user to roam freely.
   */
  blocking?: boolean;
  /** Offer a "Skip" while waiting for the user (default true). */
  skippable?: boolean;
}

export interface TourChapter {
  id: string;
  /** Page this chapter belongs to — used by the per-page "Show me around". */
  page: Page;
  title: string;
  steps: TourStep[];
}

const projectsChapter: TourChapter = {
  id: "projects",
  page: "projects",
  title: "Projects & Recordings",
  steps: [
    {
      id: "welcome",
      page: "projects",
      placement: "center",
      title: "Welcome",
      body:
        "This is an interactive guide in the world of gaze analysis — create a project, import a recording, " +
        "compute gaze, annotate it and export the results. " +
        "You can leave any time and start it again from the help menu.",
    },
    {
      id: "sidebar",
      page: "projects",
      anchor: "sidebar.projects",
      placement: "right",
      title: "The pipeline lives in the sidebar",
      body:
        "Each icon is one stage, roughly in the order you work through them: Projects, Player, " +
        "Gaze, Events, AoI, Surface Map, Visualise, and Export at the bottom.",
    },
    {
      id: "new-project",
      page: "projects",
      anchor: "projects.newProjectTile",
      placement: "right",
      title: "Create your first project",
      body:
        "A project groups the recordings that belong together — one study, one session or one " +
        "participant group.",
      advance: { type: "click" },
      waitingHint: "Click New Project to continue.",
    },
    {
      id: "name-project",
      page: "projects",
      anchor: "projects.newProjectForm",
      placement: "bottom",
      title: "Give it a name",
      body: "Type a name and press Create, or just hit Enter.",
      advance: { type: "event", event: "project:created" },
      waitingHint: "The tour continues once the project exists.",
    },
    {
      id: "open-project",
      page: "projects",
      anchor: "projects.projectTile",
      placement: "right",
      title: "Open the project",
      body:
        "Your project is now a tile. Click it to open it — the badge shows amount of recordings.",
      advance: { type: "click" },
      waitingHint: "Click your project tile to open it.",
    },
    {
      id: "add-recording",
      page: "projects",
      anchor: "project.addRecording",
      placement: "bottom",
      title: "Add a recording",
      body: "The project is still empty. Open the Add Recording menu.",
      advance: { type: "click" },
      waitingHint: "Click Add Recording.",
    },
    {
      id: "import-menu",
      page: "projects",
      anchor: "project.importMenu",
      placement: "left",
      title: "Two ways to get data in",
      body: "Here you have 2 options:",
      bullets: [
        {
          title: "Import new recording",
          text:
            "Unpacks a native Pupil Labs .zip into the database and attaches it to this project. " +
            "This is the one you use for your own data.",
        },
        {
          title: "Use an existing one",
          text:
            "Links a recording that was imported before — the same recording can live in several " +
            "projects at once, without being copied.",
        },
      ],
      outro: "The tour takes the second one.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "picker.demoRecording" },
      ],
    },
    {
      id: "pick-existing",
      page: "projects",
      anchor: "project.addExisting",
      placement: "left",
      title: "Open the existing recordings",
      body:
        "Click this entry. It lists everything already in the database — including the demo " +
        `recording ${DEMO_RECORDING_LABEL} the tour runs on.`,
      advance: [
        { type: "anchor", anchor: "picker.demoRecording" },
        { type: "anchor", anchor: "picker.confirmAdd" },
        { type: "anchor", anchor: "project.recordingTile" },
      ],
      blocking: false,
      waitingHint: "Click «Add existing recording».",
    },
    {
      id: "pick-demo",
      page: "projects",
      anchor: "picker.demoRecording",
      placement: "right",
      title: "Pick the demo recording",
      body:
        `${DEMO_RECORDING_LABEL} is the recording this tour walks through — short, and already ` +
        "carrying everything the later stages need. Tick it.",
      advance: [
        { type: "anchor", anchor: "picker.confirmAdd" },
        { type: "anchor", anchor: "project.recordingTile" },
      ],
      blocking: false,
      waitingHint: "Tick the highlighted recording.",
    },
    {
      id: "confirm-add",
      page: "projects",
      anchor: "picker.confirmAdd",
      placement: "bottom",
      title: "Add it to the project",
      body:
        "Add is active now. Press it — the dialog closes and the recording shows up in the project.",
      advance: { type: "anchor", anchor: "project.recordingTile" },
      blocking: false,
      waitingHint: "Press Add.",
    },
    {
      id: "recording-tile",
      page: "projects",
      anchor: "project.recordingTile",
      placement: "right",
      title: "Open the recording",
      body:
        "Every recording in the project gets a tile with its scene preview. A green Gaze badge " +
        "means gaze has already been computed for it. Click the tile to open its details.",
      advance: { type: "click" },
      waitingHint: "Click the recording tile.",
    },
    {
      id: "actions",
      page: "projects",
      anchor: "recording.actions",
      placement: "left",
      title: "From here the analysis starts",
      body:
        "Calculate Gaze reconstructs where the participant looked, Annotate Events marks the " +
        "timeline, Annotate AoI draws areas of interest on the scene. Each opens the matching page " +
        "with this recording already selected. Gaze comes first — the other stages build on it.",
    },
    {
      id: "open-player",
      page: "projects",
      anchor: "recording.videoPreview",
      placement: "right",
      title: "Open the player",
      body:
        "Before running anything, look at the raw material. Click the preview — it opens the " +
        "player, where the scene video is shown with every result the pipeline has produced so " +
        "far drawn on top of it.",
      advance: { type: "click" },
      waitingHint: "Click the video preview.",
    },
  ],
};

const playerChapter: TourChapter = {
  id: "player",
  page: "player",
  title: "The Player",
  steps: [
    {
      id: "pick-recording",
      page: "player",
      anchor: "player.recordingList",
      placement: "right",
      title: "Pick what to watch",
      body:
        "Opened from the sidebar, the player starts with this list — choose a recording! " +
        "Coming from a project, the recording is already selected and this " +
        "step is skipped.",
      advance: { type: "anchor", anchor: "player.scene" },
      optional: true,
      blocking: false,
      waitingHint: "Choose a recording from the list.",
    },
    {
      id: "scene",
      page: "player",
      anchor: "player.scene",
      placement: "center",
      title: "The scene camera",
      body:
        "This is what the participant saw. Clicking anywhere on the frame starts and stops " +
        "playback — the space bar does the same. Try it now.",
      advance: { type: "click" },
      waitingHint: "Click the video to start playback.",
    },
    {
      id: "controls",
      page: "player",
      anchor: "player.controls",
      placement: "top",
      title: "The control bar",
      body:
        "Everything else lives down here: the timeline, playback controls, speed, and " +
        "different overlays that you receive after next stages.",
    },
    {
      id: "seekbar",
      page: "player",
      anchor: "player.seekbar",
      placement: "top",
      title: "Timeline",
      body:
        "Drag anywhere on the bar to jump through the recording. The filled part shows how far " +
        "along you are; every overlay follows the position instantly.",
    },
    {
      id: "transport",
      page: "player",
      anchor: "player.transport",
      placement: "top",
      title: "Play, sound and position",
      body:
        "Play/pause (or the space bar) and the current position against " +
        "the total length — useful when you note down a timestamp for an event.",
    },
    {
      id: "speed",
      page: "player",
      anchor: "player.speed",
      placement: "top",
      title: "Playback speed",
      body:
        "From 0.1× to 2×. Slow motion is what you want when checking whether the gaze dot really " +
        "sits on what the participant was looking at, or when hunting for the exact frame an " +
        "event starts.",
    },
    {
      id: "overlays",
      page: "player",
      anchor: "player.overlays",
      placement: "top",
      title: "Overlay toggles",
      body:
        "These five draw the pipeline's results on top of the video. A toggle stays greyed out " +
        "until the stage behind it has completed — so on a fresh recording most of them are dim, and " +
        "they light up as you work through next stages.",
    },
    {
      id: "gaze-toggle",
      page: "player",
      anchor: "player.gazeToggle",
      placement: "top",
      title: "Gaze point",
      body:
        "Draws the red gaze dot — the result of your own mapping. " +
        "This is the overlay you check first to judge whether the calibration worked.",
    },
    {
      id: "cloud-toggle",
      page: "player",
      anchor: "player.cloudGazeToggle",
      placement: "top",
      title: "Reference gaze",
      body:
        "Draws Pupil Cloud's own gaze in blue, next to yours. Available when the recording ships " +
        "a cloud gaze.csv. With both on, a small panel appears over the video that can connect " +
        "the two dots and report the distance between them.",
    },
    {
      id: "scanpath-toggle",
      page: "player",
      anchor: "player.scanpathToggle",
      placement: "top",
      title: "Scanpath",
      body:
        "Draws the last few seconds of fixations and the saccades between them, so you see the " +
        "path the eyes took rather than a single point.",
    },
    {
      id: "pupil-toggle",
      page: "player",
      anchor: "player.pupilToggle",
      placement: "top",
      title: "Pupil overlay",
      body:
        "Shows the detected pupil ellipses on the eye camera. " +
        "Use it to check the detections and whether the pupil was visible at all. ",
      optional: true,
    },
    {
      id: "eye-toggle",
      page: "player",
      anchor: "player.eyeToggle",
      placement: "top",
      title: "Eye camera",
      body:
        "Shows or hides the small eye-camera picture over the scene. Drag it anywhere on the " +
        "frame if it covers something you need to see.",
      optional: true,
    },
    {
      id: "fullscreen",
      page: "player",
      anchor: "player.fullscreen",
      placement: "top",
      title: "Fullscreen",
      body: "Blows the scene up to the whole screen. Escape brings you back.",
    },
    {
      id: "back",
      page: "player",
      anchor: "player.back",
      placement: "bottom",
      title: "Back to where you came from",
      body:
        "Back returns to the recording you opened the player from. That is where the analysis " +
        "starts — Calculate Gaze first.",
    },
  ],
};


const gazeChapter: TourChapter = {
  id: "gaze",
  page: "gaze",
  title: "Gaze Estimation",
  steps: [
    {
      id: "pick-recording",
      page: "gaze",
      anchor: "gaze.demoRecording",
      placement: "right",
      title: "Choose the recording",
      body:
        `Gaze analysis always runs on one recording at a time. Pick ${DEMO_RECORDING_LABEL} — the ` +
        "same one the tour has been using so far.",
      advance: { type: "anchor", anchor: "gaze.stepIndicator" },
      waitingHint: "Pick a recording from the list.",
    },
    {
      id: "overview",
      page: "gaze",
      anchor: "gaze.stepIndicator",
      placement: "bottom",
      title: "Four stages, in order",
      body:
        "This is the heart of the app: turning two eye videos into a gaze point on the scene. " +
        "Each stage feeds the next, and a stage turns green once its data exists.",
      bullets: [
        { title: "Pupils", text: "Finds the pupil in every frame of both eye videos." },
        { title: "Calibrate", text: "Marks where the participant looked at nine known moments." },
        { title: "Map", text: "Fits the model and predicts a gaze point for the whole recording." },
        { title: "Fixations", text: "Groups the gaze points into fixations and saccades." },
      ],
      outro:
        "Click any stage in this indicator to jump to it — that is also how you go back and re-run " +
        "one later. Re-running a stage invalidates the ones after it.",
    },
    {
      id: "source",
      page: "gaze",
      anchor: "gaze.sourceSelector",
      placement: "bottom",
      title: "Which gaze to work from",
      body:
        "Everything below depends on this switch, and each source keeps its own copy of the " +
        "results, so switching never overwrites another one.",
      bullets: [
        { title: "My pipeline", text: "Your own detection, calibration and mapping — all four stages." },
        { title: "Cloud gaze + my fixations", text: "Pupil Cloud's gaze, your own fixation detection." },
        { title: "Pupil Cloud", text: "Cloud's gaze and Cloud's fixations, used as a reference." },
      ],
      outro:
        "The cloud sources ship gaze with the recording, so their wizard starts at stage 3. The " +
        "tour follows «My pipeline».",
    },

    {
      id: "open-detect",
      page: "gaze",
      anchor: "gaze.stepDetect",
      placement: "bottom",
      title: "Stage 1 — Pupils",
      body: "Click Pupils to open the first stage.",
      advance: { type: "click" },
      waitingHint: "Click «Pupils» in the indicator.",
      optional: true,
    },
    {
      id: "detect-preview",
      page: "gaze",
      anchor: "gaze.detectPreview",
      placement: "top",
      title: "Check before you commit",
      body:
        "Detection runs over the whole eye video and takes minutes, so try it on one frame first. " +
        "Single frame shows every stage of the detector on the frame you pick; Live video runs it " +
        "continuously so you can watch it cope with blinks and eyelashes.",
      optional: true,
    },
    {
      id: "detect-config",
      page: "gaze",
      anchor: "gaze.detectConfig",
      placement: "top",
      title: "Detector parameters",
      body:
        "Two detectors run side by side: floodfill is the primary one, the edge-based fit is the " +
        "fallback when floodfill fails. The defaults work for most recordings — reach for these " +
        "only when the preview shows the fit missing the pupil. Every field has a tooltip " +
        "explaining what it does.",
      optional: true,
    },
    {
      id: "detect-run",
      page: "gaze",
      anchor: "gaze.detectRun",
      placement: "top",
      title: "Run the detection",
      body:
        "Starts the detector on both eye videos. Expect a few minutes; progress and a Cancel " +
        "button appear just above. When it finishes the wizard moves to Calibrate on its own.",
      outro:
        "Start it now if you like — minimise the tour while it runs, or press Next to keep reading.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "gaze.calibCanvas" },
      ],
      optional: true,
    },

    {
      id: "open-calibrate",
      page: "gaze",
      anchor: "gaze.stepCalibrate",
      placement: "bottom",
      title: "Stage 2 — Calibrate",
      body: "Click Calibrate to open the second stage.",
      advance: { type: "click" },
      waitingHint: "Click «Calibrate» in the indicator.",
      optional: true,
    },
    {
      id: "calib-canvas",
      page: "gaze",
      anchor: "gaze.calibCanvas",
      placement: "left",
      title: "Mark where they looked",
      body:
        "The participant looked at nine known targets at the start of the recording. Scrub to the " +
        "moment they fixate one, then click that spot on the scene. The app takes a short " +
        "confidence-gated window of pupil positions around that timestamp and pairs it with the " +
        "point you clicked.",
      optional: true,
    },
    {
      id: "calib-controls",
      page: "gaze",
      anchor: "gaze.calibControls",
      placement: "top",
      title: "Finding the right frame",
      body:
        "Play/pause (space bar too), slow speeds and the scrubber. The eye camera in the corner " +
        "is draggable — watch it to see when the eye actually settles on the target.",
      optional: true,
    },
    {
      id: "calib-points",
      page: "gaze",
      anchor: "gaze.calibPoints",
      placement: "right",
      title: "The nine points",
      body:
        "A tick means the point is marked; the highlighted one is what your next click records. " +
        "Undo last and Clear all fix mistakes, and you can click any number to redo just that " +
        "point.",
      optional: true,
    },
    {
      id: "calib-save",
      page: "gaze",
      anchor: "gaze.calibSave",
      placement: "top",
      title: "Save the calibration",
      body:
        "Saves the marked points and moves on to mapping. Nine points give the polynomial model " +
        "enough to work with — fewer will still save, but expect a worse fit.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "gaze.mapRun" },
      ],
      optional: true,
    },

    {
      id: "open-map",
      page: "gaze",
      anchor: "gaze.stepMap",
      placement: "bottom",
      title: "Stage 3 — Map",
      body: "Click Map to open the third stage.",
      advance: { type: "click" },
      waitingHint: "Click «Map» in the indicator.",
    },
    {
      id: "map-summary",
      page: "gaze",
      anchor: "gaze.mapSummary",
      placement: "top",
      title: "What goes in",
      body:
        "The calibration points from stage 2. Nine of them shows green; anything less is flagged, " +
        "and with none at all mapping stays disabled until you go back.",
      optional: true,
    },
    {
      id: "map-run",
      page: "gaze",
      anchor: "gaze.mapRun",
      placement: "top",
      title: "Fit and predict",
      body:
        "Fits a polynomial regression on the calibration pairs and predicts a gaze point for every " +
        "frame of the recording. Faster than detection, but still not instant.",
      outro:
        "When it finishes you get the mean RMSE — the average residual in pixels. That number is " +
        "your first sanity check: high RMSE usually means a mis-marked calibration point.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "gaze.mapResults" },
      ],
    },
    {
      id: "map-player",
      page: "gaze",
      anchor: "gaze.mapOpenPlayer",
      placement: "top",
      title: "Check it on the video",
      body:
        "The real test is watching it: this opens the player with the gaze overlay on, so you can " +
        "see whether the red dot sits on what the participant was looking at. RMSE cannot tell " +
        "you that.",
      optional: true,
    },

    {
      id: "open-fixations",
      page: "gaze",
      anchor: "gaze.stepFixations",
      placement: "bottom",
      title: "Stage 4 — Fixations",
      body: "Click Fixations to open the last stage.",
      advance: { type: "click" },
      waitingHint: "Click «Fixations» in the indicator.",
    },
    {
      id: "fix-params",
      page: "gaze",
      anchor: "gaze.fixParams",
      placement: "top",
      title: "Dispersion thresholds",
      body:
        "Fixations are found with I-DT: a run of gaze samples that stays inside a small area for " +
        "long enough counts as one fixation.",
      bullets: [
        { title: "Max dispersion", text: "How far the gaze may wander and still be the same fixation." },
        { title: "Min duration", text: "Shorter candidates are thrown away as noise." },
        { title: "Max gap", text: "A longer blink or tracking loss ends the fixation." },
      ],
      optional: true,
    },
    {
      id: "fix-run",
      page: "gaze",
      anchor: "gaze.fixRun",
      placement: "top",
      title: "Compute the fixations",
      body:
        "Produces fixations in scene coordinates, annotated with surface coordinates wherever the " +
        "gaze lands on the paper. Afterwards you get counts and durations, and the scanpath " +
        "overlay in the player comes alive.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "gaze.fixResults" },
      ],
    },
    {
      id: "wrap-up",
      page: "gaze",
      anchor: "gaze.stepIndicator",
      placement: "bottom",
      title: "All four green",
      body:
        "With every stage done, this recording has gaze and fixations, and the rest of the app " +
        "unlocks: Events for marking the timeline, AoI for areas of interest, Surface Map for " +
        "paper coordinates, Visualise for heatmaps and scanpaths, and Export for the CSVs.",
    },
  ],
};

export const CHAPTERS: TourChapter[] = [projectsChapter, playerChapter, gazeChapter];

export function getChapter(id: string): TourChapter | undefined {
  return CHAPTERS.find((c) => c.id === id);
}

export function chapterForPage(page: string): TourChapter | undefined {
  return CHAPTERS.find((c) => c.page === page);
}
