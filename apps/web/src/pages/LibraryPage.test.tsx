import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import LibraryPage from "./LibraryPage";
import type { LibraryRow, MediaCard } from "@/lib/types";

const rows: LibraryRow[] = [
  {
    key: "genre:35", genreId: 35, title: "Comedy", total: 30,
    items: [{ id: "c1", title: "Funny One", year: 2020, posterPath: "poster/c1.jpg", backdropPath: null }],
  },
  {
    key: "genre:18", genreId: 18, title: "Drama", total: 2,
    items: [{ id: "d1", title: "Sad One", year: 2019, posterPath: "poster/d1.jpg", backdropPath: null }],
  },
];

const alphaItems: MediaCard[] = [
  { id: "a1", title: "Alien", year: 1979, posterPath: "poster/a1.jpg" },
  { id: "b1", title: "Брат", year: 1997, posterPath: "poster/b1.jpg" },
];

const comedyItems: MediaCard[] = [
  { id: "c1", title: "Funny One", year: 2020, posterPath: "poster/c1.jpg" },
];

function setup(route: string) {
  const client = makeClient();
  client.setQueryData(["menu"], { items: [{ libraryId: "lib1", name: "Movies" }] });
  client.setQueryData(["library-rows", "lib1"], { rows });
  client.setQueryData(["library-items", "lib1", "alpha", "", null], alphaItems);
  client.setQueryData(["library-items", "lib1", "rating", "", 35], comedyItems);
  return renderWithProviders(
    <Routes>
      <Route path="/library/:libraryId" element={<LibraryPage />} />
    </Routes>,
    { route, client },
  );
}

describe("LibraryPage", () => {
  it("defaults to the Categories tab: library-name heading + genre rails with See-all links", () => {
    setup("/library/lib1");
    expect(screen.getByRole("heading", { name: "Movies", level: 1 })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Categories", selected: true })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Comedy" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Drama" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all (30)" }).getAttribute("href")).toBe(
      "/library/lib1?genre=35",
    );
  });

  it("?tab=browse renders the flat alphabetical grid with search, no rails", () => {
    setup("/library/lib1?tab=browse");
    expect(screen.getByRole("tab", { name: "Browse", selected: true })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search titles…")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Alien/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Брат/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Comedy" })).toBeNull();
  });

  it("?genre=35 renders the See-all grid with genre heading and a back link", () => {
    setup("/library/lib1?genre=35");
    expect(screen.getByRole("heading", { name: "Comedy", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to categories/ }).getAttribute("href")).toBe(
      "/library/lib1",
    );
    expect(screen.getByRole("link", { name: /Funny One/ })).toBeTruthy();
  });
});
