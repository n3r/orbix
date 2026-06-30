import { describe, it, expect, beforeEach } from "vitest";
import { detectInitialLanguage, setActiveLanguage } from "./useActiveLanguage";
import i18n from "./index";

beforeEach(() => {
  localStorage.clear();
});

describe("active language", () => {
  it("detects from localStorage first", () => {
    localStorage.setItem("orbix_lang", "es");
    expect(detectInitialLanguage()).toBe("es");
  });

  it("falls back to en for an unsupported/absent browser language", () => {
    expect(detectInitialLanguage()).toBe("en");
  });

  it("setActiveLanguage updates i18n, storage, and <html lang>", async () => {
    await setActiveLanguage("es");
    expect(i18n.language).toBe("es");
    expect(localStorage.getItem("orbix_lang")).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    await setActiveLanguage("en");
  });
});
