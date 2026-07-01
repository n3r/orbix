import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router";
import { render, screen } from "@testing-library/react";
import SpotlightPoster from "./SpotlightPoster";
import type { HomeCard } from "@/lib/types";

function renderPoster(item: HomeCard) {
  return render(
    <MemoryRouter>
      <SpotlightPoster item={item} active={false} onPromote={() => {}} />
    </MemoryRouter>,
  );
}

describe("SpotlightPoster", () => {
  it("links to the title page", () => {
    renderPoster({ id: "x1", title: "My Show", year: 2020, posterPath: "poster/x.jpg" });
    expect(screen.getByRole("link", { name: /My Show/ }).getAttribute("href")).toBe("/title/x1");
  });

  it("renders a progress bar when the item has progress", () => {
    const { container } = renderPoster({
      id: "x2", title: "In Progress", year: 2020, posterPath: "poster/x.jpg",
      progress: { positionSec: 600, durationSec: 1200 },
    });
    const bar = container.querySelector("[data-progress]") as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar!.style.width).toBe("50%");
  });
});
