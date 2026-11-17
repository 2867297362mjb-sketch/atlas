import { useEffect, useState } from "react";
import { useAppStore } from "@/features/app/stores/app-store";
import { useMemoryGraphStore } from "../stores/memory-graph-store";
import { MemoryGraphCanvas } from "./memory-graph-canvas";
import { MemoryTreeView } from "./memory-tree-view";
import { MemoryGraphView, type MemoryGraphViewMode } from "./views/memory-graph-view";

const VIEW_KEY = "atlas-memory-graph-view-mode";

/** The Memory tab's Graph sub-tab: store wiring for `MemoryGraphView`. */
export function MemoryGraph() {
  const projectPath = useAppStore((s) => s.currentProject)?.path ?? null;
  const phase = useMemoryGraphStore((s) => s.phase);
  const progress = useMemoryGraphStore((s) => s.progress);
  const error = useMemoryGraphStore((s) => s.error);
  const graph = useMemoryGraphStore((s) => s.graph);
  const docCount = useMemoryGraphStore((s) => s.docCount);
  const query = useMemoryGraphStore((s) => s.query);
  const querying = useMemoryGraphStore((s) => s.querying);
  const results = useMemoryGraphStore((s) => s.results);
  const matchedIds = useMemoryGraphStore((s) => s.matchedIds);
  const selectedId = useMemoryGraphStore((s) => s.selectedId);
  const { init, download, buildIndex, runQuery, setQuery, clearQuery, select } =
    useMemoryGraphStore((s) => s.actions);

  useEffect(() => {
    if (projectPath) void init(projectPath);
  }, [projectPath, init]);

  const [viewMode, setViewMode] = useState<MemoryGraphViewMode>(() => {
    // Tree is the default/initial view; only an explicit "graph" pref overrides.
    // The read is guarded like the write: storage that throws (blocked, or
    // a webview with it disabled) must not take the Map down with it.
    try {
      return localStorage.getItem(VIEW_KEY) === "graph" ? "graph" : "tree";
    } catch {
      return "tree";
    }
  });
  const changeViewMode = (m: MemoryGraphViewMode) => {
    setViewMode(m);
    try {
      localStorage.setItem(VIEW_KEY, m);
    } catch {
      /* ignore */
    }
  };

  return (
    <MemoryGraphView
      projectOpen={projectPath !== null}
      phase={phase}
      progress={progress}
      error={error}
      graph={graph}
      docCount={docCount}
      query={query}
      querying={querying}
      results={results}
      selectedId={selectedId}
      viewMode={viewMode}
      onViewModeChange={changeViewMode}
      onDownload={() => void download()}
      onRetry={() => {
        if (phase === "download-failed") void download();
        else if (projectPath) void init(projectPath);
      }}
      onQueryChange={setQuery}
      onRunQuery={(q) => {
        if (projectPath) void runQuery(projectPath, q);
      }}
      onClearQuery={clearQuery}
      onSelect={select}
      onReindex={() => {
        if (projectPath) void buildIndex(projectPath);
      }}
      renderStage={(cutoffMs) => {
        if (!graph || !projectPath) return null;
        const Stage = viewMode === "graph" ? MemoryGraphCanvas : MemoryTreeView;
        return (
          <Stage
            graph={graph}
            projectPath={projectPath}
            selectedId={selectedId}
            matchedIds={matchedIds}
            cutoffMs={cutoffMs}
            onSelect={select}
            onActivate={select}
          />
        );
      }}
    />
  );
}
