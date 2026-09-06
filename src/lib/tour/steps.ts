import type { Page } from "@/types";
import type { AnchorId } from "./anchors";
import { DEMO_RECORDING_LABEL } from "./demo";
import type { TourEventName } from "./events";

export type Placement = "top" | "bottom" | "left" | "right" | "center";

/** Where the tooltip sits along the anchor's edge, for top/bottom placements. */
export type Align = "start" | "center" | "end";

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
  /**
   * A second element folded into the spotlight while it is on screen — the menu
   * the anchored control opens. Without it the tooltip sits right below the
   * closed control and covers the menu the moment the user opens it.
   */
  expand?: AnchorId;
  title: string;
  body: string;
  /** Numbered list rendered under `body`. */
  bullets?: TourBullet[];
  /** Closing line rendered under the list. */
  outro?: string;
  placement?: Placement;
  /** Slides the tooltip along the anchor instead of centring it on it — the way
      to keep a step off a centred canvas the anchor spans. */
  align?: Align;
  /**
   * Whether the rest of the screen is darkened (default true). Turn it off for
   * steps that ask the user to *look at* something — a video they must scrub to
   * find a frame in is useless at 40% brightness.
   */
  dim?: boolean;
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
          title: "Add existing recording",
          text:
            "Links a recording that was imported before — the same recording can live in several " +
            "projects at once, without being copied.",
        },
        {
          title: "Import new recording",
          text:
            "Unpacks a native Pupil Labs .zip into the database and attaches it to this project. " +
            "This is the one you use for your own data.",
        },
      ],
      outro: "The tour takes the first one.",
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
      // No `page`: the tour must not jump there itself — the point of the step
      // is that the user learns where the stage lives in the sidebar.
      id: "go-to-gaze",
      anchor: "sidebar.gaze",
      placement: "right",
      title: "Open the Gaze stage",
      body:
        "Everything the recording still lacks — pupils, calibration, gaze, fixations — is made " +
        "here. Click Gaze in the sidebar.",
      advance: { type: "click" },
      waitingHint: "Click «Gaze» in the sidebar.",
    },
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
      expand: "gaze.sourceMenu",
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
        "button appear just above.",
      outro:
        "When it finishes, the wizard opens Calibrate by itself and the tour follows it — there " +
        "is nothing to click. Start it now if you like: minimise the tour while it runs, or press " +
        "Next to keep reading.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "gaze.calibCanvas" },
      ],
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
      id: "calib-your-turn",
      page: "gaze",
      anchor: "gaze.calibCanvas",
      placement: "left",
      title: "Your turn — mark the points",
      body:
        "The tour steps aside: scrub, watch the eye camera, and click each of the nine targets on " +
        "the scene. Nothing here is blocked and nothing is timed.",
      outro: "Press Next when the points are marked — or now, if you would rather come back to it.",
      blocking: false,
      dim: false,
      optional: true,
    },
    {
      id: "calib-save",
      page: "gaze",
      anchor: "gaze.calibSave",
      placement: "top",
      title: "Save the calibration",
      body:
        "Saves the marked points and opens stage 3 by itself — the tour follows. Nine points give " +
        "the polynomial model enough to work with; fewer will still save, but expect a worse fit.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "gaze.mapRun" },
      ],
      optional: true,
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
        "your first sanity check: high RMSE usually means a mis-marked calibration point. " +
        "One ordering trap: mapping resolves page coordinates through the AoI surface as it runs, " +
        "so if you have not defined that surface yet, run it now and expect to repair the page " +
        "coordinates afterwards — the offset panel on the Visualise page does it without a " +
        "second pass over the video.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "gaze.mapResults" },
      ],
      optional: true,
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
        "Each stage opened the next one by itself, but this indicator is always there: click any " +
        "stage to go back and look at it, or to re-run it with different settings. Re-running one " +
        "invalidates the stages after it, so they will need running again.",
      outro:
        "With every stage done, this recording has gaze and fixations, and the rest of the app " +
        "unlocks: Events for marking the timeline, AoI for areas of interest, Surface Map for " +
        "paper coordinates, Visualise for heatmaps and scanpaths, and Export for the CSVs.",
    },
  ],
};


