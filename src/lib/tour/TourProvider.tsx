import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { useNav } from "@/lib/nav";
import { findAnchor } from "./anchors";
import { onTourEvent } from "./events";
import { CHAPTERS, getChapter, type Advance, type TourChapter, type TourStep } from "./steps";

const STORAGE_KEY = "tour.v1";

interface Persisted {
  /** The welcome dialog was answered once — never auto-open it again. */
  welcomeSeen: boolean;
  /** Chapter ids the user has finished. */
  completed: string[];
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      return { welcomeSeen: !!p.welcomeSeen, completed: p.completed ?? [] };
    }
  } catch {
    /* corrupted entry — start over */
  }
  return { welcomeSeen: false, completed: [] };
}

function savePersisted(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* private mode / quota — the tour just won't be remembered */
  }
}

/** What the finished-chapter card shows when a chapter runs out of steps. */
export interface TourFinish {
  chapter: TourChapter;
  next: TourChapter | null;
}

interface TourApi {
  running: boolean;
  minimized: boolean;
  chapter: TourChapter | null;
  step: TourStep | null;
  stepIndex: number;
  stepCount: number;
  isLastStep: boolean;
  /** Waiting for the user to do something rather than press Next. */
  waiting: boolean;
  welcomeSeen: boolean;
  completed: string[];
  /** Set while the "chapter done" card is up, instead of a step. */
  finish: TourFinish | null;
  /** Start the whole tour, or one chapter by id. */
  start: (chapterId?: string) => void;
  next: () => void;
  back: () => void;
  stop: () => void;
  minimize: () => void;
  resume: () => void;
  dismissWelcome: () => void;
  /** Start the chapter offered on the finish card. */
  continueNext: () => void;
}

const TourContext = createContext<TourApi | null>(null);

export function useTour(): TourApi {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used inside <TourProvider>");
  return ctx;
}

