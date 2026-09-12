/**
 * Geometry of the printed sheet the gaze is mapped onto.
 *
 * Everything stored (AoI areas, marker registry, gaze) is in normalized page
 * coordinates, so the orientation only decides the pixel canvas a background is
 * warped into and the aspect ratio the pages draw it at. The value lives in the
 * AoI state, next to the background it describes, and every page that renders the
 * page reads it from there — mixing the two would squeeze the sheet.
 */

export type PaperOrientation = "portrait" | "landscape";

/**
 * What the editor asks the warp for. "auto" lets the backend read the layout off
 * the marker quad and report which of the two it resolved to; that resolved value
 * is what gets stored and what every renderer draws at.
 */
export type OrientationMode = PaperOrientation | "auto";

/** A4 at 96 dpi. */
const A4_SHORT = 794;
const A4_LONG = 1123;

export interface PaperSize {
  w: number;
  h: number;
}

export const PORTRAIT_SIZE: PaperSize = { w: A4_SHORT, h: A4_LONG };
export const LANDSCAPE_SIZE: PaperSize = { w: A4_LONG, h: A4_SHORT };

export function paperSize(orientation: PaperOrientation | null | undefined): PaperSize {
  return orientation === "landscape" ? LANDSCAPE_SIZE : PORTRAIT_SIZE;
}

/** Normalizes whatever a stored state carries into a known orientation. */
export function asOrientation(value: unknown): PaperOrientation {
  return value === "landscape" ? "landscape" : "portrait";
}

/** Normalizes a stored mode; anything unknown (including an old state) is auto. */
export function asOrientationMode(value: unknown): OrientationMode {
  return value === "landscape" || value === "portrait" ? value : "auto";
}
