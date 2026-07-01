import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EncoderCapabilityList from "./EncoderCapabilityList";
import type { CapabilityReport } from "@orbix/core";

const report: CapabilityReport = {
  ffmpeg: { present: true, version: "6.1" },
  ffprobe: { present: true, version: "6.1" },
  encoders: [
    { key: "software", codec: "libx264", listed: true, available: true },
    { key: "vaapi", codec: "h264_vaapi", listed: false, available: false, reasonCode: "not_built_in" },
    { key: "qsv", codec: "h264_qsv", listed: true, available: false, reasonCode: "test_failed", reason: "qsv device missing" },
    { key: "nvenc", codec: "h264_nvenc", listed: true, available: true },
  ],
};

describe("EncoderCapabilityList", () => {
  it("renders a status for every encoder and marks the current one", () => {
    render(<EncoderCapabilityList report={report} current="nvenc" />);
    expect(screen.getByText("Software (libx264)")).toBeTruthy();
    expect(screen.getAllByText("Available")).toHaveLength(2);
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getByText(/current/)).toBeTruthy();
  });

  it("shows the localized reason and the stderr detail on failures", () => {
    render(<EncoderCapabilityList report={report} current="software" />);
    expect(screen.getByText("Not built into ffmpeg on this server")).toBeTruthy();
    expect(screen.getByText(/qsv device missing/)).toBeTruthy();
  });

  it("shows the ffmpeg/ffprobe footer when both are present", () => {
    render(<EncoderCapabilityList report={report} current="software" />);
    expect(screen.getByText(/ffmpeg 6\.1/)).toBeTruthy();
  });

  it("warns when ffmpeg is missing", () => {
    const missing: CapabilityReport = {
      ffmpeg: { present: false },
      ffprobe: { present: false },
      encoders: report.encoders.map((e) => ({
        ...e,
        available: false,
        listed: false,
        reasonCode: "ffmpeg_not_found" as const,
      })),
    };
    render(<EncoderCapabilityList report={missing} current="software" />);
    expect(screen.getByText(/was not found on the server PATH/)).toBeTruthy();
  });
});
