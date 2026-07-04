import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@orbix/db";
import { DEFAULT_EPG_SOURCES, seedEpgSourcesForCountries } from "./tv-epg";

function fakePrisma(existingUrls: string[]) {
  const rows = new Map<string, { id: string; name: string; url: string }>(
    existingUrls.map((url, i) => [url, { id: `existing-${i}`, name: "existing", url }]),
  );
  const upserted: { name: string; url: string }[] = [];
  const prisma = {
    tvEpgSource: {
      findMany: async ({ where }: { where: { url: { in: string[] } } }) =>
        where.url.in.filter((u) => rows.has(u)).map((url) => ({ url })),
      upsert: async ({
        where,
        create,
      }: {
        where: { url: string };
        create: { name: string; url: string };
      }) => {
        upserted.push(create);
        const row = rows.get(where.url) ?? { id: `new-${rows.size}`, ...create };
        rows.set(where.url, row);
        return row;
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, upserted, rows };
}

describe("DEFAULT_EPG_SOURCES", () => {
  it("routes all CIS countries to the single iptvx.one LITE feed", () => {
    const iptvx = DEFAULT_EPG_SOURCES.find((s) => s.url === "https://epg.iptvx.one/EPG_LITE.xml.gz");
    expect(iptvx?.name).toBe("iptvx.one (RU/CIS)");
    for (const cc of ["RU", "UA", "BY", "KZ", "KG", "UZ", "AM", "GE", "AZ", "MD"]) {
      expect(iptvx?.countries).toContain(cc);
    }
  });
  it("has one epgshare01 entry per covered country (UK not GB)", () => {
    const uk = DEFAULT_EPG_SOURCES.find((s) => s.countries.length === 1 && s.countries[0] === "UK");
    expect(uk?.url).toBe("https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz");
    expect(uk?.name).toBe("epgshare01 UK");
    const covered = DEFAULT_EPG_SOURCES.filter((s) => s.countries.length === 1).map((s) => s.countries[0]);
    expect(covered.sort()).toEqual(
      ["US", "UK", "DE", "FR", "ES", "IT", "PT", "BR", "TR", "NL", "RS", "GR", "PL", "SE", "NO", "FI", "DK"].sort(),
    );
  });
});

describe("seedEpgSourcesForCountries", () => {
  it("creates one row per matching default, upserting by url", async () => {
    const { prisma, upserted } = fakePrisma([]);
    const n = await seedEpgSourcesForCountries(prisma, ["RU", "DE"]);
    expect(n).toBe(2);
    expect(upserted.map((c) => c.url).sort()).toEqual([
      "https://epg.iptvx.one/EPG_LITE.xml.gz",
      "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz",
    ].sort());
  });
  it("is idempotent: existing urls are upserted as no-ops, not counted as new", async () => {
    const { prisma, rows } = fakePrisma(["https://epg.iptvx.one/EPG_LITE.xml.gz"]);
    const n = await seedEpgSourcesForCountries(prisma, ["RU", "UA"]); // both map to the same feed
    expect(n).toBe(0);
    expect(rows.size).toBe(1); // upsert no-ops on the existing row — no duplicate
  });
  it("countries without a default create nothing", async () => {
    const { prisma, upserted } = fakePrisma([]);
    expect(await seedEpgSourcesForCountries(prisma, ["JP"])).toBe(0);
    expect(upserted).toHaveLength(0);
  });
  it("re-seeding the same countries twice stays idempotent (upsert path, no duplicate rows)", async () => {
    const { prisma, rows } = fakePrisma([]);
    const first = await seedEpgSourcesForCountries(prisma, ["RU", "DE"]);
    expect(first).toBe(2);
    const second = await seedEpgSourcesForCountries(prisma, ["RU", "DE"]);
    expect(second).toBe(0); // already seeded — upsert no-ops, nothing "new" the second time
    expect(rows.size).toBe(2); // still exactly one row per url — re-seeding created no duplicates
  });
});
