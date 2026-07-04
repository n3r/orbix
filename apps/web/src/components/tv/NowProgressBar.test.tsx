import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { NowProgressBar } from "./NowProgressBar";

function fillOf(container: HTMLElement) {
  return container.querySelector("[data-progress] > div") as HTMLElement;
}

describe("NowProgressBar", () => {
  it("renders a partial width for a slot in progress", () => {
    const start = new Date(Date.now() - 30 * 60_000).toISOString();
    const stop = new Date(Date.now() + 30 * 60_000).toISOString();
    const { container } = render(<NowProgressBar start={start} stop={stop} />);
    const fill = fillOf(container);
    expect(fill).toBeTruthy();
    const pct = Number.parseFloat(fill.style.width);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
  });

  it("clamps to 0% for a slot that hasn't started yet", () => {
    const start = new Date(Date.now() + 60 * 60_000).toISOString();
    const stop = new Date(Date.now() + 120 * 60_000).toISOString();
    const { container } = render(<NowProgressBar start={start} stop={stop} />);
    expect(fillOf(container).style.width).toBe("0%");
  });

  it("clamps to 100% for a slot that already ended", () => {
    const start = new Date(Date.now() - 120 * 60_000).toISOString();
    const stop = new Date(Date.now() - 60 * 60_000).toISOString();
    const { container } = render(<NowProgressBar start={start} stop={stop} />);
    expect(fillOf(container).style.width).toBe("100%");
  });
});
