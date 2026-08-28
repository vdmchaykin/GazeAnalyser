import { useEffect, useMemo, useState, type ElementType, type ReactNode } from "react";
import { ChevronRight, Film, FolderOpen } from "lucide-react";
import { formatDuration, formatDate } from "@/lib/utils";
import { RecordingThumbnail } from "@/components/player/RecordingThumbnail";
import type { Project, ProjectRef, RecordingMeta } from "@/types";

/**
 * The one recording picker every page uses: projects on top, each expanding to
 * the recordings inside it, loose recordings below.
 *
 * A recording is treated as belonging to a single project (its first membership)
 * — the schema allows several, but the app's workflow assumes one, and listing a
 * recording under two projects would make the same row appear twice.
 */

/** Which projects the user has expanded, shared by every page's picker. */
const STORAGE_KEY = "picker.expandedProjects";

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveExpanded(ids: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch { /* private mode — expansion just won't persist */ }
}

interface ProjectGroup {
  id: string;
  name: string;
  recordings: RecordingMeta[];
}

/** Split recordings into their project groups plus the ones in no project. */
function groupByProject(
  recordings: RecordingMeta[],
  extraProjects: Project[],
): { groups: ProjectGroup[]; loose: RecordingMeta[] } {
  const byId = new Map<string, ProjectGroup>();
  const loose: RecordingMeta[] = [];

  // Projects with no recordings are invisible in the memberships, so seed the
  // map from the caller's project list when it has one. Seeded projects keep the
  // caller's order; ones found only through a membership are sorted by name.
  for (const p of extraProjects) byId.set(p.id, { id: p.id, name: p.name, recordings: [] });
  const seeded = new Set(byId.keys());
  const discovered: ProjectGroup[] = [];

  for (const rec of recordings) {
    const project = rec.projects?.[0];
    if (!project) {
      loose.push(rec);
      continue;
    }
    let group = byId.get(project.id);
    if (!group) {
      group = { id: project.id, name: project.name, recordings: [] };
      byId.set(project.id, group);
      discovered.push(group);
    }
    group.recordings.push(rec);
  }

  discovered.sort((a, b) => a.name.localeCompare(b.name));
  const groups = [...seeded].map((id) => byId.get(id)!).concat(discovered);
  return { groups, loose };
}

export interface RecordingPickerProps {
  recordings: RecordingMeta[];
  loading?: boolean;
  /** Lets projects that hold no recordings still appear (the Export page needs this). */
  projects?: Project[];
  selectedRecordingId?: string | null;
  selectedProjectId?: string | null;
  onSelect: (rec: RecordingMeta) => void;
  /** When given, a project row is selectable too; otherwise it only expands. */
  onSelectProject?: (project: ProjectRef) => void;
  /** "all" also lists project recordings in the bottom section (Export). */
  recordingsSection?: "ungrouped" | "all";
  /** Expand the project holding a recording this matches — used to keep the
      tour's demo recording reachable without the user opening its project. */
  autoExpand?: (rec: RecordingMeta) => boolean;
  /** Extra props for a recording's row, e.g. a tour anchor. */
  rowProps?: (rec: RecordingMeta) => Record<string, unknown> | undefined;
  emptyIcon?: ElementType;
  emptyText?: string;
  /** Sidebar box classes (width and borders). */
  className?: string;
  /** Extra props for the sidebar itself, e.g. a tour anchor. */
  containerProps?: Record<string, unknown>;
}

