import { describe, it, expect } from "vitest";
import { resolveSourceRoot, type SourceRootRecord, type ResolveDeps } from "./source-root";

const base: SourceRootRecord = {
  id: "s1", kind: "local", path: "/movies",
  smbHost: null, smbShare: null, smbSubpath: null,
  smbUsername: null, smbPassword: null, smbDomain: null,
};

function deps(mounted: string[] = []): ResolveDeps {
  return {
    decrypt: (b) => b.replace("enc:", ""),
    mount: {
      mountsDir: "/data/mounts",
      run: async (_c, a) => { mounted.push(a[3] ?? ""); },
      readMounts: async () => mounted.map((m) => `//x ${m} cifs ro 0 0`).join("\n"),
      mkdir: async () => {},
      writeCred: async () => {},
      rmCred: async () => {},
    },
  };
}

describe("resolveSourceRoot", () => {
  it("returns the path for a local source", async () => {
    expect(await resolveSourceRoot(base, deps())).toBe("/movies");
  });
  it("throws when a local source has no path", async () => {
    await expect(resolveSourceRoot({ ...base, path: null }, deps())).rejects.toThrow();
  });
  it("mounts an smb source and returns the mount point", async () => {
    const src: SourceRootRecord = { ...base, kind: "smb", path: null, smbHost: "nas", smbShare: "media", smbPassword: "enc:pw" };
    expect(await resolveSourceRoot(src, deps())).toBe("/data/mounts/s1");
  });
  it("appends smbSubpath to the mount point", async () => {
    const src: SourceRootRecord = { ...base, kind: "smb", path: null, smbHost: "nas", smbShare: "media", smbSubpath: "Films" };
    expect(await resolveSourceRoot(src, deps())).toBe("/data/mounts/s1/Films");
  });
  it("throws on unknown kind", async () => {
    await expect(resolveSourceRoot({ ...base, kind: "nfs" }, deps())).rejects.toThrow();
  });
});
