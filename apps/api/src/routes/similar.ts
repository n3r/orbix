import type { FastifyInstance } from "fastify";
import { itemSimilarity } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile, kidsRatingWhere, profileAllowsItem } from "../lib/catalog-filter";

const LIMIT = 12;

interface Card {
  id: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  matchState: string;
}

// Full feature select used for the Jaccard fallback (genres/keywords/cast/director).
const featureSelect = {
  id: true,
  title: true,
  year: true,
  posterPath: true,
  matchState: true,
  rating: true,
  genres: { select: { genre: { select: { name: true } } } },
  keywords: { select: { keyword: { select: { name: true } } } },
  credits: {
    select: { role: true, department: true, order: true, person: { select: { name: true } } },
    orderBy: { order: "asc" as const },
  },
} as const;

type FeatureRow = {
  id: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  matchState: string;
  rating: string | null;
  genres: { genre: { name: string } }[];
  keywords: { keyword: { name: string } }[];
  credits: { role: string; department: string; order: number; person: { name: string } }[];
};

function toFeatures(item: FeatureRow) {
  return {
    genres: item.genres.map((g) => g.genre.name),
    keywords: item.keywords.map((k) => k.keyword.name),
    cast: item.credits
      .filter((c) => c.department === "cast")
      .slice(0, 10)
      .map((c) => c.person.name),
    director: item.credits.find((c) => c.department === "crew" && c.role === "Director")?.person.name,
  };
}

function toCard(item: Card): Card {
  return {
    id: item.id,
    title: item.title,
    year: item.year,
    posterPath: item.posterPath,
    matchState: item.matchState,
  };
}

export default async function similarRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/items/:id/similar",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const { id } = req.params;
      const [anchor, profile] = await Promise.all([
        app.prisma.mediaItem.findUnique({ where: { id }, select: featureSelect }),
        activeProfile(app, req),
      ]);
      if (!anchor) return reply.code(404).send({ error: "not_found" });
      // Kids: never reveal similar for a title the profile can't see.
      if (!profileAllowsItem(profile, { rating: anchor.rating })) {
        return reply.code(404).send({ error: "not_found" });
      }

      const ratingFilter = kidsRatingWhere(profile);

      // ── Embeddings path: nearest neighbours of the anchor's vector ───────────
      // The CROSS JOIN to the anchor's own Embedding row means: if the anchor has
      // no embedding yet, the query returns zero rows and we degrade to Jaccard.
      try {
        const rows = await app.prisma.$queryRaw<{ id: string }[]>`
          SELECT mi.id
          FROM "MediaItem" mi
          JOIN "Embedding" e ON e."mediaItemId" = mi.id
          JOIN "Embedding" anchor ON anchor."mediaItemId" = ${id}
          WHERE mi.id <> ${id}
          ORDER BY e.vector <=> anchor.vector
          LIMIT ${LIMIT * 3}
        `;
        if (rows.length > 0) {
          const ids = rows.map((r) => r.id);
          const cards = await app.prisma.mediaItem.findMany({
            where: { id: { in: ids }, ...(ratingFilter ?? {}) },
            select: { id: true, title: true, year: true, posterPath: true, matchState: true },
          });
          const order = new Map(ids.map((x, i) => [x, i] as const));
          const items = cards
            .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
            .slice(0, LIMIT)
            .map(toCard);
          if (items.length > 0) return reply.send({ items });
        }
      } catch (err) {
        // pgvector missing, embedder unavailable, or anchor has no vector — degrade.
        app.log.debug({ err }, "[similar] embeddings path unavailable, using Jaccard fallback");
      }

      // ── Fallback: weighted Jaccard over the matched catalog (cap 1000) ───────
      const candidates = (await app.prisma.mediaItem.findMany({
        where: {
          id: { not: id },
          matchState: { in: ["matched", "manual"] },
          ...(ratingFilter ?? {}),
        },
        take: 1000,
        select: featureSelect,
      })) as FeatureRow[];

      const anchorFeatures = toFeatures(anchor as FeatureRow);
      const items = candidates
        .map((c) => ({ c, score: itemSimilarity(anchorFeatures, toFeatures(c)) }))
        .sort((a, b) => b.score - a.score || (b.c.year ?? 0) - (a.c.year ?? 0))
        .slice(0, LIMIT)
        .map(({ c }) => toCard(c));

      return reply.send({ items });
    },
  );
}