export function RecordingPicker({
  recordings,
  loading = false,
  projects = [],
  selectedRecordingId = null,
  selectedProjectId = null,
  onSelect,
  onSelectProject,
  recordingsSection = "ungrouped",
  autoExpand,
  rowProps,
  emptyIcon: EmptyIcon = Film,
  emptyText = "No recordings yet",
  className = "w-80 border-r border-zinc-800",
  containerProps,
}: RecordingPickerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);

  const { groups, loose } = useMemo(
    () => groupByProject(recordings, projects),
    [recordings, projects],
  );

  // Open the project holding the current selection (a page opened for a specific
  // recording) or a recording the caller wants reachable straight away.
  useEffect(() => {
    const wanted = recordings.filter(
      (r) => r.id === selectedRecordingId || autoExpand?.(r),
    );
    if (wanted.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const rec of wanted) {
        const id = rec.projects?.[0]?.id;
        if (id && !next.has(id)) { next.add(id); changed = true; }
      }
      if (!changed) return prev;
      saveExpanded(next);
      return next;
    });
  // autoExpand is a fresh closure on every render, so it stays out of the deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordings, selectedRecordingId]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveExpanded(next);
      return next;
    });
  };

  const listed = recordingsSection === "all" ? recordings : loose;
  const nothingAtAll = recordings.length === 0 && groups.length === 0;

  return (
    <div className={`${className} flex flex-col shrink-0`} {...containerProps}>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="text-zinc-500 text-xs p-4">Loading…</p>
        ) : nothingAtAll ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
            <EmptyIcon className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs">{emptyText}</p>
          </div>
        ) : (
          <>
            {groups.length > 0 && (
              <>
                <SectionLabel>Projects</SectionLabel>
                {groups.map((group) => (
                  <div key={group.id}>
                    <ProjectRow
                      group={group}
                      open={expanded.has(group.id)}
                      active={selectedProjectId === group.id}
                      onToggle={() => toggle(group.id)}
                      onSelect={
                        onSelectProject && (() => onSelectProject({ id: group.id, name: group.name }))
                      }
                    />
                    {expanded.has(group.id) && (
                      group.recordings.length === 0 ? (
                        <p className="pl-11 pr-4 py-2 text-[11px] text-zinc-600
                                      border-b border-zinc-800/50">
                          No recordings in this project
                        </p>
                      ) : (
                        group.recordings.map((rec) => (
                          <RecordingRow
                            key={rec.id}
                            rec={rec}
                            nested
                            active={selectedRecordingId === rec.id}
                            onClick={() => onSelect(rec)}
                            extraProps={rowProps?.(rec)}
                          />
                        ))
                      )
                    )}
                  </div>
                ))}
              </>
            )}

            {listed.length > 0 && (
              <>
                <SectionLabel>Recordings</SectionLabel>
                {listed.map((rec) => (
                  <RecordingRow
                    key={rec.id}
                    rec={rec}
                    active={selectedRecordingId === rec.id}
                    onClick={() => onSelect(rec)}
                    extraProps={rowProps?.(rec)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The picker beside an empty pane — the "nothing selected yet" state that every
 * page opens on.
 */
export function RecordingPickerScreen({
  placeholder,
  placeholderIcon: PlaceholderIcon,
  ...picker
}: RecordingPickerProps & { placeholder: ReactNode; placeholderIcon?: ElementType }) {
  return (
    <div className="flex h-full">
      <RecordingPicker {...picker} />
      <div className="flex-1 flex items-center justify-center text-zinc-600">
        <div className="text-center">
          {PlaceholderIcon && <PlaceholderIcon className="w-10 h-10 mb-3 mx-auto opacity-20" />}
          <p className="text-sm">{placeholder}</p>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
      {children}
    </p>
  );
}

function ProjectRow({
  group, open, active, onToggle, onSelect,
}: {
  group: ProjectGroup;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  /** Set only where a project is a valid target on its own (the Export page). */
  onSelect?: () => void;
}) {
  const count = group.recordings.length;
  const body = (
    <>
      <FolderOpen className="w-4 h-4 shrink-0 text-indigo-400" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{group.name}</p>
        <p className="text-[11px] text-zinc-500 truncate">
          {count} recording{count === 1 ? "" : "s"}
        </p>
      </div>
    </>
  );
  const rowClass = `w-full flex items-center gap-3 px-4 py-2.5 text-left
    border-b border-zinc-800/50 transition-colors cursor-pointer
    ${active ? "bg-zinc-800" : "hover:bg-zinc-900"}`;

  // Without a select handler the whole row is the expand toggle; with one, the
  // row selects the project and only the chevron expands it.
  if (!onSelect) {
    return (
      <button onClick={onToggle} className={rowClass} aria-expanded={open}>
        {body}
        <Chevron open={open} />
      </button>
    );
  }
  return (
    <div className={rowClass}>
      <button onClick={onSelect} className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer">
        {body}
      </button>
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? "Collapse project" : "Expand project"}
        className="p-1 -mr-1 rounded hover:bg-zinc-800 cursor-pointer"
      >
        <Chevron open={open} />
      </button>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={`w-3.5 h-3.5 text-zinc-600 shrink-0 transition-transform
                  ${open ? "rotate-90" : ""}`}
    />
  );
}

function RecordingRow({
  rec, nested = false, active, onClick, extraProps,
}: {
  rec: RecordingMeta;
  nested?: boolean;
  active: boolean;
  onClick: () => void;
  extraProps?: Record<string, unknown>;
}) {
  return (
    <button
      {...extraProps}
      onClick={onClick}
      className={`w-full flex items-center gap-3 py-2.5 text-left
        border-b border-zinc-800/50 transition-colors cursor-pointer
        ${nested ? "pl-7 pr-4" : "px-4"}
        ${active ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
    >
      <RecordingThumbnail recordingId={rec.id} className="w-14 h-8 rounded shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{rec.name}</p>
        <p className="text-[11px] text-zinc-500 truncate">
          {rec.wearer_name} · {formatDuration(rec.duration_sec)} · {formatDate(rec.start_time)}
        </p>
      </div>
      <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
    </button>
  );
}
