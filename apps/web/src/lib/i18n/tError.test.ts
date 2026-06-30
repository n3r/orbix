import { describe, it, expect } from "vitest";
import i18n from "./index";
import { errorMessage } from "./tError";

const t = i18n.getFixedT("en");

describe("errorMessage", () => {
  it("maps a known code", () => {
    expect(errorMessage("invalid_credentials", t)).toBe("Invalid email or password.");
  });
  it("falls back to unknown for an unmapped code", () => {
    expect(errorMessage("weird_code", t)).toBe("Something went wrong. Please try again.");
  });
  it("handles undefined", () => {
    expect(errorMessage(undefined, t)).toBe("Something went wrong. Please try again.");
  });
  it("localizes by active language", () => {
    const es = i18n.getFixedT("es");
    expect(errorMessage("invalid_credentials", es)).toBe("Correo o contraseña no válidos.");
  });
});
