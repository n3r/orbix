import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import type { Env } from "@orbix/config";
import dbPlugin from "./plugins/db";
import sessionPlugin from "./plugins/session";
import { queuePlugin } from "./plugins/queue";
import { mountsPlugin } from "./plugins/mounts";
import type { MountRuntime } from "./lib/mount-runtime";
import health from "./routes/health";
import setup from "./routes/setup";
import auth from "./routes/auth";
import profilesRoute from "./routes/profiles";
import menuRoute from "./routes/menu";
import settingsRoute from "./routes/settings";
import { librariesRoute } from "./routes/libraries";
import { imagesRoute } from "./routes/images";
import scanRoute from "./routes/scan";
import catalogRoute from "./routes/catalog";
import streamRoute from "./routes/stream";
import subtitlesRoute from "./routes/subtitles";
import playstateRoute from "./routes/playstate";
import discoveryRoute from "./routes/discovery";
import similarRoute from "./routes/similar";
import seriesRoute from "./routes/series";
import { fixRoute } from "./routes/fix";
import { refreshRoute } from "./routes/refresh";
import { staticWebPlugin } from "./plugins/static-web";
import { TmdbClient, getSetting } from "@orbix/core";
import { refreshMetadata } from "./jobs/refresh-metadata.js";

export async function buildApp(env: Env, overrides?: { mountRuntime?: MountRuntime }): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const runtime = overrides?.mountRuntime;
  const origins = env.WEB_ORIGIN.split(",").map((s) => s.trim());
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(dbPlugin);
  await app.register(sessionPlugin);
  await app.register(queuePlugin(env, { runtime }));
  await app.register(mountsPlugin(env, { runtime }));
  await app.register(health); // root — used by the Docker healthcheck
  // All app API routes live under /api so Fastify can serve them same-origin
  // alongside the static SPA (the browser always calls relative /api/...).
  await app.register(setup, { prefix: "/api" });
  await app.register(auth, { prefix: "/api" });
  await app.register(profilesRoute, { prefix: "/api" });
  await app.register(menuRoute, { prefix: "/api" });
  await app.register(settingsRoute, { prefix: "/api" });
  await app.register(librariesRoute(env, { runtime }), { prefix: "/api" });
  await app.register(imagesRoute(env), { prefix: "/api" });
  await app.register(scanRoute, { prefix: "/api" });
  await app.register(catalogRoute, { prefix: "/api" });
  await app.register(streamRoute(env), { prefix: "/api" });
  await app.register(subtitlesRoute, { prefix: "/api" });
  await app.register(playstateRoute, { prefix: "/api" });
  await app.register(discoveryRoute, { prefix: "/api" });
  await app.register(similarRoute, { prefix: "/api" });
  await app.register(seriesRoute, { prefix: "/api" });
  await app.register(fixRoute(env), { prefix: "/api" });
  await app.register(refreshRoute(env), { prefix: "/api" });

  // ── Periodic metadata refresh (daily; selectStaleItems decides what's stale) ──
  const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
  const refreshTimer = setInterval(async () => {
    try {
      const token = await getSetting<string>("tmdbToken", {
        fallback: "",
        read: (k) => app.prisma.setting.findUnique({ where: { key: k } }),
      });
      if (!token) return; // no-op cleanly when unconfigured

      const cadenceDays = await getSetting<number>("refreshCadenceDays", {
        fallback: 90,
        read: (k) => app.prisma.setting.findUnique({ where: { key: k } }),
      });

      const client = new TmdbClient(token);
      const result = await refreshMetadata(app.prisma, client, {
        cadenceDays,
        metadataDir: env.METADATA_DIR,
      });
      app.log.info(result, "Scheduled metadata refresh complete");
    } catch (err) {
      app.log.error({ err }, "Scheduled metadata refresh failed");
    }
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref(); // don't block process shutdown

  // Serve the built SPA last so its catch-all fallback sits below the API routes.
  await app.register(staticWebPlugin, {});

  return app;
}