const eventsChapter: TourChapter = {
  id: "events",
  page: "events",
  title: "Events",
  steps: [
    {
      // No `page`: the user should learn where the stage lives, not be teleported.
      id: "go-to-events",
      anchor: "sidebar.events",
      placement: "right",
      title: "Open the Events stage",
      body: "Click Events in the sidebar.",
      advance: { type: "click" },
      waitingHint: "Click «Events» in the sidebar.",
    },
    {
      id: "intro",
      page: "events",
      placement: "center",
      title: "Cut the recording into pieces",
      body:
        "An event is a named timestamp: the moment a task started, the moment the participant " +
        "turned the page. Everything downstream reads them — the segment tabs on the AoI, " +
        "Surface Map and Visualise pages are built from the events you mark here.",
    },
    {
      id: "pick-recording",
      page: "events",
      anchor: "events.demoRecording",
      placement: "right",
      title: "Choose the recording",
      body: `Events belong to one recording. Open ${DEMO_RECORDING_LABEL} again.`,
      advance: { type: "anchor", anchor: "events.panel" },
      waitingHint: "Pick a recording from the list.",
    },
    {
      id: "video",
      page: "events",
      anchor: "events.video",
      placement: "left",
      title: "The video is the clock",
      body:
        "Every event you add is stamped with the time shown here, so marking is really just " +
        "«find the frame, then name it». Click the video to play or pause it — the space bar " +
        "does the same, and the arrow keys step a second at a time.",
    },
    {
      id: "seekbar",
      page: "events",
      anchor: "events.seekbar",
      placement: "top",
      title: "The timeline shows what you marked",
      body:
        "Every event becomes a tick on this bar, coloured by which template it came from. Drag " +
        "to scrub; the ticks make it obvious when you skipped one or stamped two too close " +
        "together.",
    },
    {
      id: "controls",
      page: "events",
      anchor: "events.controls",
      placement: "top",
      title: "Play, sound, speed",
      body:
        "The speeds go down to 0.1× — that is the point of them. Marking the frame where a hand " +
        "leaves a circle is hopeless at 1×, and easy at a tenth of it.",
    },
    {
      id: "manual-add",
      page: "events",
      anchor: "events.manualAdd",
      placement: "right",
      title: "Add an event by hand",
      body:
        "Type a name and press Add, or just hit Enter. It lands at the video's current time — " +
        "so pause first, then type.",
      outro:
        "Names ending in _begin and _end are special: mark test01_begin and test01_end and the " +
        "other pages grow a «Test01» tab that covers exactly that stretch of the recording.",
    },
    {
      id: "templates",
      page: "events",
      anchor: "events.templates",
      placement: "right",
      title: "Templates for long sequences",
      body:
        "A Trail Making Test needs about fifty events in a fixed order, and typing them out is " +
        "both slow and error-prone. These buttons know the sequence and always offer the next " +
        "name in it — the grey label tells you what you are about to add.",
      bullets: [
        { title: "TMT-A", text: "1, 1_out, 2, 2_out … 25. The E key adds the next one without leaving the video." },
        { title: "TMT-B", text: "The alternating number/letter sequence. Same idea, on the R key." },
        { title: "The _end buttons", text: "Shift+E and Shift+R close the test out whenever you are." },
      ],
      outro:
        "Keep one hand on the space bar and one on E, and a whole test takes one pass through " +
        "the video.",
    },
    {
      id: "colors",
      page: "events",
      anchor: "events.colors",
      placement: "right",
      title: "Marker colours",
      body:
        "Which colour each family of markers gets on the timeline. Cosmetic, but it makes a " +
        "recording with two tests in it far easier to read.",
    },
    {
      id: "list",
      page: "events",
      anchor: "events.list",
      placement: "right",
      title: "Fixing what you marked",
      body:
        "Every event, in time order. Click its timestamp to jump the video there and check it. " +
        "Hovering a row reveals a pencil to rename and a bin to delete — a mistyped name is " +
        "worth fixing, because the segment tabs elsewhere are built from these strings.",
    },
    {
      id: "wrap-up",
      page: "events",
      placement: "center",
      title: "Saved as you go",
      body:
        "There is no save button — each event is written to the recording the moment you add it, " +
        "and exported later as events.csv. Next up: AoI, where you tell the app which piece of " +
        "paper the participant was looking at.",
    },
  ],
};

