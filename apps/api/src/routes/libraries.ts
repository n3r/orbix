import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { validateLibraryInput, validateSectionInput, validateSourceInput, validateSectionPatch, LibraryValidationError } from "@orbix/core";
import { Prisma } from "@orbix/db";
import { requireAuth } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";

export default async function libraries(app: FastifyInstance) {
  // GET /libraries — returns libraries with their sections
  app.get("/libraries", { preHandler: requireAuth(app) }, async () =>
    app.prisma.library.findMany({
      include: {
        sections: {
          orderBy: { order: "asc" },
          include: { sources: true },
        },
      },
    }),
  );

  // POST /libraries
  app.post<{ Body: unknown }>("/libraries", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      const v = validateLibraryInput(req.body);
      const lib = await app.prisma.library.create({
        data: { name: v.name },
        select: { id: true, name: true },
      });
      return lib;
    } catch (e) {
      if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
      throw e;
    }
  });

  // DELETE /libraries/:id
  app.delete<{ Params: { id: string } }>("/libraries/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      await app.prisma.library.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        return reply.code(404).send({ error: "not_found" });
      }
      throw e;
    }
  });

  // POST /sections
  app.post<{ Body: unknown }>("/sections", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      const v = validateSectionInput(req.body);
      const section = await app.prisma.section.create({
        data: { libraryId: v.libraryId, name: v.name, order: v.order ?? 0 },
        select: { id: true, name: true, libraryId: true },
      });
      return section;
    } catch (e) {
      if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
      throw e;
    }
  });

  // PATCH /sections/:id
  app.patch<{ Params: { id: string }; Body: unknown }>("/sections/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      const patch = validateSectionPatch(req.body);
      const data: { name?: string; order?: number } = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.order !== undefined) data.order = patch.order;
      const section = await app.prisma.section.update({
        where: { id: req.params.id },
        data,
        select: { id: true, name: true, order: true },
      });
      return section;
    } catch (e) {
      if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        return reply.code(404).send({ error: "not_found" });
      }
      throw e;
    }
  });

  // DELETE /sections/:id
  app.delete<{ Params: { id: string } }>("/sections/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      await app.prisma.section.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        return reply.code(404).send({ error: "not_found" });
      }
      throw e;
    }
  });

  // POST /sources
  app.post<{ Body: unknown }>("/sources", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      const v = validateSourceInput(req.body);
      // Check that the path exists and is readable
      try {
        await fs.promises.access(v.path, fs.constants.R_OK);
      } catch {
        return reply.code(400).send({ error: "path_unreadable" });
      }
      const source = await app.prisma.source.create({
        data: { sectionId: v.sectionId, path: v.path },
        select: { id: true, path: true, sectionId: true },
      });
      return source;
    } catch (e) {
      if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
      throw e;
    }
  });

  // DELETE /sources/:id
  app.delete<{ Params: { id: string } }>("/sources/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      await app.prisma.source.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        return reply.code(404).send({ error: "not_found" });
      }
      throw e;
    }
  });
}
