import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TitleHero from "./TitleHero";
import type { TitleDetail } from "@/lib/types";

const base: TitleDetail = {
  id: "x",
  kind: "movie",
  title: "Blade Runner",
  year: 1982,
  overview: "A blade runner must pursue replicants.",
  runtimeSec: 6900,
  rating: "R",
  posterPath: null,
  backdropPath: "backdrop/x.jpg",
  matchState: "matched",
  genres: ["Sci-Fi", "Thriller"],
  cast: [],
  director: null,
  files: [],
};

describe("TitleHero", () => {
  it("renders the title as text when there is no logo", () => {
    render(<TitleHero item={base} onPlay={() => {}} canPlay playLabel="Play" />);
    expect(screen.getByRole("heading", { name: "Blade Runner" })).toBeTruthy();
  });

  it("renders the logo image instead of the title heading when logoPath is set", () => {
    render(
      <TitleHero item={{ ...base, logoPath: "logo/x.png" }} onPlay={() => {}} canPlay playLabel="Play" />,
    );
    expect(screen.getByAltText("Blade Runner")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Blade Runner" })).toBeNull();
  });

  it("fires onPlay when the play button is clicked", () => {
    const onPlay = vi.fn();
    render(<TitleHero item={base} onPlay={onPlay} canPlay playLabel="Play" />);
    screen.getByRole("button", { name: "Play" }).click();
    expect(onPlay).toHaveBeenCalledOnce();
  });

  it("hides the wishlist button while membership is unknown", () => {
    render(
      <TitleHero item={base} onPlay={() => {}} canPlay playLabel="Play"
        wishlistLabel="Add to Wishlist" onToggleWishlist={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /Wishlist/ })).toBeNull();
  });

  it("fires onToggleWishlist and reflects membership via aria-pressed", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <TitleHero item={base} onPlay={() => {}} canPlay playLabel="Play"
        inWishlist={false} wishlistLabel="Add to Wishlist" onToggleWishlist={onToggle} />,
    );
    const btn = screen.getByRole("button", { name: /Add to Wishlist/ });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    btn.click();
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <TitleHero item={base} onPlay={() => {}} canPlay playLabel="Play"
        inWishlist={true} wishlistLabel="In Wishlist" onToggleWishlist={onToggle} />,
    );
    expect(screen.getByRole("button", { name: /In Wishlist/ }).getAttribute("aria-pressed")).toBe("true");
  });
});