const aoiChapter: TourChapter = {
  id: "aoi",
  page: "aoi",
  title: "Areas of Interest",
  steps: [
    {
      id: "go-to-aoi",
      anchor: "sidebar.aoi",
      placement: "right",
      title: "Open the AoI stage",
      body: "Click AoI in the sidebar.",
      advance: { type: "click" },
      waitingHint: "Click «AoI» in the sidebar.",
    },
    {
      id: "intro",
      page: "aoi",
      placement: "center",
      title: "From a moving camera to a flat page",
      body:
        "The scene camera moves with the head, so a gaze point in video pixels means nothing on " +
        "its own. This page fixes that: AprilTags printed around the sheet let the app work out " +
        "where the page is in every frame and flatten it to the same rectangle every time. " +
        "Gaze then gets page coordinates, and areas you draw on the page stay put.",
      outro:
        "Ideally do this before running Map on the Gaze page. If you already mapped, nothing is " +
        "lost — applying an offset on the Visualise page re-projects the existing gaze through the " +
        "surface you are about to define, without another pass over the video.",
    },
    {
      id: "pick-target",
      page: "aoi",
      anchor: "aoi.targetList",
      placement: "right",
      title: "A project, not a recording",
      body:
        "Every session of the same study looks at the same printed page, so the areas are drawn " +
        "once for the project and every recording in it uses them. Click a project row to open it.",
      outro:
        "Expand a project and pick a single recording only when that session used a different " +
        "sheet — its areas then override the project's, for that one recording.",
      advance: { type: "anchor", anchor: "aoi.segmentTabs" },
      waitingHint: "Open a project — or one recording — to continue.",
    },
    {
      id: "scope",
      page: "aoi",
      anchor: "aoi.scopeNotice",
      placement: "bottom",
      align: "start",
      title: "Whose areas are on screen",
      body:
        "This strip always names who the annotation belongs to, and offers the one move that " +
        "changes it: publishing a recording's areas to its whole project, or dropping an " +
        "override so the recording follows the project again.",
      optional: true,
    },
    {
      id: "frame-video",
      page: "aoi",
      anchor: "aoi.frameVideo",
      placement: "right",
      title: "Find a good frame",
      body:
        "Go ahead and scrub — the tour is not blocking anything here. You are looking for one " +
        "frame where the sheet is fully visible, reasonably flat and reasonably sharp: a moment " +
        "when the participant was looking straight at it. All four corner tags should be legible, " +
        "and motion blur is the usual reason a detection comes back short.",
      outro: "Press Next once you are parked on a frame you like.",
      blocking: false,
      dim: false,
      optional: true,
    },
    {
      id: "detect",
      page: "aoi",
      anchor: "aoi.detectRun",
      placement: "top",
      align: "end",
      title: "Detect AprilTags",
      body:
        "Finds every tag in this one frame and computes the flattening from them. It is quick — " +
        "if the result disappoints, scrub a second and try again rather than settling.",
      advance: [
        { type: "button" },
        { type: "anchor", anchor: "aoi.tagPreview" },
      ],
      blocking: false,
      dim: false,
      optional: true,
    },
    {
      id: "tags",
      page: "aoi",
      anchor: "aoi.tagPreview",
      placement: "left",
      title: "Check the tags it found",
      body:
        "Green tags are in, red are out, and clicking one toggles it. Three tags are the bare " +
        "minimum and four give a solid result; the badge above turns green once you have enough.",
      outro:
        "Exclude a tag when it belongs to another sheet in shot, or when it is so blurred that " +
        "its corners are guesswork — a bad corner drags the whole flattening with it.",
      optional: true,
    },
    {
      id: "warp",
      page: "aoi",
      anchor: "aoi.warpPreview",
      placement: "left",
      title: "The flattened page",
      body:
        "This is the frame seen straight on, and it is the canvas you will draw on. Judge it " +
        "strictly: text should run in straight horizontal lines and the sheet should fill the " +
        "preview. A skewed or cropped warp means the tags were mis-detected, and every " +
        "coordinate afterwards inherits the error.",
      optional: true,
    },
    {
      id: "confirm-frame",
      page: "aoi",
      anchor: "aoi.confirmFrame",
      placement: "left",
      title: "Use this frame",
      body: "Locks in the flattening for this segment and opens the drawing canvas.",
      advance: [
        { type: "click" },
        { type: "anchor", anchor: "aoi.canvas" },
      ],
      waitingHint: "Press «Use this frame».",
      optional: true,
    },
    {
      id: "add-area",
      page: "aoi",
      anchor: "aoi.addArea",
      placement: "right",
      title: "Create an area",
      body:
        "Add makes a new area with a colour and a name, selects it, and arms a drawing tool — but " +
        "it has no shape until you draw one. The A key does exactly the same thing, which is " +
        "worth learning: a page with a dozen areas on it is a dozen round trips to this button.",
      outro: "Add one now — the button or the key, whichever you like.",
      // Only the event, never a click as well: both would fire for the same
      // press and advance the tour twice.
      advance: [
        { type: "event", event: "aoi:area-added" },
        { type: "button" },
      ],
      optional: true,
    },
    {
      id: "tools",
      page: "aoi",
      anchor: "aoi.tools",
      placement: "bottom",
      align: "start",
      title: "The tool is already chosen",
      body:
        "Adding an area arms the tool you drew with last — an ellipse the first time — so the " +
        "normal rhythm is press A, drag, press A, drag, without touching this bar at all. Come " +
        "here only to change shape:",
      bullets: [
        { title: "Rectangle and ellipse", text: "Click and drag on the page to place one." },
        { title: "Polygon", text: "Hold and drag to trace a freehand outline; right-click cancels it." },
        { title: "Select", text: "Move a finished shape around instead of drawing. Keyboard V." },
      ],
      outro: "Whichever you pick becomes the armed tool for the next area too.",
      optional: true,
    },
    {
      id: "draw-area",
      page: "aoi",
      anchor: "aoi.canvas",
      placement: "left",
      title: "Draw it — the tour will wait",
      body:
        "Drag on the page to give your area a shape. Nothing is blocked, so add a couple more " +
        "with A and place those too if you want to get the feel of it.",
      outro:
        "Shapes are stored in page coordinates rather than pixels, so they hold for every " +
        "recording sharing this annotation — however each participant happened to hold the sheet. " +
        "Press Next when you have drawn at least one.",
      blocking: false,
      dim: false,
      optional: true,
    },
    {
      id: "area-list",
      page: "aoi",
      anchor: "aoi.areaList",
      placement: "right",
      title: "Managing the areas",
      body:
        "The eye hides an area on the canvas without deleting it, double-clicking the name " +
        "renames it, and the bin removes it. The names travel with the numbers into the exported " +
        "CSVs, so it is worth calling them what your analysis calls them.",
      optional: true,
    },
    {
      id: "reference-menu",
      page: "aoi",
      anchor: "aoi.referenceMenu",
      placement: "bottom",
      align: "end",
      title: "A video frame is a poor canvas",
      body:
        "Even a good frame is compressed, slightly blurred and lit by whatever the room had. " +
        "Placing an area on a specific word in it is guesswork. The fix is to draw on a scan of " +
        "the same sheet instead — same tags, same coordinates, far sharper.",
      outro: "Open this menu.",
      advance: { type: "click" },
      waitingHint: "Click «Reference image».",
      optional: true,
    },
    {
      id: "reference-upload",
      page: "aoi",
      anchor: "aoi.uploadReference",
      placement: "left",
      title: "Upload the scan",
      body:
        "Pick this entry, then choose a photo or scan of the sheet. It has to show the same " +
        "AprilTags — that is how the app lines it up with what the camera saw.",
      advance: [
        { type: "click" },
        { type: "anchor", anchor: "aoi.uploadDropzone" },
      ],
      waitingHint: "Click the upload entry.",
      blocking: false,
      optional: true,
    },
    {
      id: "reference-file",
      page: "aoi",
      anchor: "aoi.uploadDropzone",
      placement: "right",
      title: "Choose the image",
      body:
        "The tags are detected on it exactly as they were on the video frame, and the same " +
        "green/red picker appears on the right. Confirm with «Replace background» and the " +
        "drawing canvas swaps to the scan.",
      outro:
        "Your existing areas stay exactly where they are — only what is underneath them changes.",
      blocking: false,
      dim: false,
      optional: true,
    },
    {
      id: "reference-reopen",
      page: "aoi",
      anchor: "aoi.referenceMenu",
      placement: "bottom",
      align: "end",
      title: "Open the menu once more",
      body:
        "Confirming the upload closed the dropdown. Open it again — now that a reference exists, " +
        "it has grown an extra section.",
      advance: { type: "click" },
      waitingHint: "Click «Reference image» again.",
      blocking: false,
      optional: true,
    },
    {
      id: "reference-switch",
      page: "aoi",
      anchor: "aoi.backgroundSwitch",
      placement: "left",
      title: "Switching back and forth",
      body:
        "Once a reference exists the menu grows this pair. Video frame shows what the camera " +
        "actually saw — useful for checking that an area really does sit where you think it does " +
        "in the recording — and Reference image gives you the sharp version to draw on. Flip " +
        "between them as often as you like; the coordinates are the same either way.",
      blocking: false,
      optional: true,
    },
    {
      id: "draw-on-reference",
      page: "aoi",
      anchor: "aoi.canvas",
      placement: "left",
      title: "Draw one more, on the clean sheet",
      body:
        "Press A and place another area, now that you can actually read the page. This is the " +
        "difference the reference image makes — and why it is worth uploading one whenever the " +
        "areas are small.",
      outro: "Press Next when you are done.",
      blocking: false,
      dim: false,
      optional: true,
    },
    {
      id: "save",
      page: "aoi",
      anchor: "aoi.save",
      placement: "right",
      title: "Save the annotation",
      body:
        "Unlike Events, this page does not save on its own — nothing is stored until you press " +
        "this. Opened from a project, it saves for every recording in it.",
      advance: [
        { type: "click" },
        { type: "button" },
      ],
      optional: true,
    },
    {
      id: "redetect",
      page: "aoi",
      anchor: "aoi.redetect",
      placement: "right",
      title: "Start the frame over",
      body:
        "Goes back to the video to pick a different frame — the escape hatch when a warp turns " +
        "out to be off. Your areas survive it; only the background and the flattening change.",
      optional: true,
    },
    {
      id: "tabs",
      page: "aoi",
      anchor: "aoi.segmentTabs",
      placement: "bottom",
      align: "start",
      title: "Now do it again per test",
      body:
        "Everything you just did belongs to one tab. Each tab keeps its own frame, its own " +
        "reference image and its own areas, so a recording where the participant worked through " +
        "two different sheets gets each sheet annotated properly instead of averaged into one.",
      bullets: [
        { title: "Where the tabs come from", text: "The _begin events you marked on the Events page, plus General for the whole recording." },
        { title: "The + button", text: "Adds a tab no event created — for a second sheet you never marked." },
        { title: "Per tab", text: "Pick a frame, detect the tags, draw the areas, save. The steps you just went through, once each." },
      ],
      outro:
        "Switch to another tab now if the recording has one, or move on and come back when you " +
        "need it.",
    },
    {
      id: "wrap-up",
      page: "aoi",
      placement: "center",
      title: "The surface exists now",
      body:
        "With a saved surface, gaze mapping can produce page coordinates, the Surface Map page " +
        "can outline the sheet on the video, and Visualise can draw heatmaps on it.",
    },
  ],
};

