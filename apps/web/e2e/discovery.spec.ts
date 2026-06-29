/**
 * E2E: Natural-language search — constraint path (deterministic, no model needed).
 *
 * Seeds 3 items:
 *   - "Short Comedy Film"   — Comedy, 95 min (5 700 s), 2018
 *   - "Classic Comedy Film" — Comedy, 100 min (6 000 s), 1980
 *   - "Epic Drama Film"     — Drama, 180 min (10 800 s), 1995
 *
 * Query "comedy under 2 hours" (runtimeMaxSec = 7 200, genre = Comedy):
 *   - Both comedies should appear (5 700 ≤ 7 200, 6 000 ≤ 7 200).
 *   - The drama must be absent (10 800 > 7 200, wrong genre too).
 *
 * Auth approach (mirrors playback.spec.ts):
 *   - Seed creates media items only (no account) so as not to complete "setup"
 *     before library.spec.ts or onboarding.spec.ts get a chance to run.
 *   - doOnboarding creates the account on-demand:
 *       /setup → via setup API (first to run);
 *       /login → via direct Prisma create (another spec ran setup first).
 */

import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// ── Seed constants ────────────────────────────────────────────────────────────
const LIBRARY_ID = "disclib0000000000000000001";
const SECTION_ID = "discsect000000000000000001";
const COMEDY_SHORT_ID = "discitem000000000000000001"; // 95 min, Comedy, 2018
const COMEDY_LONG_ID = "discitem000000000000000002"; // 100 min, Comedy, 1980
const DRAMA_LONG_ID = "discitem000000000000000003"; // 180 min, Drama, 1995

const ADMIN_EMAIL = "disctest@home.lan";
const ADMIN_PASSWORD = "longenough";

// ── DB helpers ────────────────────────────────────────────────────────────────

async function seedDb() {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");

  // Clean any leftovers from a previous failed run (media items only)
  await prisma.embedding.deleteMany({
    where: { mediaItemId: { in: [COMEDY_SHORT_ID, COMEDY_LONG_ID, DRAMA_LONG_ID] } },
  });
  await prisma.mediaItem.deleteMany({
    where: { id: { in: [COMEDY_SHORT_ID, COMEDY_LONG_ID, DRAMA_LONG_ID] } },
  });
  await prisma.section.deleteMany({ where: { id: SECTION_ID } });
  await prisma.library.deleteMany({ where: { id: LIBRARY_ID } });

  // NOTE: We intentionally do NOT create an account here.
  // Creating an account in beforeAll would make isSetupComplete() return true
  // before library.spec.ts or onboarding.spec.ts can do their own setup,
  // breaking those tests. Account creation happens lazily in doOnboarding().

  // Upsert genres (unique by name)
  const [comedyGenre, dramaGenre] = await Promise.all([
    prisma.genre.upsert({
      where: { name: "Comedy" },
      create: { name: "Comedy" },
      update: {},
    }),
    prisma.genre.upsert({
      where: { name: "Drama" },
      create: { name: "Drama" },
      update: {},
    }),
  ]);

  // Create library → section → items with MediaItemGenre associations
  await prisma.library.create({
    data: {
      id: LIBRARY_ID,
      name: "Discovery Test Library",
      sections: {
        create: {
          id: SECTION_ID,
          name: "Discovery Test Section",
          order: 0,
          items: {
            create: [
              {
                id: COMEDY_SHORT_ID,
                title: "Short Comedy Film",
                sortTitle: "short comedy film",
                year: 2018,
                runtimeSec: 95 * 60, // 5 700 s
                matchState: "matched",
                genres: { create: [{ genreId: comedyGenre.id }] },
              },
              {
                id: COMEDY_LONG_ID,
                title: "Classic Comedy Film",
                sortTitle: "classic comedy film",
                year: 1980,
                runtimeSec: 100 * 60, // 6 000 s
                matchState: "matched",
                genres: { create: [{ genreId: comedyGenre.id }] },
              },
              {
                id: DRAMA_LONG_ID,
                title: "Epic Drama Film",
                sortTitle: "epic drama film",
                year: 1995,
                runtimeSec: 180 * 60, // 10 800 s  — exceeds 2 h cap
                matchState: "matched",
                genres: { create: [{ genreId: dramaGenre.id }] },
              },
            ],
          },
        },
      },
    },
  });

  await prisma.$disconnect();
}

