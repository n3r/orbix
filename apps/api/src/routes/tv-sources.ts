import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Env } from "@orbix/config";
import { Prisma } from "@orbix/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { tvEvents, tvDoneCache } from "../plugins/tv-queue";
import { seedEpgSourcesForCountries } from "../lib/tv-epg";

interface TvSourceBody {
  kind?: string;
  name?: string;
  url?: string;
  countries?: unknown;
  epgUrl?: string;
  /** Raw playlist text (JSON upload — the repo has no multipart dependency). */
  fileContent?: string;
  enabled?: boolean;
}

/** Normalize a countries payload to trimmed UPPERCASE codes; null when invalid. */
function parseCountries(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const c of input) {
    if (typeof c !== "string") return null;
    const code = c.trim().toUpperCase();
    if (code) out.push(code);
  }
  return out;
}

// Playlists can be a few MB — Fastify's default 1 MiB body limit is too small
// for an uploaded M3U. 25 MiB is far above any real-world playlist.
const PLAYLIST_BODY_LIMIT = 25 * 1024 * 1024;

export function tvSourcesRoute(env: Env) {
  return async function tvSources(app: FastifyInstance) {
    const manage = { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] };
    const playlistsDir = path.join(env.METADATA_DIR, "tv", "playlists");

    async function writePlaylist(sourceId: string, content: string): Promise<string> {
      const filePath = path.join(playlistsDir, `${sourceId}.m3u`);
      await fs.promises.mkdir(playlistsDir, { recursive: true });
      await fs.promises.writeFile(filePath, content, "utf8");
      return filePath;
    }

    // GET /tv/sources — every TvSource field is safe to return (no secrets).
    app.get("/tv/sources", manage, async () =>
      app.prisma.tvSource.findMany({ orderBy: { createdAt: "asc" } }),
    );

    // POST /tv/sources
    //   { kind:"iptv-org", name, countries }  (max one row — 409 on a second)
    //   { kind:"m3u", name, url? | fileContent?, epgUrl? }
    app.post<{ Body: TvSourceBody }>(
      "/tv/sources",
      { ...manage, bodyLimit: PLAYLIST_BODY_LIMIT },
      async (req, reply) => {
        const body = req.body ?? {};
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return reply.code(400).send({ error: "invalid_name" });

        if (body.kind === "iptv-org") {
          const existing = await app.prisma.tvSource.findFirst({
            where: { kind: "iptv-org" },
            select: { id: true },
          });
          if (existing) return reply.code(409).send({ error: "iptv_org_exists" });
          const countries = parseCountries(body.countries);
          if (!countries || countries.length === 0) {
            return reply.code(400).send({ error: "countries_required" });
          }
          try {
            const created = await app.prisma.tvSource.create({
              data: { kind: "iptv-org", name, countries },
            });
            // Auto-seed default EPG sources for the newly-enabled countries.
            // Best-effort; idempotent under sequential use (findFirst-then-
            // create) — never touches admin-configured sources. The source
            // row above already committed, so a seeding failure must not
            // fail this request.
            try {
              await seedEpgSourcesForCountries(app.prisma, countries);
            } catch (seedErr) {
              app.log.warn(
                { err: seedErr, sourceId: created.id },
                "tv EPG default-source seeding failed — continuing",
              );
            }
            return created;
          } catch (e) {
            // Belt-and-suspenders: the findFirst check above is a friendly
            // pre-check, but two concurrent requests can both pass it (TOCTOU).
            // The DB-level partial unique index (TvSource_iptv_org_singleton_key)
            // is the real guard — translate its P2002 into the same 409 shape.
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
              return reply.code(409).send({ error: "iptv_org_exists" });
            }
            throw e;
          }
        }

        if (body.kind === "m3u") {
          const url = typeof body.url === "string" ? body.url.trim() : "";
          const fileContent = typeof body.fileContent === "string" ? body.fileContent : "";
          if (!url && !fileContent) return reply.code(400).send({ error: "url_or_file_required" });
          const epgUrl =
            typeof body.epgUrl === "string" && body.epgUrl.trim() ? body.epgUrl.trim() : null;
          const created = await app.prisma.tvSource.create({
            data: { kind: "m3u", name, url: url || null, epgUrl },
          });
          if (fileContent) {
            const filePath = await writePlaylist(created.id, fileContent);
            return await app.prisma.tvSource.update({
              where: { id: created.id },
              data: { filePath },
            });
          }
          return created;
        }

        return reply.code(400).send({ error: "invalid_kind" });
      },
    );

    // PATCH /tv/sources/:id — partial update; fileContent replaces the stored playlist.
    app.patch<{ Params: { id: string }; Body: TvSourceBody }>(
      "/tv/sources/:id",
      { ...manage, bodyLimit: PLAYLIST_BODY_LIMIT },
      async (req, reply) => {
        const body = req.body ?? {};
        const data: Prisma.TvSourceUpdateInput = {};
        if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
        if (typeof body.enabled === "boolean") data.enabled = body.enabled;
        if (typeof body.url === "string") data.url = body.url.trim() || null;
        if (typeof body.epgUrl === "string") data.epgUrl = body.epgUrl.trim() || null;
        let updatedCountries: string[] | null = null;
        if (body.countries !== undefined) {
          const countries = parseCountries(body.countries);
          if (!countries || countries.length === 0) {
            return reply.code(400).send({ error: "countries_required" });
          }
          data.countries = countries;
          updatedCountries = countries;
        }
        try {
          let source = await app.prisma.tvSource.update({ where: { id: req.params.id }, data });
          if (typeof body.fileContent === "string" && body.fileContent && source.kind === "m3u") {
            const filePath = await writePlaylist(source.id, body.fileContent);
            source = await app.prisma.tvSource.update({
              where: { id: source.id },
              data: { filePath },
            });
          }
          // Countries changed on the iptv-org source — auto-seed default EPG
          // sources for the new set. Best-effort; idempotent under
          // sequential use (findFirst-then-create). The update above
          // already committed, so a seeding failure must not fail this
          // request.
          if (updatedCountries && source.kind === "iptv-org") {
            try {
              await seedEpgSourcesForCountries(app.prisma, updatedCountries);
            } catch (seedErr) {
              app.log.warn(
                { err: seedErr, sourceId: source.id },
                "tv EPG default-source seeding failed — continuing",
              );
            }
          }
          return source;
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
            return reply.code(404).send({ error: "not_found" });
          }
          throw e;
        }
      },
    );

    // DELETE /tv/sources/:id — channels cascade; uploaded playlist removed best-effort.
    app.delete<{ Params: { id: string } }>("/tv/sources/:id", manage, async (req, reply) => {
      try {
        const source = await app.prisma.tvSource.delete({ where: { id: req.params.id } });
        if (source.filePath) await fs.promises.unlink(source.filePath).catch(() => {});
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          return reply.code(404).send({ error: "not_found" });
        }
        throw e;
      }
    });

    // POST /tv/sources/:id/sync — enqueue a tv-sync job, return { jobId }.
    app.post<{ Params: { id: string } }>("/tv/sources/:id/sync", manage, async (req, reply) => {
      const source = await app.prisma.tvSource.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!source) return reply.code(404).send({ error: "not_found" });
      const jobId = randomUUID();
      await app.tvQueue.add("tv-sync", { jobId, sourceId: source.id });
      return { jobId };
    });

    // GET /tv/sync/events?jobId= — SSE; forward tvEvents for this jobId until
    // "done"/"error" (scan.ts shape: hijack, done-cache replay for late subscribers).
    app.get<{ Querystring: { jobId?: string } }>("/tv/sync/events", manage, async (req, reply) => {
      const jobId = req.query.jobId;
      if (!jobId) return reply.code(400).send({ error: "job_id_required" });

      // Take raw control of the response so Fastify does not touch it again.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      // If the sync finished before the client connected, replay the cached event.
      const cached = tvDoneCache.get(jobId);
      if (cached) {
        res.write(`data: ${JSON.stringify(cached)}\n\n`);
        res.end();
        return;
      }

      const listener = (event: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event["phase"] === "done" || event["phase"] === "error") {
          tvEvents.off(jobId, listener);
          res.end();
        }
      };

      // Clean up if the client disconnects early.
      req.raw.on("close", () => {
        tvEvents.off(jobId, listener);
      });

      tvEvents.on(jobId, listener);
    });
  };
}
