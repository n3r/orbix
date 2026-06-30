import type { FastifyInstance } from "fastify";
import { localizeItem, localizeGenres } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile, kidsRatingWhere, profileAllowsItem } from "../lib/catalog-filter";

export default async function catalogRoute(app: FastifyInstance) {
  // GET /sections/:id/items?sort=&q=
  app.get<{
    Params: { id: string };
    Querystring: { sort?: string; q?: string };
  }>(
    "/sections/:id/items",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const { id } = req.params;
      const sort = req.query.sort ?? "title";
      const q = req.query.q?.trim();

      const allowedSorts = ["title", "added", "year"];
      if (!allowedSorts.includes(sort)) {
        return reply.code(400).send({ error: "invalid_sort" });
      }

      const orderBy =
        sort === "added"
          ? [{ addedAt: "desc" as const }]
          : sort === "year"
          ? [{ year: "desc" as const }]
          : [{ sortTitle: "asc" as const }];

      const profile = await activeProfile(app, req);
      const ratingFilter = kidsRatingWhere(profile);
      const lang = profile?.language ?? "en";

      // MVP cap at 500 items
      // NOTE: the `q` filter matches the base (en) title only; localized-title
      // search is a deliberate Phase-2 follow-up, not required here.
      const items = await app.prisma.mediaItem.findMany({
        where: {
          sectionId: id,
          ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
          ...(ratingFilter ?? {}),
        },
        select: {
          id: true,
          title: true,
          year: true,
          posterPath: true,
          matchState: true,
          translations: { where: { language: lang }, select: { title: true } },
        },
        orderBy,
        take: 500,
      });

      // Coalesce title → requested-language translation, else base.
      return items.map(({ translations, ...rest }) => ({
        ...rest,
        title: localizeItem({ title: rest.title }, translations[0]).title,
      }));
    },
  );

  // GET /items/:id
  app.get<{ Params: { id: string } }>(
    "/items/:id",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const profilePromise = activeProfile(app, req);
      const lang = (await profilePromise)?.language ?? "en";

      const [item, profile] = await Promise.all([
        app.prisma.mediaItem.findUnique({
          where: { id: req.params.id },
          select: {
            id: true,
            kind: true,
            title: true,
            year: true,
            overview: true,
            tagline: true,
            status: true,
            runtimeSec: true,
            rating: true,
            posterPath: true,
            backdropPath: true,
            logoPath: true,
            tmdbScore: true,
            imdbRating: true,
            imdbVotes: true,
            rtRating: true,
            metacritic: true,
            matchState: true,
            translations: { where: { language: lang }, select: { title: true, overview: true } },
            genres: {
              select: {
                genre: {
                  select: {
                    tmdbId: true,
                    name: true,
                    translations: { where: { language: lang }, select: { name: true } },
                  },
                },
              },
            },
            seasons: {
              select: {
                seasonNumber: true,
                name: true,
                posterPath: true,
                _count: { select: { episodes: true } },
              },
              orderBy: { seasonNumber: "asc" },
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
            files: {
              select: {
                id: true,
                path: true,
                container: true,
                videoCodec: true,
                audioCodecs: true,
                width: true,
                height: true,
                durationSec: true,
                size: true,
              },
            },
          },
        }),
        profilePromise,
      ]);

      if (!item) return reply.code(404).send({ error: "not_found" });

      // Kids profile: return 404 for blocked titles (avoids leaking existence)
      if (!profileAllowsItem(profile, { rating: item.rating })) {
        return reply.code(404).send({ error: "not_found" });
      }

      const cast = item.credits
        .filter((c) => c.department === "cast")
        .slice(0, 15)
        .map((c) => ({ name: c.person.name, character: c.role }));

      const directorCredit = item.credits.find(
        (c) => c.department === "crew" && c.role === "Director",
      );
      const director = directorCredit ? { name: directorCredit.person.name } : null;

      // Coalesce localized title/overview/genres → requested language, else base.
      const localized = localizeItem(
        { title: item.title, overview: item.overview },
        item.translations[0],
      );
      const genreTrMap = new Map<number, string>();
      for (const g of item.genres) {
        const trName = g.genre.translations[0]?.name;
        if (g.genre.tmdbId != null && trName) genreTrMap.set(g.genre.tmdbId, trName);
      }
      const genres = localizeGenres(
        item.genres.map((g) => ({ tmdbId: g.genre.tmdbId, name: g.genre.name })),
        genreTrMap,
      ).map((x) => x.name);

      return {
        id: item.id,
        kind: item.kind,
        title: localized.title,
        year: item.year,
        overview: localized.overview,
        tagline: item.tagline,
        status: item.status,
        runtimeSec: item.runtimeSec,
        rating: item.rating,
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        logoPath: item.logoPath,
        tmdbScore: item.tmdbScore,
        imdbRating: item.imdbRating,
        imdbVotes: item.imdbVotes,
        rtRating: item.rtRating,
        metacritic: item.metacritic,
        matchState: item.matchState,
        genres,
        ...(item.kind === "series"
          ? {
              seasons: item.seasons.map((s) => ({
                seasonNumber: s.seasonNumber,
                name: s.name,
                episodeCount: s._count.episodes,
                posterPath: s.posterPath,
              })),
            }
          : {}),
        cast,
        director,
        // CRITICAL: BigInt size must be serialized as string to avoid JSON.stringify error
        files: item.files.map((f) => ({
          id: f.id,
          path: f.path,
          container: f.container,
          videoCodec: f.videoCodec,
          audioCodecs: f.audioCodecs,
          width: f.width,
          height: f.height,
          durationSec: f.durationSec,
          size: f.size == null ? null : f.size.toString(),
        })),
      };
    },
  );
}
