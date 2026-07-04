import { describe, it, expect } from "vitest";
import { seasonShapeScore, matchSpecialEpisode, pickBestByShape, type LocalSeasonShape } from "./season-shape";

const local = (tuples: [number, number, number][]): LocalSeasonShape[] =>
  tuples.map(([seasonNumber, episodeCount, maxEpisode]) => ({ seasonNumber, episodeCount, maxEpisode }));

describe("seasonShapeScore", () => {
  it("prefers the exact-fit candidate over a contradicting one (Shōgun 2024 vs 1980)", () => {
    const files = local([[1, 10, 10]]);
    const shogun2024 = [{ seasonNumber: 1, episodeCount: 10 }];
    const shogun1980 = [{ seasonNumber: 1, episodeCount: 5 }];
    expect(seasonShapeScore(files, shogun2024)).toBeGreaterThan(seasonShapeScore(files, shogun1980));
  });

  it("punishes missing seasons hard (The Flash 2014 vs 1990)", () => {
    const files = local([
      [2, 23, 23],
      [3, 23, 23],
      [5, 22, 22],
      [9, 13, 13],
    ]);
    const flash2014 = [
      { seasonNumber: 1, episodeCount: 23 },
      { seasonNumber: 2, episodeCount: 23 },
      { seasonNumber: 3, episodeCount: 23 },
      { seasonNumber: 4, episodeCount: 22 },
      { seasonNumber: 5, episodeCount: 22 },
      { seasonNumber: 6, episodeCount: 18 },
      { seasonNumber: 7, episodeCount: 18 },
      { seasonNumber: 8, episodeCount: 20 },
      { seasonNumber: 9, episodeCount: 13 },
    ];
    const flash1990 = [{ seasonNumber: 1, episodeCount: 22 }];
    expect(seasonShapeScore(files, flash2014)).toBeGreaterThan(0);
    expect(seasonShapeScore(files, flash1990)).toBeLessThan(0);
  });

  it("prefers exact season sizes over a superset (Doctor Who 2005 vs classic)", () => {
    const files = local([
      [1, 13, 13],
      [2, 13, 13],
      [3, 13, 13],
    ]);
    const dw2005 = [
      { seasonNumber: 1, episodeCount: 13 },
      { seasonNumber: 2, episodeCount: 13 },
      { seasonNumber: 3, episodeCount: 13 },
    ];
    const dwClassic = [
      { seasonNumber: 1, episodeCount: 42 },
      { seasonNumber: 2, episodeCount: 39 },
      { seasonNumber: 3, episodeCount: 45 },
    ];
    expect(seasonShapeScore(files, dw2005)).toBeGreaterThan(seasonShapeScore(files, dwClassic));
  });

  it("tolerates a one-off overflow (a special counted into the local season)", () => {
    const files = local([[4, 7, 7]]);
    const provider = [{ seasonNumber: 4, episodeCount: 6 }];
    expect(seasonShapeScore(files, provider)).toBeGreaterThan(0);
  });

  it("ignores season 0 on both sides", () => {
    const files = local([
      [0, 3, 913],
      [1, 6, 6],
    ]);
    const provider = [{ seasonNumber: 1, episodeCount: 6 }];
    expect(seasonShapeScore(files, provider)).toBe(seasonShapeScore(local([[1, 6, 6]]), provider));
  });
});

describe("matchSpecialEpisode", () => {
  const dwSpecials = [
    { episodeNumber: 6, title: "The Christmas Invasion", airDate: "2005-12-25" },
    { episodeNumber: 7, title: "Attack of the Graske", airDate: "2005-12-25" },
    { episodeNumber: 17, title: "Voyage of the Damned", airDate: "2007-12-25" },
    { episodeNumber: 60, title: "The Day of the Doctor", airDate: "2013-11-23" },
    { episodeNumber: 76, title: "The Return of Doctor Mysterio", airDate: "2016-12-25" },
  ];

  it("matches by title hint", () => {
    expect(matchSpecialEpisode({ title: "The Day Of The Doctor", year: 2013 }, dwSpecials)).toBe(60);
    expect(matchSpecialEpisode({ title: "voyage of the damned", year: 2007 }, dwSpecials)).toBe(17);
  });

  it("falls back to a unique air year", () => {
    expect(matchSpecialEpisode({ year: 2016 }, dwSpecials)).toBe(76);
  });

  it("breaks a same-year tie with the christmas-titled episode", () => {
    expect(matchSpecialEpisode({ year: 2005, christmas: true }, dwSpecials)).toBe(6);
  });

  it("returns undefined when nothing distinguishes the candidates", () => {
    expect(matchSpecialEpisode({ year: 2004 }, dwSpecials)).toBeUndefined();
    expect(matchSpecialEpisode({}, dwSpecials)).toBeUndefined();
  });

  it("never title-matches on a sub-threshold similarity", () => {
    expect(matchSpecialEpisode({ title: "completely unrelated" }, dwSpecials)).toBeUndefined();
  });
});

describe("pickBestByShape candidate budget", () => {
  it("shape-checks beyond the top three so a lower-ranked exact fit can win", async () => {
    const finalists = ["ranch16", "ranch12", "ranch04", "leranch"];
    const shapes: Record<string, { seasonNumber: number; episodeCount: number }[]> = {
      ranch16: [{ seasonNumber: 1, episodeCount: 20 }],
      ranch12: [{ seasonNumber: 1, episodeCount: 10 }],
      ranch04: [{ seasonNumber: 1, episodeCount: 8 }],
      leranch: [
        { seasonNumber: 1, episodeCount: 26 },
        { seasonNumber: 2, episodeCount: 26 },
      ],
    };
    const local = [
      { seasonNumber: 1, episodeCount: 26, maxEpisode: 26 },
      { seasonNumber: 2, episodeCount: 26, maxEpisode: 26 },
    ];
    const winner = await pickBestByShape(finalists, local, async (f) => shapes[f]!);
    expect(winner).toBe("leranch");
  });
});
