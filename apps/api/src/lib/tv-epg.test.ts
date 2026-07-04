import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@orbix/db";
import { DEFAULT_EPG_SOURCES, seedEpgSourcesForCountries } from "./tv-epg";

function fakePrisma(existingUrls: string[]) {
  const created: { name: string; url: string }[] = [];
  const prisma = {
    tvEpgSource: {
      findFirst: async ({ where }: { where: { url: string } }) =>
        existingUrls.includes(where.url) ? { id: "e1", url: where.url } : null,
      create: async ({ data }: { data: { name: string; url: string } }) => {
        created.push(data);
        return { id: `new-${created.length}`, ...data };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, created };
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
    const { prisma, created } = fakePrisma([]);
    const n = await seedEpgSourcesForCountries(prisma, ["RU", "DE"]);
    expect(n).toBe(2);
    expect(created.map((c) => c.url).sort()).toEqual([
      "https://epg.iptvx.one/EPG_LITE.xml.gz",
      "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz",
    ].sort());
  });
  it("is idempotent: existing urls are not recreated", async () => {
    const { prisma, created } = fakePrisma(["https://epg.iptvx.one/EPG_LITE.xml.gz"]);
    const n = await seedEpgSourcesForCountries(prisma, ["RU", "UA"]); // both map to the same feed
    expect(n).toBe(0);
    expect(created).toHaveLength(0);
  });
  it("countries without a default create nothing", async () => {
    const { prisma, created } = fakePrisma([]);
    expect(await seedEpgSourcesForCountries(prisma, ["JP"])).toBe(0);
    expect(created).toHaveLength(0);
  });
});
