import { useEffect, useRef, useState } from "react";
import { GraduationCap, HelpCircle } from "lucide-react";
import { HELP_CONTENT } from "@/lib/helpContent";
import { tourAnchor } from "@/lib/tour/anchors";
import { CHAPTERS, chapterForPage } from "@/lib/tour/steps";
import { useTour } from "@/lib/tour/TourProvider";

interface HelpButtonProps {
  page: string;
}

export function HelpButton({ page }: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const help = HELP_CONTENT[page];
  const tour = useTour();
  const chapter = chapterForPage(page);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!help) return null;

  return (
    <div className="relative" ref={ref} {...tourAnchor("topbar.help")}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Help"
        aria-label="Help"
        className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
          open ? "text-white bg-zinc-800" : "text-zinc-400 hover:text-white hover:bg-zinc-800"
        }`}
      >
        <HelpCircle className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 max-h-[70vh] overflow-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl z-50 p-4 text-left">
          <h2 className="text-sm font-semibold text-white mb-1">{help.title}</h2>
          {help.intro && (
            <p className="text-xs text-zinc-400 mb-3 leading-relaxed">{help.intro}</p>
          )}
          {(chapter || CHAPTERS.length > 0) && (
            <div className="mb-3 flex items-center gap-2 pb-3 border-b border-zinc-800">
              <button
                onClick={() => { setOpen(false); tour.start(chapter?.id); }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-white
                           bg-indigo-600 hover:bg-indigo-500 transition-colors cursor-pointer"
              >
                <GraduationCap className="w-3.5 h-3.5" />
                {chapter ? "Show me around" : "Start the tour"}
              </button>
              {chapter && (
                <button
                  onClick={() => { setOpen(false); tour.start(); }}
                  className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  Full tour
                </button>
              )}
            </div>
          )}

          <ol className="space-y-3">
            {help.sections.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-zinc-800 text-zinc-300 text-[11px] font-semibold flex items-center justify-center">
                  {i + 1}
                </span>
                <div>
                  <div className="text-xs font-medium text-zinc-200">{s.heading}</div>
                  <div className="text-xs text-zinc-400 leading-relaxed mt-0.5">{s.body}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
