/**
 * Seek a video without stacking seeks on top of each other.
 *
 * Clicking quickly along a timeline (or holding an arrow key) asks for a new
 * position before the previous seek has finished. In the Linux webview every
 * seek flushes the GStreamer pipeline, and flushes piling up on one another
 * froze the whole app. So while a seek is in flight, a new request only replaces
 * the pending target; when the running seek lands, the video jumps once to the
 * latest target. The last click always wins — intermediate ones are dropped.
 */

interface Pending {
  t: number;
  since: number;
}

const pending = new WeakMap<HTMLVideoElement, Pending>();

/** A seek that never reports `seeked` (decode error, element reset) must not
 *  block every later seek — after this long the next request goes straight in. */
const STUCK_MS = 2000;

export function seekVideo(v: HTMLVideoElement, t: number): void {
  if (!Number.isFinite(t)) return;
  const queued = pending.get(v);
  if (v.seeking && !(queued && performance.now() - queued.since > STUCK_MS)) {
    if (!queued) {
      v.addEventListener("seeked", () => {
        const next = pending.get(v);
        pending.delete(v);
        if (next !== undefined) seekVideo(v, next.t);
      }, { once: true });
    }
    pending.set(v, { t, since: queued?.since ?? performance.now() });
    return;
  }
  pending.delete(v);
  v.currentTime = t;
}

/** Where the video is headed: the queued target if a seek is pending, else
 *  its current position — for relative steps (±1 frame, ±1 s). */
export function targetTime(v: HTMLVideoElement): number {
  return pending.get(v)?.t ?? v.currentTime;
}
