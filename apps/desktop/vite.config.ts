import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Modern webview targets (Tauri 2) — needed for top-level await in the
  // backend selection module. The app's floor is Safari 15 (iOS 15), which
  // reads all of ES2022 but class static blocks: naming it makes the build
  // lower those, in our code and in what we bundle (pdf.js ships one in its
  // "legacy" build, which stopped the PDF reader loading at all there).
  // harness/webkit.test.ts holds the built files to this.
  build: {
    target: ["es2022", "safari15"],
  },

  // The book typesetter runs in a module worker that code-splits
  // (hyphenation patterns load per language).
  worker: {
    format: "es" as const,
  },

  resolve: {
    alias: [
      // fontkit's brotli import only serves WOFF2; the bundled fonts are
      // TTF/OTF, so a stub keeps its 750 KB dictionary out of the bundle.
      {
        find: /^brotli\/decompress\.js$/,
        replacement: fileURLToPath(new URL("./src/book/engine/brotliStub.ts", import.meta.url)),
      },
    ],
  },

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
}));
