import type { PrismaClient } from "@orbix/db";

const CIS = ["RU", "UA", "BY", "KZ", "KG", "UZ", "AM", "GE", "AZ", "MD"];
// iptv-org country codes (their countries.json is authoritative — "UK" not "GB").
const EPGSHARE_COUNTRIES = [
  "US", "UK", "DE", "FR", "ES", "IT", "PT", "BR", "TR",
  "NL", "RS", "GR", "PL", "SE", "NO", "FI", "DK",
];

/** Default XMLTV feeds seeded when an iptv-org country is enabled. */
export const DEFAULT_EPG_SOURCES: { countries: string[]; name: string; url: string }[] = [
  { countries: CIS, name: "iptvx.one (RU/CIS)", url: "https://epg.iptvx.one/EPG_LITE.xml.gz" },
  ...EPGSHARE_COUNTRIES.map((cc) => ({
    countries: [cc],
    name: `epgshare01 ${cc}`,
    url: `https://epgshare01.online/epgshare01/epg_ripper_${cc}1.xml.gz`,
  })),
];

/**
 * Upsert-by-url the default EPG sources covering the given country codes.
 * Never deletes or disables anything the admin already configured.
 *
 * `url` is a DB-level unique constraint (`TvEpgSource_url_key`), so each
 * upsert is create-if-absent / no-op if present — idempotent and
 * concurrency-safe with no findFirst-then-create TOCTOU window.
 *
 * Returns the number of rows newly created, determined by a single
 * `findMany` pre-check before upserting. Under a concurrent double-seed race
 * this count can be an approximation (two callers may both see a url as
 * "new"), but the DB rows themselves are always correctly deduplicated
 * regardless of what this count reports.
 */
export async function seedEpgSourcesForCountries(
  prisma: PrismaClient,
  countries: string[],
): Promise<number> {
  const wanted = DEFAULT_EPG_SOURCES.filter((s) => s.countries.some((c) => countries.includes(c)));
  if (wanted.length === 0) return 0;
  const existing = await prisma.tvEpgSource.findMany({
    where: { url: { in: wanted.map((s) => s.url) } },
    select: { url: true },
  });
  const existingUrls = new Set(existing.map((e) => e.url));
  for (const s of wanted) {
    await prisma.tvEpgSource.upsert({
      where: { url: s.url },
      create: { name: s.name, url: s.url },
      update: {},
    });
  }
  return wanted.filter((s) => !existingUrls.has(s.url)).length;
}
