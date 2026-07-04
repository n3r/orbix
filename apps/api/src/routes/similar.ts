import type { FastifyInstance } from "fastify";
import { rankSimilarItems, type SimilarRankItem } from "@orbix/core";
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

// Full local feature select used for hybrid recommendation ranking.
const featureSelect = {
  id: true,
  title: true,
  year: true,
  posterPath: true,
  matchState: true,
  rating: true,
  runtimeSec: true,
  tmdbScore: true,
  imdbRating: true,
  rtRating: true,
  metacritic: true,
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
  runtimeSec: number | null;
  tmdbScore: number | null;
  imdbRating: number | null;
  rtRating: number | null;
  metacritic: number | null;
  genres: { genre: { name: string } }[];
  keywords: { keyword: { name: string } }[];
  credits: { role: string; department: string; order: number; person: { name: string } }[];
};

function toRankItem(item: FeatureRow, vectorScore?: number): SimilarRankItem {
  return {
    id: item.id,
    genres: item.genres.map((g) => g.genre.name),
    keywords: item.keywords.map((k) => k.keyword.name),
    cast: item.credits
      .filter((c) => c.department === "cast")
      .slice(0, 10)
      .map((c) => c.person.name),
    director: item.credits.find((c) => c.department === "crew" && c.role === "Director")?.person.name,
    year: item.year,
    runtimeSec: item.runtimeSec,
    rating: item.rating,
    tmdbScore: item.tmdbScore,
    imdbRating: item.imdbRating,
    rtRating: item.rtRating,
    metacritic: item.metacritic,
    ...(vectorScore !== undefined ? { vectorScore } : {}),
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
      // no embedding yet, the query returns zero rows and we degrade to metadata.
      const vectorScores = new Map<string, number>();
      try {
        const rows = await app.prisma.$queryRaw<{ id: string; distance: number }[]>`
          SELECT mi.id, (e.vector <=> anchor.vector) AS distance
          FROM "MediaItem" mi
          JOIN "Embedding" e ON e."mediaItemId" = mi.id
          JOIN "Embedding" anchor ON anchor."mediaItemId" = ${id}
          WHERE mi.id <> ${id}
            AND mi."matchState" IN ('matched', 'manual')
          ORDER BY e.vector <=> anchor.vector
          LIMIT ${LIMIT * 8}
        `;
        if (rows.length > 0) {
          const ids = rows.map((r) => r.id);
          for (const row of rows) {
            vectorScores.set(row.id, Math.max(0, 1 - Number(row.distance)));
          }
          const vectorCandidates = (await app.prisma.mediaItem.findMany({
            where: { id: { in: ids }, ...(ratingFilter ?? {}) },
            select: featureSelect,
          })) as FeatureRow[];
          const ranked = rankSimilarItems({
            anchor: toRankItem(anchor as FeatureRow),
            candidates: vectorCandidates.map((candidate) =>
              toRankItem(candidate, vectorScores.get(candidate.id)),
            ),
            limit: LIMIT,
            diversityPenalty: 0.16,
          });

          if (ranked.length >= LIMIT) {
            const order = new Map(ranked.map((entry, index) => [entry.id, index] as const));
            const items = vectorCandidates
              .filter((candidate) => order.has(candidate.id))
              .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
              .map(toCard);
            return reply.send({ items });
          }
        }
      } catch (err) {
        // pgvector missing, embedder unavailable, or anchor has no vector — degrade.
        app.log.debug({ err }, "[similar] embeddings path unavailable, using metadata fallback");
      }

      // ── Fallback/supplement: hybrid metadata ranking over the matched catalog.
      const candidates = (await app.prisma.mediaItem.findMany({
        where: {
          id: { not: id },
          matchState: { in: ["matched", "manual"] },
          ...(ratingFilter ?? {}),
        },
        orderBy: [{ year: "desc" }, { id: "asc" }],
        take: 1000,
        select: featureSelect,
      })) as FeatureRow[];

      const ranked = rankSimilarItems({
        anchor: toRankItem(anchor as FeatureRow),
        candidates: candidates.map((candidate) => toRankItem(candidate, vectorScores.get(candidate.id))),
        limit: LIMIT,
        diversityPenalty: 0.16,
      });
      const order = new Map(ranked.map((entry, index) => [entry.id, index] as const));
      const items = candidates
        .filter((candidate) => order.has(candidate.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map(toCard);

      return reply.send({ items });
    },
  );
}
