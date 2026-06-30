import type { FastifyInstance } from "fastify";
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

      // MVP cap at 500 items
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
        },
        orderBy,
        take: 500,
      });

      return items;
    },
  );

  // GET /items/:id
  app.get<{ Params: { id: string } }>(
    "/items/:id",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const [item, profile] = await Promise.all([
        app.prisma.mediaItem.findUnique({
          where: { id: req.params.id },
          select: {
            id: true,
            kind: true,
            title: true,
            year: true,
            overview: true,
            runtimeSec: true,
            rating: true,
            posterPath: true,
            backdropPath: true,
            matchState: true,
            genres: {
              select: { genre: { select: { name: true } } },
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
        activeProfile(app, req),
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

      return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        year: item.year,
        overview: item.overview,
        runtimeSec: item.runtimeSec,
        rating: item.rating,
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        matchState: item.matchState,
        genres: item.genres.map((g) => g.genre.name),
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
