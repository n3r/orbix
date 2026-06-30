import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/auth";
import { activeProfile, profileAllowsItem } from "../lib/catalog-filter";

export default async function seriesRoute(app: FastifyInstance) {
  // GET /items/:id/seasons/:n/episodes — episode list for one season of a series.
  // Each episode carries its owned fileId (null when not in the library) and the
  // active profile's progress, so the UI can show "Resume" + a progress bar.
  app.get<{ Params: { id: string; n: string } }>(
    "/items/:id/seasons/:n/episodes",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const seriesId = req.params.id;
      const seasonNumber = Number.parseInt(req.params.n, 10);
      if (!Number.isInteger(seasonNumber)) {
        return reply.code(400).send({ error: "invalid_season" });
      }
      const profileId = req.cookies["orbix_profile"];

      const [series, profile] = await Promise.all([
        app.prisma.mediaItem.findUnique({
          where: { id: seriesId },
          select: { id: true, kind: true, rating: true },
        }),
        activeProfile(app, req),
      ]);
      if (!series) return reply.code(404).send({ error: "not_found" });
      // Kids gate: episodes inherit the series rating.
      if (!profileAllowsItem(profile, { rating: series.rating })) {
        return reply.code(404).send({ error: "not_found" });
      }

      const season = await app.prisma.season.findUnique({
        where: { seriesId_seasonNumber: { seriesId, seasonNumber } },
        select: { id: true },
      });
      if (!season) return reply.send({ episodes: [] });

      const episodes = await app.prisma.episode.findMany({
        where: { seasonId: season.id },
        orderBy: { episodeNumber: "asc" },
        select: {
          id: true,
          episodeNumber: true,
          title: true,
          overview: true,
          stillPath: true,
          runtimeSec: true,
          airDate: true,
          files: { select: { id: true }, take: 1 },
        },
      });

      // Progress per episode for the active profile (keyed by series + episode).
      const progressByEpisode = new Map<
        string,
        { positionSec: number; durationSec: number; finished: boolean }
      >();
      if (profileId && episodes.length > 0) {
        const states = await app.prisma.playbackState.findMany({
          where: {
            profileId,
            mediaItemId: seriesId,
            episodeId: { in: episodes.map((e) => e.id) },
          },
          select: { episodeId: true, positionSec: true, durationSec: true, finished: true },
        });
        for (const s of states) {
          progressByEpisode.set(s.episodeId, {
            positionSec: s.positionSec,
            durationSec: s.durationSec,
            finished: s.finished,
          });
        }
      }

      return reply.send({
        episodes: episodes.map((e) => ({
          id: e.id,
          episodeNumber: e.episodeNumber,
          title: e.title,
          overview: e.overview,
          stillPath: e.stillPath,
          runtimeSec: e.runtimeSec,
          airDate: e.airDate ? e.airDate.toISOString() : null,
          fileId: e.files[0]?.id ?? null,
          progress: progressByEpisode.get(e.id) ?? null,
        })),
      });
    },
  );
}
