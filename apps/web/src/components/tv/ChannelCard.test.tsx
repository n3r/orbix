import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChannelCard from "./ChannelCard";
import type { TvChannelCard } from "@/lib/types";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const base: TvChannelCard = {
  id: "chan-1",
  number: 101,
  name: "News One",
  country: "US",
  categories: ["news"],
  quality: "HD",
  logo: null,
  healthy: true,
  favorite: false,
};

describe("ChannelCard", () => {
  it("renders the logo img with the API-provided src as-is (not double-prefixed)", () => {
    // The logo art is decorative (alt="") since the name renders as text
    // alongside it, so it's excluded from the accessible "img" role —
    // query the DOM directly instead of via screen.getByRole/AltText.
    const { container } = wrap(
      <ChannelCard channel={{ ...base, logo: "/api/images/channel/x.png" }} onPlay={() => {}} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/images/channel/x.png");
  });

  it("renders the monogram fallback (no img) when logo is null", () => {
    const { container } = wrap(<ChannelCard channel={{ ...base, logo: null }} onPlay={() => {}} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("NO")).toBeTruthy();
  });
});
