import { createContext, useContext } from "react";
import type { NavPage, Page, RecordingMeta } from "@/types";

/**
 * App-level navigation, lifted out of App so anything below it (notably the
 * interactive tour) can drive the page switch instead of only reacting to it.
 */
export interface NavApi {
  page: Page;
  playerRecordingId: string | null;
  /** Recording carried over when jumping from Projects into an analysis page. */
  navRecording: RecordingMeta | null;
  setPage: (p: Page) => void;
  openPlayer: (id: string) => void;
  closePlayer: () => void;
  navigateWithRecording: (p: NavPage, recording: RecordingMeta) => void;
  clearRecording: () => void;
}

export const NavContext = createContext<NavApi | null>(null);

export function useNav(): NavApi {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav must be used inside NavContext.Provider");
  return ctx;
}
