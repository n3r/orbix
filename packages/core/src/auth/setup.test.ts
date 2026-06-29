import { describe, it, expect, vi } from "vitest";
import { isSetupComplete, createAdminAccount, SetupAlreadyCompleteError, ValidationError } from "./setup";

describe("setup", () => {
  it("reports incomplete when no accounts exist", async () => {
    expect(await isSetupComplete({ countAccounts: async () => 0 })).toBe(false);
  });
  it("reports complete when an account exists", async () => {
    expect(await isSetupComplete({ countAccounts: async () => 1 })).toBe(true);
  });
  it("creates the admin when none exists", async () => {
    const insert = vi.fn(async () => ({ id: "acc1" }));
    const res = await createAdminAccount(
      { email: "me@example.com", password: "longenough" },
      { hasAnyAccount: async () => false, insert }
    );
    expect(res.id).toBe("acc1");
    expect(insert).toHaveBeenCalledOnce();
  });
  it("refuses to create a second account", async () => {
    await expect(
      createAdminAccount({ email: "me@example.com", password: "longenough" },
        { hasAnyAccount: async () => true, insert: async () => ({ id: "x" }) })
    ).rejects.toBeInstanceOf(SetupAlreadyCompleteError);
  });
  it("rejects a weak password", async () => {
    await expect(
      createAdminAccount({ email: "me@example.com", password: "short" },
        { hasAnyAccount: async () => false, insert: async () => ({ id: "x" }) })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
