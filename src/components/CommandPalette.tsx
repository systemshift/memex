import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";
import { api, TypeInfo } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";
import { typeIcon, Calendar, Search, Plus, Settings, Sparkles } from "../icons";

type Props = {
  open: boolean;
  onClose: () => void;
  onSelectNode: (id: string) => void;
  onToday: () => void;
  onNew: () => void;
  onSearch: () => void;
  onSettings: () => void;
};

type NodeRow = {
  id: string;
  typeName: string;
};

/**
 * Cmd-K command palette. Fuses three sources into one fuzzy-findable
 * list:
 *   - All nodes across every type, each rendered with its label
 *   - Named actions (today, new, search, settings)
 *   - Quick "Ask about …" entries for the top nodes, once chat is a
 *     routine thing (placeholder for now — just opens the node)
 *
 * The list materializes lazily when the palette first opens, so the
 * startup path isn't paying for a full-graph scan.
 */
export function CommandPalette({
  open,
  onClose,
  onSelectNode,
  onToday,
  onNew,
  onSearch,
  onSettings,
}: Props) {
  const [value, setValue] = useState("");
  const [rows, setRows] = useState<NodeRow[] | null>(null);

  // Preload every node once per session when the palette opens. For a
  // personal graph of a few thousand nodes this is milliseconds; if we
  // outgrow that, swap in paginated / indexed search.
  useEffect(() => {
    if (!open || rows !== null) return;
    (async () => {
      try {
        const types: TypeInfo[] = await api.listTypes();
        const out: NodeRow[] = [];
        for (const t of types) {
          const ids = await api.listNodesByType(t.name);
          for (const id of ids) {
            out.push({ id, typeName: t.name });
          }
        }
        setRows(out);
      } catch {
        setRows([]);
      }
    })();
  }, [open, rows]);

  // Reset the filter when the palette opens so an old query doesn't
  // greet the user.
  useEffect(() => {
    if (open) setValue("");
  }, [open]);

  const allIds = useMemo(
    () => (rows ? rows.slice(0, 500).map((r) => r.id) : []),
    [rows],
  );
  const labels = useNodeLabels(allIds, 0);

  if (!open) return null;

  const pick = (id: string) => {
    onSelectNode(id);
    onClose();
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <Command label="Command Palette" shouldFilter loop>
          <Command.Input
            value={value}
            onValueChange={setValue}
            placeholder="Type a node label, an id, or an action…"
            autoFocus
          />
          <Command.List>
            <Command.Empty>No matches.</Command.Empty>

            <Command.Group heading="Actions">
              <Command.Item value="today today's note daily" onSelect={() => { onToday(); onClose(); }}>
                <Calendar size={14} />
                <span>Open today's note</span>
                <span className="palette-shortcut">⌘D</span>
              </Command.Item>
              <Command.Item value="new node create" onSelect={() => { onNew(); onClose(); }}>
                <Plus size={14} />
                <span>New node…</span>
                <span className="palette-shortcut">⌘N</span>
              </Command.Item>
              <Command.Item value="search content fulltext" onSelect={() => { onSearch(); onClose(); }}>
                <Search size={14} />
                <span>Search content</span>
                <span className="palette-shortcut">⌘⇧F</span>
              </Command.Item>
              <Command.Item value="settings preferences" onSelect={() => { onSettings(); onClose(); }}>
                <Settings size={14} />
                <span>Settings</span>
              </Command.Item>
            </Command.Group>

            {rows && rows.length > 0 && (
              <Command.Group heading="Nodes">
                {rows.slice(0, 500).map((r) => {
                  const Icon = typeIcon(r.typeName);
                  const label = labels[r.id] ?? r.id;
                  const showId = label !== r.id;
                  return (
                    <Command.Item
                      key={r.id}
                      value={`${r.id} ${label}`}
                      onSelect={() => pick(r.id)}
                    >
                      <Icon size={14} />
                      <span className="palette-item-label">{label}</span>
                      {showId && (
                        <span className="palette-item-id">{r.id}</span>
                      )}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            <Command.Group heading="Tips">
              <Command.Item value="hint" disabled>
                <Sparkles size={14} />
                <span>Tip: press Esc to close; ↑↓ to navigate</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
