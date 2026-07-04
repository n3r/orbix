import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChannelNowNext } from "./ChannelNowNext";
import type { TvProgrammeSlot } from "@/lib/types";

const now: TvProgrammeSlot = {
  title: "Evening News",
  start: new Date(Date.now() - 30 * 60_000).toISOString(),
  stop: new Date(Date.now() + 30 * 60_000).toISOString(),
};
const next: TvProgrammeSlot = {
  title: "Weather Tonight",
  start: new Date(Date.now() + 30 * 60_000).toISOString(),
  stop: new Date(Date.now() + 60 * 60_000).toISOString(),
};

describe("ChannelNowNext", () => {
  it("shows the now title with a non-zero progress bar, plus the next title", () => {
    const { container } = render(<ChannelNowNext now={now} next={next} />);
    expect(screen.getByText("Evening News")).toBeTruthy();
    expect(screen.getByText(/Weather Tonight/)).toBeTruthy();
    const fill = container.querySelector("[data-progress] > div") as HTMLElement;
    expect(Number.parseFloat(fill.style.width)).toBeGreaterThan(0);
  });

  it("shows the noEpg copy and no next line when now is null", () => {
    render(<ChannelNowNext now={null} next={null} />);
    expect(screen.getByText("No guide data")).toBeTruthy();
    expect(screen.queryByText(/Weather Tonight/)).toBeNull();
  });

  it("still shows next even when now is null", () => {
    render(<ChannelNowNext now={null} next={next} />);
    expect(screen.getByText("No guide data")).toBeTruthy();
    expect(screen.getByText(/Weather Tonight/)).toBeTruthy();
  });
});
