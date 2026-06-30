import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RatingBadges from "./RatingBadges";

describe("RatingBadges", () => {
  it("renders IMDb, RT, and TMDB when present", () => {
    render(<RatingBadges imdbRating={9} rtRating={96} tmdbScore={8.7} />);
    expect(screen.getByText(/IMDb/)).toBeTruthy();
    expect(screen.getByText("9.0")).toBeTruthy();
    expect(screen.getByText("96%")).toBeTruthy();
    expect(screen.getByText(/TMDB/)).toBeTruthy();
  });

  it("renders nothing when no ratings and no mpaa", () => {
    const { container } = render(<RatingBadges />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the MPAA cert chip when provided", () => {
    render(<RatingBadges mpaa="PG-13" />);
    expect(screen.getByText("PG-13")).toBeTruthy();
  });
});
