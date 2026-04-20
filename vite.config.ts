import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Raise the warn threshold so BlockNote's chunk doesn't generate
    // noise — we've deliberately split it into its own chunk.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split heavy dependencies into their own chunks so the
        // initial bundle stays small and each library's bytes only
        // arrive when they're actually needed.
        manualChunks: {
          // React runtime + markdown renderer
          react: ["react", "react-dom", "react-markdown", "remark-gfm"],
          // BlockNote editor (biggest single dep — ProseMirror + extensions)
          blocknote: [
            "@blocknote/react",
            "@blocknote/core",
            "@blocknote/mantine",
          ],
          // Force-directed graph (d3-force + canvas renderer)
          "force-graph": ["react-force-graph-2d"],
          // Command-palette + fuzzy search
          ui: ["cmdk", "fuse.js", "lucide-react"],
        },
      },
    },
  },
}));
