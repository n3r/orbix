import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/auth";
import { requireTvAccess } from "../lib/tv-access";
import { activeProfile } from "../lib/catalog-filter";

// ── Shared card shape (fixed cross-phase contract) ──────────────────────────

export interface TvChannelCard {
  id: string;
  number: number;
  name: string;
  country: string | null;
  categories: string[];
  quality: string | null;
  /** Same-origin cached-image URL ("/api/images/channel/x.png") or null → UI monogram. */
  logo: string | null;
  healthy: boolean;
  favorite: boolean;
}

interface ChannelRow {
  id: string;
  number: number;
  name: string;
  country: string | null;
  categories: string[];
  quality: string | null;
  logoPath: string | null;
  hidden: boolean;
  streams: { protocol: string; status: string }[];
}

const CHANNEL_CARD_SELECT = {
  id: true,
  number: true,
  name: true,
  country: true,
  categories: true,
  quality: true,
  logoPath: true,
  hidden: true,
  streams: { select: { protocol: true, status: true } },
} as const;

const RAIL_CAP = 30;
const RECENTS_CAP = 20;

function toCard(ch: ChannelRow, favoriteIds: ReadonlySet<string>): TvChannelCard {
  return {
    id: ch.id,
    number: ch.number,
    name: ch.name,
    country: ch.country,
    categories: ch.categories,
    quality: ch.quality,
    logo: ch.logoPath ? `/api/images/${ch.logoPath}` : null,
    healthy: ch.streams.some((s) => s.protocol === "hls" && s.status !== "dead"),
    favorite: favoriteIds.has(ch.id),
  };
}

