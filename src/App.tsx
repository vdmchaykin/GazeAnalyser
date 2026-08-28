import React, { useCallback, useMemo, useState } from "react";
import { ThemeProvider } from "@/lib/theme";
import { NavContext, useNav, type NavApi } from "@/lib/nav";
import { TourProvider } from "@/lib/tour/TourProvider";
import { TourOverlay } from "@/lib/tour/TourOverlay";
import { WelcomeDialog } from "@/components/tour/WelcomeDialog";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { GazePage } from "@/pages/GazePage";
import { ExportPage } from "@/pages/ExportPage";
import { PlayerPage } from "@/pages/PlayerPage";
import { EventsPage } from "@/pages/EventsPage";
import { AoiPage } from "@/pages/AoiPage";
import { PaperGazePage } from "@/pages/PaperGazePage";
import { VisualisationPage } from "@/pages/VisualisationPage";
import { ConfirmDialogHost } from "@/components/ConfirmDialog";
import type { NavPage, Page, RecordingMeta } from "@/types";

function AppShell() {
  const nav = useNavState();

  return (
    <NavContext.Provider value={nav}>
      <TourProvider>
        <AppInner />
        <WelcomeDialog />
        <TourOverlay />
      </TourProvider>
    </NavContext.Provider>
  );
}

/** Page + player state, shared through NavContext so the tour can drive it. */
function useNavState(): NavApi {
  const [page, setPage] = useState<Page>("projects");
  const [playerRecordingId, setPlayerRecordingId] = useState<string | null>(null);
  const [navRecording, setNavRecording] = useState<RecordingMeta | null>(null);

  const openPlayer = useCallback((id: string) => setPlayerRecordingId(id), []);
  const closePlayer = useCallback(() => setPlayerRecordingId(null), []);
  const navigateWithRecording = useCallback((p: NavPage, recording: RecordingMeta) => {
    setNavRecording(recording);
    setPage(p);
  }, []);
  const goToPage = useCallback((p: Page) => setPage(p), []);
  const clearRecording = useCallback(() => setNavRecording(null), []);

  return useMemo(() => ({
    page, playerRecordingId, navRecording,
    setPage: goToPage, openPlayer, closePlayer, navigateWithRecording, clearRecording,
  }), [page, playerRecordingId, navRecording, goToPage, openPlayer, closePlayer,
       navigateWithRecording, clearRecording]);
}

function AppInner() {
  const nav = useNav();
  const { page, playerRecordingId, navRecording } = nav;

  if (playerRecordingId) {
    return (
      <div className="flex h-screen w-screen bg-zinc-950 text-white overflow-hidden">
        <Sidebar current={page} onChange={(p) => { nav.closePlayer(); nav.setPage(p); }} />
        <div className="flex flex-col flex-1 min-w-0">
          <PlayerPage recordingId={playerRecordingId} onBack={nav.closePlayer} />
        </div>
      </div>
    );
  }

  const pages: Record<Page, React.ReactElement> = {
    projects: <ProjectsPage onNavigate={nav.navigateWithRecording} onOpenPlayer={nav.openPlayer} />,
    gaze: <GazePage onOpenPlayer={nav.openPlayer} initialRecording={navRecording ?? undefined} />,
    player: <PlayerPage initialRecording={navRecording ?? undefined} />,
    export: <ExportPage onNavigate={nav.navigateWithRecording} />,
    events: <EventsPage initialRecording={navRecording ?? undefined} />,
    aoi: <AoiPage initialRecording={navRecording ?? undefined} />,
    surface: <PaperGazePage initialRecording={navRecording ?? undefined} />,
    visualisation: <VisualisationPage initialRecording={navRecording ?? undefined} />,
  };

  // Sidebar navigation drops the recording carried over from Projects.
  const handleSidebarChange = (p: Page) => {
    nav.clearRecording();
    nav.setPage(p);
  };

  return (
    <div className="flex h-screen w-screen bg-zinc-950 text-white overflow-hidden">
      <Sidebar current={page} onChange={handleSidebarChange} />
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar current={page} />
        <main className="flex-1 overflow-auto">
          {pages[page]}
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AppShell />
      <ConfirmDialogHost />
    </ThemeProvider>
  );
}

export default App;
