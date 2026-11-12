/** Durable package-owned state uses the SDK's sibling-file writer before publication. */
import { writeFileAtomic } from "@unbrained/pm-cli/sdk";
import { mkdir, open, link, rename, unlink, lstat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

/** A fully written and flushed candidate that is still invisible to state readers. */
export interface StagedGithubState {
  file: string;
  staged: string;
}

/** Exclusive publication never overwrites a peer's existing plan or lease. */
export interface GithubStateWriteOptions {
  exclusive?: boolean;
  /** Platform seam for portability tests; filesystem operations remain native. */
  platform?: () => NodeJS.Platform;
  /** Observation/fault-injection boundary after fsync and before publication. */
  onStaged?: (context: StagedGithubState) => void | Promise<void>;
}

/** Writable file handles support Windows FlushFileBuffers; Windows cannot fsync directories. */
export function githubStateSyncMode(directory: boolean, platform: NodeJS.Platform = process.platform): "r" | "r+" | undefined {
  return directory ? platform === "win32" ? undefined : "r" : "r+";
}

/** Flush a complete file, or a directory only where the platform supports it. */
export async function syncGithubStatePath(target: string, directory: boolean, platform: NodeJS.Platform = process.platform): Promise<void> {
  const mode = githubStateSyncMode(directory, platform);
  if (mode === undefined) return; // win32 has no supported directory-fsync path through Node.
  const handle = await open(target, mode);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Publish only complete fsynced bytes; atomic link preserves exclusive-create semantics. */
export async function writeGithubStateAtomic(file: string, contents: string, options: GithubStateWriteOptions = {}): Promise<void> {
  const directory = dirname(file);
  const created = await mkdir(directory, { recursive: true });
  if (options.exclusive) {
    // Match O_EXCL even when an existing owner's directory is read-only.
    // This is an early contention hint; link() remains the race-safe authority.
    const exists = await lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (exists) throw Object.assign(new Error("Durable state already exists"), { code: "EEXIST" });
  }
  const staged = join(directory, `.${basename(file)}.${randomUUID()}.stage`);
  try {
    await writeFileAtomic(staged, contents, { createParentDirectories: false });
    const platform = (options.platform ?? (() => process.platform))();
    await syncGithubStatePath(staged, false, platform);
    await options.onStaged?.({ file, staged });
    if (options.exclusive) await link(staged, file);
    else await rename(staged, file);
    // A newly created directory also needs its parent entry made durable.
    const last = created ? dirname(created) : directory;
    for (let current = directory; ; current = dirname(current)) {
      await syncGithubStatePath(current, true, platform);
      if (current === last || current === dirname(current)) break;
    }
  } finally {
    // A crash can leave an invisible stage; readers never enumerate it as state.
    await unlink(staged).catch(() => undefined);
  }
}