async function cleanDb() {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");

  await prisma.embedding.deleteMany({
    where: { mediaItemId: { in: [COMEDY_SHORT_ID, COMEDY_LONG_ID, DRAMA_LONG_ID] } },
  });
  await prisma.mediaItem.deleteMany({
    where: { id: { in: [COMEDY_SHORT_ID, COMEDY_LONG_ID, DRAMA_LONG_ID] } },
  });
  await prisma.section.deleteMany({ where: { id: SECTION_ID } });
  await prisma.library.deleteMany({ where: { id: LIBRARY_ID } });
  // Only delete our own profile — do not wipe profiles from other specs.
  await prisma.profile.deleteMany({ where: { name: "Searcher" } });
  await prisma.account.deleteMany({ where: { email: ADMIN_EMAIL } });
  await prisma.$disconnect();
}

// ── Onboarding helper ─────────────────────────────────────────────────────────
// Handles two scenarios without interfering with other parallel specs:
//
//   /setup  → create our account via the setup API (we are first).
//   /login  → another spec already ran setup; create our account directly in
//             the DB (bypassing the setup wizard that only allows one admin)
//             then log in.  This mirrors the approach in playback.spec.ts.

async function doOnboarding(page: Page) {
  await page.goto("http://localhost:1060/");
  await page.waitForURL(/\/(setup|login|profiles|$)/, { timeout: 15_000 });

  if (page.url().includes("/setup")) {
    // We are the first spec to run — create our account via the setup wizard.
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /create/i }).click();
    await expect(page).toHaveURL(/\/profiles/, { timeout: 15_000 });
  } else if (page.url().includes("/login")) {
    // Another spec already ran setup.  Create our account directly in the DB
    // (same technique as playback.spec.ts) then log in normally.
    process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
    const { prisma } = await import("@orbix/db");
    const { hashPassword } = await import("@orbix/core");
    await prisma.account.deleteMany({ where: { email: ADMIN_EMAIL } });
    await prisma.account.create({
      data: { email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), isAdmin: true },
    });
    await prisma.$disconnect();

    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/profiles/, { timeout: 15_000 });
  }

  // Create "Searcher" profile if absent, then select it
  await page.waitForURL(/\/(profiles|$)/, { timeout: 15_000 });
  if (page.url().includes("/profiles")) {
    const profileText = page.getByText("Searcher");
    if (!(await profileText.isVisible())) {
      await page.getByRole("button", { name: /add profile/i }).click();
      await page.getByLabel("Name").fill("Searcher");
      await page.getByRole("button", { name: /save/i }).click();
    }
    await page.getByText("Searcher").click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("NL search — constraint path", () => {
  test.beforeAll(async () => {
    await seedDb();
  });

  test.afterAll(async () => {
    await cleanDb();
  });

  test("'comedy under 2 hours' returns both comedies and excludes the long drama", async ({
    page,
  }) => {
    await doOnboarding(page);

    await page.goto("http://localhost:1060/search");

    // Fill query and submit
    const input = page.getByPlaceholder(/e\.g\./i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill("comedy under 2 hours");
    await page.getByRole("button", { name: /^search$/i }).click();

    // Both comedies must appear in results
    await expect(page.getByText("Short Comedy Film")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Classic Comedy Film")).toBeVisible({ timeout: 15_000 });

    // The 180-min drama must NOT be present (excluded by both runtime and genre filters)
    await expect(page.getByText("Epic Drama Film")).not.toBeVisible();
  });
});
