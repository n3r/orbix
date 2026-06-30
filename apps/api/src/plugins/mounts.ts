import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import { buildMountRuntime, type MountRuntime } from "../lib/mount-runtime";

const SMB_SOURCE_SELECT = {
  id: true,
  kind: true,
  path: true,
  smbHost: true,
  smbShare: true,
  smbSubpath: true,
  smbUsername: true,
  smbPassword: true,
  smbDomain: true,
};

// On boot, mount all enabled SMB sources so scans / streaming can read them.
// Failures are logged, never fatal (e.g. dev hosts without cifs-utils, or the
// DB being unavailable in unit tests).
export function mountsPlugin(env: Env, deps?: { runtime?: MountRuntime }) {
  return fp(async (app: FastifyInstance) => {
    if (env.NODE_ENV === "test") return; // unit tests never mount or touch the DB on boot
    const runtime = deps?.runtime ?? buildMountRuntime(env);
    app.addHook("onReady", async () => {
      try {
        const sources = await app.prisma.source.findMany({
          where: { kind: "smb", enabled: true },
          select: SMB_SOURCE_SELECT,
        });
        for (const src of sources) {
          try {
            await runtime.resolve(src);
            await app.prisma.source.update({ where: { id: src.id }, data: { status: "ok", statusMessage: null } });
          } catch (err) {
            const message = err instanceof Error ? err.message : "mount failed";
            app.log.warn({ sourceId: src.id, err }, "SMB mount failed on boot");
            await app.prisma.source.update({ where: { id: src.id }, data: { status: "error", statusMessage: message } });
          }
        }
      } catch (err) {
        app.log.warn({ err }, "boot SMB mount sweep skipped");
      }
    });
  });
}
