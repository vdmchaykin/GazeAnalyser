/**
 * Anchoring overlay points to the SCENE instead of the screen.
 *
 * A fixation is stored as a single scene-pixel coordinate, valid only in the
 * frames it was measured in. Drawn unchanged while the trailing scanpath window
 * plays on, it sticks to the display while the head-mounted camera moves away
 * from the object that was actually looked at. Two transforms fix that, in order
 * of preference:
 *
 *   1. the AoI surface homography — for fixations that landed on the tagged
 *      paper, their normalized surface position is re-projected through the
 *      current frame's surface corners. Exact, drift-free, survives occlusion of
 *      individual markers (see `backend/app/api/routes/aoi.py`).
 *   2. scene egomotion — chaining the per-frame-pair homographies from
 *      `scene_motion.csv` transports the point from its own frame into the
 *      current one. Approximate (parallax under head translation, error grows
 *      with chain length), but works anywhere in the scene.
 *
 * Matrices are row-major 3×3 in homogeneous scene pixels.
 */

export type Mat3 = Float64Array;

const EPS = 1e-12;

export function identity(): Mat3 {
  return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

/** Expand the backend's 8-number form (implicit `h22 = 1`) into a matrix. */
export function matFrom8(h: ArrayLike<number>): Mat3 {
  return new Float64Array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const m = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      m[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return m;
}

/**
 * Inverse of a homography (adjugate over determinant), or null if singular.
 *
 * Needed whenever a point has to travel BACKWARDS through a transform that was
 * built in the forward direction — a scene point turned into surface coordinates
 * through the frame it was measured in, or an egomotion chain read from a later
 * frame towards an earlier one.
 */
export function invertMat(m: Mat3): Mat3 | null {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < EPS) return null;
  const s = 1 / det;
  return new Float64Array([
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ]);
}

export function applyMat(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  if (Math.abs(w) < EPS) return [x, y];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/**
 * Homography from the unit square onto a quad, corners in [TL, TR, BR, BL] order
 * — i.e. `(0,0) → TL … (0,1) → BL`, matching how the backend registers the
 * surface (`_localize_surface`), so a fixation's normalized paper coordinates go
 * straight through it.
 *
 * Heckbert's closed form for the square→quad case; no linear solve needed.
 * Returns null for a degenerate quad.
 */
export function unitSquareToQuad(q: ArrayLike<number>): Mat3 | null {
  const x0 = q[0], y0 = q[1], x1 = q[2], y1 = q[3];
  const x2 = q[4], y2 = q[5], x3 = q[6], y3 = q[7];

  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;

  // A parallelogram has no perspective term — the general branch would divide by
  // a vanishing determinant, so handle it as a plain affine map.
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return new Float64Array([x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1]);
  }

  const dx1 = x1 - x2, dx2 = x3 - x2;
  const dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < EPS) return null;

  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return new Float64Array([
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ]);
}

/** Index of the entry closest to `target` in an ascending array (-1 if empty). */
export function nearestIndex(sorted: Float64Array, target: number): number {
  const n = sorted.length;
  if (n === 0) return -1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - target) < Math.abs(sorted[lo] - target)) lo--;
  return lo;
}

/**
 * Cumulative transforms onto `toIdx`: entry `k - fromIdx` maps frame `k` into
 * frame `toIdx`. Built once per rendered frame and shared by every point, so the
 * cost is one 3×3 product per frame in the window regardless of how many
 * fixations are on screen.
 *
 * `steps[i]` maps frame `i-1` onto frame `i`; an unsolved pair (null) is treated
 * as no motion, which keeps the chain usable across a short tracking dropout
 * instead of discarding the whole trail.
 */
export function chainTo(steps: (Mat3 | null)[], fromIdx: number, toIdx: number): Mat3[] {
  const n = toIdx - fromIdx + 1;
  const out: Mat3[] = new Array(n);
  out[n - 1] = identity();
  for (let k = toIdx - 1; k >= fromIdx; k--) {
    const next = out[k + 1 - fromIdx];
    const step = steps[k + 1] ?? null;
    out[k - fromIdx] = step ? matMul(next, step) : next;
  }
  return out;
}
