import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import HomeBillboard from "./HomeBillboard";
import type { HomeCard, TitleDetail } from "@/lib/types";

const card: HomeCard = {
  id: "a",
  title: "Movie A",
  year: 2020,
  posterPath: "poster/a.jpg",
  backdropPath: "backdrop/a.jpg",
};

const detail = (over: Partial<TitleDetail> = {}): TitleDetail => ({
  id: "a", kind: "movie", title: "Movie A", year: 2020, overview: "A grand adventure.",
  tagline: null, runtimeSec: null, rating: "PG-13", posterPath: "poster/a.jpg",
  backdropPath: "backdrop/a.jpg", logoPath: null, status: null, matchState: "matched",
  genres: ["Action"], cast: [], director: null, files: [], ...over,
});

describe("HomeBillboard", () => {
  it("paints title + Play/More info immediately from the card, before detail loads", () => {
    renderWithProviders(<HomeBillboard card={card} />);
    expect(screen.getByRole("heading", { name: "Movie A" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Play/ }).getAttribute("href")).toBe("/title/a?play=1");
    expect(screen.getByRole("link", { name: /More info/ }).getAttribute("href")).toBe("/title/a");
  });

  it("upgrades to synopsis, meta and cert plate once detail lands", () => {
    const client = makeClient();
    client.setQueryData(["item", "a"], detail());
    renderWithProviders(<HomeBillboard card={card} />, { client });
    expect(screen.getByText("A grand adventure.")).toBeTruthy();
    expect(screen.getByText(/Action · 2020/)).toBeTruthy();
    expect(screen.getByText("PG-13")).toBeTruthy();
  });

  it("swaps the visible title for logo art but keeps an accessible heading", () => {
    const client = makeClient();
    client.setQueryData(["item", "a"], detail({ logoPath: "logo/a.png" }));
    renderWithProviders(<HomeBillboard card={card} />, { client });
    const heading = screen.getByRole("heading", { name: "Movie A" });
    expect(heading.className).toContain("sr-only");
    const logo = document.querySelector('img[src="/api/images/logo/a.png"]');
    expect(logo).toBeTruthy();
  });
});
