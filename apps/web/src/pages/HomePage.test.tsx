import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import HomePage from "./HomePage";
import type { HomeRow } from "@/lib/types";

const rows: HomeRow[] = [
  { key: "continue", title: "Continue Watching", items: [
    { id: "a", title: "Resume A", year: 2020, posterPath: "poster/a.jpg", backdropPath: "backdrop/a.jpg",
      progress: { positionSec: 600, durationSec: 1200 }, resume: null },
  ] },
  { key: "hiddenGems", title: "Hidden gems", items: [
    { id: "b", title: "Gem B", year: 2019, posterPath: "poster/b.jpg", backdropPath: "backdrop/b.jpg" },
  ] },
];

function setup() {
  const client = makeClient();
  client.setQueryData(["home-rows"], { rows });
  return renderWithProviders(<HomePage />, { client });
}

describe("HomePage", () => {
  it("features a non-continue title on the billboard", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Gem B", level: 1 })).toBeTruthy();
  });

  it("renders every row below the billboard, continue watching included", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Continue Watching" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Hidden gems" })).toBeTruthy();
    // The featured title also keeps its place in its row (billboard + card).
    expect(screen.getAllByRole("link", { name: /Gem B/ }).length).toBeGreaterThan(0);
  });
});
