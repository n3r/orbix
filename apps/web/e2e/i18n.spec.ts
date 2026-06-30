import { test, expect } from "@playwright/test";

// Drives the onboarding flow with the UI language forced to Spanish and asserts
// localized chrome renders end-to-end. Cleans up the admin/profile it creates so
// the single-admin DB constraint isn't tripped by later specs.
test.afterAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.profile.deleteMany();
  await prisma.account.deleteMany();
  await prisma.$disconnect();
});

test("Spanish locale renders localized UI through onboarding", async ({ page }) => {
  // Force the pre-login language before any app code runs.
  await page.addInitScript(() => localStorage.setItem("orbix_lang", "es"));

  await page.goto("http://localhost:1060/");
  await expect(page).toHaveURL(/\/setup/);

  // <html lang> reflects the active locale, and the setup screen is in Spanish.
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByText("Crea tu cuenta")).toBeVisible();

  // Complete setup using the Spanish field labels.
  await page.getByLabel("Correo electrónico").fill("hola@casa.lan");
  await page.getByLabel("Contraseña").fill("contraseñalarga");
  await page.getByRole("button", { name: /crear cuenta/i }).click();

  // Profile picker is localized.
  await expect(page).toHaveURL(/\/profiles/);
  await expect(page.getByText("¿Quién está viendo?")).toBeVisible();

  // Create a Spanish profile and enter the app.
  await page.getByRole("button", { name: /añadir perfil/i }).click();
  await page.getByLabel("Nombre").fill("Sofía");
  await page.getByRole("button", { name: /guardar/i }).click();
  await page.getByText("Sofía").click();
  await expect(page).toHaveURL(/\/$/);

  // In-app nav chrome is localized too. Scope to the top bar (banner) — the same
  // "Inicio" label also exists in the hidden mobile bottom nav.
  await expect(page.getByRole("banner").getByText("Inicio")).toBeVisible();
});
