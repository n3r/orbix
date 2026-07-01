import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  detectCapabilities,
  buildEncoderTestArgs,
  type CapabilityReport,
  type EncoderSetting,
} from "@orbix/core";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
// Default VAAPI render node; override with the VAAPI_DEVICE env var. This is an
// optional operational knob, not part of the validated boot Env.
const DEFAULT_VAAPI_DEVICE = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";

export interface ExecOutcome {
  code: number | "ENOENT";
  stdout: string;
  stderr: string;
}

export type ExecFileImpl = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<ExecOutcome>;

/** Real ffmpeg/ffprobe runner. Never throws — maps failures to an ExecOutcome. */
export const realExec: ExecFileImpl = async (cmd, args, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string; stderr?: string; killed?: boolean;
    };
    if (e.code === "ENOENT") return { code: "ENOENT", stdout: "", stderr: "" };
    const stderr = e.killed ? "timed out" : e.stderr ?? "";
    return { code: 1, stdout: e.stdout ?? "", stderr };
  }
};

/** Last one or two non-empty stderr lines, capped, for a compact failure reason. */
export function tailReason(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-2).join(" ");
  return tail.length > 200 ? tail.slice(0, 200) : tail;
}

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/version\s+(\S+)/i);
  return m?.[1];
}

/**
 * Scan this server's ffmpeg for encoder availability. Wires real execFile-based
 * adapters into the pure core detector; encoder tests run sequentially (core
 * awaits each) to avoid GPU contention.
 */
export async function scanTranscodeCapabilities(opts: {
  vaapiDevice?: string;
  exec?: ExecFileImpl;
  timeoutMs?: number;
} = {}): Promise<CapabilityReport> {
  const exec = opts.exec ?? realExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const vaapiDevice = opts.vaapiDevice ?? DEFAULT_VAAPI_DEVICE;

  return detectCapabilities({
    runVersion: async (bin) => {
      const out = await exec(bin, ["-version"], timeoutMs);
      if (out.code === "ENOENT") return { present: false };
      return { present: out.code === 0, version: parseVersion(out.stdout) };
    },
    runEncoderList: async () => {
      const out = await exec("ffmpeg", ["-hide_banner", "-encoders"], timeoutMs);
      return out.code === 0 ? out.stdout : "";
    },
    runEncodeTest: async (encoder: EncoderSetting) => {
      const args = buildEncoderTestArgs(encoder, { vaapiDevice });
      const out = await exec("ffmpeg", args, timeoutMs);
      if (out.code === 0) return { ok: true };
      return { ok: false, reason: tailReason(out.stderr) || "test failed" };
    },
  });
}
