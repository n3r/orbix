import { test, expect, type Page } from "@playwright/test";

// TV phase-3 e2e: nav visibility per profile kind, /tv empty state, admin TV
// account surfaces. Runs against the throwaway e2e DB (global-setup wipes it);
// zero channels are imported so no external network is ever touched.
//
// Each Playwright test gets its own fresh browser context (no persisted
// cookies), so every test (re)authenticates via login() below before doing
// anything else — same idiom as library.spec.ts / playback.spec.ts's
// doOnboarding(). DB state (accounts/profiles), unlike cookies, persists
// across tests in this file.

const ADMIN_EMAIL = "tv@home.lan";
const ADMIN_PASSWORD = "longenough";

test.afterAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.profile.deleteMany();
  await prisma.account.deleteMany();
  await prisma.$disconnect();
});

// Runs first-time setup (test 1, fresh DB → lands on /setup) or logs in
// (tests 2+, the account already exists → lands on /login) and lands on
// /profiles either way.
async function login(page: Page) {
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
}

test("standard profile sees the TV nav and the /tv empty state", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: /add profile/i }).click();
  await page.getByLabel("Name").fill("Adult");
  await page.getByRole("button", { name: /save/i }).click();
  await page.getByText("Adult").click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("banner").getByRole("link", { name: "TV" }).click();
  await expect(page).toHaveURL(/\/tv/);
  await expect(page.getByTestId("tv-empty-state")).toBeVisible(); // added in Task 8 Step 5.5
});

test("kids profile has no TV nav and /tv degrades gracefully", async ({ page }) => {
  // ProfilesPage's "add profile" form always POSTs kind:"standard" — there is
  // no UI control on this branch to create a kids-kind profile (confirmed
  // against apps/web/src/pages/ProfilesPage.tsx: the request body hardcodes
  // `kind`, with no selector for it in the form). Seed it directly via Prisma
  // instead, the same way sibling specs seed state the UI itself can't
  // produce (billboard.spec.ts / discovery.spec.ts seed playback/media rows
  // directly rather than through a form).
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.profile.create({ data: { name: "Kiddo", kind: "kids", maturityCap: 3 } });
  await prisma.$disconnect();

  await login(page);
  await page.getByText("Kiddo").click();
  await expect(page).toHaveURL(/\/$/);

  // UI assertions only: no TV entry in the nav…
  await expect(page.getByRole("banner").getByRole("link", { name: "TV" })).toHaveCount(0);
  // …and direct navigation degrades gracefully rather than crashing. The
  // server 403s GET /tv/home for kids profiles (requireTvAccess, covered by
  // tv-catalog.test.ts); TvHomePage doesn't special-case that error — its
  // query error-fallback renders the same generic empty shell it would show
  // for a genuinely empty catalog (data ?? {…empty…}), so tv-empty-state is
  // present either way. That's a graceful (if imprecise) degradation: no
  // crash, no leaked channel content. The load-bearing kids-specific client
  // check for this spec is the nav assertion above.
  await page.goto("http://localhost:1060/tv");
  await expect(page.getByTestId("tv-empty-state")).toBeVisible();
});

test("admin account TV tab renders sources, EPG and channel-manager sections", async ({ page }) => {
  // Back to the standard (PIN-less) profile.
  await login(page);
  await page.getByText("Adult").click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("http://localhost:1060/account/tv");
  await expect(page.getByRole("heading", { name: "EPG sources" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Channel manager" })).toBeVisible();
  // Empty-list copy proves the queries resolved (local API only).
  await expect(page.getByText(/No EPG sources yet/i)).toBeVisible();
});
