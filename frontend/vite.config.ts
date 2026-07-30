import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Split the heavy chart library and React out of the app bundle so the browser
    // caches them separately and the first paint isn't blocked by one 1.3 MB file.
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ["echarts"],
          react: ["react", "react-dom"],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    // Must match wherever the backend actually binds. It normally reads PORT=8000
    // from backend/.env, but an OS-level PORT env var (Windows System/User env vars
    // take precedence over .env) can silently override that — check what the
    // backend's own startup log says ("API listening on :____") if this ever drifts.
    proxy: { "/api": { target: "http://localhost:8001", changeOrigin: true } },
  },
});
