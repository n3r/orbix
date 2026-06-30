import path from "node:path";
import { ensureMounted, type MountDeps, type SmbSourceRecord } from "./smb";

export interface SourceRootRecord extends SmbSourceRecord {
  kind: string;
  path: string | null;
}

export interface ResolveDeps {
  mount: MountDeps;
  decrypt: (blob: string) => string;
}

export async function resolveSourceRoot(src: SourceRootRecord, deps: ResolveDeps): Promise<string> {
  if (src.kind === "local") {
    if (!src.path) throw new Error(`local source ${src.id} has no path`);
    return src.path;
  }
  if (src.kind === "smb") {
    const decrypted: SmbSourceRecord = {
      ...src,
      smbPassword: src.smbPassword ? deps.decrypt(src.smbPassword) : null,
    };
    const mp = await ensureMounted(deps.mount, decrypted);
    return src.smbSubpath ? path.join(mp, src.smbSubpath) : mp;
  }
  throw new Error(`unknown source kind: ${src.kind}`);
}
