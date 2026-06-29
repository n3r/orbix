import path from "node:path";

export type ImageKind = "poster" | "backdrop";

export async function cacheImage(
  tmdbPath: string,
  kind: ImageKind,
  deps: {
    fetchImpl: typeof fetch;
    writeFile: (absPath: string, data: Uint8Array) => Promise<void>;
    exists: (absPath: string) => Promise<boolean>;
    baseDir: string;
    size?: string;
  },
): Promise<string> {
  const rel = `${kind}/${path.basename(tmdbPath)}`;
  const abs = path.join(deps.baseDir, rel);

  if (await deps.exists(abs)) {
    return rel;
  }

  const size = deps.size ?? (kind === "poster" ? "w500" : "w1280");
  const url = `https://image.tmdb.org/t/p/${size}${tmdbPath}`;
  const res = await deps.fetchImpl(url);

  if (!res.ok) {
    throw new Error(`Image fetch failed: ${res.status} for ${url}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  await deps.writeFile(abs, bytes);
  return rel;
}
