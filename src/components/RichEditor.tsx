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
  /** Fired after every successful save — status-bar indicator only. */
  onSaved?: () => void;
  /** Fired only when the save's [[refs]] set differs from the prior
   *  save's. This gates the expensive panel refetch cascade. */
  onGraphChanged?: () => void;
  onContentChange?: (text: string) => void;
};

type RefItem = DefaultReactSuggestionItem & { id: string };

/** Pattern used to extract [[type:id]] / [[type:id#bN]] refs from the
 *  saved markdown so we can detect structural changes without parsing. */
const REF_RE = /\[\[([\w]+:[a-f0-9]{8,64}(?:#b\d+)?)\]\]/g;
function refsFingerprint(md: string): string {
  const set = new Set<string>();
  for (const m of md.matchAll(REF_RE)) set.add(m[1]);
  return [...set].sort().join("|");
}

/** TTL for the `[[` picker's node list. Refetches lazily inside
 *  getRefItems when the list is older than this; no refetching on
 *  every save. */
const AUTOCOMPLETE_TTL_MS = 5000;

/**
 * BlockNote-backed editor. Storage is markdown. Autosaves on a 800 ms
 * debounce and on blur. Only bumps the app-wide refresh counter when
 * the save's `[[ref]]` set actually changed, so pure-text edits don't
 * trigger the whole app to refetch its panels.
 */
export function RichEditor({
  nodeId,
  onSaved,
  onGraphChanged,
  onContentChange,
}: Props) {
  const loadedForId = useRef<string>("");
  const saveTimer = useRef<number | null>(null);
  const currentNodeId = useRef<string>(nodeId);
  currentNodeId.current = nodeId;

  // Callbacks held in refs so the BlockNoteView handlers don't need
  // unstable deps in their useCallback memo. React parents tend not
  // to memoize onSaved / onContentChange, and we don't want every
  // parent render to propagate a new handler identity down into
  // ProseMirror land.
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  const graphChangedRef = useRef(onGraphChanged);
  graphChangedRef.current = onGraphChanged;
  const contentChangeRef = useRef(onContentChange);
  contentChangeRef.current = onContentChange;

  // Last saved refs per-node — lets us detect "content changed but
  // [[refs]] didn't" and skip bumping the app refresh counter.
  const lastRefsByNode = useRef<Map<string, string>>(new Map());

  const [everyId, setEveryId] = useState<string[]>([]);
  const lastAutocompleteFetchAt = useRef<number>(0);
  const autocompleteInFlight = useRef<Promise<void> | null>(null);

  // --- Editor creation (once per mount) ----------------------------------

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

  // --- Autocomplete source (mount + lazy TTL refresh) --------------------

  const fetchEveryId = useCallback(async () => {
    // Coalesce concurrent calls.
    if (autocompleteInFlight.current) return autocompleteInFlight.current;
    const p = (async () => {
      try {
        const types = await api.listTypes();
        const ids: string[] = [];
        for (const t of types) {
          const rows = await api.listNodesByType(t.name);
          ids.push(...rows);
        }
        setEveryId(ids);
        lastAutocompleteFetchAt.current = Date.now();
      } catch {
        // Not fatal — picker just shows stale / no results.
      } finally {
        autocompleteInFlight.current = null;
      }
    })();
    autocompleteInFlight.current = p;
    return p;
  }, []);

  // Initial fetch on mount. Subsequent fetches are triggered lazily
  // from getRefItems when the user actually opens the `[[` picker.
  useEffect(() => {
    fetchEveryId();
  }, [fetchEveryId]);

  const labels = useNodeLabels(everyId, 0);

  // --- Node switch: flush outgoing save, then replace content ------------

  useEffect(() => {
    let cancelled = false;
    const incoming = nodeId;
    const outgoing = loadedForId.current;

    (async () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (outgoing && outgoing !== incoming) {
          try {
            const md = await editor.blocksToMarkdownLossy(editor.document);
            await api.writeNode(outgoing, md);
          } catch {}
        }
      }

      if (cancelled) return;
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
        lastRefsByNode.current.set(incoming, refsFingerprint(md));
        contentChangeRef.current?.(md);
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // --- Save plumbing -----------------------------------------------------
  //
  // Handlers are stable (empty deps) because everything they read is
  // behind a ref. BlockNoteView therefore doesn't see a new handler
  // identity on every parent render.

  const commitSave = useCallback(async (target: string) => {
    try {
      const md = await editor.blocksToMarkdownLossy(editor.document);
      await api.writeNode(target, md);
      contentChangeRef.current?.(md);
      savedRef.current?.();
      // Only bump the app refresh counter when [[refs]] changed.
      const now = refsFingerprint(md);
      const prev = lastRefsByNode.current.get(target);
      if (prev !== undefined && prev !== now) {
        graphChangedRef.current?.();
      }
      lastRefsByNode.current.set(target, now);
    } catch {
      // Save errors surface through the status bar via the save-state
      // wrapper; nothing actionable here.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = useCallback(() => {
    if (loadedForId.current !== currentNodeId.current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const target = currentNodeId.current;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      commitSave(target);
    }, 800);
  }, [commitSave]);

  const handleBlur = useCallback(async () => {
    if (loadedForId.current !== currentNodeId.current) return;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await commitSave(currentNodeId.current);
  }, [commitSave]);

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
    async (query: string): Promise<RefItem[]> => {
      // Lazy TTL refresh — refetch when the list is stale and the
      // user is actively using the picker. Fires off-thread so the
      // first keystroke renders immediately with the cached list.
      if (Date.now() - lastAutocompleteFetchAt.current > AUTOCOMPLETE_TTL_MS) {
        fetchEveryId();
      }
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
    [everyId, labels, insertRef, fetchEveryId],
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
          getItems={getRefItems}
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
