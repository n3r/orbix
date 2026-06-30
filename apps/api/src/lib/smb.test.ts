import { describe, it, expect } from "vitest";
import { ensureMounted, isMounted, mountPointFor, unmount, type MountDeps, type SmbSourceRecord } from "./smb";

interface FakeDeps extends MountDeps {
  calls: string[][];
}

function fakeDeps(initialMounts = ""): FakeDeps {
  const state = { mounts: initialMounts };
  const calls: string[][] = [];
  return {
    calls,
    mountsDir: "/data/mounts",
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "mount") state.mounts += `//x ${args[3]} cifs ro 0 0\n`;
      if (cmd === "umount") state.mounts = state.mounts.split("\n").filter((l) => l.split(" ")[1] !== args[0]).join("\n");
    },
    readMounts: async () => state.mounts,
    mkdir: async () => {},
    writeCred: async () => {},
    rmCred: async () => {},
  };
}

const src: SmbSourceRecord = {
  id: "src1", smbHost: "nas", smbShare: "media", smbSubpath: null,
  smbUsername: "u", smbPassword: "p", smbDomain: null,
};

describe("smb mount manager", () => {
  it("mounts when not already mounted", async () => {
    const deps = fakeDeps();
    const mp = await ensureMounted(deps, src);
    expect(mp).toBe(mountPointFor(deps, "src1"));
    expect(deps.calls[0]?.[0]).toBe("mount");
    expect(deps.calls[0]).toContain("//nas/media");
  });
  it("is idempotent — no second mount call", async () => {
    const deps = fakeDeps();
    await ensureMounted(deps, src);
    const before = deps.calls.length;
    await ensureMounted(deps, src);
    expect(deps.calls.length).toBe(before);
    expect(await isMounted(deps, "src1")).toBe(true);
  });
  it("unmounts only when mounted", async () => {
    const deps = fakeDeps();
    await unmount(deps, "src1"); // no-op
    expect(deps.calls.length).toBe(0);
    await ensureMounted(deps, src);
    await unmount(deps, "src1");
    expect(deps.calls.some((c) => c[0] === "umount")).toBe(true);
  });
});
