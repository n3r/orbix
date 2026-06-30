import { describe, it, expect, vi, afterEach } from "vitest";
import { apiJson, ApiError } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("apiJson", () => {
  it("returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })));
    await expect(apiJson<{ ok: number }>("/x")).resolves.toEqual({ ok: 1 });
  });

  it("throws ApiError with the status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(apiJson("/x")).rejects.toMatchObject({ status: 401 });
    await expect(apiJson("/x")).rejects.toBeInstanceOf(ApiError);
  });
});
