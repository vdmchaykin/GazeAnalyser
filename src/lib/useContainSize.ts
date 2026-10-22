import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * The largest box of the given aspect ratio that fits inside `ref`'s element.
 *
 * A video and the canvas drawn over it must cover exactly the same pixels, or
 * every coordinate read from or drawn on the canvas is off. CSS `aspect-ratio`
 * with `width: 100%` cannot promise that: once `max-height` clamps the box, the
 * width stays at 100% and the ratio breaks, the video letterboxes itself inside
 * the wider box, and the canvas stretches across all of it — clicks and overlays
 * then land squeezed toward the centre horizontally. Sizing the box explicitly
 * from the container keeps the two identical at any window shape.
 */
export function useContainSize(ref: RefObject<HTMLElement | null>, aspect: number) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !(aspect > 0)) return;
    const measure = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (W <= 0 || H <= 0) return;
      const width = Math.min(W, H * aspect);
      setSize({ width, height: width / aspect });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, aspect]);

  return size;
}
