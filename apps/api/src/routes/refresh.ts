/**
 * refresh.ts — Admin maintenance routes
 *
 * POST /maintenance/refresh
 *   Triggers an immediate TMDB metadata refresh for all stale items.
 *   Returns { refreshed, skipped } or { reason: "no_token" }.
 *
 * DELETE /maintenance/cache
 *   Clears all cached poster/backdrop images from disk and nulls out
 *   posterPath/backdropPath on every MediaItem. Strictly path-guarded:
 *   deletes only within METADATA_DIR/poster and METADATA_DIR/backdrop.
 *   Returns { cleared: true }.
 */

import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { requireAuth } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { TmdbClient, getSetting } from "@orbix/core";
import type { Env } from "@orbix/config";
import { refreshMetadata } from "../jobs/refresh-metadata.js";
import { rebuildMetadata } from "../jobs/rebuild-metadata.js";

export function refreshRoute(env: Env) {
  return async function (app: FastifyInstance) {
    // ── POST /maintenance/refresh ────────────────────────────────────────────

    app.post(
      "/maintenance/refresh",
      { preHandler: [requireAuth(app), requireNonKids(app)] },
      async (_req, reply) => {
        const token = await getSetting<string>("tmdbToken", {
          fallback: "",
          read: (k) => app.prisma.setting.findUnique({ where: { key: k } }),
        });

        if (!token) {
          return reply.send({ reason: "no_token" });
        }

        const cadenceDays = await getSetting<number>("refreshCadenceDays", {
          fallback: 90,
          read: (k) => app.prisma.setting.findUnique({ where: { key: k } }),
        });

        const client = new TmdbClient(token);
        const result = await refreshMetadata(app.prisma, client, {
          cadenceDays,
          metadataDir: env.METADATA_DIR,
        });

        return reply.send(result);
      },
    );

    // ── POST /maintenance/rebuild ────────────────────────────────────────────
    // Force-re-enrich every item now (ignores the staleness cadence and the
    // tmdbId requirement), so directly-seeded / never-matched items get real
    // TMDB metadata + artwork without visiting each title's Fix-match page.

    app.post(
      "/maintenance/rebuild",
      { preHandler: [requireAuth(app), requireNonKids(app)] },
      async (_req, reply) => {
        const token = await getSetting<string>("tmdbToken", {
          fallback: "",
          read: (k) => app.prisma.setting.findUnique({ where: { key: k } }),
        });

        if (!token) {
          return reply.send({ reason: "no_token" });
        }

        const client = new TmdbClient(token);
        const result = await rebuildMetadata(app.prisma, client, {
          metadataDir: env.METADATA_DIR,
        });

        return reply.send(result);
      },
    );

    // ── DELETE /maintenance/cache ────────────────────────────────────────────

    app.delete(
      "/maintenance/cache",
      { preHandler: [requireAuth(app), requireNonKids(app)] },
      async (_req, reply) => {
        const safeBase = path.resolve(env.METADATA_DIR);
        const subdirs = ["poster", "backdrop"] as const;

        for (const sub of subdirs) {
          const subDir = path.resolve(path.join(safeBase, sub));

          // Path-escape guard: resolved path must be strictly under safeBase
          if (!subDir.startsWith(safeBase + path.sep) && subDir !== safeBase) {
            app.log.error(
              { subDir, safeBase },
              "Path escape detected — aborting cache clear",
            );
            return reply.code(500).send({ error: "path_escape_detected" });
          }

          try {
            await fs.promises.rm(subDir, { recursive: true, force: true });
          } catch (err) {
            app.log.warn({ err, subDir }, "Failed to remove image subdir — continuing");
          }
        }

        // Null out posterPath and backdropPath on all MediaItems
        await app.prisma.mediaItem.updateMany({
          data: { posterPath: null, backdropPath: null },
        });

        return reply.send({ cleared: true });
      },
    );
  };
}
