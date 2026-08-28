/**
 * Loading and applying the scene-anchoring transforms (see `sceneAnchor.ts`).
 *
 * Any overlay that draws a point measured in ONE scene frame while a DIFFERENT
 * frame is on screen needs this: the trailing fixations of the scanpath, and the
 * calibration dots, which are clicked at one moment and then have to stay on the
 * paper while the head-mounted camera keeps moving.
 *
 * `makeTransport(curIdx)` does the per-frame work once and hands back a closure
 * that maps any (scene point, its frame) into the current frame — so the cost is
 * one chain build per rendered frame, not one per point.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyMat, chainTo, identity, invertMat, matFrom8, matMul, nearestIndex,
  unitSquareToQuad, type Mat3,
} from "./sceneAnchor";
import type { SceneMotionData, SurfacePositionsData } from "@/types";

const API = "http://localhost:8765";

/** Which transform carried a point into the current frame. */
export type AnchorMode = "surface" | "flow" | "fixed";

/** Maps a scene point measured in `fromIdx` into the frame the transport was built for. */
export type Transport = (x: number, y: number, fromIdx: number) => [number, number, AnchorMode];

/**
 * Longest egomotion chain we walk. Homography chaining drifts with every link
 * (parallax under head translation), so past a few seconds the result is worse
 * than leaving the point alone — and the cap also bounds the per-frame cost.
 */
const MAX_FLOW_FRAMES = 240;

/**
 * How far outside the paper a point may sit and still be transported through the
 * surface homography, in surface widths. The homography is exact for anything
 * COPLANAR with the paper — the rest of the table top included — but a point far
 * off the sheet is likely on another plane entirely, so it goes to flow instead.
 */
const SURFACE_MARGIN = 1.5;

