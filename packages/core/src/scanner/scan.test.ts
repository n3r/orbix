import { describe, it, expect, beforeEach } from "vitest";
import { scanSource, ScanDeps } from "./scan";
import type { MediaFileTechnical } from "./probe";
import { parseMediaPath } from "./parse";

const fileA = { path: "/m/A (2001)/A (2001).mkv", mtime: new Date("2024-01-01"), size: 100 };
const fileB = { path: "/m/B (2002)/B (2002).mkv", mtime: new Date("2024-01-02"), size: 200 };

const stubTech: MediaFileTechnical = { audioCodecs: [], subtitleTracks: [], audioTracks: [] };

function makeDeps(files: typeof fileA[]): { deps: ScanDeps; repo: Map<string, { mtime: Date; size: number }> } {
  const repo = new Map<string, { mtime: Date; size: number }>();

  const deps: ScanDeps = {
    listFiles: async (_root: string) => files,
    probe: async (_path: string) => stubTech,
    findFileByPath: async (path: string) => {
      const entry = repo.get(path);
      if (!entry) return null;
      return { mtime: entry.mtime, size: entry.size };
    },
    upsertItemAndFile: async ({ file, parsed }) => {
      const existed = repo.has(file.path);
      repo.set(file.path, { mtime: file.mtime, size: file.size });
      return { itemId: parsed.title, created: !existed };
    },
  };

  return { deps, repo };
}

describe("scanSource", () => {
  const opts = { libraryId: "lib-1", root: "/m" };

  it("first scan: adds both files", async () => {
    const { deps } = makeDeps([fileA, fileB]);
    const result = await scanSource(opts, deps);
    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.itemIds).toHaveLength(2);
  });

  it("second scan with unchanged stats: skips both files", async () => {
    const { deps } = makeDeps([fileA, fileB]);
    await scanSource(opts, deps); // populate repo
    const result = await scanSource(opts, deps);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.itemIds).toHaveLength(0);
  });

  it("changed file: updates changed file, skips unchanged", async () => {
    const { deps, repo } = makeDeps([fileA, fileB]);
    await scanSource(opts, deps); // populate repo

    // bump size of fileA
    const changedFileA = { ...fileA, size: 999 };
    const depsChanged = makeDeps([changedFileA, fileB]).deps;
    // share the same repo
    depsChanged.findFileByPath = async (path: string) => {
      const entry = repo.get(path);
      if (!entry) return null;
      return { mtime: entry.mtime, size: entry.size };
    };
    depsChanged.upsertItemAndFile = async ({ file, parsed }) => {
      const existed = repo.has(file.path);
      repo.set(file.path, { mtime: file.mtime, size: file.size });
      return { itemId: parsed.title, created: !existed };
    };

    const result = await scanSource(opts, depsChanged);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.added).toBe(0);
    expect(result.itemIds).toHaveLength(1);
  });

  it("itemIds are unique and in first-seen order", async () => {
    // Two files with the same parsed title (same itemId) — deduped
    const fileA1 = { path: "/m/A (2001)/A (2001).mkv", mtime: new Date("2024-01-01"), size: 100 };
    const fileA2 = { path: "/m/A (2001)/A (2001).mp4", mtime: new Date("2024-01-01"), size: 200 };
    const { deps } = makeDeps([fileA1, fileA2]);
    const result = await scanSource(opts, deps);
    expect(result.added).toBe(2);
    // Both map to the same title "A", so itemIds should be deduplicated
    const uniqueIds = [...new Set(result.itemIds)];
    expect(result.itemIds).toEqual(uniqueIds);
  });
});
