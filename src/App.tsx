import { useCallback, useEffect, useState } from "react";
import { api, MountStatus } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { RightPanel } from "./components/RightPanel";
import "./App.css";

/**
 * Top-level shell. Holds the currently-selected node id and a "refresh
 * token" that child panels watch to re-query memex-fs when graph-
 * shaped state changes (new node created, content saved with new refs,
 * etc.). Data itself lives entirely on the mount; this component owns
 * only the selection and the refresh cadence.
 */
export default function App() {
  const [mount, setMount] = useState<MountStatus | null>(null);
  const [currentId, setCurrentId] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const m = await api.mountStatus();
      setMount(m);
      if (!m.mounted) return;
      try {
        const id = await api.todayNoteId();
        // Touch today's note so it exists and shows up in /types/Daily/.
        // write_node is idempotent; a blank write creates the dir.
        try {
          await api.readNode(id);
        } catch {
          // ignore; writeNode will create.
        }
        await api.writeNode(id, await api.readNode(id));
        setCurrentId(id);
      } catch (e) {
        setBootError(String(e));
      }
    })();
  }, []);

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

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
        setCurrentId(id);
        bump();
      })
      .catch((e) => window.alert(`Create failed: ${e}`));
  }, [bump]);

  if (mount && !mount.mounted) {
    return (
      <main className="layout-unmounted">
        <h1>memex-fs isn't mounted</h1>
        <p>
          Expected at: <code>{mount.path}</code>
        </p>
        <p>
          Start it with:
          <br />
          <code>
            memex-fs mount --data ~/.memex/data --mount {mount.path}
          </code>
        </p>
      </main>
    );
  }

  if (!mount || !currentId) {
    return (
      <main className="layout-loading">
        <p className="muted">{bootError ?? "Loading…"}</p>
      </main>
    );
  }

  return (
    <div className="layout">
      <Sidebar
        currentId={currentId}
        onSelect={setCurrentId}
        refreshKey={refreshKey}
        onNewNode={onNewNode}
      />
      <Editor
        key={currentId}
        nodeId={currentId}
        onSaved={bump}
      />
      <RightPanel
        nodeId={currentId}
        refreshKey={refreshKey}
        onSelect={setCurrentId}
      />
    </div>
  );
}
