import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import type { PrismaClient } from "@orbix/db";
import {
  createXmltvCollector,
  matchEpgChannels,
  normalizeChannelName,
  type XmltvChannelName,
  type XmltvProgramme,
} from "@orbix/core";

export const EPG_WINDOW_BACK_MS = 6 * 60 * 60 * 1000; // now − 6 h
export const EPG_WINDOW_FWD_MS = 48 * 60 * 60 * 1000; // now + 48 h
const BATCH = 500;

export interface TvEpgDeps {
  fetchUpstream: (
    url: string,
    opts: { userAgent?: string; referrer?: string; wantText: boolean; timeoutMs?: number },
  ) => Promise<{ finalUrl: string; status: number; headers: Record<string, string>; body: unknown; text?: string }>;
  now?: () => Date;
  onProgress?: (p: { source: string; processed: number }) => void;
}

export interface TvEpgResult {
  sources: number;
  programmesUpserted: number;
  channelsMatchedByName: number;
  pruned: number;
  errors: string[];
}

function isGzUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith(".gz");
  } catch {
    return url.endsWith(".gz");
  }
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as { getReader?: unknown }).getReader === "function") {
    return Readable.fromWeb(body as never);
  }
  throw new Error("unsupported upstream body type");
}

type Row = { channelId: string; p: XmltvProgramme };

async function upsertBatch(prisma: PrismaClient, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  await prisma.$transaction(
    rows.map(({ channelId, p }) =>
      prisma.tvProgramme.upsert({
        where: { channelId_start: { channelId, start: p.start } },
        update: { stop: p.stop, title: p.title, description: p.description, category: p.category, lang: p.lang },
        create: {
          channelId,
          start: p.start,
          stop: p.stop,
          title: p.title,
          description: p.description,
          category: p.category,
          lang: p.lang,
        },
      }),
    ),
  );
  return rows.length;
}

/**
 * Ingest every enabled TvEpgSource: stream the XMLTV download through gunzip
 * (when .gz) into the pure core collector, in ONE pass per source:
 *   - programmes for direct epgIds are flushed in batches of 500 as they stream;
 *   - channel display-names are collected, and any xmltv id whose name collides
 *     with one of our channel names is admitted into the live wantedIds set
 *     (XMLTV orders <channel> before <programme>, so nothing is missed);
 *   - after parsing, matchEpgChannels decides the unique name-based mapping and
 *     the buffered candidate rows are flushed through it.
 * Serving stays Postgres-only; this job is the only XML touchpoint.
 */
export async function runTvEpgSync(prisma: PrismaClient, deps: TvEpgDeps): Promise<TvEpgResult> {
  const now = deps.now ? deps.now() : new Date();
  const windowStart = new Date(now.getTime() - EPG_WINDOW_BACK_MS);
  const windowEnd = new Date(now.getTime() + EPG_WINDOW_FWD_MS);
  const result: TvEpgResult = { sources: 0, programmesUpserted: 0, channelsMatchedByName: 0, pruned: 0, errors: [] };

  const channels = await prisma.tvChannel.findMany({
    select: { id: true, epgId: true, name: true, altNames: true },
  });
  if (channels.length === 0) return result;

  // Direct epgId → channelId[] (several channels/sources can share an epgId).
  const direct = new Map<string, string[]>();
  for (const ch of channels) {
    if (!ch.epgId) continue;
    const list = direct.get(ch.epgId) ?? [];
    list.push(ch.id);
    direct.set(ch.epgId, list);
  }
  // Normalized DB names — used to admit candidate xmltv ids during the stream.
  const dbNames = new Set<string>();
  for (const ch of channels) {
    for (const n of [ch.name, ...ch.altNames]) {
      const key = normalizeChannelName(n);
      if (key) dbNames.add(key);
    }
  }
  const chById = new Map(channels.map((c) => [c.id, c]));

  const sources = await prisma.tvEpgSource.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });

  for (const source of sources) {
    result.sources++;
    await prisma.tvEpgSource.update({
      where: { id: source.id },
      data: { status: "syncing", statusMessage: null },
    });
    try {
      const res = await deps.fetchUpstream(source.url, { wantText: false, timeoutMs: 30_000 });
      if (res.status !== 200) throw new Error(`upstream responded ${res.status}`);

      const wanted = new Set(direct.keys()); // LIVE set — candidates admitted below
      const xmltvChannels: XmltvChannelName[] = [];
      const directRows: Row[] = [];
      const candidateRows: XmltvProgramme[] = []; // ids admitted by name collision
      let processed = 0;

      const collector = createXmltvCollector({
        wantedIds: wanted,
        offsetMin: source.offsetMin,
        windowStart,
        windowEnd,
        onChannel: (c) => {
          xmltvChannels.push(c);
          // Admit colliding ids so their rows are captured in THIS pass; the
          // final unique mapping is decided by matchEpgChannels afterwards.
          if (!wanted.has(c.id) && c.names.some((n) => dbNames.has(normalizeChannelName(n)))) {
            wanted.add(c.id);
          }
        },
        onProgramme: (p) => {
          const chIds = direct.get(p.epgId);
          if (chIds) {
            for (const channelId of chIds) directRows.push({ channelId, p });
          } else {
            candidateRows.push(p); // resolved after the full channel list is known
          }
        },
      });

      const raw = toNodeReadable(res.body);
      const stream = isGzUrl(source.url) || isGzUrl(res.finalUrl) ? raw.pipe(createGunzip()) : raw;
      const decoder = new TextDecoder("utf-8"); // stream:true → multibyte-safe across chunks
      for await (const chunk of stream) {
        collector.write(decoder.decode(chunk as Buffer, { stream: true }));
        while (directRows.length >= BATCH) {
          processed += await upsertBatch(prisma, directRows.splice(0, BATCH));
          deps.onProgress?.({ source: source.name, processed });
        }
      }
      const tail = decoder.decode();
      if (tail) collector.write(tail);
      collector.end();
      processed += await upsertBatch(prisma, directRows.splice(0));

      // Name-based mapping for channels whose epgId found no direct rows.
      // NOTE (v1): an xmltv id that is ALSO some channel's direct epgId only
      // feeds that channel this run — its rows were flushed live, not buffered.
      const byXmltvId = new Map<string, string[]>();
      for (const [chId, xid] of matchEpgChannels(channels, xmltvChannels)) {
        if (chById.get(chId)?.epgId === xid) continue; // pass-1 → already direct
        result.channelsMatchedByName++;
        const list = byXmltvId.get(xid) ?? [];
        list.push(chId);
        byXmltvId.set(xid, list);
      }
      const matchedRows: Row[] = [];
      for (const p of candidateRows) {
        for (const channelId of byXmltvId.get(p.epgId) ?? []) matchedRows.push({ channelId, p });
      }
      while (matchedRows.length > 0) {
        processed += await upsertBatch(prisma, matchedRows.splice(0, BATCH));
      }
      result.programmesUpserted += processed;
      deps.onProgress?.({ source: source.name, processed });

      await prisma.tvEpgSource.update({
        where: { id: source.id },
        data: { status: "ok", statusMessage: null, lastSyncAt: now },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${source.name}: ${message}`);
      await prisma.tvEpgSource.update({
        where: { id: source.id },
        data: { status: "error", statusMessage: message.slice(0, 500) },
      });
    }
  }

  const pruned = await prisma.tvProgramme.deleteMany({ where: { stop: { lt: windowStart } } });
  result.pruned = pruned.count;
  return result;
}
