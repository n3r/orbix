import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

// ── Run serially so test 1 (setup) doesn't race test 2 (login) ───────────────
test.describe.configure({ mode: "serial" });

// ── Seed constants ────────────────────────────────────────────────────────────
const LIBRARY_ID = "seedlibrary00000000000001";
const SECTION_ID = "seedsection0000000000001";
const ITEM_ID = "seeditem000000000000000001";
const ADMIN_EMAIL = "libtest@home.lan";
const ADMIN_PASSWORD = "longenough";
const METADATA_DIR = process.env.METADATA_DIR ?? "./data/metadata";
const POSTER_REL = "poster/seed.jpg";
const POSTER_ABS = path.resolve(METADATA_DIR, POSTER_REL);

// Minimal valid 1×1 JPEG (44 bytes — smallest possible valid JPEG)
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy" +
  "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEB" +
  "AxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAA" +
  "AAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABmX/9k=",
  "base64",
);

// ── DB helpers ────────────────────────────────────────────────────────────────

async function seedDb() {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");

  // Clean any leftover rows from a previous failed run
  await prisma.mediaItem.deleteMany({ where: { id: ITEM_ID } });
  await prisma.section.deleteMany({ where: { id: SECTION_ID } });
  await prisma.library.deleteMany({ where: { id: LIBRARY_ID } });

  await prisma.library.create({
    data: {
      id: LIBRARY_ID,
      name: "Seed Library",
      sections: {
        create: {
          id: SECTION_ID,
          name: "Seed Section",
          order: 0,
          items: {
            create: {
              id: ITEM_ID,
              title: "Seeded Movie",
              sortTitle: "seeded movie",
              year: 2020,
              overview: "A seeded overview for testing.",
              posterPath: POSTER_REL,
              matchState: "matched",
            },
          },
        },
      },
    },
  });

  // Write tiny poster JPEG so /api/images/poster/seed.jpg serves it
  await fs.promises.mkdir(path.dirname(POSTER_ABS), { recursive: true });
  await fs.promises.writeFile(POSTER_ABS, TINY_JPEG);

  await prisma.$disconnect();
}

async function cleanDb() {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");

  await prisma.mediaItem.deleteMany({ where: { id: ITEM_ID } });
  await prisma.section.deleteMany({ where: { id: SECTION_ID } });
  await prisma.library.deleteMany({ where: { id: LIBRARY_ID } });
  // Remove the admin account created by this spec's onboarding
  await prisma.profile.deleteMany();
  await prisma.account.deleteMany({ where: { email: ADMIN_EMAIL } });
  await prisma.$disconnect();

  // Remove poster file
  try {
    fs.unlinkSync(POSTER_ABS);
  } catch {
    // ignore if already gone
  }
}

// ── Auth helper ───────────────────────────────────────────────────────────────
// Drives the onboarding flow to get an authenticated session cookie.
// Handles two cases:
//   1. Fresh DB (setup not done)  → runs full setup → creates profile → selects it
//   2. Already set up (test 2+)   → logs in → selects existing profile

async function doOnboarding(page: Page) {
  // The home page redirects based on state. In the SPA this redirect happens
  // client-side (after the guard's async queries), so wait with an auto-retrying
  // assertion until we actually land on an unauthenticated screen — a plain
  // waitForURL matching "/" would resolve before the client redirect fires.
  await page.goto("http://localhost:1060/");
  await expect(page).toHaveURL(/\/(setup|login)$/, { timeout: 15_000 });

  if (page.url().includes("/setup")) {
    // Case 1: brand-new — run setup
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /create/i }).click();
    await expect(page).toHaveURL(/\/profiles/, { timeout: 15_000 });

    // Create a profile so the profile-select screen works
    await page.getByRole("button", { name: /add profile/i }).click();
    await page.getByLabel("Name").fill("Tester");
    await page.getByRole("button", { name: /save/i }).click();
  } else if (page.url().includes("/login")) {
    // Case 2: already set up — log in
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/profiles/, { timeout: 15_000 });
  }

  // Select the profile (both cases land on /profiles)
  await page.waitForURL(/\/(profiles|$)/, { timeout: 15_000 });
  if (page.url().includes("/profiles")) {
    await page.getByText("Tester").click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Library browse + title detail", () => {
  test.beforeAll(async () => {
    await seedDb();
  });

  test.afterAll(async () => {
    await cleanDb();
  });

  test("library grid shows seeded movie", async ({ page }) => {
    await doOnboarding(page);
    await page.goto(`http://localhost:1060/library/${SECTION_ID}`);
    await expect(page.getByText("Seeded Movie")).toBeVisible({ timeout: 15_000 });
  });

  test("title detail shows overview", async ({ page }) => {
    await doOnboarding(page);
    await page.goto(`http://localhost:1060/title/${ITEM_ID}`);
    await expect(
      page.getByText("A seeded overview for testing."),
    ).toBeVisible({ timeout: 15_000 });
  });
});
