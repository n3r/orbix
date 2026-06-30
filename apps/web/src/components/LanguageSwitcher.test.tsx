import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/lib/i18n";
import LanguageSwitcher from "./LanguageSwitcher";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("LanguageSwitcher", () => {
  it("renders an option for every supported language", () => {
    render(<LanguageSwitcher />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["English", "Español", "Deutsch", "Português", "Русский", "Français"]);
  });

  it("reflects the active language as the selected value", async () => {
    await i18n.changeLanguage("es");
    render(<LanguageSwitcher />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("es");
    await i18n.changeLanguage("en");
  });
});
