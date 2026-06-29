import type { FastifyInstance } from "fastify";
import { isFinished, continueWatching } from "@orbix/core";
import { requireAuth } from "../lib/auth";

export default async function playstateRoute(app: FastifyInstance) {
  // PUT /items/:id/progress — upsert playback position for the active profile
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/items/:id/progress",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const profileId = req.cookies["orbix_profile"];
      if (!profileId) return reply.code(400).send({ error: "no_profile" });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const positionSec = body.positionSec;
      const durationSec = body.durationSec;

      if (
        typeof positionSec !== "number" ||
        typeof durationSec !== "number" ||
        positionSec < 0 ||
        durationSec < 0
      ) {
        return reply.code(400).send({ error: "invalid_body" });
      }

      const mediaItemId = req.params.id;
      const finished = isFinished(positionSec, durationSec);

      await app.prisma.playbackState.upsert({
        where: { profileId_mediaItemId: { profileId, mediaItemId } },
        create: { profileId, mediaItemId, positionSec, durationSec, finished },
        update: { positionSec, durationSec, finished },
      });

      return { ok: true, finished };
    },
  );

  // GET /items/:id/progress — read current position for the active profile
  app.get<{ Params: { id: string } }>(
    "/items/:id/progress",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const profileId = req.cookies["orbix_profile"];
      if (!profileId) return reply.code(400).send({ error: "no_profile" });

      const mediaItemId = req.params.id;
      const state = await app.prisma.playbackState.findUnique({
        where: { profileId_mediaItemId: { profileId, mediaItemId } },
        select: { positionSec: true, durationSec: true, finished: true },
      });

      if (!state) return { positionSec: 0, durationSec: 0, finished: false };
      return state;
    },
  );

  // GET /continue-watching — in-progress items for the active profile, newest first
  app.get(
    "/continue-watching",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const profileId = req.cookies["orbix_profile"];
      if (!profileId) return reply.code(400).send({ error: "no_profile" });

      const states = await app.prisma.playbackState.findMany({
        where: { profileId },
        select: {
          mediaItemId: true,
          positionSec: true,
          durationSec: true,
          finished: true,
          updatedAt: true,
        },
      });

      const inProgress = continueWatching(states);

      const enriched = await Promise.all(
        inProgress.map(async ({ mediaItemId, positionSec, durationSec }) => {
          const item = await app.prisma.mediaItem.findUnique({
            where: { id: mediaItemId },
            select: { title: true, posterPath: true },
          });
          if (!item) return null;
          return { mediaItemId, title: item.title, posterPath: item.posterPath, positionSec, durationSec };
        }),
      );

      return enriched.filter((x) => x !== null);
    },
  );
}
