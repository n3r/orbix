import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@orbix/core";
import { requireAuth } from "../lib/auth";

const read = (app: FastifyInstance) => (k: string) =>
  app.prisma.setting.findUnique({ where: { key: k } });

const write = (app: FastifyInstance) => async (k: string, v: unknown) => {
  await app.prisma.setting.upsert({
    where: { key: k },
    create: { key: k, value: v as object },
    update: { value: v as object },
  });
};

export default async function settings(app: FastifyInstance) {
  app.get("/settings", { preHandler: requireAuth(app) }, async () => {
    const token = await getSetting<string>("tmdbToken", { fallback: "", read: read(app) });
    return { tmdbConfigured: token.length > 0 }; // never return the secret
  });

  app.put<{ Body: { tmdbToken?: string } }>(
    "/settings",
    { preHandler: requireAuth(app) },
    async (req) => {
      if (typeof req.body?.tmdbToken === "string") {
        await setSetting("tmdbToken", req.body.tmdbToken, { write: write(app) });
      }
      return { ok: true };
    },
  );
}
