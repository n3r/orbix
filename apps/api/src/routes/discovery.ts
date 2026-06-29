import type { FastifyInstance } from "fastify";
import { buildSmartRows, itemSimilarity, continueWatching } from "@orbix/core";
import { requireAuth } from "../lib/auth";

export default async function discoveryRoute(app: FastifyInstance) {
  // GET /home/rows — smart home rows for the active profile
  app.get(
    "/home/rows",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const profileId = req.cookies["orbix_profile"];
      if (!profileId) return reply.code(400).send({ error: "no_profile" });

      // ── 1. Load catalog ──────────────────────────────────────────────────────
      // All MediaItems with genre/keyword/cast/director features (cap 300 for MVP)
      const rawItems = await app.prisma.mediaItem.findMany({
        take: 300,
        select: {
          id: true,
          title: true,
          year: true,
          posterPath: true,
          genres: {
            select: { genre: { select: { name: true } } },
          },
          keywords: {
            select: { keyword: { select: { name: true } } },
          },
          credits: {
            select: {
              role: true,
              department: true,
              order: true,
              person: { select: { name: true } },
            },
            orderBy: { order: "asc" },
          },
        },
      });

      // Build a quick id→item lookup for hydration and history title resolution
      const itemById = new Map(rawItems.map((item) => [item.id, item]));

      // Build catalog: determine playedByProfile via a single PlaybackState +
      // PlayEvent query for this profile
      const [playedStates, playedEvents] = await Promise.all([
        app.prisma.playbackState.findMany({
          where: { profileId },
          select: { mediaItemId: true },
        }),
        app.prisma.playEvent.findMany({
          where: { profileId },
          select: { mediaItemId: true },
        }),
      ]);
      const playedIds = new Set<string>([
        ...playedStates.map((s) => s.mediaItemId),
        ...playedEvents.map((e) => e.mediaItemId),
      ]);

      const catalog = rawItems.map((item) => {
        const genres = item.genres.map((g) => g.genre.name);
        const keywords = item.keywords.map((k) => k.keyword.name);
        const cast = item.credits
          .filter((c) => c.department === "cast")
          .slice(0, 10)
          .map((c) => c.person.name);
        const directorCredit = item.credits.find(
          (c) => c.department === "crew" && c.role === "Director",
        );
        const director = directorCredit?.person.name;

        return {
          id: item.id,
          title: item.title,
          features: { genres, keywords, cast, director },
          playedByProfile: playedIds.has(item.id),
        };
      });

      // ── 2. Continue Watching ─────────────────────────────────────────────────
      const allStates = await app.prisma.playbackState.findMany({
        where: { profileId },
        select: {
          mediaItemId: true,
          positionSec: true,
          durationSec: true,
          finished: true,
          updatedAt: true,
        },
      });
      const cwList = continueWatching(allStates);

      // ── 3. History ───────────────────────────────────────────────────────────
      const events = await app.prisma.playEvent.findMany({
        where: { profileId },
        orderBy: { at: "desc" },
        take: 50,
        select: { mediaItemId: true },
      });
      // Dedup: keep first occurrence (newest) per mediaItemId
      const seen = new Set<string>();
      const history: { mediaItemId: string; title: string }[] = [];
      for (const ev of events) {
        if (seen.has(ev.mediaItemId)) continue;
        seen.add(ev.mediaItemId);
        const item = itemById.get(ev.mediaItemId);
        if (item) history.push({ mediaItemId: ev.mediaItemId, title: item.title });
      }

      // ── 4. Build smart rows ──────────────────────────────────────────────────
      const smartRows = buildSmartRows({
        continueWatching: cwList,
        history,
        catalog,
        simOf: itemSimilarity,
        limit: 20,
      });

      // ── 5. Hydrate itemIds → cards ──────────────────────────────────────────
      const rows = smartRows
        .map((row) => {
          const items = row.itemIds
            .map((id) => {
              const item = itemById.get(id);
              if (!item) return null;
              return {
                id: item.id,
                title: item.title,
                year: item.year,
                posterPath: item.posterPath,
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);

          return { key: row.key, title: row.title, items };
        })
        .filter((row) => row.items.length > 0);

      return { rows };
    },
  );
}
