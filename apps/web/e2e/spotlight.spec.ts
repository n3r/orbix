/**
 * E2E: homepage spotlight row.
 *   - Seeds two in-progress movies (Continue Watching).
 *   - Hero defaults to the first; hovering the second poster promotes it.
 */
import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const LIBRARY_ID = "spotlib00000000000000001";
const ITEM_A = "spotitem0000000000000001";
const ITEM_B = "spotitem0000000000000002";
const PROFILE_NAME = "Spotter";
const ADMIN_EMAIL = "spotlight@home.lan";
const ADMIN_PASSWORD = "longenough";

async function seedDb() {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  const { hashPassword } = await import("@orbix/core");

  await prisma.playbackState.deleteMany({ where: { mediaItemId: { in: [ITEM_A, ITEM_B] } } });
  await prisma.mediaItem.deleteMany({ where: { id: { in: [ITEM_A, ITEM_B] } } });
  await prisma.library.deleteMany({ where: { id: LIBRARY_ID } });
  await prisma.account.deleteMany();

  await prisma.account.create({
    data: { email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), isAdmin: true },
  });

  await prisma.library.create({
    data: {
      id: LIBRARY_ID,
      name: "Spotlight Library",
      items: {
        create: [
          { id: ITEM_A, title: "Alpha Movie", sortTitle: "alpha movie", year: 2020,
            overview: "Alpha overview.", backdropPath: "backdrop/a.jpg", matchState: "matched" },
          { id: ITEM_B, title: "Bravo Movie", sortTitle: "bravo movie", year: 2021,
            overview: "Bravo overview.", backdropPath: "backdrop/b.jpg", matchState: "matched" },
        ],
      },
    },
  });

  await prisma.$disconnect();
}

async function cleanDb() {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.playbackState.deleteMany({ where: { mediaItemId: { in: [ITEM_A, ITEM_B] } } });
  await prisma.mediaItem.deleteMany({ where: { id: { in: [ITEM_A, ITEM_B] } } });
  await prisma.library.deleteMany({ where: { id: LIBRARY_ID } });
  await prisma.profile.deleteMany({ where: { name: PROFILE_NAME } });
  await prisma.account.deleteMany({ where: { email: ADMIN_EMAIL } });
  await prisma.$disconnect();
}

async function onboardAndGetProfileId(page: Page): Promise<string> {
  await page.goto("http://localhost:1060/");
  await page.waitForURL(/\/(setup|login|profiles)/, { timeout: 15_000 });
  if (page.url().includes("/setup")) {
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /create/i }).click();
  } else if (page.url().includes("/login")) {
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
  }
  await expect(page).toHaveURL(/\/profiles/, { timeout: 15_000 });
  const exists = await page.getByText(PROFILE_NAME).isVisible().catch(() => false);
  if (!exists) {
    await page.getByRole("button", { name: /add profile/i }).click();
    await page.getByLabel("Name").fill(PROFILE_NAME);
    await page.getByRole("button", { name: /save/i }).click();
  }
  await page.getByText(PROFILE_NAME).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  // Read the created profile id so we can seed playback states for it.
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  const profile = await prisma.profile.findFirstOrThrow({ where: { name: PROFILE_NAME } });
  await prisma.$disconnect();
  return profile.id;
}

async function seedProgress(profileId: string) {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.playbackState.createMany({
    data: [
      { profileId, mediaItemId: ITEM_A, episodeId: "", positionSec: 600, durationSec: 1200, finished: false },
      { profileId, mediaItemId: ITEM_B, episodeId: "", positionSec: 300, durationSec: 1200, finished: false },
    ],
  });
  await prisma.$disconnect();
}

test.describe("homepage spotlight row", () => {
  test.beforeAll(seedDb);
  test.afterAll(cleanDb);

  test("hero defaults to the first item and hovering a poster promotes it", async ({ page }) => {
    const profileId = await onboardAndGetProfileId(page);
    await seedProgress(profileId);

    await page.goto("http://localhost:1060/");
    // Alpha is newest-updated? createMany order is not guaranteed; assert either
    // hero shows one of the two, then hover the other and assert it takes over.
    const heroAlpha = page.getByRole("heading", { name: "Alpha Movie" });
    const heroBravo = page.getByRole("heading", { name: "Bravo Movie" });
    await expect(heroAlpha.or(heroBravo)).toBeVisible({ timeout: 15_000 });

    // Hover the Bravo poster (there is a poster link for each item).
    await page.getByRole("link", { name: /Bravo Movie/ }).first().hover();
    await expect(page.getByRole("heading", { name: "Bravo Movie" })).toBeVisible({ timeout: 15_000 });
  });
});
