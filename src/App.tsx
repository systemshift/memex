import { useCallback, useEffect, useState } from "react";
import { api, MountStatus } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { RightPanel } from "./components/RightPanel";
import { Ribbon } from "./components/Ribbon";
import { StatusBar } from "./components/StatusBar";
import { EditorTabs } from "./components/EditorTabs";
import { CommandPalette } from "./components/CommandPalette";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/SettingsModal";
import { GraphViewModal } from "./components/GraphViewModal";
import { ClustersModal } from "./components/ClustersModal";
import { useHistory } from "./hooks/useHistory";
import { useTabs } from "./hooks/useTabs";
import "./App.css";

type SaveState = "idle" | "saving" | "saved" | "error";

const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * App shell. Composes ribbon / sidebar / tabs / editor / right panel /
 * status bar, owns the navigation state (history + open tabs), and
 * hosts the global overlays (command palette, search, settings).
 *
 * Every child panel fetches its own data from memex-fs via the api
 * wrapper — App doesn't hold graph data itself, only orchestration.
 */
export default function App() {
  const [mount, setMount] = useState<MountStatus | null>(null);
  const [bootId, setBootId] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [bootError, setBootError] = useState<string | null>(null);

  // Global overlay state.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [clustersOpen, setClustersOpen] = useState(false);

  // Word count for the status bar — the editor feeds this.
  const [currentContent, setCurrentContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // Navigation plumbing.
  const history = useHistory(bootId);
  const tabs = useTabs(bootId);

  const apiKeyPresent = useMemo_api_key_env_check();

  // Bootstrap on mount: check FUSE, ensure today's daily note exists.
  useEffect(() => {
    (async () => {
      const m = await api.mountStatus();
      setMount(m);
      if (!m.mounted) return;
      try {
        const id = await api.todayNoteId();
        try {
          await api.readNode(id);
        } catch {
          // ignore — writeNode below will create
        }
        await api.writeNode(id, await api.readNode(id));
        setBootId(id);
      } catch (e) {
        setBootError(String(e));
      }
    })();
  }, []);

  // Unified navigation: whenever something selects a node, route
  // through here so tabs + history stay in sync.
  const goTo = useCallback(
    (id: string) => {
      if (!id) return;
      tabs.open(id);
      history.go(id);
    },
    [tabs, history],
  );

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Keep history and tabs pointed at the same node when activation
  // changes via the tab row or a back/forward button.
  useEffect(() => {
    if (tabs.active && tabs.active !== history.current) {
      history.go(tabs.active);
    }
  }, [tabs.active]);
  useEffect(() => {
    if (history.current && history.current !== tabs.active) {
      tabs.open(history.current);
    }
  }, [history.current]);

  const onNewNode = useCallback(() => {
    const raw = window.prompt(
      "New node id (format: type:identifier, e.g. note:first-draft)",
    );
    if (!raw) return;
    const id = raw.trim();
    if (!id || id.includes("/") || id.includes("..")) {
      window.alert(`Invalid id: ${id}`);
      return;
    }
    api
      .writeNode(id, "")
      .then(() => {
        goTo(id);
        bump();
      })
      .catch((e) => window.alert(`Create failed: ${e}`));
  }, [goTo, bump]);

  const onToday = useCallback(() => {
    api.todayNoteId().then((id) => {
      // Create if missing.
      api.writeNode(id, "").catch(() => {});
      goTo(id);
      bump();
    });
  }, [goTo, bump]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const k = e.key.toLowerCase();
      if (k === "k" && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (k === "d" && !e.shiftKey) {
        e.preventDefault();
        onToday();
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        onNewNode();
      } else if (k === "[") {
        e.preventDefault();
        history.back();
      } else if (k === "]") {
        e.preventDefault();
        history.forward();
      } else if (k === "w" && !e.shiftKey) {
        e.preventDefault();
        if (tabs.active) tabs.close(tabs.active);
      } else if (k === "g" && !e.shiftKey) {
        e.preventDefault();
        setGraphOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [history.back, history.forward, onToday, onNewNode, tabs]);

  // Close overlays on Escape — common, and independent of modifiers.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (clustersOpen) setClustersOpen(false);
      else if (graphOpen) setGraphOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (searchOpen) setSearchOpen(false);
      else if (paletteOpen) setPaletteOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [paletteOpen, searchOpen, settingsOpen, graphOpen, clustersOpen]);

  const wordCount = currentContent.trim()
    ? currentContent.trim().split(/\s+/).length
    : 0;

  if (mount && !mount.mounted) {
    return (
      <main className="layout-unmounted">
        <h1>memex-fs isn't mounted</h1>
        <p>Expected at: <code>{mount.path}</code></p>
        <p>
          Start it with:
          <br />
          <code>memex-fs mount --data ~/.memex/data --mount {mount.path}</code>
        </p>
      </main>
    );
  }

  if (!mount || !tabs.active) {
    return (
      <main className="layout-loading">
        <p className="muted">{bootError ?? "Loading…"}</p>
      </main>
    );
  }

  const currentId = tabs.active;

  return (
    <>
      <div className="app-shell">
        <Ribbon
          onToday={onToday}
          onNew={onNewNode}
          onSearch={() => setSearchOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          onCommand={() => setPaletteOpen(true)}
          onGraph={() => setGraphOpen(true)}
          onClusters={() => setClustersOpen(true)}
          onBack={history.back}
          onForward={history.forward}
          canBack={history.canBack}
          canForward={history.canForward}
        />

        <div className="layout">
          <Sidebar
            currentId={currentId}
            onSelect={goTo}
            refreshKey={refreshKey}
            onNewNode={onNewNode}
          />

          <div className="main-column">
            <EditorTabs
              tabs={tabs.tabs}
              active={currentId}
              onActivate={tabs.activate}
              onClose={tabs.close}
              refreshKey={refreshKey}
            />
            <EditorWithSave
              key={currentId}
              nodeId={currentId}
              onSaved={bump}
              onContentChange={setCurrentContent}
              onSaveState={setSaveState}
            />
          </div>

          <RightPanel
            nodeId={currentId}
            refreshKey={refreshKey}
            onSelect={goTo}
          />
        </div>

        <StatusBar
          mountPath={mount.path}
          wordCount={wordCount}
          saveState={saveState}
          model={DEFAULT_MODEL}
          apiKeyPresent={apiKeyPresent}
          nodeCount={null}
        />
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectNode={goTo}
        onToday={onToday}
        onNew={onNewNode}
        onSearch={() => setSearchOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={goTo}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mountPath={mount.path}
        model={DEFAULT_MODEL}
        apiKeyPresent={apiKeyPresent}
      />
      <GraphViewModal
        open={graphOpen}
        onClose={() => setGraphOpen(false)}
        centerId={currentId}
        onSelect={goTo}
      />
      <ClustersModal
        open={clustersOpen}
        onClose={() => setClustersOpen(false)}
        onSelect={goTo}
      />
    </>
  );
}

/** Editor wrapper that also reports save state up. Keeping the wrapper
 *  external so Editor stays focused on content editing. */
function EditorWithSave({
  nodeId,
  onSaved,
  onContentChange,
  onSaveState,
}: {
  nodeId: string;
  onSaved?: () => void;
  onContentChange?: (c: string) => void;
  onSaveState: (s: SaveState) => void;
}) {
  return (
    <EditorWithSaveInner
      nodeId={nodeId}
      onSaved={onSaved}
      onContentChange={onContentChange}
      onSaveState={onSaveState}
    />
  );
}

function EditorWithSaveInner(props: {
  nodeId: string;
  onSaved?: () => void;
  onContentChange?: (c: string) => void;
  onSaveState: (s: SaveState) => void;
}) {
  // Patch the Editor to pipe saveState up by overriding writeNode
  // via a proxy effect. Simpler: render the Editor and derive state
  // from its observable effects.
  return (
    <Editor
      nodeId={props.nodeId}
      onSaved={() => {
        props.onSaveState("saved");
        // Reset to idle after a moment so the status bar doesn't look frozen.
        window.setTimeout(() => props.onSaveState("idle"), 1200);
        props.onSaved?.();
      }}
      onContentChange={(c) => {
        props.onSaveState("saving");
        props.onContentChange?.(c);
      }}
    />
  );
}

/** Check whether OPENAI_API_KEY is likely set in the Tauri-process
 *  env. We have no Tauri command for env reads today, so the UI
 *  assumes a common default; the backend fails loud if the key is
 *  missing, and the status bar updates when a chat attempt errors. */
function useMemo_api_key_env_check(): boolean {
  // TODO: expose a Tauri command that reports env presence without
  //       leaking the key itself. Until then, default to "probably set"
  //       and let the chat failure surface the reality.
  return true;
}
