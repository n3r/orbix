import { describe, it, expect } from "vitest";
import { validateProfileInput, ProfileValidationError } from "./profiles";

describe("validateProfileInput", () => {
  it("accepts a standard profile", () => {
    expect(validateProfileInput({ name: "Personal", kind: "standard" }).name).toBe("Personal");
  });
  it("requires maturityCap for kids profiles", () => {
    expect(() => validateProfileInput({ name: "Kids", kind: "kids" })).toThrow(ProfileValidationError);
  });
  it("rejects a non-4-digit pin", () => {
    expect(() => validateProfileInput({ name: "P", kind: "standard", pin: "12" })).toThrow(ProfileValidationError);
  });
});
