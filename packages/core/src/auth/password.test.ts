import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(await verifyPassword(hash, "hunter2hunter2")).toBe(true);
  });
  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });
});