const surfaceChapter: TourChapter = {
  id: "surface",
  page: "surface",
  title: "Surface Map",
  steps: [
    {
      // No `page`: the user should learn where the stage lives, not be teleported.
      id: "go-to-surface",
      anchor: "sidebar.surface",
      placement: "right",
      title: "Open the Surface Map stage",
      body: "Click Surface Map in the sidebar.",
      advance: { type: "click" },
      waitingHint: "Click «Surface Map» in the sidebar.",
    },
    {
      id: "intro",
      page: "surface",
      placement: "center",
      title: "Does the page tracking actually hold?",
      body:
        "This page is the check between mapping and analysis: the scene video with the detected " +
        "sheet drawn on it, next to the flattened page with the gaze on it, playing in step. If " +
        "these two agree, the numbers downstream are trustworthy.",
    },
    {
      id: "pick-recording",
      page: "surface",
      anchor: "surface.demoRecording",
      placement: "right",
      title: "Choose the recording",
      body: `Open ${DEMO_RECORDING_LABEL}. It needs mapped gaze and a saved AoI surface to show anything.`,
      advance: { type: "anchor", anchor: "surface.scene" },
      waitingHint: "Pick a recording from the list.",
    },
    {
      id: "scene",
      page: "surface",
      anchor: "surface.scene",
      placement: "right",
      title: "The scene, with the sheet outlined",
      body:
        "The blue quadrilateral is where the app believes the page is in this frame, from the " +
        "tags it can currently see. Watch it as the head moves: it should stay glued to the " +
        "sheet. Where it jumps or vanishes, too few markers were readable and gaze for those " +
        "frames has no page coordinates.",
    },
    {
      id: "paper",
      page: "surface",
      anchor: "surface.paper",
      placement: "left",
      title: "The same gaze, flattened",
      body:
        "The gaze point from the left, projected onto the page. This is exactly what the heatmaps " +
        "are built from — if the dot here sits somewhere other than where the participant is " +
        "plainly looking in the video, fix that before trusting any statistic.",
    },
    {
      id: "tabs",
      page: "surface",
      anchor: "surface.segmentTabs",
      placement: "bottom",
      align: "start",
      title: "Per-segment surfaces",
      body:
        "The same tabs as on the AoI page. Each one carries its own sheet, so switching tabs " +
        "switches which surface the overlay is looking for.",
      optional: true,
    },
    {
      id: "timeline",
      page: "surface",
      anchor: "surface.timeline",
      placement: "top",
      title: "One timeline for both views",
      body:
        "The video drives everything: scrub or play, and the scene overlay, the flattened page " +
        "and the eye camera all follow the same clock. Your events are marked on the bar, so you " +
        "can jump straight to the stretch you care about.",
    },
    {
      id: "toggles",
      page: "surface",
      anchor: "surface.overlayToggles",
      placement: "top",
      title: "What to draw on the video",
      body: "Four overlays, each on its own toggle:",
      bullets: [
        { title: "Frame", text: "The outline of the detected sheet." },
        { title: "Square", text: "The individual AprilTags, so you can see which ones the frame found." },
        { title: "Eye icon in red", text: "The gaze point on the scene video." },
        { title: "Eye camera", text: "The draggable eye-video window, where the recording has one." },
      ],
      outro:
        "When the outline misbehaves, turn on the markers: they usually show one tag dropping out " +
        "as it leaves the frame or goes out of focus.",
    },
    {
      id: "exports",
      page: "surface",
      anchor: "surface.exports",
      placement: "left",
      title: "What this page produces",
      body:
        "Both files are generated here rather than on the Export page, because both need a pass " +
        "over the video that takes a while.",
    },
    {
      id: "positions",
      page: "surface",
      anchor: "surface.positionsPanel",
      placement: "left",
      title: "surface_positions.csv",
      body:
        "One row per frame: where the sheet was, and whether it was found at all. It is the file " +
        "the outline above is drawn from, it is what Pupil Player's surface tracker exports under " +
        "the same name, and gaze re-projection reads it.",
      outro:
        "Generate it once per segment. Until it exists the scene video has no outline, and the " +
        "page says so.",
    },
    {
      id: "aoi-fixations",
      page: "surface",
      anchor: "surface.aoiFixationsPanel",
      placement: "left",
      title: "aoi_fixations.csv",
      body:
        "Fixations joined to the areas you drew: which area each one landed in, how long it " +
        "lasted, in what order. For most analyses this is the file you actually want, and it is " +
        "the one the AoI heatmap on the Visualise page is computed from.",
    },
    {
      id: "wrap-up",
      page: "surface",
      placement: "center",
      title: "Verified",
      body:
        "Outline steady, gaze landing where it should, both CSVs generated. Now the pictures: " +
        "the Visualise page turns all of this into heatmaps and scanpaths.",
    },
  ],
};

