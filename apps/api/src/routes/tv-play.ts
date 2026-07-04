import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  orderStreams,
  rewritePlaylist,
  signProxyPayload,
  verifyProxyPayload,
  encodeUpstream,
  decodeUpstream,
} from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { requireTvAccess } from "../lib/tv-access";
import { makeTvUpstream, type TvUpstream, type UpstreamResult } from "../lib/tv-upstream";
import { loadNowNext } from "../lib/tv-now-next";
import { nextStreamHealth } from "../lib/tv-health-state";

const MAX_SOURCES = 3;

interface StreamRow {
  id: string;
  url: string;
  referrer: string | null;
  userAgent: string | null;
  status: string;
  failCount: number;
}

/**
 * Live-TV playback: tune endpoint + signed HLS proxy + player health feedback.
 * Every route sits behind requireAuth + requireTvAccess (kids → 403, spec §Kids).
 * The proxy only fetches URLs the server itself minted while rewriting
 * playlists (HMAC over streamId|url with SESSION_SECRET) — see core tv/proxy.
 */
export default function tvPlayRoute(
  env: { SESSION_SECRET: string },
  deps?: { upstream?: TvUpstream },
) {
  return async function (app: FastifyInstance) {
    const upstream = deps?.upstream ?? makeTvUpstream();
    app.addHook("onClose", async () => {
      await upstream.close();
    });

    const guards = { preHandler: [requireAuth(app), requireTvAccess(app)] };

    const toProxy = (streamId: string) => (absUrl: string, kind: "playlist" | "bytes") =>
      `/api/tv/proxy/${streamId}/${kind === "playlist" ? "p" : "s"}` +
      `?u=${encodeUpstream(absUrl)}&sig=${signProxyPayload(env.SESSION_SECRET, streamId, absUrl)}`;

    /** Load a proxyable stream row; sends 404 and returns null when absent/hidden. */
    async function loadStream(streamId: string, reply: FastifyReply): Promise<StreamRow | null> {
      const stream = await app.prisma.tvStream.findUnique({
        where: { id: streamId },
        select: {
          id: true,
          url: true,
          referrer: true,
          userAgent: true,
          status: true,
          failCount: true,
          channel: { select: { hidden: true } },
        },
      });
      if (!stream || stream.channel.hidden) {
        void reply.code(404).send({ error: "not_found" });
        return null;
      }
      return stream;
    }

    /** failCount++ with degraded/dead thresholds (proxy-side upstream failures). */
    async function bumpFailure(stream: { id: string; failCount: number; status: string }) {
      const next = nextStreamHealth(stream, false);
      await app.prisma.tvStream.update({
        where: { id: stream.id },
        data: { ...next, lastCheckAt: new Date() },
      });
    }

    /** Verify the u/sig pair for a stream; sends 403 and returns null on failure. */
    function verifiedTarget(
      streamId: string,
      query: { u?: string; sig?: string },
      reply: FastifyReply,
    ): string | null {
      const target = query.u ? decodeUpstream(query.u) : null;
      if (!target || !query.sig || !verifyProxyPayload(env.SESSION_SECRET, streamId, target, query.sig)) {
        void reply.code(403).send({ error: "bad_sig" });
        return null;
      }
      return target;
    }

    // ------------------------------------------------------------------
    // GET /tv/channels/:id/play — ordered proxied sources for a channel
    // ------------------------------------------------------------------
    app.get<{ Params: { id: string } }>("/tv/channels/:id/play", guards, async (req, reply) => {
      const channel = await app.prisma.tvChannel.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          number: true,
          name: true,
          logoPath: true,
          country: true,
          quality: true,
          hidden: true,
          streams: {
            select: { id: true, quality: true, label: true, priority: true, protocol: true, status: true },
          },
        },
      });
      if (!channel || channel.hidden) return reply.code(404).send({ error: "not_found" });

      const ordered = orderStreams(channel.streams);
      if (ordered.length === 0) return reply.code(409).send({ error: "no_playable_stream" });

      const nowNext = (await loadNowNext(app.prisma, [channel.id])).get(channel.id) ?? { now: null, next: null };

      return {
        channel: {
          id: channel.id,
          number: channel.number,
          name: channel.name,
          logo: channel.logoPath ? `/api/images/${channel.logoPath}` : null,
          country: channel.country,
          quality: channel.quality,
        },
        nowNext,
        sources: ordered.slice(0, MAX_SOURCES).map((s) => ({
          streamId: s.id,
          src: `/api/tv/proxy/${s.id}/index.m3u8`,
          quality: s.quality,
          label: s.label,
        })),
      };
    });

    // ------------------------------------------------------------------
    // GET /tv/proxy/:streamId/index.m3u8 — entry playlist (stream's own URL)
    // ------------------------------------------------------------------
    app.get<{ Params: { streamId: string } }>(
      "/tv/proxy/:streamId/index.m3u8",
      guards,
      async (req, reply) => {
        const stream = await loadStream(req.params.streamId, reply);
        if (!stream) return;

        let result: UpstreamResult;
        try {
          result = await upstream.fetchUpstream(stream.url, {
            userAgent: stream.userAgent,
            referrer: stream.referrer,
            wantText: true,
          });
        } catch {
          await bumpFailure(stream);
          return reply.code(502).send({ error: "upstream_unreachable" });
        }
        if (result.status !== 200) {
          await bumpFailure(stream);
          return reply.code(502).send({ error: `upstream_${result.status}` });
        }

        const rewritten = rewritePlaylist(result.text ?? "", result.finalUrl, toProxy(stream.id));
        return reply
          .code(200)
          .header("content-type", "application/vnd.apple.mpegurl")
          .header("cache-control", "no-store")
          .send(rewritten);
      },
    );

    // ------------------------------------------------------------------
    // GET /tv/proxy/:streamId/p — nested playlists (variants, alt media)
    // ------------------------------------------------------------------
    app.get<{ Params: { streamId: string }; Querystring: { u?: string; sig?: string } }>(
      "/tv/proxy/:streamId/p",
      guards,
      async (req, reply) => {
        const stream = await loadStream(req.params.streamId, reply);
        if (!stream) return;
        const target = verifiedTarget(stream.id, req.query, reply);
        if (!target) return;

        let result: UpstreamResult;
        try {
          result = await upstream.fetchUpstream(target, {
            userAgent: stream.userAgent,
            referrer: stream.referrer,
            wantText: true,
          });
        } catch {
          return reply.code(502).send({ error: "upstream_unreachable" });
        }
        if (result.status !== 200) return reply.code(502).send({ error: `upstream_${result.status}` });

        // Rewrite against THIS playlist's final URL (redirect-hop safe).
        const rewritten = rewritePlaylist(result.text ?? "", result.finalUrl, toProxy(stream.id));
        return reply
          .code(200)
          .header("content-type", "application/vnd.apple.mpegurl")
          .header("cache-control", "no-store")
          .send(rewritten);
      },
    );

    // ------------------------------------------------------------------
    // GET /tv/proxy/:streamId/s — opaque bytes: segments, init sections, keys
    // ------------------------------------------------------------------
    app.get<{ Params: { streamId: string }; Querystring: { u?: string; sig?: string } }>(
      "/tv/proxy/:streamId/s",
      guards,
      async (req, reply) => {
        const stream = await loadStream(req.params.streamId, reply);
        if (!stream) return;
        const target = verifiedTarget(stream.id, req.query, reply);
        if (!target) return;

        let result: UpstreamResult;
        try {
          result = await upstream.fetchUpstream(target, {
            userAgent: stream.userAgent,
            referrer: stream.referrer,
            wantText: false,
          });
        } catch {
          return reply.code(502).send({ error: "upstream_unreachable" });
        }
        if (result.status !== 200 || !result.body) {
          return reply.code(502).send({ error: `upstream_${result.status}` });
        }

        // Pure pass-through (Threadfin lesson: never buffer in-process).
        // Hijack so Fastify leaves the raw response to us (SSE-route pattern).
        reply.hijack();
        const raw = reply.raw;
        const headers: Record<string, string> = { "cache-control": "no-store" };
        const ct = result.headers["content-type"];
        if (ct) headers["content-type"] = ct;
        const cl = result.headers["content-length"];
        if (cl) headers["content-length"] = cl;
        raw.writeHead(200, headers);

        const body = Readable.fromWeb(result.body as NodeWebReadableStream<Uint8Array>);
        body.pipe(raw); // backpressure via the pipe
        body.on("error", () => raw.destroy());
        raw.on("close", () => body.destroy());
      },
    );

    // ------------------------------------------------------------------
    // POST /tv/streams/:id/health — player health feedback
    // ------------------------------------------------------------------
    app.post<{ Params: { id: string }; Body: { ok?: boolean; code?: string } | null }>(
      "/tv/streams/:id/health",
      guards,
      async (req, reply) => {
        const stream = await app.prisma.tvStream.findUnique({
          where: { id: req.params.id },
          select: { id: true, status: true, failCount: true },
        });
        if (!stream) return reply.code(404).send({ error: "not_found" });

        const now = new Date();
        if (req.body?.ok === true) {
          const next = nextStreamHealth(stream, true);
          await app.prisma.tvStream.update({
            where: { id: stream.id },
            data: { ...next, lastOkAt: now, lastCheckAt: now },
          });
        } else {
          if (req.body?.code) req.log.info({ streamId: stream.id, code: req.body.code }, "tv stream failure reported");
          const next = nextStreamHealth(stream, false);
          await app.prisma.tvStream.update({
            where: { id: stream.id },
            data: { ...next, lastCheckAt: now },
          });
        }
        return { ok: true };
      },
    );
  };
}
