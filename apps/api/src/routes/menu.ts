import type { FastifyInstance } from "fastify";
import { resolveProfileMenu, type MenuLibrary, type MenuEntry } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile } from "../lib/catalog-filter";

async function loadLibraries(app: FastifyInstance): Promise<MenuLibrary[]> {
  const libraries = await app.prisma.library.findMany({
    select: { id: true, name: true, order: true },
  });
  return libraries.map((l) => ({ libraryId: l.id, name: l.name, order: l.order }));
}

async function loadEntries(app: FastifyInstance, profileId: string): Promise<MenuEntry[]> {
  return app.prisma.profileMenuEntry.findMany({
    where: { profileId },
    select: { libraryId: true, position: true },
  });
}

export default async function menu(app: FastifyInstance) {
  // GET /me/menu — resolved categories for the active profile's nav.
  app.get("/me/menu", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.send({ items: [] });
    const [libraries, entries] = await Promise.all([loadLibraries(app), loadEntries(app, profile.id)]);
    return reply.send({ items: resolveProfileMenu(libraries, entries) });
  });

  // GET /me/menu/config — every library + the currently-enabled ordered ids, for the editor.
  app.get("/me/menu/config", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    const libraries = await loadLibraries(app);
    const entries = profile ? await loadEntries(app, profile.id) : [];
    const all = resolveProfileMenu(libraries, []);
    const enabled = resolveProfileMenu(libraries, entries).map((l) => l.libraryId);
    return reply.send({ libraries: all, enabled });
  });

  // PUT /me/menu — replace the active profile's ordered enabled libraries.
  app.put<{ Body: { libraryIds?: unknown } }>("/me/menu", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.code(400).send({ error: "no_active_profile" });

    const ids = req.body?.libraryIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      return reply.code(400).send({ error: "invalid" });
    }
    const libraryIds = ids as string[];
    // An empty menu is not representable (zero entries means "show all"), so an
    // empty save would silently re-enable every library — reject it instead.
    if (libraryIds.length === 0) {
      return reply.code(400).send({ error: "empty" });
    }
    // Duplicate ids would violate the @@unique([profileId, libraryId]) on insert.
    if (new Set(libraryIds).size !== libraryIds.length) {
      return reply.code(400).send({ error: "duplicate" });
    }
    const existing = await app.prisma.library.findMany({ select: { id: true } });
    const valid = new Set(existing.map((l) => l.id));
    if (!libraryIds.every((id) => valid.has(id))) {
      return reply.code(400).send({ error: "unknown_library" });
    }

    await app.prisma.$transaction([
      app.prisma.profileMenuEntry.deleteMany({ where: { profileId: profile.id } }),
      app.prisma.profileMenuEntry.createMany({
        data: libraryIds.map((libraryId, position) => ({ profileId: profile.id, libraryId, position })),
      }),
    ]);

    const [libraries, entries] = await Promise.all([loadLibraries(app), loadEntries(app, profile.id)]);
    return reply.send({ items: resolveProfileMenu(libraries, entries) });
  });
}
