import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import type { Env } from "@orbix/config";
import dbPlugin from "./plugins/db";
import sessionPlugin from "./plugins/session";
import { queuePlugin } from "./plugins/queue";
import health from "./routes/health";
import setup from "./routes/setup";
import auth from "./routes/auth";
import profilesRoute from "./routes/profiles";
import settingsRoute from "./routes/settings";
import librariesRoute from "./routes/libraries";
import { imagesRoute } from "./routes/images";
import scanRoute from "./routes/scan";
import catalogRoute from "./routes/catalog";
import streamRoute from "./routes/stream";
import subtitlesRoute from "./routes/subtitles";
import playstateRoute from "./routes/playstate";
import discoveryRoute from "./routes/discovery";
import { fixRoute } from "./routes/fix";
import { refreshRoute } from "./routes/refresh";
import { TmdbClient, getSetting } from "@orbix/core";
import { refreshMetadata } from "./jobs/refresh-metadata.js";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const origins = env.WEB_ORIGIN.split(",").map((s) => s.trim());
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(dbPlugin);
  await app.register(sessionPlugin);
  await app.register(queuePlugin(env));
  await app.register(health);
  await app.register(setup);
  await app.register(auth);
  await app.register(profilesRoute);
  await app.register(settingsRoute);
  await app.register(librariesRoute);
  await app.register(imagesRoute(env));
  await app.register(scanRoute);
  await app.register(catalogRoute);
  await app.register(streamRoute(env));
  await app.register(subtitlesRoute);
  await app.register(playstateRoute);
  await app.register(discoveryRoute);
  await app.register(fixRoute(env));
  await app.register(refreshRoute(env));

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

  return app;
}
