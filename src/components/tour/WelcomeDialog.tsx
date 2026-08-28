import { GraduationCap, Play, X } from "lucide-react";
import { useTour } from "@/lib/tour/TourProvider";

/**
 * Shown once, on the very first launch. Answering it — either way — is
 * remembered, so it never interrupts again; the tour stays reachable from the
 * help menu in the top bar.
 */
export function WelcomeDialog() {
  const tour = useTour();

  if (tour.welcomeSeen || tour.running) return null;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60">
      <div className="w-[440px] rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/50 p-6">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-500/25
                           flex items-center justify-center">
            <GraduationCap className="w-4.5 h-4.5 text-indigo-400" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-white">First time here?</h2>
            <p className="text-[11px] text-zinc-500">A guided walkthrough of the whole pipeline</p>
          </div>
          <button
            onClick={tour.dismissWelcome}
            title="Close"
            className="ml-auto text-zinc-500 hover:text-zinc-300 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="mt-4 text-xs text-zinc-400 leading-relaxed">
          The tour highlights what to click and explains each step on your own data — from creating
          a project and importing a recording through to exporting the results. It follows along at
          your pace: minimise it while something is processing, leave whenever you like, and restart
          it from the help menu in the top bar.
        </p>

        <div className="mt-5 flex items-center gap-2">
          <button
            onClick={tour.dismissWelcome}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
          >
            Maybe later
          </button>
          <button
            onClick={() => tour.start()}
            className="ml-auto flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs text-white
                       bg-indigo-600 hover:bg-indigo-500 transition-colors cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" /> Start the tour
          </button>
        </div>
      </div>
    </div>
  );
}
