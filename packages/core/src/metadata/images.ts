import path from "node:path";

export type ImageKind = "poster" | "backdrop" | "logo" | "still";

interface ImageDeps {
  fetchImpl: typeof fetch;
  writeFile: (absPath: string, data: Uint8Array) => Promise<void>;
  exists: (absPath: string) => Promise<boolean>;
  baseDir: string;
  size?: string;
}

const DEFAULT_SIZE: Record<ImageKind, string> = {
  poster: "w500",
  backdrop: "w1280",
  // Logos are transparent PNGs — w500 keeps the alpha channel and is plenty for
  // a hero title treatment while staying small on disk.
  logo: "w500",
  still: "w300",
};

/**
 * Cache an image served by TMDB's image CDN, keyed by its tmdbPath basename.
 * Returns the metadata-relative path (e.g. "poster/abc.jpg") for storage.
 */
export async function cacheImage(
  tmdbPath: string,
  kind: ImageKind,
  deps: ImageDeps,
): Promise<string> {
  const rel = `${kind}/${path.basename(tmdbPath)}`;
  const abs = path.join(deps.baseDir, rel);

  if (await deps.exists(abs)) {
    return rel;
  }

  const size = deps.size ?? DEFAULT_SIZE[kind];
  const url = `https://image.tmdb.org/t/p/${size}${tmdbPath}`;
  await fetchAndWrite(url, abs, deps);
  return rel;
}

/**
 * Cache an image from an absolute URL (e.g. fanart.tv logo art) under the given
 * image kind, using the URL's basename as the filename. Returns the
 * metadata-relative path for storage.
 */
export async function cacheImageFromUrl(
  url: string,
  kind: ImageKind,
  deps: Omit<ImageDeps, "size">,
): Promise<string> {
  const base = path.basename(new URL(url).pathname) || `${kind}.img`;
  const rel = `${kind}/${base}`;
  const abs = path.join(deps.baseDir, rel);

  if (await deps.exists(abs)) {
    return rel;
  }
  await fetchAndWrite(url, abs, deps);
  return rel;
}

async function fetchAndWrite(
  url: string,
  abs: string,
  deps: { fetchImpl: typeof fetch; writeFile: (a: string, d: Uint8Array) => Promise<void> },
): Promise<void> {
  const res = await deps.fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Image fetch failed: ${res.status} for ${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await deps.writeFile(abs, bytes);
}
