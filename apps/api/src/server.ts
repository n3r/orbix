import { loadEnv } from "@orbix/config";
import { buildApp } from "./app";

const env = loadEnv();
const app = await buildApp(env);
app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
