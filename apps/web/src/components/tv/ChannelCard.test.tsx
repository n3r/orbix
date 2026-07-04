import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
  now: null,
  next: null,
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

  it("falls back to the monogram when the logo img fails to load", () => {
    const { container } = wrap(
      <ChannelCard channel={{ ...base, logo: "/api/images/channel/x.png" }} onPlay={() => {}} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();

    fireEvent.error(img!);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("NO")).toBeTruthy();
  });

  it("shows the now title with a progress bar when now is set", () => {
    const now = {
      title: "Evening News",
      start: new Date(Date.now() - 30 * 60_000).toISOString(),
      stop: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const { container } = wrap(<ChannelCard channel={{ ...base, now }} onPlay={() => {}} />);
    expect(screen.getByText("Evening News")).toBeTruthy();
    const fill = container.querySelector("[data-progress] > div") as HTMLElement;
    expect(Number.parseFloat(fill.style.width)).toBeGreaterThan(0);
  });

  it("stays clean (no EPG placeholder copy) when now is null", () => {
    const { container } = wrap(<ChannelCard channel={base} onPlay={() => {}} />);
    expect(container.querySelector("[data-progress]")).toBeNull();
  });
});
