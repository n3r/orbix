import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router";
import { render, screen } from "@testing-library/react";
import SpotlightHero from "./SpotlightHero";
import type { HomeCard, TitleDetail } from "@/lib/types";

const detail: TitleDetail = {
  id: "s1", kind: "series", title: "The Series", year: 2011,
  overview: "Twisted tales run wild in this anthology.", tagline: null,
  runtimeSec: null, rating: "TV-MA", posterPath: "poster/s.jpg",
  backdropPath: "backdrop/s.jpg", logoPath: null, status: null, matchState: "matched",
  genres: ["Drama"], cast: [], director: null, files: [],
  seasons: [{ seasonNumber: 1, name: null, episodeCount: 8, posterPath: null }],
};

// Note: a plain default parameter (`d = detail`) can't distinguish "omitted"
// from "explicitly undefined" — JS applies the default in both cases — but the
// last test below needs `detail` to stay `undefined`. A rest tuple preserves
// that distinction while keeping every call site unchanged.
function renderHero(card: HomeCard, ...rest: [TitleDetail | undefined] | []) {
  const d = rest.length > 0 ? rest[0] : detail;
  return render(
    <MemoryRouter>
      <SpotlightHero card={card} detail={d} />
    </MemoryRouter>,
  );
}

describe("SpotlightHero", () => {
  it("renders the title heading and Play link when there is no logo", () => {
    renderHero({ id: "s1", title: "The Series", year: 2011, posterPath: "poster/s.jpg" });
    expect(screen.getByRole("heading", { name: "The Series" })).toBeTruthy();
    // toHaveAttribute (jest-dom) isn't usable here: a stray hoisted vitest@3.2.6
    // (pulled in by packages/core|config|api, which pin vitest ^3.0.0) shadows
    // the workspace-root bare `import "vitest"` that @testing-library/jest-dom
    // resolves against, so its expect.extend() patches a different `expect`
    // instance than the one globally injected by vitest@~4.1.9 here. Assert via
    // plain DOM API instead, matching SpotlightPoster.test.tsx's convention.
    expect(screen.getByRole("link", { name: /play/i }).getAttribute("href")).toBe("/title/s1");
  });

  it("shows the discovery metadata line and description", () => {
    renderHero({ id: "s1", title: "The Series", year: 2011, posterPath: "poster/s.jpg" });
    expect(screen.getByText(/Drama/)).toBeTruthy();
    expect(screen.getByText(/TV-MA/)).toBeTruthy();
    expect(screen.getByText(/Twisted tales/)).toBeTruthy();
  });

  it("shows the resume line + time-left for a continue item", () => {
    renderHero({
      id: "s1", title: "The Series", year: 2011, posterPath: "poster/s.jpg",
      progress: { positionSec: 600, durationSec: 1200 },
      resume: { seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends" },
    });
    expect(screen.getByText("S3 E4 · Old Friends")).toBeTruthy();
    expect(screen.getByText("10m left")).toBeTruthy();
  });

  it("renders a skeleton (no heading) while detail is loading", () => {
    renderHero({ id: "s1", title: "The Series", year: 2011, posterPath: "poster/s.jpg" }, undefined);
    expect(screen.queryByRole("heading", { name: "The Series" })).toBeNull();
  });

  it("shows progress (no S/E line) for a continue movie with resume: null", () => {
    const movieDetail: TitleDetail = {
      id: "m1", kind: "movie", title: "Movie M", year: 2020,
      overview: "SHOULD NOT SHOW", tagline: null,
      runtimeSec: null, rating: "PG-13", posterPath: "poster/m.jpg",
      backdropPath: "backdrop/m.jpg", logoPath: null, status: null, matchState: "matched",
      genres: ["Action"], cast: [], director: null, files: [],
    };
    renderHero(
      {
        id: "m1", title: "Movie M", year: 2020, posterPath: "poster/m.jpg",
        progress: { positionSec: 600, durationSec: 1200 },
        resume: null,
      },
      movieDetail,
    );
    expect(screen.getByText("10m left")).toBeTruthy();
    expect(screen.queryByText(/SHOULD NOT SHOW/)).toBeNull();
  });
});
