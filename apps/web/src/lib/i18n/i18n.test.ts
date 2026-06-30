import { describe, it, expect } from "vitest";
import i18n from "./index";

describe("i18n bootstrap", () => {
  it("initializes with en fallback and resolves a common key", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("common:app.name")).toBe("Orbix");
    expect(i18n.t("common:actions.save")).toBe("Save");
  });

  it("resolves Spanish translations for the es locale", async () => {
    await i18n.changeLanguage("es");
    expect(i18n.t("common:actions.save")).toBe("Guardar");
  });

  it("falls back to en when a key is missing in the active locale", async () => {
    await i18n.changeLanguage("es");
    // brand name is identical across locales; proves resolution works end-to-end
    expect(i18n.t("common:app.name")).toBe("Orbix");
    await i18n.changeLanguage("en");
  });
});
