import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.API_TARGET ?? "http://127.0.0.1:4318";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/v1": apiTarget
    }
  }
});
