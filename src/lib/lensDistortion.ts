/**
 * Scene-camera lens distortion, ported from what the backend does with OpenCV
 * (`undistort_points` / `distort_points` in `backend/app/api/routes/aoi.py`).
 *
 * Why a client needs it: `surface_positions.csv` stores the surface corners in
 * RAW sensor pixels, but a homography can only describe a projective map. Fitting
 * one straight onto the raw corners and reprojecting the AprilTags through it puts
 * them up to ~20 px off near the page corners, which is plainly visible as green
 * boxes sliding off the printed markers. Undistorting the corners first, fitting
 * there, and distorting each projected point back reproduces the backend's own
 * geometry to well under a pixel.
 *
 * The model is OpenCV's rational one: radial k1,k2,k3 over k4,k5,k6, plus
 * tangential p1,p2 — the order the coefficients arrive in is [k1,k2,p1,p2,k3,k4,k5,k6].
 */

export interface SceneIntrinsics {
  fx: number; fy: number; cx: number; cy: number;
  /** [k1, k2, p1, p2, k3, k4, k5, k6] */
  d: number[];
}

export interface Lens {
  /** Raw sensor pixels → ideal pinhole pixels. */
  undistort(x: number, y: number): [number, number];
  /** Ideal pinhole pixels → raw sensor pixels. */
  distort(x: number, y: number): [number, number];
}

/** `cv2.undistortPoints` runs exactly this many fixed-point steps by default;
 *  matching it keeps our corners bit-for-bit identical to the backend's. */
const UNDISTORT_ITERATIONS = 5;

const IDENTITY_LENS: Lens = {
  undistort: (x, y) => [x, y],
  distort: (x, y) => [x, y],
};

/** A lens for these intrinsics, or a pass-through when the recording has none. */
export function makeLens(intr: SceneIntrinsics | null | undefined): Lens {
  if (!intr || !Number.isFinite(intr.fx) || !intr.fx) return IDENTITY_LENS;

  const { fx, fy, cx, cy } = intr;
  const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0, k4 = 0, k5 = 0, k6 = 0] = intr.d ?? [];

  return {
    undistort(u, v) {
      const x0 = (u - cx) / fx;
      const y0 = (v - cy) / fy;
      let x = x0, y = y0;
      for (let i = 0; i < UNDISTORT_ITERATIONS; i++) {
        const r2 = x * x + y * y;
        const r4 = r2 * r2, r6 = r4 * r2;
        const radial = (1 + k4 * r2 + k5 * r4 + k6 * r6) / (1 + k1 * r2 + k2 * r4 + k3 * r6);
        const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
        const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
        x = (x0 - dx) * radial;
        y = (y0 - dy) * radial;
      }
      return [x * fx + cx, y * fy + cy];
    },

    distort(u, v) {
      const x = (u - cx) / fx;
      const y = (v - cy) / fy;
      const r2 = x * x + y * y;
      const r4 = r2 * r2, r6 = r4 * r2;
      const radial = (1 + k1 * r2 + k2 * r4 + k3 * r6) / (1 + k4 * r2 + k5 * r4 + k6 * r6);
      const xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
      const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
      return [xd * fx + cx, yd * fy + cy];
    },
  };
}