export default async function tvCatalogRoute(app: FastifyInstance) {
  const guard = { preHandler: [requireAuth(app), requireTvAccess(app)] };

  // GET /tv/home — rails: recents, favorites, per-country, per-category.
  app.get("/tv/home", guard, async (req) => {
    const profile = await activeProfile(app, req);

    const [favRows, events, channels] = await Promise.all([
      profile
        ? app.prisma.tvFavorite.findMany({
            where: { profileId: profile.id },
            orderBy: { position: "asc" },
            select: { channelId: true },
          })
        : Promise.resolve([]),
      profile
        ? // Prisma's distinct is applied post-query and interacts badly with
          // take — fetch a recent window and dedupe by channel in memory.
          app.prisma.tvPlayEvent.findMany({
            where: { profileId: profile.id },
            orderBy: { at: "desc" },
            take: 200,
            select: { channelId: true },
          })
        : Promise.resolve([]),
      app.prisma.tvChannel.findMany({
        where: { hidden: false },
        orderBy: { number: "asc" },
        select: CHANNEL_CARD_SELECT,
      }),
    ]);

    const favoriteIds = new Set(favRows.map((r) => r.channelId));
    const byId = new Map<string, ChannelRow>(channels.map((c) => [c.id, c]));

    // Recents: latest tune per channel, most recent first, cap 20.
    const seen = new Set<string>();
    const recentIds: string[] = [];
    for (const e of events) {
      if (seen.has(e.channelId)) continue;
      seen.add(e.channelId);
      recentIds.push(e.channelId);
      if (recentIds.length >= RECENTS_CAP) break;
    }
    const recents = recentIds
      .map((id) => byId.get(id))
      .filter((c): c is ChannelRow => c != null)
      .map((c) => toCard(c, favoriteIds));

    const favorites = favRows
      .map((f) => byId.get(f.channelId))
      .filter((c): c is ChannelRow => c != null)
      .map((c) => toCard(c, favoriteIds));

    // Country rails, largest first (channel lists inherit number order).
    const byCountry = new Map<string, ChannelRow[]>();
    for (const c of channels) {
      if (!c.country) continue;
      const list = byCountry.get(c.country);
      if (list) list.push(c);
      else byCountry.set(c.country, [c]);
    }
    const countries = [...byCountry.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([code, list]) => ({
        code,
        channels: list.slice(0, RAIL_CAP).map((c) => toCard(c, favoriteIds)),
      }));

    // Category rails ("on now" annotations arrive with the EPG phase).
    const byCategory = new Map<string, ChannelRow[]>();
    for (const c of channels) {
      for (const cat of c.categories) {
        const list = byCategory.get(cat);
        if (list) list.push(c);
        else byCategory.set(cat, [c]);
      }
    }
    const categories = [...byCategory.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([id, list]) => ({
        id,
        channels: list.slice(0, RAIL_CAP).map((c) => toCard(c, favoriteIds)),
      }));

    return { recents, favorites, countries, categories };
  });

  // GET /tv/guide — windowed channel list; now/next joins arrive with EPG.
  app.get<{
    Querystring: {
      country?: string;
      category?: string;
      favorites?: string;
      q?: string;
      offset?: string;
      limit?: string;
    };
  }>("/tv/guide", guard, async (req) => {
    const profile = await activeProfile(app, req);
    const offsetRaw = Number.parseInt(req.query.offset ?? "", 10);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    const limitRaw = Number.parseInt(req.query.limit ?? "", 10);
    const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 200);
    const q = req.query.q?.trim();
    const favoritesOnly = req.query.favorites === "true" || req.query.favorites === "1";

    const favRows = profile
      ? await app.prisma.tvFavorite.findMany({
          where: { profileId: profile.id },
          select: { channelId: true },
        })
      : [];
    const favoriteIds = new Set(favRows.map((r) => r.channelId));
    if (favoritesOnly && favoriteIds.size === 0) {
      return { total: 0, offset, limit, channels: [] };
    }

    const where = {
      hidden: false,
      ...(req.query.country ? { country: req.query.country.trim().toUpperCase() } : {}),
      ...(req.query.category ? { categories: { has: req.query.category.trim().toLowerCase() } } : {}),
      ...(favoritesOnly ? { id: { in: [...favoriteIds] } } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
    };

    const [total, rows] = await Promise.all([
      app.prisma.tvChannel.count({ where }),
      app.prisma.tvChannel.findMany({
        where,
        orderBy: { number: "asc" },
        skip: offset,
        take: limit,
        select: CHANNEL_CARD_SELECT,
      }),
    ]);

    return { total, offset, limit, channels: rows.map((c) => toCard(c, favoriteIds)) };
  });

  // GET /tv/channels/:id — detail; hidden channels are 404 everywhere.
  app.get<{ Params: { id: string } }>("/tv/channels/:id", guard, async (req, reply) => {
    const [profile, ch] = await Promise.all([
      activeProfile(app, req),
      app.prisma.tvChannel.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          number: true,
          name: true,
          rawName: true,
          country: true,
          languages: true,
          categories: true,
          website: true,
          epgId: true,
          quality: true,
          logoPath: true,
          hidden: true,
          streams: {
            select: { id: true, quality: true, label: true, protocol: true, status: true, priority: true },
            orderBy: { priority: "asc" },
          },
        },
      }),
    ]);
    if (!ch || ch.hidden) return reply.code(404).send({ error: "not_found" });

    const favorite = profile
      ? (await app.prisma.tvFavorite.findUnique({
          where: { profileId_channelId: { profileId: profile.id, channelId: ch.id } },
          select: { id: true },
        })) != null
      : false;

    return {
      id: ch.id,
      number: ch.number,
      name: ch.name,
      rawName: ch.rawName,
      country: ch.country,
      languages: ch.languages,
      categories: ch.categories,
      website: ch.website,
      epgId: ch.epgId,
      quality: ch.quality,
      logo: ch.logoPath ? `/api/images/${ch.logoPath}` : null,
      healthy: ch.streams.some((s) => s.protocol === "hls" && s.status !== "dead"),
      favorite,
      // Stream URLs are deliberately not exposed — playback goes through the
      // phase-2 proxy; the admin channel manager (later phase) gets its own view.
      streams: ch.streams.map((s) => ({
        id: s.id,
        quality: s.quality,
        label: s.label,
        protocol: s.protocol,
        status: s.status,
        priority: s.priority,
      })),
    };
  });

  // GET /tv/channels/:id/programmes — contract-stable stub until the EPG phase
  // (phase 3 of the TV rollout); the shape is locked now so the UI can build
  // against it.
  app.get<{ Params: { id: string }; Querystring: { day?: string } }>(
    "/tv/channels/:id/programmes",
    guard,
    async (req, reply) => {
      const ch = await app.prisma.tvChannel.findUnique({
        where: { id: req.params.id },
        select: { id: true, hidden: true },
      });
      if (!ch || ch.hidden) return reply.code(404).send({ error: "not_found" });
      return { programmes: [] };
    },
  );

  // ── Favorites (per-profile) ────────────────────────────────────────────────

  // PUT /tv/favorites/:channelId — idempotent add, appended position.
  app.put<{ Params: { channelId: string } }>("/tv/favorites/:channelId", guard, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.code(400).send({ error: "no_profile" });
    const ch = await app.prisma.tvChannel.findUnique({
      where: { id: req.params.channelId },
      select: { id: true, hidden: true },
    });
    if (!ch || ch.hidden) return reply.code(404).send({ error: "not_found" });
    const max = await app.prisma.tvFavorite.aggregate({
      where: { profileId: profile.id },
      _max: { position: true },
    });
    await app.prisma.tvFavorite.upsert({
      where: { profileId_channelId: { profileId: profile.id, channelId: ch.id } },
      create: { profileId: profile.id, channelId: ch.id, position: (max._max.position ?? 0) + 1 },
      update: {}, // already a favorite — keep its position
    });
    return { ok: true };
  });

  // DELETE /tv/favorites/:channelId
  app.delete<{ Params: { channelId: string } }>(
    "/tv/favorites/:channelId",
    guard,
    async (req, reply) => {
      const profile = await activeProfile(app, req);
      if (!profile) return reply.code(400).send({ error: "no_profile" });
      await app.prisma.tvFavorite.deleteMany({
        where: { profileId: profile.id, channelId: req.params.channelId },
      });
      return reply.code(204).send();
    },
  );

  // GET /tv/favorites — ordered by position; hidden channels filtered out.
  app.get("/tv/favorites", guard, async (req) => {
    const profile = await activeProfile(app, req);
    if (!profile) return { favorites: [] };
    const rows = await app.prisma.tvFavorite.findMany({
      where: { profileId: profile.id },
      orderBy: { position: "asc" },
      select: { channelId: true, channel: { select: CHANNEL_CARD_SELECT } },
    });
    const favoriteIds = new Set(rows.map((r) => r.channelId));
    return {
      favorites: rows.filter((r) => !r.channel.hidden).map((r) => toCard(r.channel, favoriteIds)),
    };
  });

  // POST /tv/events/:channelId — tune event (recents); client fire-and-forgets.
  app.post<{ Params: { channelId: string } }>("/tv/events/:channelId", guard, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.code(400).send({ error: "no_profile" });
    const ch = await app.prisma.tvChannel.findUnique({
      where: { id: req.params.channelId },
      select: { id: true, hidden: true },
    });
    if (!ch || ch.hidden) return reply.code(404).send({ error: "not_found" });
    await app.prisma.tvPlayEvent.create({ data: { profileId: profile.id, channelId: ch.id } });
    return { ok: true };
  });
}
