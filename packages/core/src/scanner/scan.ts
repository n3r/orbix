import { parseMediaPath } from "./parse";
import type { MediaFileTechnical } from "./probe";

export interface ScanResult {
  added: number;
  updated: number;
  skipped: number;
  itemIds: string[];
}

export interface ScanDeps {
  listFiles: (root: string) => Promise<{ path: string; mtime: Date; size: number }[]>;
  probe: (path: string) => Promise<MediaFileTechnical>;
  findFileByPath: (path: string) => Promise<{ mtime: Date | null; size: number | null } | null>;
  upsertItemAndFile: (input: {
    sectionId: string;
    file: { path: string; mtime: Date; size: number };
    parsed: ReturnType<typeof parseMediaPath>;
    tech: MediaFileTechnical;
  }) => Promise<{ itemId: string; created: boolean }>;
}

export async function scanSource(
  opts: { sectionId: string; root: string },
  deps: ScanDeps
): Promise<ScanResult> {
  const files = await deps.listFiles(opts.root);

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const seenItemIds = new Set<string>();
  const itemIds: string[] = [];

  for (const file of files) {
    const existing = await deps.findFileByPath(file.path);

    const unchanged =
      existing !== null &&
      existing.mtime !== null &&
      existing.size !== null &&
      existing.mtime.getTime() === file.mtime.getTime() &&
      existing.size === file.size;

    if (unchanged) {
      skipped++;
      continue;
    }

    const parsed = parseMediaPath(file.path);
    const tech = await deps.probe(file.path);
    const { itemId, created } = await deps.upsertItemAndFile({
      sectionId: opts.sectionId,
      file,
      parsed,
      tech,
    });

    if (created) {
      added++;
    } else {
      updated++;
    }

    if (!seenItemIds.has(itemId)) {
      seenItemIds.add(itemId);
      itemIds.push(itemId);
    }
  }

  return { added, updated, skipped, itemIds };
}
