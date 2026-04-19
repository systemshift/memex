import {
  useCreateBlockNote,
  SuggestionMenuController,
  DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { typeIcon } from "../icons";
import { useNodeLabels } from "../hooks/useNodeLabels";

type Props = {
  nodeId: string;
  onSaved?: () => void;
  onContentChange?: (text: string) => void;
};

/** Picker entry for the `[[ref]]` autocomplete. Extends BlockNote's
 *  DefaultReactSuggestionItem shape with the node id so the onItemClick
 *  handler can resolve back to the graph. */
type RefItem = DefaultReactSuggestionItem & { id: string };

/**
 * BlockNote-backed editor. Storage remains markdown — the editor
 * serializes to/from markdown on every autosave and every mount-
 * switch, so the `content` file on memex-fs stays readable by
 * Claude Code / bash / any other consumer.
 *
 * Markdown round-trip via BlockNote is "lossy" for some exotic
 * constructs (their word), but clean for everything we use right
 * now: headings, paragraphs, bullet/numbered lists, quote, code,
 * inline bold/italic/code, links. Round-trip edge cases show up
 * as diffs in the commit chain, not data loss.
 *
 * The `[[ref]]` experience: typing `[[` opens a floating picker
 * scoped to every node in the graph. Selecting inserts
 * `[[type:id]]` as plain text at the cursor; memex-fs's link
 * index picks it up on save and the backlinks panel reflects it.
 */
export function RichEditor({ nodeId, onSaved, onContentChange }: Props) {
  const [loaded, setLoaded] = useState(false);
  // Stable per-mount reference so we can re-init the editor when
  // the node changes without tearing BlockNote fully down.
  const lastLoaded = useRef<string>("");
  const saveTimer = useRef<number | null>(null);
  const [everyId, setEveryId] = useState<string[]>([]);

  const editor = useCreateBlockNote({
    // Start with an empty document; we hydrate asynchronously after
    // the mount so markdown parsing doesn't block first paint.
    initialContent: [{ type: "paragraph", content: "" }],

    /**
     * Route dropped / pasted / attached files through memex-fs as
     * new binary nodes (Image / Video / File / Audio / PDF). The
     * returned `memex://{id}` URL is embedded in the block; the
     * resolveFileUrl callback below turns it into a blob URL on
     * render so the webview can actually display it.
     */
    uploadFile: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = await api.createBinaryNode(
        Array.from(bytes),
        file.type || "application/octet-stream",
        file.name,
      );
      return `memex://${id}`;
    },

    /**
     * Turn `memex://{id}` into a Blob URL the browser can render.
     * Pass through any other URL (http, https, data:, file:) so
     * users can still embed external images if they want.
     *
     * Memory note: blob URLs are not revoked here — BlockNote
     * holds them as long as the block is mounted. The Editor key
     * resets on node-switch, so lingering blobs are bounded by
     * how many blocks you display per node.
     */
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
        // Broken URL — return an empty data: url so BlockNote shows
        // its default broken-image placeholder.
        return "data:,";
      }
    },
  });

  // Pull every node id once (cheap on a personal graph) for the
  // `[[` picker's fuzzy search. Labels are fetched lazily via the
  // same hook the sidebar uses.
  useEffect(() => {
    (async () => {
      try {
        const types = await api.listTypes();
        const ids: string[] = [];
        for (const t of types) {
          const rows = await api.listNodesByType(t.name);
          ids.push(...rows);
        }
        setEveryId(ids);
      } catch {
        // Not fatal — autocomplete just shows no results.
      }
    })();
  }, [nodeId]);

  const labels = useNodeLabels(everyId, 0);

  // Hydrate editor when the selected node changes. Parse the
  // node's markdown into blocks and swap them in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoaded(false);
      try {
        const md = await api.readNode(nodeId);
        const blocks = md.trim()
          ? await editor.tryParseMarkdownToBlocks(md)
          : [{ type: "paragraph" as const, content: "" }];
        if (cancelled) return;
        editor.replaceBlocks(editor.document, blocks as any);
        lastLoaded.current = nodeId;
        onContentChange?.(md);
      } catch {
        // Leave the editor empty; the load error banner lives
        // in the Editor wrapper one level up.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  // Save on debounce. BlockNote fires onChange on every keystroke;
  // we wait 800 ms of quiet before asking memex-fs to commit.
  const handleChange = () => {
    if (!loaded || lastLoaded.current !== nodeId) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        const md = await editor.blocksToMarkdownLossy(editor.document);
        await api.writeNode(nodeId, md);
        onContentChange?.(md);
        onSaved?.();
      } catch {
        // Save errors surface through the status bar via the
        // wrapper's state; nothing to do here.
      }
    }, 800);
  };

  // Also commit immediately on blur so a window switch doesn't
  // leave pending changes in memory for up to 800 ms.
  const handleBlur = async () => {
    if (!loaded || lastLoaded.current !== nodeId) return;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      const md = await editor.blocksToMarkdownLossy(editor.document);
      await api.writeNode(nodeId, md);
      onContentChange?.(md);
      onSaved?.();
    } catch {}
  };

  // Picker items for the `[[` trigger. We trigger on `[` and filter
  // the query string to handle the second bracket the user types to
  // create `[[`.
  const getRefItems = (query: string): RefItem[] => {
    const q = (query ?? "").toLowerCase();
    // Strip the second `[` if present (that's the one the user typed
    // after the trigger).
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
  };

  /** Replace the trigger char (`[`) and any typed query back to it
   *  with `[[id]]`. BlockNote doesn't expose the TipTap editor in its
   *  public TS surface, so this uses the underscore-prefixed escape
   *  hatch — safe for our single-app use, not production-API-safe. */
  const insertRef = (id: string) => {
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
  };

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

/**
 * Honor the same light/dark resolution the rest of the app uses.
 * BlockNote's Mantine theme accepts "light" | "dark"; we watch the
 * document's effective theme on first render (the Settings modal
 * toggles `data-theme` at the root).
 */
function getPreferredTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  const override = document.documentElement.getAttribute("data-theme");
  if (override === "dark" || override === "light") return override;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
