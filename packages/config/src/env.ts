import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive(),
  WEB_PORT: z.coerce.number().int().positive(),
  SESSION_SECRET: z.string().min(32),
  WEB_ORIGIN: z.string().url(),
  METADATA_DIR: z.string().default("./data/metadata"),
  TRANSCODE_DIR: z.string().default("./data/transcode"),
  MODELS_DIR: z.string().default("./data/models"),
  MOUNTS_DIR: z.string().default("./data/mounts"),
  EMBEDDINGS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Cap on concurrent ffmpeg transcode sessions (LRU-evicted past the cap).
  MAX_TRANSCODE_SESSIONS: z.coerce.number().int().positive().default(4),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
