import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const valid = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://orbix:orbix@localhost:1062/orbix",
  REDIS_URL: "redis://localhost:1063",
  API_PORT: "1061",
  WEB_PORT: "1060",
  SESSION_SECRET: "x".repeat(32),
  WEB_ORIGIN: "http://localhost:1060",
};

describe("loadEnv", () => {
  it("parses a valid environment and coerces ports to numbers", () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(1061);
    expect(env.NODE_ENV).toBe("development");
  });

  it("defaults MOUNTS_DIR", () => {
    expect(loadEnv(valid).MOUNTS_DIR).toBe("./data/mounts");
  });

  it("throws when SESSION_SECRET is too short", () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: "short" })).toThrow();
  });

  it("throws when DATABASE_URL is missing", () => {
    const { DATABASE_URL, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow();
  });
});