const visualisationChapter: TourChapter = {
  id: "visualisation",
  page: "visualisation",
  title: "Visualise",
  steps: [
    {
      // No `page`: the user should learn where the stage lives, not be teleported.
      id: "go-to-visualisation",
      anchor: "sidebar.visualisation",
      placement: "right",
      title: "Open the Visualise stage",
      body: "Click Visualise in the sidebar.",
      advance: { type: "click" },
      waitingHint: "Click «Visualise» in the sidebar.",
    },
    {
      id: "intro",
      page: "visualisation",
      placement: "center",
      title: "The pictures",
      body:
        "Three views of the same page: where the gaze piled up, how much each area got, and the " +
        "route between them. Everything here is drawn on the flattened sheet from the AoI page, " +
        "and everything can be exported as a PNG for a paper.",
    },
    {
      id: "pick-recording",
      page: "visualisation",
      anchor: "vis.demoRecording",
      placement: "right",
      title: "Choose the recording",
      body: `Open ${DEMO_RECORDING_LABEL} once more.`,
      advance: { type: "anchor", anchor: "vis.modeSwitch" },
      waitingHint: "Pick a recording from the list.",
    },
    {
      id: "modes",
      page: "visualisation",
      anchor: "vis.modeSwitch",
      placement: "bottom",
      title: "Three views",
      body: "Each answers a different question, and each needs a different stage to have run:",
      bullets: [
        { title: "Heatmap", text: "Raw gaze density — where attention pooled. Needs mapped gaze." },
        { title: "AoI Heatmap", text: "One number per area you drew, coloured and labelled. Needs fixations and areas." },
        { title: "Scanpath", text: "The fixations in order, joined by saccades, sized by duration." },
      ],
      outro:
        "If a view comes up empty it says which step is missing rather than showing you a blank " +
        "page.",
    },
    {
      id: "mode-options",
      page: "visualisation",
      anchor: "vis.modeOptions",
      placement: "bottom",
      title: "Settings for the current view",
      body:
        "This spot changes with the mode. Heatmap gets a radius slider — how far each gaze point " +
        "spreads, and the one knob that decides whether the picture reads as a few sharp spots or " +
        "one warm cloud. AoI Heatmap gets the choice between total dwell time and fixation count. " +
        "Scanpath has nothing to set.",
      optional: true,
    },
    {
      id: "segments",
      page: "visualisation",
      anchor: "vis.segmentTabs",
      placement: "bottom",
      align: "start",
      title: "One test at a time",
      body:
        "The tabs window the data to a stretch of the recording, using the _begin and _end events " +
        "you marked. Comparing two tests is just clicking between two tabs.",
      optional: true,
    },
    {
      id: "canvas",
      page: "visualisation",
      anchor: "vis.canvas",
      placement: "left",
      title: "The figure",
      body:
        "The sheet underneath is the same flattened page the areas were drawn on, so the overlay " +
        "and the content line up by construction. It redraws as you change mode, segment or " +
        "radius — no recompute step to wait for.",
    },
    {
      id: "colorbar",
      page: "visualisation",
      anchor: "vis.colorbar",
      placement: "left",
      title: "Read the scale",
      body:
        "The scale is relative to the busiest spot in the current view, not an absolute one. Two " +
        "heatmaps from different segments are therefore not directly comparable by colour — check " +
        "the numbers on the bar before claiming one area got more attention than another.",
      optional: true,
    },
    {
      id: "offset",
      page: "visualisation",
      anchor: "vis.offsetPanel",
      placement: "bottom",
      title: "Correcting a systematic shift",
      body:
        "Sometimes every point sits the same small distance off — typically below and to one " +
        "side of what was really being read. That is parallax between the eye and the scene " +
        "camera, not a mapping failure, and one offset fixes the whole recording.",
      outro:
        "Nudge the arrows and the canvas previews the shift live; Apply rewrites the page " +
        "coordinates and rebuilds the fixations. It also re-projects gaze through the current " +
        "surface, which is the quick repair when Map ran before the AoI surface existed.",
    },
    {
      id: "download",
      page: "visualisation",
      anchor: "vis.download",
      placement: "bottom",
      title: "Export the figure",
      body:
        "Saves what you see as a PNG, with the colour scale drawn in beside it on a white margin " +
        "— a self-contained figure rather than a screenshot that needs a caption to explain it.",
    },
    {
      id: "footer",
      page: "visualisation",
      anchor: "vis.footer",
      placement: "top",
      title: "How much data is behind it",
      body:
        "The counts for the current view and segment. Worth a glance before you read anything " +
        "into a picture: a heatmap built from forty gaze points looks confident and means very " +
        "little.",
    },
    {
      id: "wrap-up",
      page: "visualisation",
      placement: "center",
      title: "Pictures done, numbers next",
      body:
        "One stage left: Export, which hands the underlying numbers to whatever you do your " +
        "statistics in.",
    },
  ],
};

