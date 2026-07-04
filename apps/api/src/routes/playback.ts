import type { FastifyInstance } from "fastify";
import {
  decidePlayback,
  computeSegmentBoundaries,
  buildPlaybackQualities,
  findPlaybackQuality,
  type AudioTrack,
  type ClientCapabilities,
  type PlaybackAudioMode,
  type PlaybackPlan,
  type PlaybackQuality,
  type SegmentBoundary,
} from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { queryTokenAuth } from "../lib/device-auth";
import { activeProfile, profileAllowsItem } from "../lib/catalog-filter";
import { IMAGE_CODECS } from "./subtitles";
import type { PlaySessionRegistry } from "../playback/registry";
import type { SessionManager } from "../playback/session";

interface SubTrackJson { index: number; codec?: string; language?: string; title?: string }

/** Human-readable label for a subtitle track (title tag > language > index). */
function subtitleLabel(t: SubTrackJson): string {
  if (t.title?.trim()) return t.title.trim();
  if (t.language?.trim()) return t.language.trim().toUpperCase();
  return `Track ${t.index}`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

function parseCapabilities(v: unknown): ClientCapabilities | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isStringArray(o.containers) || !isStringArray(o.videoCodecs) || !isStringArray(o.audioCodecs)) return null;
  if (typeof o.maxAudioChannels !== "number" || !Number.isInteger(o.maxAudioChannels) || o.maxAudioChannels < 1) return null;
  return {
    containers: o.containers,
    videoCodecs: o.videoCodecs,
    audioCodecs: o.audioCodecs,
    maxAudioChannels: o.maxAudioChannels,
    hlsMultichannelAacBroken: o.hlsMultichannelAacBroken === true,
    subtitleDelivery: o.subtitleDelivery === "sidecar" ? "sidecar" : "hls",
  };
}

function parseAudioMode(v: unknown): PlaybackAudioMode {
  return v === "leveled" ? "leveled" : "standard";
}

/** The audio modes a client may pick (mirrors the ffargs `leveled` filter). */
const AUDIO_MODES = [
  { id: "standard", label: "Standard" },
  { id: "leveled", label: "Leveling" },
] as const;

/**
 * Audio decision for a plan that must be upgraded off direct play (a quality
 * downscale or loudness leveling forces re-encoding the container). Mirrors the
 * audio branch of `decidePlayback`: a direct file's audio codec is already
 * client-compatible, so copy it — but re-encode multichannel AAC that MSE
 * can't append (the HLS-broken-multichannel quirk).
 */
function directPlayAudio(
  track: AudioTrack | undefined,
  caps: ClientCapabilities,
): { audioAction: "copy" | "aac"; audioChannels: number } {
  const channels = track?.channels ?? 2;
  const mustReencode =
    caps.hlsMultichannelAacBroken === true && track?.codec === "aac" && channels > 2;
  return mustReencode
    ? { audioAction: "aac", audioChannels: Math.max(1, Math.min(channels, caps.maxAudioChannels)) }
    : { audioAction: "copy", audioChannels: channels };
}

