import { test, expect } from "@playwright/test";

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
