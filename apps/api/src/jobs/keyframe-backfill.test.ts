import { describe, it, expect } from "vitest";
import { sweepKeyframeBackfill, type KeyframeBackfillDeps } from "./keyframe-backfill";

function deps(overrides: Partial<KeyframeBackfillDeps> = {}) {
  const adds: { name: string; data: { fileId: string }; opts: { jobId: string } }[] = [];
  const warns: unknown[] = [];
  const infos: unknown[] = [];
  const base: KeyframeBackfillDeps = {
    prisma: {
      mediaFile: {
        findMany: async () => [
          { id: "missing1", keyframes: null },
          { id: "done1", keyframes: [0, 6.006] },
        ],
      },
    },
    queue: {
      add: async (name, data, opts) => {
        adds.push({ name, data, opts });
        return undefined;
      },
    },
    log: {
      info: (obj: unknown) => { infos.push(obj); },
      warn: (obj: unknown) => { warns.push(obj); },
    } as KeyframeBackfillDeps["log"],
    libraryId: "lib1",
  };
  return { deps: { ...base, ...overrides }, adds, warns, infos };
}

describe("sweepKeyframeBackfill", () => {
  it("enqueues a keyframes job only for the file missing an index", async () => {
    const { deps: d, adds, infos } = deps();
    await sweepKeyframeBackfill(d);

    expect(adds).toHaveLength(1);
    expect(adds[0]).toEqual({
      name: "keyframes",
      data: { fileId: "missing1" },
      opts: { jobId: "missing1" },
    });
    expect(infos[0]).toMatchObject({ libraryId: "lib1", enqueued: 1 });
  });

  it("treats an empty keyframes array as not-yet-indexed", async () => {
    const { deps: d, adds } = deps({
      prisma: {
        mediaFile: {
          findMany: async () => [{ id: "empty1", keyframes: [] }],
        },
      },
    });
    await sweepKeyframeBackfill(d);
    expect(adds).toEqual([
      { name: "keyframes", data: { fileId: "empty1" }, opts: { jobId: "empty1" } },
    ]);
  });

  it("never throws when the queue add fails — the scan must not fail", async () => {
    const { deps: d, warns } = deps({
      queue: { add: async () => { throw new Error("redis down"); } },
    });

    await expect(sweepKeyframeBackfill(d)).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ libraryId: "lib1" });
  });

  it("never throws when the file query itself fails", async () => {
    const { deps: d, warns } = deps({
      prisma: {
        mediaFile: {
          findMany: async () => { throw new Error("db down"); },
        },
      },
    });

    await expect(sweepKeyframeBackfill(d)).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
  });

  it("enqueues nothing (and logs 0) when every file already has an index", async () => {
    const { deps: d, adds, infos } = deps({
      prisma: {
        mediaFile: {
          findMany: async () => [{ id: "done1", keyframes: [0, 6] }],
        },
      },
    });
    await sweepKeyframeBackfill(d);
    expect(adds).toHaveLength(0);
    expect(infos[0]).toMatchObject({ enqueued: 0 });
  });
});
