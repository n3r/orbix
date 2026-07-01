import { describe, it, expect } from "vitest";
import { parseEncoderList, buildEncoderTestArgs, ENCODER_ORDER } from "./capabilities";

const SAMPLE_ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;

describe("parseEncoderList", () => {
  it("extracts codec names after the divider and ignores headers", () => {
    const set = parseEncoderList(SAMPLE_ENCODERS);
    expect(set.has("libx264")).toBe(true);
    expect(set.has("h264_nvenc")).toBe(true);
    expect(set.has("h264_vaapi")).toBe(true);
    expect(set.has("aac")).toBe(true);
    expect(set.has("h264_qsv")).toBe(false);
    expect(set.has("Video")).toBe(false);
    expect(set.has("=")).toBe(false);
  });

  it("returns an empty set for empty input", () => {
    expect(parseEncoderList("").size).toBe(0);
  });
});

describe("buildEncoderTestArgs", () => {
  it("software uses libx264 on a lavfi testsrc to null", () => {
    const args = buildEncoderTestArgs("software", { vaapiDevice: "/dev/dri/renderD128" });
    expect(args).toContain("libx264");
    expect(args.join(" ")).toContain("-f lavfi");
    expect(args.slice(-2)).toEqual(["null", "-"]); // -f null -
    expect(args).not.toContain("-vaapi_device");
  });

  it("nvenc uses h264_nvenc without hwupload", () => {
    const args = buildEncoderTestArgs("nvenc", { vaapiDevice: "/dev/dri/renderD128" });
    expect(args).toContain("h264_nvenc");
    expect(args.join(" ")).not.toContain("hwupload");
  });

  it("vaapi sets the device and uploads frames to the GPU", () => {
    const args = buildEncoderTestArgs("vaapi", { vaapiDevice: "/dev/dri/renderD1" });
    expect(args).toContain("-vaapi_device");
    expect(args).toContain("/dev/dri/renderD1");
    expect(args.join(" ")).toContain("format=nv12,hwupload");
    expect(args).toContain("h264_vaapi");
  });

  it("qsv uploads frames to a qsv surface", () => {
    const args = buildEncoderTestArgs("qsv", { vaapiDevice: "/dev/dri/renderD128" });
    expect(args.join(" ")).toContain("hwupload=extra_hw_frames=64,format=qsv");
    expect(args).toContain("h264_qsv");
  });

  it("ENCODER_ORDER matches the settings dropdown order", () => {
    expect(ENCODER_ORDER).toEqual(["software", "vaapi", "qsv", "nvenc"]);
  });
});