export function TourProvider({ children }: { children: ReactNode }) {
  const nav = useNav();
  const [persisted, setPersisted] = useState<Persisted>(loadPersisted);
  const [queue, setQueue] = useState<string[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [minimized, setMinimized] = useState(false);
  const [finish, setFinish] = useState<TourFinish | null>(null);

  const chapter = queue.length > 0 ? getChapter(queue[queueIndex]) ?? null : null;
  const step = chapter?.steps[stepIndex] ?? null;
  const stepCount = chapter?.steps.length ?? 0;
  const isLastStep = !!chapter && stepIndex === stepCount - 1 && queueIndex === queue.length - 1;
  const running = !!step || !!finish;

  const markCompleted = useCallback((chapterId: string) => {
    setPersisted((p) =>
      p.completed.includes(chapterId)
        ? p
        : { ...p, completed: [...p.completed, chapterId] });
  }, []);

  useEffect(() => { savePersisted(persisted); }, [persisted]);

  const stop = useCallback(() => {
    setQueue([]);
    setQueueIndex(0);
    setStepIndex(0);
    setMinimized(false);
    setFinish(null);
  }, []);

  const start = useCallback((chapterId?: string) => {
    const ids = chapterId ? [chapterId] : CHAPTERS.map((c) => c.id);
    if (ids.length === 0) return;
    setQueue(ids);
    setQueueIndex(0);
    setStepIndex(0);
    setMinimized(false);
    setFinish(null);
    setPersisted((p) => (p.welcomeSeen ? p : { ...p, welcomeSeen: true }));
  }, []);

  const next = useCallback(() => {
    if (!chapter) return;
    if (stepIndex < chapter.steps.length - 1) {
      setStepIndex((i) => i + 1);
      return;
    }
    markCompleted(chapter.id);
    if (queueIndex < queue.length - 1) {
      setQueueIndex((i) => i + 1);
      setStepIndex(0);
      return;
    }
    // Out of queued chapters: close on a card that offers whatever comes next,
    // so a single-chapter run never dead-ends.
    const i = CHAPTERS.findIndex((c) => c.id === chapter.id);
    setFinish({ chapter, next: i >= 0 ? CHAPTERS[i + 1] ?? null : null });
    setQueue([]);
    setQueueIndex(0);
    setStepIndex(0);
    setMinimized(false);
  }, [chapter, stepIndex, queueIndex, queue.length, markCompleted]);

  const back = useCallback(() => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
    } else if (queueIndex > 0) {
      const prev = getChapter(queue[queueIndex - 1]);
      setQueueIndex((i) => i - 1);
      setStepIndex(prev ? prev.steps.length - 1 : 0);
    }
  }, [stepIndex, queueIndex, queue]);

  const continueNext = useCallback(() => {
    const target = finish?.next;
    setFinish(null);
    if (target) start(target.id);
  }, [finish, start]);

  const dismissWelcome = useCallback(() => {
    setPersisted((p) => ({ ...p, welcomeSeen: true }));
  }, []);

  // ── Put the app on the page the step belongs to ────────────────────────────
  // One-shot per step: after a step has navigated once, the user — or the
  // step's own action, such as opening the player — stays in control.
  const navigatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!step?.page || !chapter) { navigatedFor.current = null; return; }
    const key = `${chapter.id}/${step.id}`;
    if (navigatedFor.current === key) return;
    navigatedFor.current = key;

    // The overlay player counts as being on the Player page, so a player step
    // never closes it out from under the user.
    if (step.page === "player") {
      if (!nav.playerRecordingId && nav.page !== "player") nav.setPage("player");
      return;
    }
    if (nav.playerRecordingId) nav.closePlayer();
    if (nav.page !== step.page) nav.setPage(step.page);
  }, [step, chapter, nav]);

  // ── Advance conditions ─────────────────────────────────────────────────────
  // A step can list several; whichever fires first moves the tour on.
  const conditions: Advance[] = !step?.advance
    ? [{ type: "button" }]
    : Array.isArray(step.advance) ? step.advance : [step.advance];
  const waiting = conditions.every((c) => c.type !== "button");

  // `next` changes identity every render; keep the listeners stable.
  const nextRef = useRef(next);
  useEffect(() => { nextRef.current = next; }, [next]);

  useEffect(() => {
    if (!step || minimized) return;
    const specs = !step.advance
      ? []
      : Array.isArray(step.advance) ? step.advance : [step.advance];
    const cleanups: (() => void)[] = [];

    for (const cond of specs) {
      if (cond.type === "click" && step.anchor) {
        // The user clicks the highlighted element itself.
        const anchor = step.anchor;
        const onClick = (e: MouseEvent) => {
          const target = e.target as HTMLElement | null;
          if (!target?.closest(`[data-tour="${anchor}"]`)) return;
          // Let the app react to the click first, then move on.
          window.setTimeout(() => nextRef.current(), 350);
        };
        document.addEventListener("click", onClick, true);
        cleanups.push(() => document.removeEventListener("click", onClick, true));
      }

      if (cond.type === "event") {
        // A page reported that something happened.
        const wanted = cond.event;
        cleanups.push(onTourEvent((name) => {
          if (name === wanted) window.setTimeout(() => nextRef.current(), 250);
        }));
      }

      if (cond.type === "anchor") {
        // Some other element appeared — polled, because it can take a while
        // (unpacking a recording, a backend round-trip).
        const wanted = cond.anchor;
        const id = window.setInterval(() => {
          if (findAnchor(wanted)) {
            window.clearInterval(id);
            nextRef.current();
          }
        }, 300);
        cleanups.push(() => window.clearInterval(id));
      }
    }

    return () => cleanups.forEach((fn) => fn());
  }, [step, minimized]);

  // Steps pointing at something that may legitimately not exist (an eye camera
  // this recording doesn't have) skip themselves instead of stalling.
  useEffect(() => {
    if (!step?.optional || !step.anchor || minimized) return;
    const anchor = step.anchor;
    const id = window.setTimeout(() => {
      if (!findAnchor(anchor)) nextRef.current();
    }, 700);
    return () => window.clearTimeout(id);
  }, [step, minimized]);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!running || minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); stop(); return; }
      // Don't steal Enter/arrows from an input the step is asking to fill in.
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (typing || waiting) return;
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [running, minimized, waiting, next, back, stop]);

  const value = useMemo<TourApi>(() => ({
    running,
    minimized,
    chapter,
    step,
    stepIndex,
    stepCount,
    isLastStep,
    waiting,
    welcomeSeen: persisted.welcomeSeen,
    completed: persisted.completed,
    finish,
    start,
    next,
    back,
    stop,
    minimize: () => setMinimized(true),
    resume: () => setMinimized(false),
    dismissWelcome,
    continueNext,
  }), [
    running, minimized, chapter, step, stepIndex, stepCount, isLastStep, waiting,
    persisted, finish, start, next, back, stop, dismissWelcome, continueNext,
  ]);

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}
