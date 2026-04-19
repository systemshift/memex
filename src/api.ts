import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers around every Tauri command exposed by the Rust backend.
 * Keeping them in one file makes it easy to track what surface the GUI
 * actually uses from memex-fs, and to add new commands without hunting
 * through components.
 */

export type MountStatus = {
  path: string;
  mounted: boolean;
};

export type TypeInfo = {
  name: string;
  count: number;
};

export type LinkInfo = {
  peer: string;
  link_type: string;
};

export const api = {
  mountStatus: (): Promise<MountStatus> => invoke("mount_status"),

  todayNoteId: (): Promise<string> => invoke("today_note_id"),

  readNode: (id: string): Promise<string> => invoke("read_node", { id }),

  writeNode: (id: string, content: string): Promise<void> =>
    invoke("write_node", { id, content }),

  readNodeType: (id: string): Promise<string> => invoke("read_node_type", { id }),

  /**
   * Batch-derive human-meaningful labels for a list of ids. The backend
   * falls back through meta.title > first line of content > humanized
   * id, so every id in the return map is guaranteed to have a label.
   */
  readNodeLabels: (ids: string[]): Promise<Record<string, string>> =>
    invoke("read_node_labels", { ids }),

  listTypes: (): Promise<TypeInfo[]> => invoke("list_types"),

  listNodesByType: (typeName: string): Promise<string[]> =>
    invoke("list_nodes_by_type", { typeName }),

  readOutgoingLinks: (id: string): Promise<LinkInfo[]> =>
    invoke("read_outgoing_links", { id }),

  readBacklinks: (id: string): Promise<LinkInfo[]> =>
    invoke("read_backlinks", { id }),

  readNeighbors: (id: string): Promise<string[]> =>
    invoke("read_neighbors", { id }),

  /** Keyword search via memex-fs's /search/{query}/ view. Order returned
   *  is memex-fs's ranking (currently term-match count). */
  searchNodes: (query: string): Promise<string[]> =>
    invoke("search_nodes", { query }),

  /** Build the Markdown context block for a node, without sending it
   *  to the LLM. Used for the "show context" toggle so users can see
   *  exactly what the assistant was given. */
  compileNodeContext: (id: string): Promise<string> =>
    invoke("compile_node_context", { id }),

  /** Kick off a streaming chat. The return resolves as soon as the
   *  request is in flight; actual tokens arrive via chat-chunk events,
   *  termination via chat-done, errors via chat-error. */
  askStream: (
    nodeId: string,
    history: ChatMessage[],
    question: string,
  ): Promise<void> =>
    invoke("ask_stream", { nodeId, history, question }),
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
