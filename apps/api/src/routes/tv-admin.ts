import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Prisma } from "@orbix/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import type { TvEpgJobData } from "../plugins/tv-queue";

const CHANNEL_SELECT = {
  id: true, number: true, name: true, country: true, categories: true, quality: true,
  logoPath: true, hidden: true, kidsAllowed: true, epgId: true,
} as const;

interface AdminChannelRow {
  id: string;
  number: number;
  name: string;
  country: string | null;
  categories: string[];
  quality: string | null;
  logoPath: string | null;
  hidden: boolean;
  kidsAllowed: boolean;
  epgId: string | null;
}

/**
 * Map a DB row (logoPath) to the API shape (logo) — same convention as
 * /tv/home + /tv/guide (tv-catalog.ts's toCard): the client only ever sees a
 * same-origin cached-image URL, never the on-disk relative path.
 */
function toAdminChannel(ch: AdminChannelRow) {
  const { logoPath, ...rest } = ch;
  return { ...rest, logo: logoPath ? `/api/images/${logoPath}` : null };
}

function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

export default async function tvAdminRoute(app: FastifyInstance): Promise<void> {
  const guards = { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] };

  // ── EPG sources CRUD ──────────────────────────────────────────────────────
  app.get("/tv/epg-sources", guards, async () => {
    return app.prisma.tvEpgSource.findMany({ orderBy: { createdAt: "asc" } });
  });

  app.post("/tv/epg-sources", guards, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; url?: string; offsetMin?: number };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const offsetMin = body.offsetMin ?? 0;
    if (!name || !isHttpUrl(url) || !Number.isInteger(offsetMin)) {
      return reply.code(400).send({ error: "invalid_epg_source" });
    }
    try {
      const created = await app.prisma.tvEpgSource.create({ data: { name, url, offsetMin } });
      return reply.code(201).send(created);
    } catch (e) {
      // The DB-level unique constraint on `url` (TvEpgSource_url_key) is the
      // real guard against duplicate EPG sources — translate its P2002 into a
      // friendly 409 (same pattern as the iptv-org singleton in tv-sources.ts).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.code(409).send({ error: "epg_source_exists" });
      }
      throw e;
    }
  });

  app.patch("/tv/epg-sources/:id", guards, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string; url?: string; enabled?: boolean; offsetMin?: number };
    const existing = await app.prisma.tvEpgSource.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const data: Prisma.TvEpgSourceUpdateInput = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) return reply.code(400).send({ error: "invalid_name" });
      data.name = body.name.trim();
    }
    if (body.url !== undefined) {
      if (typeof body.url !== "string" || !isHttpUrl(body.url.trim())) return reply.code(400).send({ error: "invalid_url" });
      data.url = body.url.trim();
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return reply.code(400).send({ error: "invalid_enabled" });
      data.enabled = body.enabled;
    }
    if (body.offsetMin !== undefined) {
      if (!Number.isInteger(body.offsetMin)) return reply.code(400).send({ error: "invalid_offset" });
      data.offsetMin = body.offsetMin;
    }
    try {
      return await app.prisma.tvEpgSource.update({ where: { id }, data });
    } catch (e) {
      // The DB-level unique constraint on `url` (TvEpgSource_url_key) rejects
      // duplicate URLs — translate its P2002 into a friendly 409.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.code(409).send({ error: "epg_source_exists" });
      }
      throw e;
    }
  });

  app.delete("/tv/epg-sources/:id", guards, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await app.prisma.tvEpgSource.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await app.prisma.tvEpgSource.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.post("/tv/epg/refresh", guards, async (_req, reply) => {
    const jobId = randomUUID();
    await app.tvQueue.add("tv-epg", { jobId } satisfies TvEpgJobData);
    return reply.code(202).send({ jobId });
  });

  // ── Channel manager ───────────────────────────────────────────────────────
  app.get("/tv/admin/channels", guards, async (req) => {
    const q = req.query as { q?: string; country?: string; offset?: string; limit?: string };
    const offset = Math.max(0, Number.parseInt(q.offset ?? "0", 10) || 0);
    const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit ?? "50", 10) || 50));
    const where: Prisma.TvChannelWhereInput = {}; // NOTE: no hidden filter — manager sees everything
    if (q.country) where.country = q.country;
    if (q.q && q.q.trim()) {
      const term = q.q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { rawName: { contains: term, mode: "insensitive" } },
      ];
    }
    const [total, channels] = await Promise.all([
      app.prisma.tvChannel.count({ where }),
      app.prisma.tvChannel.findMany({
        where, orderBy: { number: "asc" }, skip: offset, take: limit, select: CHANNEL_SELECT,
      }),
    ]);
    return { total, channels: channels.map(toAdminChannel) };
  });

  app.patch("/tv/admin/channels/:id", guards, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { hidden?: unknown; kidsAllowed?: unknown; epgId?: unknown; number?: unknown };
    const existing = await app.prisma.tvChannel.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const data: Prisma.TvChannelUpdateInput = {};
    if (body.hidden !== undefined) {
      if (typeof body.hidden !== "boolean") return reply.code(400).send({ error: "invalid_hidden" });
      data.hidden = body.hidden;
    }
    if (body.kidsAllowed !== undefined) {
      if (typeof body.kidsAllowed !== "boolean") return reply.code(400).send({ error: "invalid_kids_allowed" });
      data.kidsAllowed = body.kidsAllowed;
    }
    if (body.epgId !== undefined) {
      if (body.epgId !== null && typeof body.epgId !== "string") return reply.code(400).send({ error: "invalid_epg_id" });
      const trimmed = typeof body.epgId === "string" ? body.epgId.trim() : null;
      data.epgId = trimmed || null; // "" → null (no guide)
    }
    if (body.number !== undefined) {
      if (typeof body.number !== "number" || !Number.isInteger(body.number) || body.number < 1) {
        return reply.code(400).send({ error: "invalid_number" });
      }
      data.number = body.number;
    }
    const updated = await app.prisma.tvChannel.update({ where: { id }, data, select: CHANNEL_SELECT });
    return toAdminChannel(updated);
  });
}
