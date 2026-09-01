import { useEffect, useState } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { API_BASE, API_PORT } from "@/lib/apiBase";

type Status = "waiting" | "ready" | "failed";

/** How long to keep trying before telling the user it is not coming up. */
const TIMEOUT_MS = 30_000;
const POLL_MS = 300;

/**
 * Holds the UI back until the backend answers.
 *
 * In a bundled app the Rust shell starts the Python backend at the same moment
 * it opens the window, and that takes a couple of seconds — long enough for
 * every page to fire its first request into a closed port and settle into an
 * error state it never retries out of. In development this instead says plainly
 * that uvicorn is not running.
 */
export function BackendGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("waiting");

  useEffect(() => {
    let cancelled = false;
    const deadline = Date.now() + TIMEOUT_MS;

    const poll = async () => {
      while (!cancelled) {
        try {
          const res = await fetch(`${API_BASE}/api/health`);
          if (res.ok) {
            if (!cancelled) setStatus("ready");
            return;
          }
        } catch {
          // Backend not listening yet — expected while it boots.
        }
        if (Date.now() > deadline) {
          if (!cancelled) setStatus("failed");
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    };
    poll();

    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "ready") return <>{children}</>;

  return (
    <div className="h-screen flex flex-col items-center justify-center gap-3 bg-zinc-950 text-zinc-400">
      {status === "waiting" ? (
        <>
          <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
          <p className="text-sm">Starting the analysis backend…</p>
        </>
      ) : (
        <>
          <PlugZap className="w-6 h-6 text-red-400" />
          <p className="text-sm text-zinc-300">Could not reach the backend on port {API_PORT}.</p>
          <p className="text-xs text-zinc-600 max-w-sm text-center">
            In development, start it with{" "}
            <code className="text-zinc-400">uvicorn app.main:app --port {API_PORT}</code> from the
            backend directory, then reopen this window.
          </p>
        </>
      )}
    </div>
  );
}
