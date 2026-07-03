import type { FastifyInstance } from "fastify";
import { decidePlayback, type AudioTrack, type ClientCapabilities } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { queryTokenAuth } from "../lib/device-auth";
import { activeProfile, profileAllowsItem } from "../lib/catalog-filter";
import { IMAGE_CODECS } from "./subtitles";
import type { PlaySessionRegistry } from "../playback/registry";
import type { SessionManager } from "../playback/session";

interface SubTrackJson { index: number; codec?: string; language?: string }

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseCapabilities(v: unknown): ClientCapabilities | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isStringArray(o.containers) || !isStringArray(o.videoCodecs) || !isStringArray(o.audioCodecs)) return null;
  if (typeof o.maxAudioChannels !== "number" || o.maxAudioChannels < 1) return null;
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
        const plan = decidePlayback(
          { container: file.container ?? undefined, videoCodec: file.videoCodec ?? undefined, audioTracks },
          caps,
          { audioTrackIndex },
        );

        if (plan.mode !== "direct" && !file.durationSec) {
          return reply.code(409).send({ error: "not_probed" });
        }

        const entry = deps.registry.create({
          fileId: file.id,
          inputPath: file.path,
          durationSec: file.durationSec ?? 0,
          plan,
        });

        const streamUrl =
          plan.mode === "direct"
            ? `/api/play/${file.id}/direct`
            : `/api/play/${file.id}/master.m3u8?playSessionId=${entry.playSessionId}`;

        const subs = ((file.subtitleTracks as SubTrackJson[] | null) ?? []).map((t) => {
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
