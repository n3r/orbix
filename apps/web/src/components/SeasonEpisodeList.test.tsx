import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SeasonEpisodeList from "./SeasonEpisodeList";
import type { SeasonSummary } from "@/lib/types";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const seasons: SeasonSummary[] = [
  { seasonNumber: 0, name: "Specials", episodeCount: 2, posterPath: null },
  { seasonNumber: 1, name: "Season 1", episodeCount: 9, posterPath: null },
  { seasonNumber: 2, name: "Season 2", episodeCount: 8, posterPath: null },
];

describe("SeasonEpisodeList", () => {
  it("renders a season tab per season, defaulting to the first non-specials season", () => {
    wrap(
      <SeasonEpisodeList seriesId="s1" seasons={seasons} onPlayEpisode={() => {}} playFirstToken={0} />,
    );
    expect(screen.getByText("Episodes")).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    const active = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(active?.textContent).toBe("Season 1");
  });

  it("renders nothing when there are no seasons", () => {
    const { container } = wrap(
      <SeasonEpisodeList seriesId="s1" seasons={[]} onPlayEpisode={() => {}} playFirstToken={0} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
