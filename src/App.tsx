import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type MountStatus = {
  path: string;
  mounted: boolean;
};

/**
 * v0.3 shell: opens today's daily note, edits it, saves on blur + on a
 * debounced timer while typing. Everything else — backlinks, neighbors,
 * time travel, federation — layers on top of this in subsequent work.
 */
function App() {
  const [nodeId, setNodeId] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [status, setStatus] = useState<MountStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<number | null>(null);

  // On launch: check mount, resolve today's id, read its content.
  useEffect(() => {
    (async () => {
      const s = await invoke<MountStatus>("mount_status");
      setStatus(s);
      if (!s.mounted) return;

      const id = await invoke<string>("today_note_id");
      setNodeId(id);

      try {
        const text = await invoke<string>("read_node", { id });
        setContent(text);
      } catch (e) {
        setLoadError(String(e));
      }
    })();
  }, []);

  const save = useCallback(async (id: string, text: string) => {
    setSaveState("saving");
    try {
      await invoke("write_node", { id, content: text });
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      setLoadError(String(e));
    }
  }, []);

  // Debounced autosave: 800ms after last keystroke.
  const onChange = (text: string) => {
    setContent(text);
    setSaveState("idle");
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      if (nodeId) save(nodeId, text);
    }, 800);
  };

  // Save immediately on blur so the file is durable when the user clicks away.
  const onBlur = () => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (nodeId) save(nodeId, content);
  };

  if (status && !status.mounted) {
    return (
      <main className="container mount-missing">
        <h1>memex-fs isn't mounted</h1>
        <p>Expected at: <code>{status.path}</code></p>
        <p>
          Start it with:<br />
          <code>memex mount --data ~/.memex/data --mount {status.path}</code>
        </p>
      </main>
    );
  }

  if (!nodeId) {
    return (
      <main className="container">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="container">
      <header className="toolbar">
        <div className="title">
          <span className="id">{nodeId}</span>
        </div>
        <div className={`save-indicator ${saveState}`}>
          {saveState === "saving" && "saving…"}
          {saveState === "saved" && "saved"}
          {saveState === "error" && "save failed"}
        </div>
      </header>

      {loadError && (
        <p className="error" role="alert">{loadError}</p>
      )}

      <textarea
        className="editor"
        value={content}
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={onBlur}
        spellCheck={true}
        placeholder="Scribble for today…"
        autoFocus
      />
    </main>
  );
}

export default App;
