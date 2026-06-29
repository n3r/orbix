import type { FastifyInstance } from "fastify";
import { isFinished, continueWatching } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile, profileAllowsItem, kidsRatingWhere } from "../lib/catalog-filter";

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

      // Floor to integers for Prisma Int fields (player may send fractional seconds)
      const positionSecInt = Math.max(0, Math.floor(positionSec));
      const durationSecInt = Math.max(0, Math.floor(durationSec));

      const mediaItemId = req.params.id;

      // Kids-safety gate: a kids profile must not be able to enroll a blocked
      // item into playback history (which would then surface in continue-watching).
      const [profile, mediaItem] = await Promise.all([
        activeProfile(app, req),
        app.prisma.mediaItem.findUnique({
          where: { id: mediaItemId },
          select: { rating: true },
        }),
      ]);
      if (mediaItem && !profileAllowsItem(profile, { rating: mediaItem.rating })) {
        return reply.code(403).send({ error: "blocked_by_rating" });
      }

      const finished = isFinished(positionSecInt, durationSecInt);

      await app.prisma.playbackState.upsert({
        where: { profileId_mediaItemId: { profileId, mediaItemId } },
        create: { profileId, mediaItemId, positionSec: positionSecInt, durationSec: durationSecInt, finished },
        update: { positionSec: positionSecInt, durationSec: durationSecInt, finished },
      });

      // Best-effort: append a PlayEvent once per viewing session (dedup within 6h)
      try {
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const recent = await app.prisma.playEvent.findFirst({
          where: { profileId, mediaItemId, at: { gt: sixHoursAgo } },
        });
        if (!recent) {
          await app.prisma.playEvent.create({ data: { profileId, mediaItemId } });
        }
      } catch (_err) {
        // never fail the request on history errors
      }

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
      if (inProgress.length === 0) return [];

      const inProgressIds = inProgress.map((s) => s.mediaItemId);

      // Load the active profile so we can filter out blocked titles for kids.
      // kidsRatingWhere returns null for non-kids profiles (no extra filter).
      // The { rating: { in: [...] } } clause excludes null-rated items automatically
      // (Prisma's `in` never matches NULL), which is the safe default for kids.
      const profile = await activeProfile(app, req);
      const ratingFilter = kidsRatingWhere(profile);

      const items = await app.prisma.mediaItem.findMany({
        where: { id: { in: inProgressIds }, ...(ratingFilter ?? {}) },
        select: { id: true, title: true, posterPath: true },
      });

      const itemMap = new Map(items.map((i) => [i.id, i]));

      return inProgress
        .map(({ mediaItemId, positionSec, durationSec }) => {
          const item = itemMap.get(mediaItemId);
          if (!item) return null; // deleted item or blocked by rating gate
          return { mediaItemId, title: item.title, posterPath: item.posterPath, positionSec, durationSec };
        })
        .filter((x) => x !== null);
    },
  );
}
