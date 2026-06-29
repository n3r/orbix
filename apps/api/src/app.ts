import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import type { Env } from "@orbix/config";
import dbPlugin from "./plugins/db";
import sessionPlugin from "./plugins/session";
import health from "./routes/health";
import setup from "./routes/setup";
import auth from "./routes/auth";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(dbPlugin);
  await app.register(sessionPlugin);
  await app.register(health);
  await app.register(setup);
  await app.register(auth);
  return app;
}
