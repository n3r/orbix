import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders";
import MediaRow from "./MediaRow";
import type { HomeCard } from "@/lib/types";

const items: HomeCard[] = [
  { id: "a", title: "Alpha", year: 2020, posterPath: "poster/a.jpg", backdropPath: "backdrop/a.jpg" },
  {
    id: "b", title: "Bravo", year: 2021, posterPath: "poster/b.jpg", backdropPath: null,
    progress: { positionSec: 300, durationSec: 1200 },
    resume: { seasonNumber: 2, episodeNumber: 3, episodeTitle: "Homecoming" },
  },
];

describe("MediaRow", () => {
  it("localizes known row keys and renders one linked box-art card per item", () => {
    renderWithProviders(<MediaRow rowKey="continue" title="ignored" items={items} />);
    expect(screen.getByRole("heading", { name: "Continue Watching" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Alpha/ }).getAttribute("href")).toBe("/title/a");
    expect(screen.getByRole("link", { name: /Bravo/ }).getAttribute("href")).toBe("/title/b");
  });

  it("uses backdrop art, falls back to poster, and shows resume label + progress", () => {
    const { container } = renderWithProviders(<MediaRow title="Row" items={items} />);
    expect(container.querySelector('img[src="/api/images/backdrop/a.jpg"]')).toBeTruthy();
    expect(container.querySelector('img[src="/api/images/poster/b.jpg"]')).toBeTruthy();
    expect(screen.getByText("S2 E3 · Homecoming")).toBeTruthy();
    const bar = container.querySelector("[data-progress] > span") as HTMLElement;
    expect(bar.style.width).toBe("25%");
  });

  it("reveals chevron paddles only for the scrollable direction", () => {
    renderWithProviders(<MediaRow title="Row" items={items} />);
    const scroller = screen.getByTestId("row-scroller");
    // jsdom has no layout: simulate an overflowing strip scrolled mid-way.
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 2000 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 800 });
    scroller.scrollLeft = 100;
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Scroll left" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scroll right" })).toBeTruthy();

    scroller.scrollLeft = 0;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Scroll left" })).toBeNull();
    expect(screen.getByRole("button", { name: "Scroll right" })).toBeTruthy();
  });

  it("hides unmatched items' art but keeps the titled card", () => {
    const unmatched: HomeCard[] = [
      { id: "u", title: "Unknown File", posterPath: "poster/u.jpg", backdropPath: "backdrop/u.jpg", matchState: "unmatched" },
    ];
    const { container } = renderWithProviders(<MediaRow title="Row" items={unmatched} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Unknown File")).toBeTruthy();
  });

  it("renders an optional right-aligned header action", () => {
    renderWithProviders(
      <MediaRow title="Drama" items={items} action={<a href="/library/l1?genre=18">See all (9)</a>} />,
    );
    expect(screen.getByRole("link", { name: "See all (9)" }).getAttribute("href")).toBe(
      "/library/l1?genre=18",
    );
  });
});
