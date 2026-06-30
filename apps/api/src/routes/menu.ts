import type { FastifyInstance } from "fastify";
import { resolveProfileMenu, type MenuSection, type MenuEntry } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile } from "../lib/catalog-filter";

async function loadSections(app: FastifyInstance): Promise<MenuSection[]> {
  const libraries = await app.prisma.library.findMany({
    select: { name: true, sections: { select: { id: true, name: true, order: true } } },
  });
  return libraries.flatMap((lib) =>
    lib.sections.map((s) => ({ sectionId: s.id, name: s.name, libraryName: lib.name, order: s.order })),
  );
}

async function loadEntries(app: FastifyInstance, profileId: string): Promise<MenuEntry[]> {
  return app.prisma.profileMenuEntry.findMany({
    where: { profileId },
    select: { sectionId: true, position: true },
  });
}

export default async function menu(app: FastifyInstance) {
  // GET /me/menu — resolved categories for the active profile's nav.
  app.get("/me/menu", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.send({ items: [] });
    const [sections, entries] = await Promise.all([loadSections(app), loadEntries(app, profile.id)]);
    return reply.send({ items: resolveProfileMenu(sections, entries) });
  });

  // GET /me/menu/config — every section + the currently-enabled ordered ids, for the editor.
  app.get("/me/menu/config", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    const sections = await loadSections(app);
    const entries = profile ? await loadEntries(app, profile.id) : [];
    const all = resolveProfileMenu(sections, []);
    const enabled = resolveProfileMenu(sections, entries).map((s) => s.sectionId);
    return reply.send({ sections: all, enabled });
  });

  // PUT /me/menu — replace the active profile's ordered enabled sections.
  app.put<{ Body: { sectionIds?: unknown } }>("/me/menu", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.code(400).send({ error: "no_active_profile" });

    const ids = req.body?.sectionIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      return reply.code(400).send({ error: "invalid" });
    }
    const sectionIds = ids as string[];
    const existing = await app.prisma.section.findMany({ select: { id: true } });
    const valid = new Set(existing.map((s) => s.id));
    if (!sectionIds.every((id) => valid.has(id))) {
      return reply.code(400).send({ error: "unknown_section" });
    }

    await app.prisma.$transaction([
      app.prisma.profileMenuEntry.deleteMany({ where: { profileId: profile.id } }),
      app.prisma.profileMenuEntry.createMany({
        data: sectionIds.map((sectionId, position) => ({ profileId: profile.id, sectionId, position })),
      }),
    ]);

    const [sections, entries] = await Promise.all([loadSections(app), loadEntries(app, profile.id)]);
    return reply.send({ items: resolveProfileMenu(sections, entries) });
  });
}
