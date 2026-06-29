import type { FastifyInstance } from "fastify";
import { buildSmartRows, itemSimilarity, continueWatching, parseConstraints } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { embedText, EmbedderUnavailable } from "../discovery/embedder.js";
import { backfillEmbeddings } from "../discovery/embed-worker.js";
import { Prisma } from "@orbix/db";

// ── Shared types ──────────────────────────────────────────────────────────────

interface SearchItem {
  id: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  matchState: string;
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/** Format a float[] as a pgvector literal string: "[0.1,-0.2,...]" */
function toVecLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Rank candidates by keyword match on residual text, then by recency/title.
 * Empty residual → sort by year desc, title asc.
 * Returns top-20.
 */
function rankByKeyword(
  candidates: Array<{
    id: string;
    title: string;
    year: number | null;
    posterPath: string | null;
    matchState: string;
    overview: string | null;
  }>,
  residual: string,
): SearchItem[] {
  const lower = residual.toLowerCase();
  return [...candidates]
    .map((item) => ({
      item,
      score:
        (lower && item.title.toLowerCase().includes(lower) ? 2 : 0) +
        (lower && (item.overview ?? "").toLowerCase().includes(lower) ? 1 : 0),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.item.year ?? 0) - (a.item.year ?? 0) ||
        a.item.title.localeCompare(b.item.title),
    )
    .slice(0, 20)
    .map(({ item }) => ({
      id: item.id,
      title: item.title,
      year: item.year,
      posterPath: item.posterPath,
      matchState: item.matchState,
    }));
}

// ── Route plugin ──────────────────────────────────────────────────────────────

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

  // ── GET /search?q= ──────────────────────────────────────────────────────────
  // NL mood search: constraint filter + vector ranking (with keyword degrade).
  app.get(
    "/search",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const { q = "" } = req.query as { q?: string };
      const c = parseConstraints(q);

      // Build the Prisma WHERE clause from parsed constraints
      const where: Prisma.MediaItemWhereInput = { matchState: "matched" };

      // Runtime filter
      const runtimeFilter: { lte?: number; gte?: number } = {};
      if (c.runtimeMaxSec !== undefined) runtimeFilter.lte = c.runtimeMaxSec;
      if (c.runtimeMinSec !== undefined) runtimeFilter.gte = c.runtimeMinSec;
      if (Object.keys(runtimeFilter).length > 0) {
        where.runtimeSec = runtimeFilter;
      }

      // Decade / year filter
      const yearFilter: { gte?: number; lte?: number } = {};
      if (c.decadeStart !== undefined) yearFilter.gte = c.decadeStart;
      if (c.decadeEnd !== undefined) yearFilter.lte = c.decadeEnd;
      if (Object.keys(yearFilter).length > 0) {
        where.year = yearFilter;
      }

      // Genre filter: item must have ANY of the requested genres
      if (c.genres.length > 0) {
        where.genres = {
          some: { genre: { name: { in: c.genres } } },
        };
      }

      // Fetch candidates (cap 500 to keep ranking tractable)
      const candidates = await app.prisma.mediaItem.findMany({
        where,
        take: 500,
        select: {
          id: true,
          title: true,
          year: true,
          posterPath: true,
          matchState: true,
          overview: true,
        },
      });

      if (candidates.length === 0) {
        return reply.send({ items: [], usedEmbeddings: false });
      }

      let items: SearchItem[];
      let usedEmbeddings = false;

      if (c.residualText) {
        // ── Embeddings path (with EmbedderUnavailable degrade) ────────────────
        try {
          const qv = await embedText(c.residualText, { kind: "query" });
          const vecLit = toVecLiteral(qv);
          const candidateIds = candidates.map((item) => item.id);

          // Inline vector literal as raw SQL (safe: computed from model output,
          // not user input).  Parameterise candidate IDs normally via Prisma.join.
          const idJoin = Prisma.join(candidateIds);
          const vecRaw = Prisma.raw(`'${vecLit}'::vector`);

          const ranked = await app.prisma.$queryRaw<SearchItem[]>`
            SELECT mi.id, mi.title, mi.year, mi."posterPath", mi."matchState"
            FROM "MediaItem" mi
            JOIN "Embedding" e ON e."mediaItemId" = mi.id
            WHERE mi.id IN (${idJoin})
            ORDER BY e.vector <=> ${vecRaw}
            LIMIT 20
          `;

          if (ranked.length > 0) {
            items = ranked;
            usedEmbeddings = true;
          } else {
            // No embeddings exist for these candidates yet — degrade to keyword
            items = rankByKeyword(candidates, c.residualText);
          }
        } catch (err) {
          if (err instanceof EmbedderUnavailable) {
            // Graceful degrade: embedder not loaded
            items = rankByKeyword(candidates, c.residualText);
          } else {
            throw err;
          }
        }
      } else {
        // No residual text after constraint extraction — sort by recency/title
        items = rankByKeyword(candidates, "");
      }

      return reply.send({ items, usedEmbeddings });
    },
  );

  // ── POST /embeddings/backfill ────────────────────────────────────────────────
  // Admin endpoint: fire-and-forget backfill of missing Embedding rows.
  app.post(
    "/embeddings/backfill",
    { preHandler: requireAuth(app) },
    async (_req, reply) => {
      // Fire-and-forget: backfill returns void (catches its own errors).
      void backfillEmbeddings(app.prisma).catch((err: unknown) => {
        app.log.error(err, "[backfill] unhandled error");
      });
      return reply.send({ started: true });
    },
  );
}
