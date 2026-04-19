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

  listTypes: (): Promise<TypeInfo[]> => invoke("list_types"),

  listNodesByType: (typeName: string): Promise<string[]> =>
    invoke("list_nodes_by_type", { typeName }),

  readOutgoingLinks: (id: string): Promise<LinkInfo[]> =>
    invoke("read_outgoing_links", { id }),

  readBacklinks: (id: string): Promise<LinkInfo[]> =>
    invoke("read_backlinks", { id }),

  readNeighbors: (id: string): Promise<string[]> =>
    invoke("read_neighbors", { id }),
};
