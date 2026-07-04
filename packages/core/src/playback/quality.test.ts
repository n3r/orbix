import { describe, expect, it } from "vitest";
import { buildPlaybackQualities, findPlaybackQuality, isPlaybackQualityId } from "./quality";

describe("buildPlaybackQualities", () => {
  it("builds an adaptive ladder below a 4K source", () => {
    const qualities = buildPlaybackQualities({ width: 3840, height: 2160, bitrate: 24_000_000 });

    expect(qualities.map((q) => q.id)).toEqual(["source", "1080p", "720p", "480p"]);
    expect(qualities[0]).toMatchObject({
      id: "source",
      label: "Original (2160p)",
      width: 3840,
      height: 2160,
      bandwidth: 24_000_000,
      targetVideoBitrate: null,
    });
    expect(qualities[1]).toMatchObject({
      id: "1080p",
      width: 1920,
      height: 1080,
      targetVideoBitrate: 5_000_000,
    });
  });

  it("omits duplicate-or-higher renditions for a 720p source", () => {
    const qualities = buildPlaybackQualities({ width: 1280, height: 720 });

    expect(qualities.map((q) => q.id)).toEqual(["source", "480p"]);
    expect(qualities[1]).toMatchObject({ width: 854, height: 480 });
  });

  it("keeps only Original when the source dimensions are unknown", () => {
    expect(buildPlaybackQualities({}).map((q) => q.id)).toEqual(["source"]);
  });

  it("validates and finds quality ids", () => {
    const qualities = buildPlaybackQualities({ width: 1920, height: 1080 });

    expect(isPlaybackQualityId("720p")).toBe(true);
    expect(isPlaybackQualityId("bogus")).toBe(false);
    expect(findPlaybackQuality(qualities, "720p")?.height).toBe(720);
    expect(findPlaybackQuality(qualities, "1080p")).toBeNull();
  });
});
