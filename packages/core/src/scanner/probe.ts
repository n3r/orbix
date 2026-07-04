import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MediaFileTechnical {
  container?: string;
  videoCodec?: string;
  audioCodecs: string[];
  width?: number;
  height?: number;
  durationSec?: number;
  bitrate?: number;
  videoProfile?: string;
  videoLevel?: number;
  colorTransfer?: string;
  frameRate?: number;
  subtitleTracks: { index: number; codec?: string; language?: string; title?: string }[];
  audioTracks: { index: number; codec?: string; channels?: number; language?: string; title?: string }[];
  /** Whether ffprobe succeeded. false = empty tech from a probe failure / missing ffprobe. */
  probedOk?: boolean;
}

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  tags?: { language?: string; title?: string };
  profile?: string;
  level?: number;
  color_transfer?: string;
  r_frame_rate?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export async function probeFile(
  path: string,
  deps: { run: (path: string) => Promise<string> }
): Promise<MediaFileTechnical> {
  const raw = await deps.run(path);
  const data: FfprobeOutput = JSON.parse(raw);

  const streams = data.streams ?? [];
  const format = data.format ?? {};

  const audioCodecs: string[] = [];
  const audioTracks: MediaFileTechnical["audioTracks"] = [];
  const subtitleTracks: MediaFileTechnical["subtitleTracks"] = [];

  let videoCodec: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let videoProfile: string | undefined;
  let videoLevel: number | undefined;
  let colorTransfer: string | undefined;
  let frameRate: number | undefined;

  for (const stream of streams) {
    if (stream.codec_type === "video" && videoCodec === undefined) {
      videoCodec = stream.codec_name;
      const w = stream.width !== undefined ? Number(stream.width) : NaN;
      const h = stream.height !== undefined ? Number(stream.height) : NaN;
      if (!Number.isNaN(w)) width = w;
      if (!Number.isNaN(h)) height = h;
      if (stream.profile !== undefined) videoProfile = stream.profile;
      const lvl = stream.level !== undefined ? Number(stream.level) : NaN;
      if (!Number.isNaN(lvl)) videoLevel = lvl;
      if (stream.color_transfer !== undefined) colorTransfer = stream.color_transfer;
      if (stream.r_frame_rate) {
        const m = /^(\d+)\/(\d+)$/.exec(stream.r_frame_rate);
        if (m && Number(m[2]) > 0) {
          const fr = Math.round((Number(m[1]) / Number(m[2])) * 1000) / 1000;
          if (fr > 0) frameRate = fr;
        }
      }
    } else if (stream.codec_type === "audio") {
      if (stream.codec_name) audioCodecs.push(stream.codec_name);
      const channels = stream.channels !== undefined ? parseInt(String(stream.channels), 10) : undefined;
      audioTracks.push({
        index: stream.index,
        codec: stream.codec_name,
        channels: channels !== undefined && !Number.isNaN(channels) ? channels : undefined,
        language: stream.tags?.language,
        title: stream.tags?.title,
      });
    } else if (stream.codec_type === "subtitle") {
      subtitleTracks.push({
        index: stream.index,
        codec: stream.codec_name,
        language: stream.tags?.language,
        title: stream.tags?.title,
      });
    }
  }

  const durationRaw = format.duration !== undefined ? parseFloat(format.duration) : NaN;
  const durationSec = !Number.isNaN(durationRaw) ? Math.floor(durationRaw) : undefined;

  const bitrateRaw = format.bit_rate !== undefined ? parseInt(format.bit_rate, 10) : NaN;
  const bitrate = !Number.isNaN(bitrateRaw) ? bitrateRaw : undefined;

  const result: MediaFileTechnical = {
    audioCodecs,
    audioTracks,
    subtitleTracks,
  };

  if (format.format_name !== undefined) result.container = format.format_name;
  if (videoCodec !== undefined) result.videoCodec = videoCodec;
  if (width !== undefined) result.width = width;
  if (height !== undefined) result.height = height;
  if (durationSec !== undefined) result.durationSec = durationSec;
  if (bitrate !== undefined) result.bitrate = bitrate;
  if (videoProfile !== undefined) result.videoProfile = videoProfile;
  if (videoLevel !== undefined) result.videoLevel = videoLevel;
  if (colorTransfer !== undefined) result.colorTransfer = colorTransfer;
  if (frameRate !== undefined) result.frameRate = frameRate;

  return result;
}

export function ffprobeRunner(path: string): Promise<string> {
  return execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ]).then(({ stdout }) => stdout);
}
