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
 * Returns the number of rows created.
 */
export async function seedEpgSourcesForCountries(
  prisma: PrismaClient,
  countries: string[],
): Promise<number> {
  const wanted = DEFAULT_EPG_SOURCES.filter((s) => s.countries.some((c) => countries.includes(c)));
  let created = 0;
  for (const s of wanted) {
    const existing = await prisma.tvEpgSource.findFirst({ where: { url: s.url } });
    if (existing) continue;
    await prisma.tvEpgSource.create({ data: { name: s.name, url: s.url } });
    created++;
  }
  return created;
}
