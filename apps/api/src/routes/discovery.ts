import type { FastifyInstance } from "fastify";
import { buildSmartRows, itemSimilarity, continueWatching, parseConstraints, ratingTier, certsAtOrBelow } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile, kidsRatingWhere } from "../lib/catalog-filter";
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

      const profile = await activeProfile(app, req);
      const ratingFilter = kidsRatingWhere(profile);
      const lang = profile?.language ?? "en";
      // Coalesce a loaded item's title to the active language, else base.
      const locTitle = (it: { title: string; translations: { title: string | null }[] }) =>
        it.translations[0]?.title?.trim() ? it.translations[0].title! : it.title;

      // Shared select shape for MediaItem feature loading (used twice: catalog + must-include union)
      const itemSelect = {
        id: true,
        title: true,
        year: true,
        posterPath: true,
        addedAt: true,
        translations: { where: { language: lang }, select: { title: true } },
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
          orderBy: { order: "asc" as const },
        },
      };

      // ── 1. Load catalog + profile activity in parallel ───────────────────────
      // Catalog: deterministic order (newest first), cap raised to 2000 to handle
      // large libraries (similarity computation is O(catalog) per anchor — fine).
      // For kids profiles, apply the maturity rating filter so blocked titles never
      // enter the rows (profile + ratingFilter resolved above).
      const [rawItems, allStates, playedEvents, histEvents] = await Promise.all([
        app.prisma.mediaItem.findMany({
          take: 2000,
          orderBy: [{ addedAt: "desc" }, { id: "asc" }],
          where: ratingFilter ?? undefined,
          select: itemSelect,
        }),
        // Full playback states: used for both continueWatching and playedIds
        app.prisma.playbackState.findMany({
          where: { profileId },
          select: {
            mediaItemId: true,
            episodeId: true,
            positionSec: true,
            durationSec: true,
            finished: true,
            updatedAt: true,
          },
        }),
        // All play events (just ids): used to compute playedByProfile
        app.prisma.playEvent.findMany({
          where: { profileId },
          select: { mediaItemId: true },
        }),
        // Last 50 play events ordered by recency: used to build history
        app.prisma.playEvent.findMany({
          where: { profileId },
          orderBy: { at: "desc" },
          take: 50,
          select: { mediaItemId: true },
        }),
      ]);

      // Build initial id→item lookup
      const itemById = new Map(rawItems.map((item) => [item.id, item]));

      // ── 2. Union-in must-include items ───────────────────────────────────────
      // history anchors (histEvents) + continue-watching items (allStates) MUST
      // appear in the catalog regardless of the 2000 cap, so smart rows never
      // drop a resume card or a "because you watched" anchor.
      const mustIncludeIds = new Set<string>([
        ...allStates.map((s) => s.mediaItemId),
        ...histEvents.map((e) => e.mediaItemId),
      ]);
      const missingIds = [...mustIncludeIds].filter((id) => !itemById.has(id));

      let extraItems: typeof rawItems = [];
      if (missingIds.length > 0) {
        extraItems = await app.prisma.mediaItem.findMany({
          where: { id: { in: missingIds }, ...(ratingFilter ?? {}) },
          select: itemSelect,
        });
        for (const item of extraItems) {
          itemById.set(item.id, item);
        }
      }

      // ── 3. Build catalog (base + must-include extras) ─────────────────────────
      const playedIds = new Set<string>([
        ...allStates.map((s) => s.mediaItemId),
        ...playedEvents.map((e) => e.mediaItemId),
      ]);

      const allItems = [...rawItems, ...extraItems];
      const catalog = allItems.map((item) => {
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

      // ── 4. Continue Watching ─────────────────────────────────────────────────
      const cwList = continueWatching(allStates);

      // Map mediaItemId → its newest in-progress state (progress + resume source).
      const cwByItem = new Map<
        string,
        { positionSec: number; durationSec: number; episodeId: string }
      >();
      for (const c of cwList) {
        if (!cwByItem.has(c.mediaItemId)) {
          cwByItem.set(c.mediaItemId, {
            positionSec: c.positionSec,
            durationSec: c.durationSec,
            episodeId: c.episodeId,
          });
        }
      }
      // Resolve S/E/title for series continue items (episodeId "" = movie → skip).
      const episodeIds = [
        ...new Set([...cwByItem.values()].map((c) => c.episodeId).filter((id) => id !== "")),
      ];
      const episodes = episodeIds.length
        ? await app.prisma.episode.findMany({
            where: { id: { in: episodeIds } },
            select: {
              id: true,
              episodeNumber: true,
              title: true,
              season: { select: { seasonNumber: true } },
            },
          })
        : [];
      const epById = new Map(episodes.map((e) => [e.id, e]));

      // ── 5. History ───────────────────────────────────────────────────────────
      // Dedup: keep first occurrence (newest) per mediaItemId.
      // itemById now covers all must-include items so no anchor is lost.
      const seen = new Set<string>();
      const history: { mediaItemId: string; title: string }[] = [];
      for (const ev of histEvents) {
        if (seen.has(ev.mediaItemId)) continue;
        seen.add(ev.mediaItemId);
        const item = itemById.get(ev.mediaItemId);
        if (item) history.push({ mediaItemId: ev.mediaItemId, title: locTitle(item) });
      }

      // ── 6. Build smart rows ──────────────────────────────────────────────────
      const smartRows = buildSmartRows({
        continueWatching: cwList,
        history,
        catalog,
        simOf: itemSimilarity,
        limit: 20,
      });

      // ── 7. Hydrate itemIds → cards ──────────────────────────────────────────
      // itemById covers both the capped catalog AND the union-in extras, so
      // no continue-watching or history id is dropped during hydration.
      const rows = smartRows
        .map((row) => {
          const items = row.itemIds
            .map((id) => {
              const item = itemById.get(id);
              if (!item) return null;
              const cw = cwByItem.get(item.id);
              const ep = cw && cw.episodeId ? epById.get(cw.episodeId) : undefined;
              return {
                id: item.id,
                title: locTitle(item),
                year: item.year,
                posterPath: item.posterPath,
                addedAt: item.addedAt.toISOString(),
                progress: cw
                  ? { positionSec: cw.positionSec, durationSec: cw.durationSec }
                  : null,
                resume: ep
                  ? {
                      seasonNumber: ep.season.seasonNumber,
                      episodeNumber: ep.episodeNumber,
                      episodeTitle: ep.title,
                    }
                  : null,
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

      // Load active profile for kids-safety filtering.
      const profile = await activeProfile(app, req);
      const ratingFilter = kidsRatingWhere(profile);

      // Build the Prisma WHERE clause from parsed constraints
      const where: Prisma.MediaItemWhereInput = {
        matchState: "matched",
        ...(ratingFilter ?? {}),
      };

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

      // Rating-cap filter: apply the parsed ratingMax (e.g. "PG") as a cert
      // allowlist. Excludes unrated titles, matching kids-filter semantics.
      // Intersect with any existing kids-profile rating filter so the stricter
      // cap wins (e.g. a kids cap of PG-13 + a "for kids" query → {G,PG}).
      if (c.ratingMax) {
        const allowed = certsAtOrBelow(ratingTier(c.ratingMax));
        const existing =
          where.rating && typeof where.rating === "object" && "in" in where.rating
            ? (where.rating.in as string[])
            : null;
        where.rating = {
          in: existing ? allowed.filter((r) => existing.includes(r)) : allowed,
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
          // Guard: if the model emits non-finite floats the ::vector cast would 500.
          // Treat a non-finite vector as unusable and degrade to keyword ranking.
          if (!qv.every(Number.isFinite)) {
            // Non-finite element: degrade to keyword rather than letting the
            // ::vector cast throw a 500.
            items = rankByKeyword(candidates, c.residualText);
          } else {
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

      // Localize the (≤20) result titles to the active profile language.
      // Ranking above runs on the base (en) text — a deliberate scope bound.
      const lang = profile?.language ?? "en";
      if (lang !== "en" && items.length > 0) {
        const trs = await app.prisma.mediaItemTranslation.findMany({
          where: { language: lang, mediaItemId: { in: items.map((i) => i.id) } },
          select: { mediaItemId: true, title: true },
        });
        const trMap = new Map(trs.map((t) => [t.mediaItemId, t.title]));
        items = items.map((i) => {
          const tr = trMap.get(i.id);
          return tr && tr.trim() ? { ...i, title: tr } : i;
        });
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
