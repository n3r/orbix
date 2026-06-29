import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import type { Env } from "@orbix/config";
import dbPlugin from "./plugins/db";
import sessionPlugin from "./plugins/session";
import health from "./routes/health";
import setup from "./routes/setup";
import auth from "./routes/auth";
import profilesRoute from "./routes/profiles";
import settingsRoute from "./routes/settings";
import librariesRoute from "./routes/libraries";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const origins = env.WEB_ORIGIN.split(",").map((s) => s.trim());
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(dbPlugin);
  await app.register(sessionPlugin);
  await app.register(health);
  await app.register(setup);
  await app.register(auth);
  await app.register(profilesRoute);
  await app.register(settingsRoute);
  await app.register(librariesRoute);
  return app;
}
