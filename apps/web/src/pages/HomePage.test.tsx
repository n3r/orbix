import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import HomePage from "./HomePage";
import type { HomeRow, TitleDetail } from "@/lib/types";

const rows: HomeRow[] = [
  { key: "continue", title: "Continue Watching", items: [
    { id: "a", title: "Resume A", year: 2020, posterPath: "poster/a.jpg",
      progress: { positionSec: 600, durationSec: 1200 }, resume: null },
  ] },
  { key: "hiddenGems", title: "Hidden gems", items: [
    { id: "b", title: "Gem B", year: 2019, posterPath: "poster/b.jpg" },
  ] },
];

const detailA: TitleDetail = {
  id: "a", kind: "movie", title: "Resume A", year: 2020, overview: "o", tagline: null,
  runtimeSec: null, rating: "PG", posterPath: "poster/a.jpg", backdropPath: "backdrop/a.jpg",
  logoPath: null, status: null, matchState: "matched", genres: ["Action"], cast: [],
  director: null, files: [],
};

function setup() {
  const client = makeClient();
  client.setQueryData(["home-rows"], { rows });
  client.setQueryData(["item", "a"], detailA);
  return renderWithProviders(<HomePage />, { client });
}

describe("HomePage", () => {
  it("renders the featured (first) row as the spotlight hero", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Resume A" })).toBeTruthy();
  });

  it("renders remaining rows as rails and does not duplicate the featured row heading", () => {
    setup();
    expect(screen.getByRole("heading", { name: /Hidden gems/ })).toBeTruthy();
    // "Continue Watching" is now the spotlight, not a rail heading below.
    expect(screen.queryByRole("heading", { name: "Continue Watching" })).toBeNull();
  });
});
