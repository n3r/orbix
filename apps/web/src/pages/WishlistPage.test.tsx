import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import WishlistPage from "./WishlistPage";
import type { MediaCard } from "@/lib/types";

const items: MediaCard[] = [
  { id: "a", title: "Alpha", year: 2020, posterPath: "poster/a.jpg", matchState: "matched" },
  { id: "b", title: "Beta", year: 2021, posterPath: null, matchState: "unmatched" },
];

function setup(data: MediaCard[]) {
  const client = makeClient();
  client.setQueryData(["wishlist", "items"], data);
  return renderWithProviders(<WishlistPage />, { client });
}

describe("WishlistPage", () => {
  it("renders a poster card linking to each saved title", () => {
    setup(items);
    expect(screen.getByRole("link", { name: /Alpha/ }).getAttribute("href")).toBe("/title/a");
    expect(screen.getByRole("link", { name: /Beta/ }).getAttribute("href")).toBe("/title/b");
  });

  it("shows the empty state when nothing is saved", () => {
    setup([]);
    expect(screen.getByText("Your wishlist is empty.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Wishlist" })).toBeTruthy();
  });
});
