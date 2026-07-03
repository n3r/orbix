import { describe, it, expect } from "vitest";
import { extractKeyframes } from "./extract-keyframes";

const CSV = "0.000000,K__\n0.040000,___\n6.006000,K__\n12.012000,K__\n";

function deps(overrides: Record<string, unknown> = {}) {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    deps: {
      run: async () => CSV,
      prisma: {
        mediaFile: {
          findUnique: async () => ({ id: "f1", path: "/m.mkv", keyframes: null, ...overrides }),
          update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return {}; },
        },
      },
    },
  };
}

describe("extractKeyframes", () => {
  it("scans, parses, and stores the keyframe index", async () => {
    const { deps: d, updates } = deps();
    const res = await extractKeyframes("f1", d as never);
    expect(res).toEqual({ count: 3 });
    expect(updates[0]).toEqual({ keyframes: [0, 6.006, 12.012] });
  });

  it("skips already-indexed files", async () => {
    const { deps: d, updates } = deps({ keyframes: [0, 6] });
    expect(await extractKeyframes("f1", d as never)).toEqual({ skipped: "already_indexed" });
    expect(updates).toHaveLength(0);
  });

  it("skips missing files", async () => {
    const d = {
      run: async () => CSV,
      prisma: { mediaFile: { findUnique: async () => null, update: async () => ({}) } },
    };
    expect(await extractKeyframes("f1", d as never)).toEqual({ skipped: "not_found" });
  });

  it("stores nothing when the scan yields no keyframes", async () => {
    const { deps: d, updates } = deps();
    (d as { run: () => Promise<string> }).run = async () => "0.0,___\n";
    expect(await extractKeyframes("f1", d as never)).toEqual({ skipped: "no_keyframes" });
    expect(updates).toHaveLength(0);
  });
});
