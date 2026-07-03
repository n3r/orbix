import { describe, it, expect } from "vitest";
import { pickBillboard } from "./billboard";
import type { HomeRow } from "./types";

const card = (id: string, backdropPath: string | null = null) => ({
  id,
  title: id,
  posterPath: null,
  backdropPath,
});

describe("pickBillboard", () => {
  it("features the first backdrop-bearing card of the first non-continue row", () => {
    const rows: HomeRow[] = [
      { key: "continue", title: "Continue", items: [card("resume", "b/resume.jpg")] },
      { key: "tonight", title: "Tonight", items: [card("no-art"), card("pick", "b/pick.jpg")] },
    ];
    expect(pickBillboard(rows)?.id).toBe("pick");
  });

  it("falls back to any row's backdrop card when discovery rows have no art", () => {
    const rows: HomeRow[] = [
      { key: "continue", title: "Continue", items: [card("resume", "b/resume.jpg")] },
      { key: "tonight", title: "Tonight", items: [card("no-art")] },
    ];
    expect(pickBillboard(rows)?.id).toBe("resume");
  });

  it("falls back to the first card overall when nothing has art", () => {
    const rows: HomeRow[] = [
      { key: "continue", title: "Continue", items: [card("only")] },
    ];
    expect(pickBillboard(rows)?.id).toBe("only");
  });

  it("returns null for empty rows", () => {
    expect(pickBillboard([])).toBeNull();
    expect(pickBillboard([{ key: "tonight", title: "Tonight", items: [] }])).toBeNull();
  });

  it("rotates among the discovery row's backdrop candidates by seed", () => {
    const rows: HomeRow[] = [
      { key: "tonight", title: "Tonight", items: [card("one", "b/1.jpg"), card("no-art"), card("two", "b/2.jpg")] },
    ];
    expect(pickBillboard(rows, 0)?.id).toBe("one");
    expect(pickBillboard(rows, 1)?.id).toBe("two");
    expect(pickBillboard(rows, 2)?.id).toBe("one");
  });
});
