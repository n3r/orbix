import type { FastifyInstance } from "fastify";
import { localizeItem } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile, activeProfileId, kidsRatingWhere, profileAllowsItem } from "../lib/catalog-filter";

export default async function wishlistRoute(app: FastifyInstance) {
  // GET /wishlist — the active profile's saved titles as poster cards,
  // newest-first. Kids-filtered server-side like every other list route.
  app.get("/wishlist", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profileId = await activeProfileId(app, req);
    if (!profileId) return reply.code(400).send({ error: "no_profile" });

    const entries = await app.prisma.wishlistEntry.findMany({
      where: { profileId },
      orderBy: { addedAt: "desc" },
      select: { mediaItemId: true },
    });
    if (entries.length === 0) return [];

    const profile = await activeProfile(app, req);
    const ratingFilter = kidsRatingWhere(profile);
    const lang = profile?.language ?? "en";

    const items = await app.prisma.mediaItem.findMany({
      where: { id: { in: entries.map((e) => e.mediaItemId) }, ...(ratingFilter ?? {}) },
      select: {
        id: true,
        title: true,
        year: true,
        posterPath: true,
        matchState: true,
        translations: { where: { language: lang }, select: { title: true } },
      },
    });
    const itemMap = new Map(items.map((i) => [i.id, i]));

    // Preserve wishlist order; deleted or rating-blocked items just drop out.
    return entries
      .map((e) => itemMap.get(e.mediaItemId))
      .filter((i) => i !== undefined)
      .map(({ translations, ...rest }) => ({
        ...rest,
        title: localizeItem({ title: rest.title }, translations[0]).title,
      }));
  });

  // GET /wishlist/ids — membership ids for UI state (title-page toggle).
  // Fail-safe: never leak ids of titles the profile can't see.
  app.get("/wishlist/ids", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profileId = await activeProfileId(app, req);
    if (!profileId) return reply.code(400).send({ error: "no_profile" });

    const entries = await app.prisma.wishlistEntry.findMany({
      where: { profileId },
      orderBy: { addedAt: "desc" },
      select: { mediaItemId: true },
    });
    if (entries.length === 0) return { ids: [] };

    const profile = await activeProfile(app, req);
    const ratingFilter = kidsRatingWhere(profile);
    const visible = await app.prisma.mediaItem.findMany({
      where: { id: { in: entries.map((e) => e.mediaItemId) }, ...(ratingFilter ?? {}) },
      select: { id: true },
    });
    const visibleIds = new Set(visible.map((i) => i.id));
    return { ids: entries.map((e) => e.mediaItemId).filter((id) => visibleIds.has(id)) };
  });

  // POST /wishlist/:itemId — idempotent add. 404 for unknown AND kids-blocked
  // titles (same non-leak rule as GET /items/:id).
  app.post<{ Params: { itemId: string } }>(
    "/wishlist/:itemId",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const profileId = await activeProfileId(app, req);
      if (!profileId) return reply.code(400).send({ error: "no_profile" });

      const [profile, item] = await Promise.all([
        activeProfile(app, req),
        app.prisma.mediaItem.findUnique({
          where: { id: req.params.itemId },
          select: { rating: true },
        }),
      ]);
      if (!item || !profileAllowsItem(profile, { rating: item.rating })) {
        return reply.code(404).send({ error: "not_found" });
      }

      await app.prisma.wishlistEntry.upsert({
        where: { profileId_mediaItemId: { profileId, mediaItemId: req.params.itemId } },
        create: { profileId, mediaItemId: req.params.itemId },
        update: {},
      });
      return { ok: true };
    },
  );

  // DELETE /wishlist/:itemId — idempotent remove (no existence check needed).
  app.delete<{ Params: { itemId: string } }>(
    "/wishlist/:itemId",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const profileId = await activeProfileId(app, req);
      if (!profileId) return reply.code(400).send({ error: "no_profile" });

      await app.prisma.wishlistEntry.deleteMany({
        where: { profileId, mediaItemId: req.params.itemId },
      });
      return { ok: true };
    },
  );
}
