import { existsSync } from "node:fs";
import { join } from "node:path";
import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";

// Serves the built Vite SPA (apps/web/dist) at "/" with an SPA fallback.
// No-op when the dist directory is absent (e.g. local dev where Vite serves the UI).
export const staticWebPlugin = fp(async (app, opts: { distDir?: string }) => {
  const distDir =
    opts.distDir ??
    process.env.WEB_DIST ??
    join(process.cwd(), "apps/web/dist");

  if (!existsSync(join(distDir, "index.html"))) {
    app.log.info({ distDir }, "static-web: no SPA build found; skipping static serving");
    return;
  }

  await app.register(fastifyStatic, { root: distDir, wildcard: false });

  // Unmatched routes: client-route GETs get index.html; anything under /api 404s as JSON.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });
});
