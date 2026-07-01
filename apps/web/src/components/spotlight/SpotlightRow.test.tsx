import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import SpotlightRow from "./SpotlightRow";
import type { HomeCard, TitleDetail } from "@/lib/types";

const cardA: HomeCard = { id: "a", title: "Movie A", year: 2020, posterPath: "poster/a.jpg" };
const cardB: HomeCard = { id: "b", title: "Movie B", year: 2021, posterPath: "poster/b.jpg" };

const detail = (id: string, title: string): TitleDetail => ({
  id, kind: "movie", title, year: 2020, overview: `${title} overview`, tagline: null,
  runtimeSec: null, rating: "PG-13", posterPath: `poster/${id}.jpg`,
  backdropPath: `backdrop/${id}.jpg`, logoPath: null, status: null, matchState: "matched",
  genres: ["Action"], cast: [], director: null, files: [],
});

function setup() {
  const client = makeClient();
  client.setQueryData(["item", "a"], detail("a", "Movie A"));
  client.setQueryData(["item", "b"], detail("b", "Movie B"));
  return renderWithProviders(<SpotlightRow items={[cardA, cardB]} debounceMs={0} />, { client });
}

describe("SpotlightRow", () => {
  it("shows the first item as the hero by default", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Movie A" })).toBeTruthy();
  });

  it("promotes a poster to the hero on hover", async () => {
    setup();
    // Two links to Movie B exist (hero none yet + poster). Hover the poster.
    const posterB = screen.getAllByRole("link", { name: /Movie B/ })[0];
    fireEvent.mouseEnter(posterB);
    expect(await screen.findByRole("heading", { name: "Movie B" })).toBeTruthy();
  });
});
