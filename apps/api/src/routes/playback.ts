import type { FastifyInstance } from "fastify";
import {
  decidePlayback,
  computeSegmentBoundaries,
  type AudioTrack,
  type ClientCapabilities,
  type SegmentBoundary,
} from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { queryTokenAuth } from "../lib/device-auth";
import { activeProfile, profileAllowsItem } from "../lib/catalog-filter";
import { IMAGE_CODECS } from "./subtitles";
import type { PlaySessionRegistry } from "../playback/registry";
import type { SessionManager } from "../playback/session";

interface SubTrackJson { index: number; codec?: string; language?: string }

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
  };
}

export default function playbackRoute(deps: { registry: PlaySessionRegistry; manager: SessionManager }) {
  return async function (app: FastifyInstance) {
    app.post<{ Body: { fileId?: unknown; capabilities?: unknown; audioTrackIndex?: unknown } }>(
      "/playback/info",
      { preHandler: requireAuth(app) },
      async (req, reply) => {
        const fileId = req.body?.fileId;
        const caps = parseCapabilities(req.body?.capabilities);
        const rawIdx = req.body?.audioTrackIndex;
        const audioTrackIndex =
          rawIdx === undefined ? 0 : typeof rawIdx === "number" && Number.isInteger(rawIdx) && rawIdx >= 0 ? rawIdx : null;
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
          boundaries,
          forceKeyframes,
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
