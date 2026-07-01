import { describe, it, expect } from "vitest";
import { scanTranscodeCapabilities, tailReason, realExec, type ExecOutcome } from "./transcode-capabilities";

const ENCODER_STDOUT =
  "Encoders:\n ------\n V....D libx264 x\n V....D h264_nvenc x\n V....D h264_vaapi x\n V....D h264_qsv x\n";

/** Build a fake exec that branches on the ffmpeg invocation. */
function fakeExec(opts: {
  ffmpegPresent?: boolean;
  ffprobePresent?: boolean;
  failEncoders?: EncoderKey[];
}) {
  const fail = new Set(opts.failEncoders ?? []);
  return async (cmd: string, args: string[]): Promise<ExecOutcome> => {
    if (args.includes("-version")) {
      const present = cmd === "ffmpeg" ? opts.ffmpegPresent ?? true : opts.ffprobePresent ?? true;
      return present
        ? { code: 0, stdout: `${cmd} version 6.1 Copyright`, stderr: "" }
        : { code: "ENOENT", stdout: "", stderr: "" };
    }
    if (args.includes("-encoders")) {
      return { code: 0, stdout: ENCODER_STDOUT, stderr: "" };
    }
    // a test-encode: identify the codec from -c:v
    const codec = args[args.indexOf("-c:v") + 1];
    const codecToKey: Record<string, EncoderKey> = {
      libx264: "software", h264_vaapi: "vaapi", h264_qsv: "qsv", h264_nvenc: "nvenc",
    };
    const key = codecToKey[codec];
    return fail.has(key)
      ? { code: 1, stdout: "", stderr: `line1\nError: ${key} device missing\n` }
      : { code: 0, stdout: "", stderr: "" };
  };
}
type EncoderKey = "software" | "vaapi" | "qsv" | "nvenc";

describe("tailReason", () => {
  it("keeps the last non-empty lines and caps length", () => {
    expect(tailReason("a\nb\nError: boom\n")).toBe("b Error: boom");
    expect(tailReason("")).toBe("");
    expect(tailReason("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe("realExec", () => {
  it("maps a missing binary to code ENOENT", async () => {
    const out = await realExec("orbix-nonexistent-binary-xyz", ["-x"], 5000);
    expect(out.code).toBe("ENOENT");
  });

  it("maps a non-zero exit to code 1 with stderr captured", async () => {
    const out = await realExec(
      "node",
      ["-e", "console.error('boom'); process.exit(3)"],
      5000,
    );
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("boom");
  });

  it(
    "maps a timed-out child to code 1 with a 'timed out' reason",
    async () => {
      const out = await realExec(
        "node",
        ["-e", "setTimeout(()=>{}, 10000)"],
        100,
      );
      expect(out.code).toBe(1);
      expect(out.stderr).toBe("timed out");
    },
    10000,
  );
});

describe("scanTranscodeCapabilities", () => {
  it("reports every listed encoder that passes as available", async () => {
    const report = await scanTranscodeCapabilities({ exec: fakeExec({}) });
    expect(report.ffmpeg).toEqual({ present: true, version: "6.1" });
    expect(report.encoders.every((e) => e.available)).toBe(true);
  });

  it("marks a failing encoder unavailable with a stderr-tail reason", async () => {
    const report = await scanTranscodeCapabilities({ exec: fakeExec({ failEncoders: ["vaapi"] }) });
    const vaapi = report.encoders.find((e) => e.key === "vaapi")!;
    expect(vaapi.available).toBe(false);
    expect(vaapi.reasonCode).toBe("test_failed");
    expect(vaapi.reason).toContain("device missing");
    expect(report.encoders.find((e) => e.key === "software")!.available).toBe(true);
  });

  it("reports ffmpeg absent and no available encoders when the binary is missing", async () => {
    const report = await scanTranscodeCapabilities({ exec: fakeExec({ ffmpegPresent: false }) });
    expect(report.ffmpeg.present).toBe(false);
    expect(report.encoders.some((e) => e.available)).toBe(false);
  });

  it("passes the vaapi device into the test-encode args", async () => {
    let sawDevice = "";
    const exec = async (cmd: string, args: string[]): Promise<ExecOutcome> => {
      if (args.includes("-vaapi_device")) sawDevice = args[args.indexOf("-vaapi_device") + 1];
      if (args.includes("-version")) return { code: 0, stdout: "v 6.1", stderr: "" };
      if (args.includes("-encoders")) return { code: 0, stdout: ENCODER_STDOUT, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await scanTranscodeCapabilities({ exec, vaapiDevice: "/dev/dri/renderD42" });
    expect(sawDevice).toBe("/dev/dri/renderD42");
  });
});
