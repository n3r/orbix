import { describe, it, expect, beforeAll } from "vitest";

// Reproduces the pre-login initial-load case the e2e exercises: a stored
// language must drive BOTH i18next AND the <html lang> attribute at startup,
// before any setActiveLanguage()/profile-sync call runs. Uses a dynamic import
// so index.ts initializes AFTER localStorage is seeded (Vitest isolates the
// module graph per test file).
describe("<html lang> sync on init", () => {
  beforeAll(() => {
    document.documentElement.lang = "en"; // index.html default
    localStorage.setItem("orbix_lang", "es");
  });

  it("sets <html lang> to the stored initial language at startup", async () => {
    const { default: i18n } = await import("./index");
    expect(i18n.language).toBe("es");
    expect(document.documentElement.lang).toBe("es");
  });
});
