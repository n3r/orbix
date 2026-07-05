import { describe, it, expect } from "vitest";
import { validateProfileInput, ProfileValidationError } from "./profiles";

describe("validateProfileInput", () => {
  it("accepts a standard profile", () => {
    expect(validateProfileInput({ name: "Personal", kind: "standard" }).name).toBe("Personal");
  });
  it("requires maturityCap for kids profiles", () => {
    expect(() => validateProfileInput({ name: "Kids", kind: "kids" })).toThrow(ProfileValidationError);
  });
  it("accepts 4-6 digit pins", () => {
    expect(validateProfileInput({ name: "P", kind: "standard", pin: "1234" }).pin).toBe("1234");
    expect(validateProfileInput({ name: "P", kind: "standard", pin: "123456" }).pin).toBe("123456");
  });
  it("rejects a pin outside 4-6 digits", () => {
    expect(() => validateProfileInput({ name: "P", kind: "standard", pin: "12" })).toThrow(ProfileValidationError);
    expect(() => validateProfileInput({ name: "P", kind: "standard", pin: "1234567" })).toThrow(ProfileValidationError);
  });
  it("accepts group metadata", () => {
    expect(validateProfileInput({
      name: "Together",
      kind: "standard",
      isGroup: true,
      memberProfileIds: ["p1", "p2"],
    }).isGroup).toBe(true);
  });
  it("defaults language to en and accepts a supported language", () => {
    expect(validateProfileInput({ name: "P", kind: "standard" }).language).toBe("en");
    expect(validateProfileInput({ name: "P", kind: "standard", language: "es" }).language).toBe("es");
  });
  it("rejects an unsupported language", () => {
    expect(() => validateProfileInput({ name: "P", kind: "standard", language: "zz" })).toThrow(ProfileValidationError);
  });
});
