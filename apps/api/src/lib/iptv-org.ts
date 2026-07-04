import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import {
  getSetting,
  setSetting,
  type IptvOrgChannel,
  type IptvOrgFeed,
  type IptvOrgLogo,
  type IptvOrgStream,
} from "@orbix/core";

const API_BASE = "https://iptv-org.github.io/api";

/** Injected IO so unit tests never touch network, disk, or the DB. */
export interface IptvOrgDeps {
  fetchImpl: typeof fetch;
  readEtag: (file: string) => Promise<string | null>;
  writeEtag: (file: string, etag: string) => Promise<void>;
  readCache: (file: string) => Promise<string | null>;
  writeCache: (file: string, text: string) => Promise<void>;
}

/**
 * Conditional GET of one iptv-org API file. Upstream rebuilds daily (~00:32
 * UTC) and serves ETags: a 304 short-circuits to the parsed on-disk cache; a
 * 304 against a lost cache falls back to one unconditional refetch.
 */
export async function fetchIptvOrgFile<T>(file: string, deps: IptvOrgDeps): Promise<T> {
  const url = `${API_BASE}/${file}`;
  const etag = await deps.readEtag(file);
  let res = await deps.fetchImpl(url, etag ? { headers: { "if-none-match": etag } } : undefined);
  if (res.status === 304) {
    const cached = await deps.readCache(file);
    if (cached != null) return JSON.parse(cached) as T;
    res = await deps.fetchImpl(url); // cache lost — refetch unconditionally
  }
  if (!res.ok) throw new Error(`iptv-org fetch failed: HTTP ${res.status} for ${file}`);
  const text = await res.text();
  await deps.writeCache(file, text);
  const newTag = res.headers.get("etag");
  if (newTag) await deps.writeEtag(file, newTag);
  return JSON.parse(text) as T;
}

export interface IptvOrgCatalog {
  channels: IptvOrgChannel[];
  feeds: IptvOrgFeed[];
  streams: IptvOrgStream[];
  logos: IptvOrgLogo[];
  blocklist: { channel: string }[];
}

/** The five catalog files, fetched in parallel (each ETag-conditional). */
export async function fetchIptvOrgCatalog(deps: IptvOrgDeps): Promise<IptvOrgCatalog> {
  const [channels, feeds, streams, logos, blocklist] = await Promise.all([
    fetchIptvOrgFile<IptvOrgChannel[]>("channels.json", deps),
    fetchIptvOrgFile<IptvOrgFeed[]>("feeds.json", deps),
    fetchIptvOrgFile<IptvOrgStream[]>("streams.json", deps),
    fetchIptvOrgFile<IptvOrgLogo[]>("logos.json", deps),
    fetchIptvOrgFile<{ channel: string }[]>("blocklist.json", deps),
  ]);
  return { channels, feeds, streams, logos, blocklist };
}

/** Real adapters: ETags in Setting rows (`tvSync:etag:<file>`), bodies on disk. */
export function buildIptvOrgDeps(app: FastifyInstance, env: Env): IptvOrgDeps {
  const cacheDir = path.join(env.METADATA_DIR, "tv", "iptv-org");
  const read = (k: string) => app.prisma.setting.findUnique({ where: { key: k } });
  const write = async (k: string, v: unknown) => {
    await app.prisma.setting.upsert({
      where: { key: k },
      create: { key: k, value: v as object },
      update: { value: v as object },
    });
  };
  return {
    fetchImpl: fetch,
    readEtag: async (file) =>
      (await getSetting<string>(`tvSync:etag:${file}`, { fallback: "", read })) || null,
    writeEtag: (file, etag) => setSetting(`tvSync:etag:${file}`, etag, { write }),
    readCache: async (file) => {
      try {
        return await fs.promises.readFile(path.join(cacheDir, file), "utf8");
      } catch {
        return null;
      }
    },
    writeCache: async (file, text) => {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(path.join(cacheDir, file), text, "utf8");
    },
  };
}
