import { test, expect } from "@playwright/test";

// This spec creates the first admin via the setup wizard. Clean it up so it
// doesn't leave a second admin behind — the DB now enforces a single admin
// (partial unique index on isAdmin), which a later spec's create() would hit.
test.afterAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.profile.deleteMany();
  await prisma.account.deleteMany();
  await prisma.$disconnect();
});

test("first run: setup -> create profile -> select", async ({ page }) => {
  await page.goto("http://localhost:1060/");
  // fresh DB redirects to /setup
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel("Email").fill("me@home.lan");
  await page.getByLabel("Password").fill("longenough");
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/profiles/);
  await page.getByRole("button", { name: /add profile/i }).click();
  await page.getByLabel("Name").fill("Personal");
  await page.getByRole("button", { name: /save/i }).click();
  await page.getByText("Personal").click();
  await expect(page).toHaveURL(/\/$/);
});
