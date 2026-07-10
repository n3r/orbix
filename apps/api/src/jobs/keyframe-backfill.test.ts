import { describe, it, expect } from "vitest";
import { Prisma } from "@orbix/db";
import { sweepKeyframeBackfill, type KeyframeBackfillDeps } from "./keyframe-backfill";

function deps(overrides: Partial<KeyframeBackfillDeps> = {}) {
  const adds: { name: string; data: { fileId: string }; opts: { jobId: string } }[] = [];
  const warns: unknown[] = [];
  const infos: unknown[] = [];
  const findManyCalls: unknown[] = [];
  const base: KeyframeBackfillDeps = {
    prisma: {
      mediaFile: {
        findMany: async (args) => {
          findManyCalls.push(args);
          return [{ id: "missing1" }];
        },
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
  return { deps: { ...base, ...overrides }, adds, warns, infos, findManyCalls };
}

describe("sweepKeyframeBackfill", () => {
  it("enqueues a keyframes job for every file the DB-side query returns", async () => {
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

  it("queries with the probedOk gate, DB-side missing-keyframes predicate, id-only select, and largest-first order", async () => {
    const { deps: d, findManyCalls } = deps();
    await sweepKeyframeBackfill(d);

    expect(findManyCalls).toHaveLength(1);
    expect(findManyCalls[0]).toEqual({
      where: {
        mediaItem: { libraryId: "lib1" },
        videoCodec: { not: null },
        probedOk: true,
        // Empty-array counts as "missing" alongside the DB-null case — both
        // are filtered DB-side now, not fetched-then-JS-filtered.
        OR: [{ keyframes: { equals: Prisma.DbNull } }, { keyframes: { equals: [] } }],
      },
      select: { id: true },
      orderBy: { size: "desc" },
    });
  });

  it("never throws when a queue add fails — the scan must not fail", async () => {
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

  it("enqueues nothing (and logs 0) when the query returns no rows", async () => {
    const { deps: d, adds, infos } = deps({
      prisma: {
        mediaFile: {
          findMany: async () => [],
        },
      },
    });
    await sweepKeyframeBackfill(d);
    expect(adds).toHaveLength(0);
    expect(infos[0]).toMatchObject({ enqueued: 0 });
    expect(infos[0]).not.toHaveProperty("failed");
  });

  it("isolates a single failing queue.add: files before and after it still enqueue, sweep resolves", async () => {
    const added: string[] = [];
    const warns: unknown[] = [];
    const infos: unknown[] = [];
    const d: KeyframeBackfillDeps = {
      prisma: {
        mediaFile: {
          findMany: async () => [{ id: "file1" }, { id: "file2" }, { id: "file3" }],
        },
      },
      queue: {
        add: async (_name, data) => {
          if (data.fileId === "file2") throw new Error("transient redis blip");
          added.push(data.fileId);
          return undefined;
        },
      },
      log: {
        info: (obj: unknown) => { infos.push(obj); },
        warn: (obj: unknown) => { warns.push(obj); },
      } as KeyframeBackfillDeps["log"],
      libraryId: "lib1",
    };

    await expect(sweepKeyframeBackfill(d)).resolves.toBeUndefined();

    expect(added).toEqual(["file1", "file3"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ libraryId: "lib1", fileId: "file2" });
    expect(infos[0]).toMatchObject({ libraryId: "lib1", enqueued: 2, failed: 1 });
  });
});
