import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface SmbSourceRecord {
  id: string;
  smbHost: string | null;
  smbShare: string | null;
  smbSubpath: string | null;
  smbUsername: string | null;
  smbPassword: string | null; // already decrypted
  smbDomain: string | null;
}

export interface MountDeps {
  mountsDir: string;
  run: (cmd: string, args: string[]) => Promise<void>;
  readMounts: () => Promise<string>;
  mkdir: (dir: string) => Promise<void>;
  writeCred: (file: string, contents: string) => Promise<void>;
  rmCred: (file: string) => Promise<void>;
}

export function mountPointFor(deps: MountDeps, id: string): string {
  return path.join(deps.mountsDir, id);
}

export async function isMounted(deps: MountDeps, id: string): Promise<boolean> {
  const mp = mountPointFor(deps, id);
  const mounts = await deps.readMounts();
  return mounts.split("\n").some((line) => line.split(" ")[1] === mp);
}

export async function ensureMounted(deps: MountDeps, src: SmbSourceRecord): Promise<string> {
  const mp = mountPointFor(deps, src.id);
  if (await isMounted(deps, src.id)) return mp;
  await deps.mkdir(mp);
  const credFile = path.join(deps.mountsDir, `.cred-${src.id}`);
  const cred =
    `username=${src.smbUsername ?? "guest"}\n` +
    `password=${src.smbPassword ?? ""}\n` +
    `domain=${src.smbDomain ?? ""}\n`;
  await deps.writeCred(credFile, cred);
  try {
    const unc = `//${src.smbHost}/${src.smbShare}`;
    await deps.run("mount", ["-t", "cifs", unc, mp, "-o", `ro,credentials=${credFile},iocharset=utf8`]);
  } finally {
    await deps.rmCred(credFile).catch(() => {});
  }
  return mp;
}

export async function unmount(deps: MountDeps, id: string): Promise<void> {
  if (!(await isMounted(deps, id))) return;
  await deps.run("umount", [mountPointFor(deps, id)]);
}

export function realMountDeps(mountsDir: string): MountDeps {
  return {
    mountsDir,
    run: async (cmd, args) => {
      await execFileAsync(cmd, args);
    },
    readMounts: () => fs.readFile("/proc/mounts", "utf8").catch(() => ""),
    mkdir: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
    writeCred: (file, contents) => fs.writeFile(file, contents, { mode: 0o600 }),
    rmCred: (file) => fs.rm(file, { force: true }),
  };
}
