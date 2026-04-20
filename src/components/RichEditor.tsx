import {
  useCreateBlockNote,
  SuggestionMenuController,
  DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { typeIcon } from "../icons";
import { useNodeLabels } from "../hooks/useNodeLabels";

type Props = {
  nodeId: string;
  onSaved?: () => void;
  onContentChange?: (text: string) => void;
  /** Bumped by the parent when the graph changes so the `[[` picker
   *  sees newly-created nodes. Doesn't trigger editor re-creation. */
  refreshKey?: number;
};

type RefItem = DefaultReactSuggestionItem & { id: string };

/**
 * BlockNote-backed editor. Storage is markdown; the editor
 * serializes to/from markdown on every autosave. Storage stays
 * readable by Claude Code / bash / any other tool talking to
 * memex-fs.
 *
 * Perf note: one editor instance per component mount. Node switches
 * call `replaceBlocks` instead of re-creating the editor, so moving
 * between tabs doesn't tear down ProseMirror every time. This is a
 * meaningful speedup over remount-on-key.
 */
export function RichEditor({ nodeId, onSaved, onContentChange, refreshKey = 0 }: Props) {
  // The nodeId whose content is currently in the editor. Diverges
  // from `nodeId` prop briefly during node-switch while we flush +
  // reload; consulted by change handlers so writes don't cross
  // between nodes.
  const loadedForId = useRef<string>("");
  const saveTimer = useRef<number | null>(null);
  // Latest nodeId in a ref so async callbacks see the current one
  // even when they were captured mid-transition.
  const currentNodeId = useRef<string>(nodeId);
  currentNodeId.current = nodeId;

  const [everyId, setEveryId] = useState<string[]>([]);

  // --- Editor creation (runs once per mount) -----------------------------

  const editor = useCreateBlockNote({
    initialContent: [{ type: "paragraph", content: "" }],

    uploadFile: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = await api.createBinaryNode(
        Array.from(bytes),
        file.type || "application/octet-stream",
        file.name,
      );
      return `memex://${id}`;
    },

    resolveFileUrl: async (url: string) => {
      if (!url.startsWith("memex://")) return url;
      const id = url.slice("memex://".length);
      try {
        const [bytes, mime] = await Promise.all([
          api.readNodeBytes(id),
          api.readNodeMime(id),
        ]);
        const blob = new Blob([new Uint8Array(bytes)], {
          type: mime || "application/octet-stream",
        });
        return URL.createObjectURL(blob);
      } catch {
        return "data:,";
      }
    },
  });

  // --- Autocomplete source -----------------------------------------------
  //
  // Refresh when the graph is known to have changed (refreshKey bump),
  // not on every nodeId switch. Previously this fetch ran on every
  // tab change, which burned IPC and caused a visible stutter.

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const types = await api.listTypes();
        const ids: string[] = [];
        for (const t of types) {
          const rows = await api.listNodesByType(t.name);
          ids.push(...rows);
        }
        if (!cancelled) setEveryId(ids);
      } catch {
        // Not fatal — autocomplete just shows no results.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const labels = useNodeLabels(everyId, refreshKey);

  // --- Node switch: flush pending save, then replace content -------------

  useEffect(() => {
    let cancelled = false;
    const incoming = nodeId;
    const outgoing = loadedForId.current;

    (async () => {
      // 1. Flush the previous node's pending save synchronously so
      // content from the old node never lands on the new one.
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (outgoing && outgoing !== incoming) {
          try {
            const md = await editor.blocksToMarkdownLossy(editor.document);
            await api.writeNode(outgoing, md);
          } catch {
            // Save errors bubble through the parent's status; not critical here.
          }
        }
      }

      if (cancelled) return;

      // 2. Disable writes while we swap in the new content.
      loadedForId.current = "";

      try {
        const md = await api.readNode(incoming);
        if (cancelled) return;
        const blocks = md.trim()
          ? await editor.tryParseMarkdownToBlocks(md)
          : [{ type: "paragraph" as const, content: "" }];
        if (cancelled) return;
        editor.replaceBlocks(editor.document, blocks as any);
        loadedForId.current = incoming;
        onContentChange?.(md);
      } catch {
        // Leave whatever's in the editor; the wrapper renders a
        // load-error banner from its own state.
      }
    })();

    return () => {
      cancelled = true;
    };
    // We deliberately don't depend on editor — it's stable for the
    // lifetime of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // --- Save plumbing -----------------------------------------------------

  const handleChange = useCallback(() => {
    // Ignore events while content is being swapped in.
    if (loadedForId.current !== currentNodeId.current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const target = currentNodeId.current;
    saveTimer.current = window.setTimeout(async () => {
      saveTimer.current = null;
      try {
        const md = await editor.blocksToMarkdownLossy(editor.document);
        await api.writeNode(target, md);
        onContentChange?.(md);
        onSaved?.();
      } catch {}
    }, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, onContentChange, onSaved]);

  const handleBlur = useCallback(async () => {
    if (loadedForId.current !== currentNodeId.current) return;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const target = currentNodeId.current;
    try {
      const md = await editor.blocksToMarkdownLossy(editor.document);
      await api.writeNode(target, md);
      onContentChange?.(md);
      onSaved?.();
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, onContentChange, onSaved]);

  // --- [[ref]] picker ----------------------------------------------------

  const insertRef = useCallback(
    (id: string) => {
      const snippet = `[[${id}]]`;
      const tt: any = (editor as any)._tiptapEditor;
      if (!tt) return;
      const from = tt.state.selection.from;
      const $from = tt.state.selection.$from;
      const text: string = $from.parent.textContent;
      const offsetInNode: number = $from.parentOffset;
      const bracketIdx = text.lastIndexOf("[", offsetInNode - 1);
      const startOfTrigger =
        bracketIdx >= 0 ? from - (offsetInNode - bracketIdx) : from;
      tt.chain()
        .focus()
        .insertContentAt({ from: startOfTrigger, to: from }, snippet)
        .run();
    },
    [editor],
  );

  const getRefItems = useCallback(
    (query: string): RefItem[] => {
      const q = (query ?? "").toLowerCase();
      const normalized = q.startsWith("[") ? q.slice(1).trim() : q.trim();
      const scored = everyId
        .map((id) => ({
          id,
          label: labels[id] ?? id,
        }))
        .filter(({ id, label }) => {
          if (!normalized) return true;
          return (
            id.toLowerCase().includes(normalized) ||
            label.toLowerCase().includes(normalized)
          );
        })
        .slice(0, 20);

      return scored.map(({ id, label }) => {
        const typeName = id.split(":")[0];
        const Icon = typeIcon(typeName);
        return {
          id,
          title: label,
          subtext: id,
          aliases: [id, label],
          icon: <Icon size={14} />,
          onItemClick: () => insertRef(id),
        };
      });
    },
    [everyId, labels, insertRef],
  );

  const themeOverride = useMemo(() => getPreferredTheme(), []);

  return (
    <div className="rich-editor">
      <BlockNoteView
        editor={editor}
        theme={themeOverride}
        onChange={handleChange}
        onBlur={handleBlur}
      >
        <SuggestionMenuController
          triggerCharacter="["
          getItems={async (query) => getRefItems(query)}
        />
      </BlockNoteView>
    </div>
  );
}

function getPreferredTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  const override = document.documentElement.getAttribute("data-theme");
  if (override === "dark" || override === "light") return override;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
