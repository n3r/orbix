import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders";
import NavCategories from "./NavCategories";
import type { MenuItem } from "@/lib/types";

const items: MenuItem[] = [
  { libraryId: "s1", name: "Movies" },
  { libraryId: "s2", name: "Shows" },
];

describe("NavCategories", () => {
  it("renders a link per category targeting /library/:id", () => {
    renderWithProviders(<NavCategories items={items} pathname="/" />);
    const movies = screen.getByRole("link", { name: "Movies" });
    expect(movies.getAttribute("href")).toBe("/library/s1");
  });

  it("marks the active category via aria-current", () => {
    renderWithProviders(<NavCategories items={items} pathname="/library/s2" />);
    expect(screen.getByRole("link", { name: "Shows" }).getAttribute("aria-current")).toBe("page");
  });

  it("collapses overflow beyond maxVisible into a More menu", () => {
    const many: MenuItem[] = Array.from({ length: 5 }, (_, i) => ({
      libraryId: `x${i}`, name: `Cat${i}`,
    }));
    renderWithProviders(<NavCategories items={many} pathname="/" maxVisible={3} />);
    expect(screen.getByText("More")).toBeTruthy();
    // The 5th item lives inside the More menu, not the top row.
    expect(screen.getByRole("link", { name: "Cat4" })).toBeTruthy();
  });
});
