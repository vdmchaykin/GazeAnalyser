/**
 * The gaze cursor: a hollow red ring, so whatever was looked at stays readable
 * underneath it.
 *
 * Both the scene video overlay and the warped-surface canvas call this, so the
 * cursor is literally the same mark in both views. `radius` differs between them
 * — the two canvases have different pixel scales — and callers derive it through
 * the surface homography so the ring covers the same patch of the page either way.
 */

const RED = "#e63329";

export function drawGazeRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
): void {
  const r = Math.max(3, radius);
  const w = Math.max(1.5, r * 0.16);

  ctx.save();
  ctx.lineCap = "round";

  // A dark rim under the ring: a thin red circle otherwise washes out against
  // white paper, which is most of what this is drawn on.
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = w * 1.8;
  ring(ctx, x, y, r);

  ctx.strokeStyle = RED;
  ctx.lineWidth = w;
  ring(ctx, x, y, r);

  ctx.restore();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}
