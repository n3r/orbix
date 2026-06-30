import { describe, it, expect, afterAll } from "vitest";
import i18n from "./index";

// The test harness (test-setup.ts) imports ./lib/i18n, which initializes
// i18next AND sets <html lang> from the initial language + registers a
// languageChanged listener. These assert both halves of that sync so the
// pre-login e2e (<html lang="es"> on first load) can't regress.
describe("<html lang> sync", () => {
  afterAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("reflects the active language after init", () => {
    expect(document.documentElement.lang).toBe(i18n.language);
  });

  it("updates <html lang> on every language change", async () => {
    await i18n.changeLanguage("es");
    expect(document.documentElement.lang).toBe("es");
    await i18n.changeLanguage("de");
    expect(document.documentElement.lang).toBe("de");
  });
});
