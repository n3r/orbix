import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@orbix/core";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";

const VALID_ENCODERS = ["software", "vaapi", "qsv", "nvenc"] as const;
type EncoderValue = (typeof VALID_ENCODERS)[number];

const read = (app: FastifyInstance) => (k: string) =>
  app.prisma.setting.findUnique({ where: { key: k } });

const write = (app: FastifyInstance) => async (k: string, v: unknown) => {
  await app.prisma.setting.upsert({
    where: { key: k },
    create: { key: k, value: v as object },
    update: { value: v as object },
  });
};

interface SettingsBody {
  tmdbToken?: string;
  encoder?: string;
  omdbKey?: string;
  fanartKey?: string;
  tvdbApiKey?: string;
  tvdbPin?: string;
  refreshCadenceDays?: number;
}

export default async function settings(app: FastifyInstance) {
  app.get("/settings", { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] }, async () => {
    const r = read(app);
    const [token, encoder, omdbKey, fanartKey, tvdbApiKey, refreshCadenceDays] = await Promise.all([
      getSetting<string>("tmdbToken", { fallback: "", read: r }),
      getSetting<string>("encoder", { fallback: "software", read: r }),
      getSetting<string>("omdbKey", { fallback: "", read: r }),
      getSetting<string>("fanartKey", { fallback: "", read: r }),
      getSetting<string>("tvdbApiKey", { fallback: "", read: r }),
      getSetting<number>("refreshCadenceDays", { fallback: 90, read: r }),
    ]);
    return {
      tmdbConfigured: token.length > 0,
      encoder,
      omdbConfigured: omdbKey.length > 0,
      fanartConfigured: fanartKey.length > 0,
      tvdbConfigured: tvdbApiKey.length > 0,
      refreshCadenceDays,
    }; // never return secrets
  });

  app.put<{ Body: SettingsBody }>(
    "/settings",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async (req, reply) => {
      const body = req.body ?? {};
      const w = write(app);

      // Validate encoder if provided
      if (body.encoder !== undefined) {
        if (!(VALID_ENCODERS as readonly string[]).includes(body.encoder)) {
          return reply.code(400).send({
            error: `encoder must be one of: ${VALID_ENCODERS.join(", ")}`,
          });
        }
      }

      // Validate refreshCadenceDays if provided
      if (body.refreshCadenceDays !== undefined) {
        const days = Number(body.refreshCadenceDays);
        if (!Number.isInteger(days) || days < 1) {
          return reply.code(400).send({ error: "refreshCadenceDays must be a positive integer" });
        }
      }

      const tasks: Promise<void>[] = [];
      if (typeof body.tmdbToken === "string") {
        tasks.push(setSetting("tmdbToken", body.tmdbToken, { write: w }));
      }
      if (typeof body.encoder === "string") {
        tasks.push(setSetting("encoder", body.encoder as EncoderValue, { write: w }));
      }
      if (typeof body.omdbKey === "string") {
        tasks.push(setSetting("omdbKey", body.omdbKey, { write: w }));
      }
      if (typeof body.fanartKey === "string") {
        tasks.push(setSetting("fanartKey", body.fanartKey, { write: w }));
      }
      if (typeof body.tvdbApiKey === "string") {
        tasks.push(setSetting("tvdbApiKey", body.tvdbApiKey, { write: w }));
      }
      if (typeof body.tvdbPin === "string") {
        tasks.push(setSetting("tvdbPin", body.tvdbPin, { write: w }));
      }
      if (body.refreshCadenceDays !== undefined) {
        tasks.push(setSetting("refreshCadenceDays", Number(body.refreshCadenceDays), { write: w }));
      }
      await Promise.all(tasks);
      return { ok: true };
    },
  );
}