export default function playbackRoute(deps: { registry: PlaySessionRegistry; manager: SessionManager }) {
  return async function (app: FastifyInstance) {
    app.post<{
      Body: {
        fileId?: unknown;
        capabilities?: unknown;
        audioTrackIndex?: unknown;
        quality?: unknown;
        audioMode?: unknown;
      };
    }>(
      "/playback/info",
      { preHandler: requireAuth(app) },
      async (req, reply) => {
        const fileId = req.body?.fileId;
        const caps = parseCapabilities(req.body?.capabilities);
        const rawIdx = req.body?.audioTrackIndex;
        const audioTrackIndex =
          rawIdx === undefined ? 0 : typeof rawIdx === "number" && Number.isInteger(rawIdx) && rawIdx >= 0 ? rawIdx : null;
        const rawQuality = typeof req.body?.quality === "string" ? req.body.quality : undefined;
        const audioMode = parseAudioMode(req.body?.audioMode);
        if (typeof fileId !== "string" || !caps || audioTrackIndex === null) {
          return reply.code(400).send({ error: "invalid" });
        }

        const [file, profile] = await Promise.all([
          app.prisma.mediaFile.findUnique({
            where: { id: fileId },
            select: {
              id: true, path: true, container: true, videoCodec: true,
              durationSec: true, audioTracks: true, subtitleTracks: true,
              keyframes: true, width: true, height: true, bitrate: true,
              videoProfile: true, videoLevel: true, colorTransfer: true, frameRate: true,
              mediaItem: { select: { rating: true } },
            },
          }),
          activeProfile(app, req),
        ]);

        if (!file) return reply.code(404).send({ error: "not_found" });
        // Kids gate: 404 (not 403) so blocked titles don't leak existence.
        if (!profileAllowsItem(profile, { rating: file.mediaItem.rating })) {
          return reply.code(404).send({ error: "not_found" });
        }

        const audioTracks = ((file.audioTracks as AudioTrack[] | null) ?? []);
        if (audioTrackIndex > 0 && audioTrackIndex >= audioTracks.length) {
          return reply.code(400).send({ error: "invalid" });
        }
        let plan = decidePlayback(
          { container: file.container ?? undefined, videoCodec: file.videoCodec ?? undefined, audioTracks },
          caps,
          { audioTrackIndex },
        );

        // Quality ladder + audio mode. Qualities are derived from the source
        // dimensions/bitrate; the client re-negotiates with a `quality`/
        // `audioMode` to switch (each choice mints a fresh play session).
        const qualities = buildPlaybackQualities({
          width: file.width,
          height: file.height,
          bitrate: file.bitrate,
        });
        const quality: PlaybackQuality = findPlaybackQuality(qualities, rawQuality ?? "source") ?? qualities[0];
        const downscale = quality.id !== "source" && quality.targetVideoBitrate != null;

        // A manual downscale re-encodes video → force transcode; loudness
        // leveling re-encodes audio → a direct file must at least remux (video
        // still copies). Both upgrades carry a coherent audio decision so the
        // session's ffmpeg args stay valid.
        if (downscale && plan.mode !== "transcode") {
          const audio =
            "audioAction" in plan
              ? { audioAction: plan.audioAction, audioChannels: plan.audioChannels }
              : directPlayAudio(audioTracks[audioTrackIndex], caps);
          plan = { mode: "transcode", ...audio, audioTrackIndex } as PlaybackPlan;
        } else if (audioMode === "leveled" && plan.mode === "direct") {
          const audio = directPlayAudio(audioTracks[audioTrackIndex], caps);
          plan = { mode: "remux", ...audio, audioTrackIndex } as PlaybackPlan;
        }

        // durationSec is required from here on (computeSegmentBoundaries needs
        // it), so this gate must run before any keyframe-awareness logic.
        if (plan.mode !== "direct" && !file.durationSec) {
          return reply.code(409).send({ error: "not_probed" });
        }

        // Keyframe-awareness: a remux plan needs an exact keyframe index to
        // build spec-accurate EXTINFs (declared segment durations must match
        // real segment content, or AVPlayer stalls/misbehaves). Without one,
        // downgrade to transcode instead — forced keyframes at the segment
        // cadence make ITS fixed-cadence EXTINFs exact — and kick off a
        // best-effort background extraction so the NEXT negotiation remuxes.
        let boundaries: SegmentBoundary[] | null = null;
        let forceKeyframes = false;
        if (plan.mode === "remux") {
          const keyframes = file.keyframes as number[] | null;
          if (Array.isArray(keyframes) && keyframes.length > 0) {
            boundaries = computeSegmentBoundaries(keyframes, file.durationSec ?? 0, 6);
          } else {
            plan = {
              mode: "transcode",
              audioAction: plan.audioAction,
              audioTrackIndex: plan.audioTrackIndex,
              audioChannels: plan.audioChannels,
            };
            forceKeyframes = true;
            // Fire-and-forget: must never fail or slow this request. Errors
            // (including a bogus/unreachable Redis) just mean the file stays
            // on the transcode path until a future scan retries the enqueue.
            void app.keyframesQueue?.add("keyframes", { fileId: file.id }, { jobId: file.id }).catch((err) => {
              app.log.warn({ err }, "keyframes enqueue failed");
            });
          }
        } else if (plan.mode === "transcode") {
          forceKeyframes = true;
        }

        const rawSubtitleTracks = (file.subtitleTracks as SubTrackJson[] | null) ?? [];

        const entry = deps.registry.create({
          fileId: file.id,
          inputPath: file.path,
          durationSec: file.durationSec ?? 0,
          plan,
          quality,
          audioMode,
          boundaries,
          forceKeyframes,
          // The master playlist emits subtitle renditions unless the client
          // opted into sidecar delivery (the web player, which adds its own
          // <Track>s and would otherwise show duplicate subtitle menus).
          subtitleRenditions: caps.subtitleDelivery !== "sidecar",
          media: {
            width: file.width,
            height: file.height,
            bitrate: file.bitrate,
            videoProfile: file.videoProfile,
            videoLevel: file.videoLevel,
            colorTransfer: file.colorTransfer,
            frameRate: file.frameRate,
            videoCodec: file.videoCodec,
            container: file.container,
            audioCodec: audioTracks[audioTrackIndex]?.codec,
            subtitleTracks: rawSubtitleTracks.map((t) => ({ index: t.index, codec: t.codec, language: t.language })),
          },
        });

        let streamUrl =
          plan.mode === "direct"
            ? `/api/play/${file.id}/direct`
            : `/api/play/${file.id}/master.m3u8?playSessionId=${entry.playSessionId}`;

        // Device clients authenticate this negotiation with a bearer token (or
        // ?token=) but the returned URL is followed verbatim by a native
        // player with no header/cookie support — embed the token so the
        // subsequent master.m3u8 / direct fetch doesn't 401.
        if (req.deviceId) {
          const auth = req.headers.authorization;
          const raw = auth?.startsWith("Bearer ") ? auth.slice(7) : (req.query as { token?: string } | undefined)?.token;
          if (typeof raw === "string" && raw.length > 0) {
            streamUrl += plan.mode === "direct" ? `?token=${encodeURIComponent(raw)}` : `&token=${encodeURIComponent(raw)}`;
          }
        }

        const subs = rawSubtitleTracks.map((t) => {
          const available = !IMAGE_CODECS.has(t.codec ?? "");
          return {
            index: t.index,
            codec: t.codec,
            language: t.language,
            label: subtitleLabel(t),
            available,
            ...(available ? {} : { reason: "image_based" as const }),
          };
        });

        return {
          playSessionId: entry.playSessionId,
          mode: plan.mode,
          streamUrl,
          container: file.container,
          videoCodec: file.videoCodec,
          quality: quality.id,
          audioMode,
          qualities: qualities.map((q) => ({
            id: q.id,
            label: q.label,
            width: q.width,
            height: q.height,
            bandwidth: q.bandwidth,
          })),
          audioModes: AUDIO_MODES.map((m) => ({ id: m.id, label: m.label })),
          audioTracks: audioTracks.map((t, i) => ({
            index: i,
            codec: t.codec,
            channels: t.channels,
            language: t.language,
            selected: i === audioTrackIndex,
          })),
          subtitleTracks: subs,
        };
      },
    );

    // ------------------------------------------------------------------
    // POST /playback/:playSessionId/stop — tear down a play session early.
    // Idempotent (navigator.sendBeacon retries, and the player may call this
    // more than once) and accepts an empty body (sendBeacon sends none).
    // Any authenticated household caller may stop a session; playSessionIds are unguessable UUIDs (single-household trust model).
    // ------------------------------------------------------------------
    app.post<{ Params: { playSessionId: string } }>(
      "/playback/:playSessionId/stop",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req) => {
        const { playSessionId } = req.params;
        deps.registry.delete(playSessionId);
        await deps.manager.remove(playSessionId);
        return { ok: true };
      },
    );
  };
}
