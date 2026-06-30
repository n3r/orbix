/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const API = process.env.API_INTERNAL_URL ?? "http://localhost:1061";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // @orbix/ui resolves via its package "exports" map (raw TS source); Vite
    // transpiles the linked workspace source. Only "@" needs an alias.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 1060,
    proxy: {
      // Forward /api/* unchanged — Fastify mounts the API under /api, so NO path
      // rewrite. SSE scan stream proxies fine (Vite doesn't buffer responses).
      "/api": { target: API, changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
