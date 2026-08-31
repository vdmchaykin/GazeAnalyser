import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, GraduationCap, Minus, MousePointerClick, X } from "lucide-react";
import { findAnchor, type AnchorId } from "./anchors";
import type { Align, Placement } from "./steps";
import { useTour } from "./TourProvider";

const TOOLTIP_WIDTH = 340;
const HOLE_PAD = 6;
const GAP = 14;
const EDGE = 12;

interface Box { top: number; left: number; width: number; height: number }

function sameBox(a: Box | null, b: Box | null) {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * Follows an anchor element's viewport box. A rAF loop is used on purpose:
 * scroll, resize, page transitions, async lists and CSS transitions all move
 * the target, and one cheap measurement per frame covers every case.
 */
function useAnchorBox(anchor?: AnchorId): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  const boxRef = useRef<Box | null>(null);

  useEffect(() => {
    if (!anchor) { boxRef.current = null; setBox(null); return; }
    let frame = 0;
    const measure = () => {
      const el = findAnchor(anchor);
      let next: Box | null = null;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          next = { top: r.top, left: r.left, width: r.width, height: r.height };
        }
      }
      if (!sameBox(boxRef.current, next)) {
        boxRef.current = next;
        setBox(next);
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  return box;
}

function fits(top: number, left: number, w: number, h: number) {
  return top >= EDGE && left >= EDGE &&
    top + h <= window.innerHeight - EDGE && left + w <= window.innerWidth - EDGE;
}

/** Where the tooltip sits along the edge it is placed on. Centred by default;
 *  "start"/"end" hug the anchor's near/far edge, which is how a step on a
 *  full-width strip stays off whatever is centred underneath it. */
function alignedLeft(box: Box, w: number, align: Align) {
  if (align === "start") return box.left;
  if (align === "end") return box.left + box.width - w;
  return box.left + box.width / 2 - w / 2;
}

function alignedTop(box: Box, h: number, align: Align) {
  if (align === "start") return box.top;
  if (align === "end") return box.top + box.height - h;
  return box.top + box.height / 2 - h / 2;
}

function positionFor(box: Box, w: number, h: number, placement: Placement, align: Align) {
  switch (placement) {
    case "top":    return { top: box.top - GAP - h,   left: alignedLeft(box, w, align) };
    case "bottom": return { top: box.top + box.height + GAP, left: alignedLeft(box, w, align) };
    case "left":   return { top: alignedTop(box, h, align), left: box.left - GAP - w };
    default:       return { top: alignedTop(box, h, align), left: box.left + box.width + GAP };
  }
}

const OPPOSITE: Record<string, Placement> = {
  top: "bottom", bottom: "top", left: "right", right: "left",
};

function tooltipPosition(
  box: Box | null, w: number, h: number, placement: Placement, align: Align, anchored: boolean,
) {
  if (!box) {
    // An anchored step whose element is gone (a dialog opened over it, the
    // menu closed) parks in a corner so it never covers what the user needs.
    return anchored
      ? { top: window.innerHeight - h - EDGE, left: window.innerWidth - w - EDGE }
      : { top: window.innerHeight / 2 - h / 2, left: window.innerWidth / 2 - w / 2 };
  }
  if (placement === "center") {
    return { top: window.innerHeight / 2 - h / 2, left: window.innerWidth / 2 - w / 2 };
  }

  let pos = positionFor(box, w, h, placement, align);
  if (!fits(pos.top, pos.left, w, h)) {
    const flipped = positionFor(box, w, h, OPPOSITE[placement] ?? "bottom", align);
    if (fits(flipped.top, flipped.left, w, h)) pos = flipped;
  }
  return {
    top: Math.min(Math.max(pos.top, EDGE), Math.max(EDGE, window.innerHeight - h - EDGE)),
    left: Math.min(Math.max(pos.left, EDGE), Math.max(EDGE, window.innerWidth - w - EDGE)),
  };
}

/** Transparent-black panels around the hole: they dim *and* block the rest of
 *  the UI, while the highlighted element stays clickable through the gap. */
function Dimmer({ box, blocking, dim }: { box: Box | null; blocking: boolean; dim: boolean }) {
  const block = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  const common = `fixed z-[90]${dim ? " bg-black/60" : ""}${blocking ? "" : " pointer-events-none"}`;

  // Neither darkening nor blocking: only the ring is left, and without a box
  // there is nothing to ring — so stay out of the way entirely.
  if (!box && (!blocking || !dim)) return null;

  if (!box) {
    return <div className={`${common} inset-0`} onMouseDown={block} onClick={block} />;
  }
  const top = Math.max(0, box.top - HOLE_PAD);
  const bottom = Math.min(window.innerHeight, box.top + box.height + HOLE_PAD);
  const left = Math.max(0, box.left - HOLE_PAD);
  const right = Math.min(window.innerWidth, box.left + box.width + HOLE_PAD);

  return (
    <>
      <div className={common} style={{ top: 0, left: 0, width: "100vw", height: top }} onMouseDown={block} onClick={block} />
      <div className={common} style={{ top: bottom, left: 0, width: "100vw", height: Math.max(0, window.innerHeight - bottom) }} onMouseDown={block} onClick={block} />
      <div className={common} style={{ top, left: 0, width: left, height: bottom - top }} onMouseDown={block} onClick={block} />
      <div className={common} style={{ top, left: right, width: Math.max(0, window.innerWidth - right), height: bottom - top }} onMouseDown={block} onClick={block} />
      <div
        className="fixed z-[91] rounded-lg pointer-events-none ring-2 ring-indigo-400
                   shadow-[0_0_0_4px_rgba(99,102,241,0.25)] transition-all duration-150"
        style={{ top, left, width: right - left, height: bottom - top }}
      />
    </>
  );
}

export function TourOverlay() {
  const tour = useTour();
  const { step, chapter } = tour;
  const box = useAnchorBox(step?.anchor);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: TOOLTIP_WIDTH, h: 180 });

  // Bring the target into view when the step changes.
  useEffect(() => {
    if (!step?.anchor) return;
    const el = findAnchor(step.anchor);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [step?.id, step?.anchor]);

  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize((s) => (Math.abs(s.h - r.height) < 1 && Math.abs(s.w - r.width) < 1
      ? s
      : { w: r.width, h: r.height }));
  });

  // A chapter ran out of steps: close on a card that hands over to the next one.
  if (!step || !chapter) {
    if (!tour.finish) return null;
    const { chapter: done, next } = tour.finish;
    return createPortal(
      <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60"
           onClick={tour.stop}>
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-[400px] rounded-2xl border border-zinc-700 bg-zinc-900
                     shadow-2xl shadow-black/50 p-6"
        >
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/25
                             flex items-center justify-center">
              <Check className="w-4 h-4 text-emerald-400" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-white">{done.title} — done</h2>
              <p className="text-[11px] text-zinc-500">
                {next ? `${next.steps.length} more steps in the next chapter` : "That is the whole tour"}
              </p>
            </div>
          </div>

          <p className="mt-4 text-xs text-zinc-400 leading-relaxed">
            {next
              ? `Next up: ${next.title}. You can carry straight on, or come back to it later from ` +
                "the help menu in the top bar."
              : "Every chapter is finished. The help menu in the top bar can replay any of them."}
          </p>

          <div className="mt-5 flex items-center gap-2">
            <button
              onClick={tour.stop}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
            >
              {next ? "Not now" : "Close"}
            </button>
            {next && (
              <button
                onClick={tour.continueNext}
                className="ml-auto flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs
                           text-white bg-indigo-600 hover:bg-indigo-500
                           transition-colors cursor-pointer"
              >
                Continue <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  if (tour.minimized) {
    return createPortal(
      <button
        onClick={tour.resume}
        className="fixed bottom-5 right-5 z-[120] flex items-center gap-2 px-3.5 py-2 rounded-full
                   bg-indigo-600 hover:bg-indigo-500 text-white text-xs shadow-xl shadow-black/40
                   transition-colors cursor-pointer"
      >
        <GraduationCap className="w-4 h-4" />
        Continue tour · {tour.stepIndex + 1}/{tour.stepCount}
      </button>,
      document.body,
    );
  }

  const placement: Placement = step.placement ?? (box ? "bottom" : "center");
  const pos = tooltipPosition(box, size.w, size.h, placement, step.align ?? "center", !!step.anchor);
  const progress = ((tour.stepIndex + 1) / tour.stepCount) * 100;

  return createPortal(
    <>
      <Dimmer box={box} blocking={step.blocking ?? true} dim={step.dim ?? true} />

      <div
        ref={tooltipRef}
        role="dialog"
        aria-label={step.title}
        style={{ top: pos.top, left: pos.left, width: TOOLTIP_WIDTH }}
        className="fixed z-[120] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl
                   shadow-black/50 overflow-hidden transition-[top,left] duration-200"
      >
        <div className="flex items-center gap-2 px-4 pt-3">
          <GraduationCap className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          <span className="text-[10px] uppercase tracking-wider text-indigo-400 truncate">
            {chapter.title}
          </span>
          <span className="ml-auto text-[10px] text-zinc-500 tabular-nums">
            {tour.stepIndex + 1} / {tour.stepCount}
          </span>
          <button
            onClick={tour.minimize}
            title="Minimise the tour"
            className="text-zinc-500 hover:text-zinc-300 cursor-pointer"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={tour.stop}
            title="Exit the tour"
            className="text-zinc-500 hover:text-zinc-300 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="mx-4 mt-2 h-0.5 rounded-full bg-zinc-800 overflow-hidden">
          <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>

        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold text-white">{step.title}</h2>
          <p className="mt-1.5 text-xs text-zinc-400 leading-relaxed">{step.body}</p>

          {step.bullets && (
            <ol className="mt-2.5 space-y-2">
              {step.bullets.map((b, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="flex-shrink-0 w-4 h-4 mt-px rounded-full bg-zinc-800
                                   text-zinc-300 text-[10px] font-semibold
                                   flex items-center justify-center">
                    {i + 1}
                  </span>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    {b.title && <span className="font-medium text-zinc-200">{b.title} — </span>}
                    {b.text}
                  </p>
                </li>
              ))}
            </ol>
          )}

          {step.outro && (
            <p className="mt-2.5 text-xs text-zinc-400 leading-relaxed">{step.outro}</p>
          )}

          {tour.waiting && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 px-2.5 py-2">
              <MousePointerClick className="w-3.5 h-3.5 mt-px shrink-0 text-indigo-400 animate-pulse" />
              <span className="text-[11px] text-indigo-300 leading-relaxed">
                {step.waitingHint ?? "Go ahead — the tour continues on its own."}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 pb-3">
          <button
            onClick={tour.stop}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
          >
            Exit tour
          </button>
          <div className="ml-auto flex items-center gap-2">
            {(tour.stepIndex > 0) && (
              <button
                onClick={tour.back}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px]
                           text-zinc-300 hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <ArrowLeft className="w-3 h-3" /> Back
              </button>
            )}
            {tour.waiting ? (
              (step.skippable ?? true) && (
                <button
                  onClick={tour.next}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px]
                             text-zinc-400 hover:text-white hover:bg-zinc-800
                             transition-colors cursor-pointer"
                >
                  Skip <ArrowRight className="w-3 h-3" />
                </button>
              )
            ) : (
              <button
                onClick={tour.next}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] text-white
                           bg-indigo-600 hover:bg-indigo-500 transition-colors cursor-pointer"
              >
                {tour.isLastStep
                  ? <>Finish <Check className="w-3 h-3" /></>
                  : <>Next <ArrowRight className="w-3 h-3" /></>}
              </button>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