export function useSceneAnchor(recordingId: string) {
  // Scene-frame index: every per-frame product below is addressed by frame.
  const sceneRelRef = useRef<Float64Array>(new Float64Array(0)); // seconds since frame 0
  const surfaceRef = useRef<(number[] | null)[]>([]);            // AoI corners per frame
  const motionRef = useRef<(Mat3 | null)[]>([]);                 // egomotion per frame pair
  const frameCountRef = useRef(0);

  const [surfaceLocalized, setSurfaceLocalized] = useState<number | null>(null);
  const [motionSolved, setMotionSolved] = useState<number | null>(null);
  // Bumped whenever a fetch lands, so a consumer that only redraws on demand
  // knows to redraw once the inputs it was missing have arrived.
  const [inputsVersion, setInputsVersion] = useState(0);
  const bump = useCallback(() => setInputsVersion((v) => v + 1), []);

  const loadSurface = useCallback(() => {
    fetch(`${API}/api/recordings/${recordingId}/aoi/surface-positions/data`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SurfacePositionsData | null) => {
        surfaceRef.current = d?.corners ?? [];
        if (d?.frames) frameCountRef.current = Math.max(frameCountRef.current, d.frames);
        setSurfaceLocalized(d ? d.localized : null);
        bump();
      })
      .catch(() => {});
  }, [recordingId, bump]);

  const loadMotion = useCallback(() => {
    fetch(`${API}/api/recordings/${recordingId}/motion/data`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SceneMotionData | null) => {
        motionRef.current = (d?.h ?? []).map((h) => (h ? matFrom8(h) : null));
        if (d?.frames) frameCountRef.current = Math.max(frameCountRef.current, d.frames);
        setMotionSolved(d ? d.solved : null);
        bump();
      })
      .catch(() => {});
  }, [recordingId, bump]);

  useEffect(() => {
    sceneRelRef.current = new Float64Array(0);
    surfaceRef.current = [];
    motionRef.current = [];
    frameCountRef.current = 0;
    setSurfaceLocalized(null);
    setMotionSolved(null);

    let cancelled = false;
    fetch(`${API}/api/recordings/${recordingId}/gaze/scene-timestamps`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ts_ns: number[] } | null) => {
        const ts = d?.ts_ns;
        if (cancelled || !ts?.length) return;
        const rel = new Float64Array(ts.length);
        for (let i = 0; i < ts.length; i++) rel[i] = (ts[i] - ts[0]) / 1e9;
        sceneRelRef.current = rel;
        frameCountRef.current = Math.max(frameCountRef.current, ts.length);
        bump();
      })
      .catch(() => {});

    loadSurface();
    loadMotion();
    return () => { cancelled = true; };
  }, [recordingId, loadSurface, loadMotion, bump]);

  /**
   * Playback position → scene frame index, or -1 when the frame grid is unknown.
   * The `.time` file is authoritative; without it, fall back to spreading the
   * known frame count evenly over the clip.
   */
  const frameAt = useCallback((t: number, duration = 0): number => {
    const rel = sceneRelRef.current;
    if (rel.length) return nearestIndex(rel, t);
    const n = frameCountRef.current;
    if (n > 1 && duration > 0) {
      return Math.max(0, Math.min(n - 1, Math.round((t / duration) * (n - 1))));
    }
    return -1;
  }, []);

  /**
   * Transport into frame `curIdx`. Per point, in order of preference:
   *   1. the AoI surface — the point's normalized paper coordinates (recovered
   *      through its own frame's homography) re-projected onto this frame's
   *      corners. Exact and drift-free at any time distance.
   *   2. scene egomotion — the frame-to-frame homographies chained from the
   *      point's frame to this one, in either direction.
   *   3. nothing — the point is left where it was measured.
   */
  const makeTransport = useCallback((curIdx: number): Transport => {
    const surfaces = surfaceRef.current;
    const motion = motionRef.current;
    const curQuad = curIdx >= 0 ? surfaces[curIdx] ?? null : null;
    const curSurf = curQuad ? unitSquareToQuad(curQuad) : null;

    // Both chains are built on first use and shared by every point in the frame.
    let back: Mat3[] | null = null;   // entry k-backFrom maps frame k → curIdx
    let backFrom = 0;
    let fwd: Mat3[] | null = null;    // entry k-curIdx maps frame k → fwdTo
    let fwdInv: Mat3 | null = null;   // fwdTo → curIdx

    const flowMat = (fromIdx: number): Mat3 | null => {
      if (curIdx < 0 || fromIdx < 0) return null;
      const d = fromIdx - curIdx;
      if (d === 0) return identity();
      if (motion.length === 0 || Math.abs(d) > MAX_FLOW_FRAMES) return null;
      if (d < 0) {
        if (!back) {
          backFrom = Math.max(0, curIdx - MAX_FLOW_FRAMES);
          back = chainTo(motion, backFrom, curIdx);
        }
        return back[fromIdx - backFrom] ?? null;
      }
      if (!fwd) {
        const fwdTo = Math.min(motion.length - 1, curIdx + MAX_FLOW_FRAMES);
        if (fwdTo <= curIdx) return null;
        fwd = chainTo(motion, curIdx, fwdTo);
        fwdInv = invertMat(fwd[0]);
      }
      const a = fwd[fromIdx - curIdx];
      return a && fwdInv ? matMul(fwdInv, a) : null;
    };

    return (x, y, fromIdx) => {
      if (curSurf && fromIdx >= 0) {
        const quad = surfaces[fromIdx] ?? null;
        const from = quad ? unitSquareToQuad(quad) : null;
        const inv = from ? invertMat(from) : null;
        if (inv) {
          const [nx, ny] = applyMat(inv, x, y);
          const lo = -SURFACE_MARGIN, hi = 1 + SURFACE_MARGIN;
          if (nx > lo && nx < hi && ny > lo && ny < hi) {
            const [px, py] = applyMat(curSurf, nx, ny);
            return [px, py, "surface"];
          }
        }
      }
      const m = flowMat(fromIdx);
      if (m) {
        const [px, py] = applyMat(m, x, y);
        return [px, py, "flow"];
      }
      return [x, y, "fixed"];
    };
  }, []);

  return {
    frameAt, makeTransport, inputsVersion,
    surfaceLocalized, motionSolved, loadSurface, loadMotion,
  };
}
