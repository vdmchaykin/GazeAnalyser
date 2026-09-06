// Stable hooks the tour points at. Add the id to the union first, then spread
// `tourAnchor("...")` onto the element that should be highlighted:
//
//   <button {...tourAnchor("projects.newProjectTile")} onClick={…}>
//
// Anchors are deliberately data attributes and not CSS selectors, so restyling
// a component never breaks the tour.

export type AnchorId =
  // layout
  | "sidebar.projects"
  | "sidebar.gaze"
  | "sidebar.events"
  | "sidebar.aoi"
  | "sidebar.surface"
  | "sidebar.visualisation"
  | "sidebar.export"
  | "topbar.help"
  // projects grid
  | "projects.newProjectTile"
  | "projects.newProjectForm"
  | "projects.nameInput"
  | "projects.createButton"
  | "projects.projectTile"
  | "projects.allRecordings"
  // inside a project
  | "project.addRecording"
  | "project.importMenu"
  | "project.addExisting"
  | "project.importNew"
  | "picker.demoRecording"
  | "picker.confirmAdd"
  | "project.recordingTile"
  // recording detail
  | "recording.videoPreview"
  | "recording.actions"
  | "recording.calculateGaze"
  // player
  | "player.recordingList"
  | "player.back"
  | "player.scene"
  | "player.controls"
  | "player.seekbar"
  | "player.transport"
  | "player.speed"
  | "player.overlays"
  | "player.gazeToggle"
  | "player.cloudGazeToggle"
  | "player.scanpathToggle"
  | "player.pupilToggle"
  | "player.eyeToggle"
  | "player.fullscreen"
  // gaze wizard
  | "gaze.recordingList"
  | "gaze.demoRecording"
  | "gaze.sourceSelector"
  | "gaze.sourceMenu"
  | "gaze.stepIndicator"
  | "gaze.stepDetect"
  | "gaze.stepCalibrate"
  | "gaze.stepMap"
  | "gaze.stepFixations"
  | "gaze.detectConfig"
  | "gaze.detectPreview"
  | "gaze.detectStatus"
  | "gaze.detectRun"
  | "gaze.calibPoints"
  | "gaze.calibCanvas"
  | "gaze.calibControls"
  | "gaze.calibSave"
  | "gaze.mapSummary"
  | "gaze.mapRun"
  | "gaze.mapResults"
  | "gaze.mapOpenPlayer"
  | "gaze.fixParams"
  | "gaze.fixRun"
  | "gaze.fixResults"
  // events
  | "events.recordingList"
  | "events.demoRecording"
  | "events.panel"
  | "events.manualAdd"
  | "events.templates"
  | "events.colors"
  | "events.list"
  | "events.video"
  | "events.seekbar"
  | "events.controls"
  // AoI
  | "aoi.targetList"
  | "aoi.segmentTabs"
  | "aoi.addSegment"
  | "aoi.scopeNotice"
  | "aoi.frameVideo"
  | "aoi.frameControls"
  | "aoi.detectRun"
  | "aoi.detectResult"
  | "aoi.tagPreview"
  | "aoi.warpPreview"
  | "aoi.confirmFrame"
  | "aoi.areaList"
  | "aoi.addArea"
  | "aoi.tools"
  | "aoi.canvas"
  | "aoi.referenceMenu"
  | "aoi.uploadReference"
  | "aoi.backgroundSwitch"
  | "aoi.uploadDropzone"
  | "aoi.save"
  | "aoi.redetect"
  // surface map
  | "surface.recordingList"
  | "surface.demoRecording"
  | "surface.segmentTabs"
  | "surface.scene"
  | "surface.paper"
  | "surface.timeline"
  | "surface.controls"
  | "surface.overlayToggles"
  | "surface.exports"
  | "surface.positionsPanel"
  | "surface.aoiFixationsPanel"
  // visualisation
  | "vis.recordingList"
  | "vis.demoRecording"
  | "vis.modeSwitch"
  | "vis.modeOptions"
  | "vis.offsetPanel"
  | "vis.download"
  | "vis.segmentTabs"
  | "vis.canvas"
  | "vis.colorbar"
  | "vis.footer"
  // export
  | "export.sourceList"
  | "export.summary"
  | "export.downloadAll"
  | "export.sections";

export function tourAnchor(id: AnchorId) {
  return { "data-tour": id };
}

export function findAnchor(id: AnchorId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
}
