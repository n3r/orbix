import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import {
  validateLibraryInput,
  validateLibraryPatch,
  validateSourceInput,
  LibraryValidationError,
} from "@orbix/core";
import { Prisma } from "@orbix/db";
import type { Env } from "@orbix/config";
import { requireAuth } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { encryptSecret } from "../lib/secrets";
import { buildMountRuntime, type MountRuntime } from "../lib/mount-runtime";

// Public source projection — NEVER selects smbPassword.
const SOURCE_PUBLIC = {
  id: true,
  libraryId: true,
  kind: true,
  path: true,
  smbHost: true,
  smbShare: true,
  smbSubpath: true,
  smbUsername: true,
  smbDomain: true,
  enabled: true,
  status: true,
  statusMessage: true,
  lastScanAt: true,
};

export function librariesRoute(env: Env, deps?: { runtime?: MountRuntime }) {
  const runtime = deps?.runtime ?? buildMountRuntime(env);

  return async function libraries(app: FastifyInstance) {
    // GET /libraries — libraries + sanitized sources
    app.get("/libraries", { preHandler: requireAuth(app) }, async () =>
      app.prisma.library.findMany({
        orderBy: { order: "asc" },
        include: { sources: { select: SOURCE_PUBLIC } },
      }),
    );

    // POST /libraries
    app.post<{ Body: unknown }>("/libraries", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      try {
        const v = validateLibraryInput(req.body);
        return await app.prisma.library.create({ data: { name: v.name }, select: { id: true, name: true } });
      } catch (e) {
        if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
        throw e;
      }
    });

    // PATCH /libraries/:id
    app.patch<{ Params: { id: string }; Body: unknown }>("/libraries/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      try {
        const patch = validateLibraryPatch(req.body);
        const data: { name?: string; order?: number } = {};
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.order !== undefined) data.order = patch.order;
        return await app.prisma.library.update({ where: { id: req.params.id }, data, select: { id: true, name: true, order: true } });
      } catch (e) {
        if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    });

    // DELETE /libraries/:id
    app.delete<{ Params: { id: string } }>("/libraries/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      // Unmount any SMB sources first (best-effort).
      const smb = await app.prisma.source.findMany({ where: { libraryId: req.params.id, kind: "smb" }, select: { id: true } });
      await Promise.all(smb.map((s) => runtime.unmount(s.id).catch(() => {})));
      try {
        await app.prisma.library.delete({ where: { id: req.params.id } });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    });

    // POST /libraries/:id/sources
    app.post<{ Params: { id: string }; Body: unknown }>("/libraries/:id/sources", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      const libraryId = req.params.id;
      let v;
      try {
        v = validateSourceInput(req.body);
      } catch (e) {
        if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
        throw e;
      }

      if (v.kind === "local") {
        try {
          await fs.promises.access(v.path, fs.constants.R_OK);
        } catch {
          return reply.code(400).send({ error: "path_unreadable" });
        }
        return await app.prisma.source.create({
          data: { libraryId, kind: "local", path: v.path },
          select: SOURCE_PUBLIC,
        });
      }

      // smb — store encrypted password, then attempt a test mount (non-fatal).
      const created = await app.prisma.source.create({
        data: {
          libraryId,
          kind: "smb",
          smbHost: v.host,
          smbShare: v.share,
          smbSubpath: v.subpath ?? null,
          smbUsername: v.username ?? null,
          smbPassword: v.password ? encryptSecret(v.password, env.SESSION_SECRET) : null,
          smbDomain: v.domain ?? null,
        },
        select: { ...SOURCE_PUBLIC, smbPassword: true },
      });
      try {
        await runtime.resolve(created);
        await app.prisma.source.update({ where: { id: created.id }, data: { status: "ok", statusMessage: null } });
      } catch (err) {
        await app.prisma.source.update({
          where: { id: created.id },
          data: { status: "error", statusMessage: err instanceof Error ? err.message : "mount failed" },
        });
      }
      return app.prisma.source.findUnique({ where: { id: created.id }, select: SOURCE_PUBLIC });
    });

    // PATCH /sources/:id — { enabled?: boolean }
    app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>("/sources/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") return reply.code(400).send({ error: "invalid" });
      try {
        const source = await app.prisma.source.update({ where: { id: req.params.id }, data: { enabled }, select: SOURCE_PUBLIC });
        if (!enabled && source.kind === "smb") await runtime.unmount(source.id).catch(() => {});
        return source;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    });

    // DELETE /sources/:id
    app.delete<{ Params: { id: string } }>("/sources/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      const existing = await app.prisma.source.findUnique({ where: { id: req.params.id }, select: { id: true, kind: true } });
      if (existing?.kind === "smb") await runtime.unmount(existing.id).catch(() => {});
      try {
        await app.prisma.source.delete({ where: { id: req.params.id } });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    });
  };
}
