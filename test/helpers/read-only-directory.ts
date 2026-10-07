import { chmodSync, statSync } from "node:fs";

/**
 * Run `fn` while `directory` is temporarily read-only, restoring permissions afterwards.
 *
 * Applies mode 0o555 before invoking `fn` and restores the previous mode in a
 * `finally` block, so a throwing callback cannot leave the directory locked.
 * The permission change has no effect when the process runs as root.
 *
 * @param directory - Existing directory to make read-only for the duration.
 * @param fn - Callback invoked with the directory in read-only mode.
 * @returns Whatever `fn` resolves to; re-throwing its rejection only after the
 *          original directory mode has been restored.
 */
export async function withReadOnlyDirectory<T>(
  directory: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previousMode = statSync(directory).mode & 0o777;
  chmodSync(directory, 0o555);
  try {
    return await fn();
  } finally {
    chmodSync(directory, previousMode);
  }
}