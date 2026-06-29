import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@orbix/core";

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
  const requireAdmin = async (req: any, reply: any) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
  };

  app.get("/settings", { preHandler: requireAdmin }, async () => {
    const token = await getSetting<string>("tmdbToken", { fallback: "", read: read(app) });
    return { tmdbConfigured: token.length > 0 }; // never return the secret
  });

  app.put<{ Body: { tmdbToken?: string } }>(
    "/settings",
    { preHandler: requireAdmin },
    async (req) => {
      if (typeof req.body?.tmdbToken === "string") {
        await setSetting("tmdbToken", req.body.tmdbToken, { write: write(app) });
      }
      return { ok: true };
    },
  );
}
