import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { requireAuth } from "../lib/auth";
import {
  TmdbClient,
  enrichItem,
  cacheImage,
  getSetting,
  type ImageKind,
  type SaveMetadataInput,
} from "@orbix/core";
import type { Env } from "@orbix/config";
import { embedItem } from "../discovery/embed-worker.js";
import { EmbedderUnavailable } from "../discovery/embedder.js";

export function fixRoute(env: Env) {
  return async function (app: FastifyInstance) {
    // ── Shared helpers ────────────────────────────────────────────────────────

    const getToken = (): Promise<string> =>
      getSetting<string>("tmdbToken", {
        fallback: "",
        read: (k) => app.prisma.setting.findUnique({ where: { key: k } }),
      });

    /** Bound cacheImage — same configuration as queue.ts */
    const boundCacheImage = (tmdbPath: string, kind: ImageKind): Promise<string> =>
      cacheImage(tmdbPath, kind, {
        fetchImpl: fetch,
        exists: (a) =>
          fs.promises.access(a).then(
            () => true,
            () => false,
          ),
        writeFile: async (a, bytes) => {
          await fs.promises.mkdir(path.dirname(a), { recursive: true });
          await fs.promises.writeFile(a, bytes);
        },
        baseDir: env.METADATA_DIR,
      });

    /**
     * saveMetadata adapter for manual re-match: identical to queue.ts but sets
     * matchState="manual" instead of "matched".
     */
    const buildSaveMetadata = (itemId: string) =>
      async (input: SaveMetadataInput): Promise<void> => {
        await app.prisma.$transaction(async (tx) => {
          await tx.mediaItem.update({
            where: { id: itemId },
            data: {
              title: input.title,
              sortTitle: input.title.toLowerCase(),
              year: input.year ?? null,
              overview: input.overview ?? null,
              runtimeSec: input.runtimeSec ?? null,
              posterPath: input.posterPath ?? null,
              backdropPath: input.backdropPath ?? null,
              imdbId: input.imdbId ?? null,
              tmdbId: input.tmdbId,
              matchState: "manual",
              rating: input.rating ?? null,
            },
          });

          await tx.mediaItemGenre.deleteMany({ where: { mediaItemId: itemId } });
          await tx.mediaItemKeyword.deleteMany({ where: { mediaItemId: itemId } });
          await tx.credit.deleteMany({ where: { mediaItemId: itemId } });

          for (const g of input.genres) {
            const genre = await tx.genre.upsert({
              where: { name: g.name },
              create: { name: g.name, tmdbId: g.tmdbId },
              update: {},
            });
            await tx.mediaItemGenre.create({
              data: { mediaItemId: itemId, genreId: genre.id },
            });
          }

          for (const k of input.keywords) {
            const keyword = await tx.keyword.upsert({
              where: { name: k.name },
              create: { name: k.name, tmdbId: k.tmdbId },
              update: {},
            });
            await tx.mediaItemKeyword.create({
              data: { mediaItemId: itemId, keywordId: keyword.id },
            });
          }

          for (const c of input.cast) {
            const person = await tx.person.upsert({
              where: { tmdbId: c.tmdbId },
              create: { tmdbId: c.tmdbId, name: c.name },
              update: { name: c.name },
            });
            await tx.credit.create({
              data: {
                mediaItemId: itemId,
                personId: person.id,
                role: c.character ?? "",
                department: "cast",
                order: c.order,
              },
            });
          }

          if (input.director) {
            const dir = input.director;
            const person = await tx.person.upsert({
              where: { tmdbId: dir.tmdbId },
              create: { tmdbId: dir.tmdbId, name: dir.name },
              update: { name: dir.name },
            });
            await tx.credit.create({
              data: {
                mediaItemId: itemId,
                personId: person.id,
                role: "Director",
                department: "crew",
                order: 0,
              },
            });
          }
        });
      };

    // ── GET /items/:id/match-candidates?q= ────────────────────────────────────

    app.get<{
      Params: { id: string };
      Querystring: { q?: string };
    }>(
      "/items/:id/match-candidates",
      { preHandler: requireAuth(app) },
      async (req, reply) => {
        const token = await getToken();
        if (!token) return reply.code(503).send({ error: "tmdb_not_configured" });

        const item = await app.prisma.mediaItem.findUnique({
          where: { id: req.params.id },
          select: { title: true },
        });
        if (!item) return reply.code(404).send({ error: "not_found" });

        const q = req.query.q?.trim() || item.title;
        const client = new TmdbClient(token);
        const candidates = await client.searchMovies(q);
        return candidates;
      },
    );

    // ── POST /items/:id/match ─────────────────────────────────────────────────

    app.post<{
      Params: { id: string };
      Body: { tmdbId: number };
    }>(
      "/items/:id/match",
      { preHandler: requireAuth(app) },
      async (req, reply) => {
        const token = await getToken();
        if (!token) return reply.code(503).send({ error: "tmdb_not_configured" });

        const item = await app.prisma.mediaItem.findUnique({
          where: { id: req.params.id },
          select: { id: true, title: true, year: true },
        });
        if (!item) return reply.code(404).send({ error: "not_found" });

        const { tmdbId } = req.body;
        if (typeof tmdbId !== "number") {
          return reply.code(400).send({ error: "tmdbId_required" });
        }

        const client = new TmdbClient(token);

        await enrichItem(
          {
            id: item.id,
            title: item.title,
            year: item.year ?? undefined,
            tmdbId,
          },
          {
            client,
            cacheImage: boundCacheImage,
            saveMetadata: buildSaveMetadata(item.id),
          },
        );

        // Re-embed best-effort — silently skip if embedder unavailable
        try {
          await embedItem(app.prisma, item.id);
        } catch (err) {
          if (!(err instanceof EmbedderUnavailable)) {
            app.log.warn({ err, itemId: item.id }, "Re-embed after manual match failed");
          }
        }

        const updated = await app.prisma.mediaItem.findUnique({
          where: { id: item.id },
          select: {
            id: true,
            title: true,
            year: true,
            overview: true,
            posterPath: true,
            backdropPath: true,
            matchState: true,
            tmdbId: true,
          },
        });
        return updated;
      },
    );

    // ── POST /items/:id/poster ─────────────────────────────────────────────────

    app.post<{
      Params: { id: string };
      Body: { tmdbPosterPath: string };
    }>(
      "/items/:id/poster",
      { preHandler: requireAuth(app) },
      async (req, reply) => {
        const token = await getToken();
        if (!token) return reply.code(503).send({ error: "tmdb_not_configured" });

        const item = await app.prisma.mediaItem.findUnique({
          where: { id: req.params.id },
          select: { id: true },
        });
        if (!item) return reply.code(404).send({ error: "not_found" });

        const { tmdbPosterPath } = req.body;
        if (typeof tmdbPosterPath !== "string") {
          return reply.code(400).send({ error: "tmdbPosterPath_required" });
        }

        const localPosterPath = await boundCacheImage(tmdbPosterPath, "poster");

        const updated = await app.prisma.mediaItem.update({
          where: { id: item.id },
          data: {
            posterPath: localPosterPath,
            matchState: "manual",
          },
          select: {
            id: true,
            title: true,
            year: true,
            overview: true,
            posterPath: true,
            backdropPath: true,
            matchState: true,
            tmdbId: true,
          },
        });
        return updated;
      },
    );
  };
}