const exportChapter: TourChapter = {
  id: "export",
  page: "export",
  title: "Export",
  steps: [
    {
      // No `page`: the user should learn where the stage lives, not be teleported.
      id: "go-to-export",
      anchor: "sidebar.export",
      placement: "right",
      title: "Open the Export stage",
      body: "Click Export at the bottom of the sidebar.",
      advance: { type: "click" },
      waitingHint: "Click «Export» in the sidebar.",
    },
    {
      id: "intro",
      page: "export",
      placement: "center",
      title: "Getting the numbers out",
      body:
        "Everything the pipeline produced, as CSV. The column layouts follow Pupil Player's " +
        "exports where an equivalent file exists, so scripts written against those keep working.",
    },
    {
      id: "pick-source",
      page: "export",
      anchor: "export.sourceList",
      placement: "right",
      title: "One recording, or a whole project",
      body:
        "Pick a recording for its own files. Pick the project row instead and each file is merged " +
        "across every recording in it, with a recording column added — usually what you want for " +
        "a study.",
      advance: { type: "anchor", anchor: "export.summary" },
      waitingHint: "Pick a recording or a project to continue.",
    },
    {
      id: "summary",
      page: "export",
      anchor: "export.summary",
      placement: "bottom",
      title: "Check what you are exporting",
      body:
        "How many recordings are being merged, and which gaze source the numbers come from. That " +
        "last part matters: the same recording analysed through your own pipeline and through " +
        "Pupil Cloud gives two different sets of files, and the header is where you confirm which " +
        "one you are about to take.",
    },
    {
      id: "sections",
      page: "export",
      anchor: "export.sections",
      placement: "left",
      title: "What is ready and what is not",
      body:
        "Files are grouped by the stage that produces them. A green dot means the file exists; a " +
        "hollow one means a step has not run, and the line underneath names it — with a link " +
        "straight to the page where you can. For a project it lists exactly which recordings are " +
        "still missing it.",
      outro:
        "A few files only make sense for a single recording and say so instead of merging.",
    },
    {
      id: "download-all",
      page: "export",
      anchor: "export.downloadAll",
      placement: "bottom",
      title: "Take everything at once",
      body:
        "Asks for a folder and writes every available file into a subfolder named after the " +
        "source. Individual files have their own CSV button if you only need one. Existing files " +
        "are never overwritten without asking.",
    },
    {
      id: "wrap-up",
      page: "export",
      placement: "center",
      title: "That is the whole pipeline",
      body:
        "Import and group recordings, compute gaze, mark events, define the page and its areas, " +
        "verify the tracking, visualise it, export it. Any chapter can be replayed on its own " +
        "from the help menu in the top bar, and every page has a «Show me around» for just that " +
        "page.",
    },
  ],
};

export const CHAPTERS: TourChapter[] = [
  projectsChapter, playerChapter, gazeChapter,
  eventsChapter, aoiChapter, surfaceChapter, visualisationChapter, exportChapter,
];

export function getChapter(id: string): TourChapter | undefined {
  return CHAPTERS.find((c) => c.id === id);
}

export function chapterForPage(page: string): TourChapter | undefined {
  return CHAPTERS.find((c) => c.page === page);
}
