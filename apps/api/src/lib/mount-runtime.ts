import type { Env } from "@orbix/config";
import { realMountDeps, unmount as unmountSource, type MountDeps } from "./smb";
import { resolveSourceRoot, type SourceRootRecord } from "./source-root";
import { decryptSecret } from "./secrets";

export interface MountRuntime {
  resolve: (src: SourceRootRecord) => Promise<string>;
  unmount: (id: string) => Promise<void>;
}

export function buildMountRuntime(env: Env): MountRuntime {
  const mount: MountDeps = realMountDeps(env.MOUNTS_DIR);
  const decrypt = (blob: string) => decryptSecret(blob, env.SESSION_SECRET);
  return {
    resolve: (src) => resolveSourceRoot(src, { mount, decrypt }),
    unmount: (id) => unmountSource(mount, id),
  };
}
