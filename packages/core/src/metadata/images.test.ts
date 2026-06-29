import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { cacheImage } from "./images";

// ---------------------------------------------------------------------------
// Fake helpers — NO real network, NO real disk.
// ---------------------------------------------------------------------------

function makeFakeResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as Response;
}

function makeFetchSpy(bytes = new Uint8Array([1, 2, 3])) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
    calls.push(url.toString());
    return makeFakeResponse(bytes);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeWriteSpy() {
  const calls: { absPath: string; data: Uint8Array }[] = [];
  const writeFile = vi.fn(async (absPath: string, data: Uint8Array) => {
    calls.push({ absPath, data });
  });
  return { writeFile, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cacheImage", () => {
  it("downloads and writes poster when not cached", async () => {
    const { fetchImpl, calls: fetchCalls } = makeFetchSpy();
    const { writeFile, calls: writeCalls } = makeWriteSpy();

    const result = await cacheImage("/abc.jpg", "poster", {
      fetchImpl,
      writeFile,
      exists: async () => false,
      baseDir: "/meta",
    });

    // Returns correct relative path
    expect(result).toBe("poster/abc.jpg");

    // writeFile called once with the correct absolute path and bytes
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].absPath).toBe(path.join("/meta", "poster/abc.jpg"));
    expect(writeCalls[0].data).toBeInstanceOf(Uint8Array);
    expect(writeCalls[0].data).toHaveLength(3);
    expect(Array.from(writeCalls[0].data)).toEqual([1, 2, 3]);

    // URL contains expected parts
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("image.tmdb.org");
    expect(fetchCalls[0]).toContain("w500");
    expect(fetchCalls[0]).toContain("/abc.jpg");
  });

  it("is idempotent: skips fetch and write when already cached", async () => {
    const { fetchImpl } = makeFetchSpy();
    const { writeFile } = makeWriteSpy();

    const result = await cacheImage("/abc.jpg", "poster", {
      fetchImpl,
      writeFile,
      exists: async () => true,
      baseDir: "/meta",
    });

    expect(result).toBe("poster/abc.jpg");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("uses w1280 as default size for backdrop", async () => {
    const { fetchImpl, calls: fetchCalls } = makeFetchSpy();
    const { writeFile } = makeWriteSpy();

    const result = await cacheImage("/b.jpg", "backdrop", {
      fetchImpl,
      writeFile,
      exists: async () => false,
      baseDir: "/meta",
    });

    expect(result).toBe("backdrop/b.jpg");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("w1280");
    expect(fetchCalls[0]).toContain("/b.jpg");
  });

  it("uses custom size when provided", async () => {
    const { fetchImpl, calls: fetchCalls } = makeFetchSpy();
    const { writeFile } = makeWriteSpy();

    await cacheImage("/abc.jpg", "poster", {
      fetchImpl,
      writeFile,
      exists: async () => false,
      baseDir: "/meta",
      size: "w200",
    });

    expect(fetchCalls[0]).toContain("w200");
  });

  it("throws when fetch returns non-ok response", async () => {
    const badFetch = vi.fn(async (): Promise<Response> => {
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { writeFile } = makeWriteSpy();

    await expect(
      cacheImage("/abc.jpg", "poster", {
        fetchImpl: badFetch,
        writeFile,
        exists: async () => false,
        baseDir: "/meta",
      }),
    ).rejects.toThrow();
  });

  it("strips leading path components — only uses basename", async () => {
    const { fetchImpl, calls: fetchCalls } = makeFetchSpy();
    const { writeFile, calls: writeCalls } = makeWriteSpy();

    const result = await cacheImage("/deep/path/img.jpg", "poster", {
      fetchImpl,
      writeFile,
      exists: async () => false,
      baseDir: "/meta",
    });

    // basename strips everything but "img.jpg"
    expect(result).toBe("poster/img.jpg");
    expect(writeCalls[0].absPath).toBe(path.join("/meta", "poster/img.jpg"));
    expect(fetchCalls[0]).toContain("/deep/path/img.jpg");
  });
});
