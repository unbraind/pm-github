/** Resolve tracker identity and schema through the same public SDK boundary as host commands. */
import { AsyncLocalStorage } from "node:async_hooks";
import { getActiveExtensionRegistrations, isTerminalStatus, normalizeStatusInput, readSettings, resolveItemTypeRegistry, resolvePmRoot, resolveRuntimeStatusRegistry, SETTINGS_DEFAULTS, type RuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";

/** Built-in contracts preserve pure planner compatibility when no workspace is supplied. */
const defaultStatuses = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);

/** Accept a workspace, tracker directory or relative CLI path before reading its schema. */
export async function readGithubWorkspace(pmPath: string) {
  const pmRoot = resolvePmRoot(process.cwd(), pmPath);
  const settings = await readSettings(pmRoot);
  return { pmRoot, settings, types: resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()),
    statuses: resolveRuntimeStatusRegistry(settings.schema) };
}

/** Typed tracker selector of the current host invocation; blank or absent means an implicit selection. */
const githubInvocationScope = new AsyncLocalStorage<{ typedPath: string | undefined }>();

/**
 * Remember the typed tracker selector of one host invocation so commands its
 * failures render can replay it.
 *
 * A repair, recovery or ownership-conflict hint is rendered from one
 * invocation that already selected its tracker. The store keeps the caller's
 * typed `--pm-path`/`--path` spelling, exactly as the host's own recovery scope
 * does, so deep renderers need no signature changes and concurrent SDK calls
 * never read each other's scope.
 *
 * @param typedPath - The invocation's typed tracker selector, or undefined
 * when it selected its tracker implicitly.
 * @param run - The invocation body whose rendered commands replay the selector.
 * @returns The invocation body's result.
 */
export function withGithubInvocationScope<T>(typedPath: string | undefined, run: () => T): T {
  return githubInvocationScope.run({ typedPath }, run);
}

/** The typed tracker selector of the current invocation, or undefined for an implicit selection. */
export function githubInvocationPath(): string | undefined {
  return githubInvocationScope.getStore()?.typedPath;
}

/**
 * Copy-safe selector arguments for a command rendered from the current
 * invocation.
 *
 * The failing invocation's own spelling is replayed verbatim, so a copy made in
 * the same shell resolves the same tracker; a blank or absent selection stays
 * implicit, because the shell's directory and `PM_PATH` resolve it again. A
 * copy made in another directory after a typed selector is the harmful case:
 * without these arguments it would update an item with the same ID in whatever
 * tracker that directory holds.
 *
 * @param typedPath - The typed tracker selector of the failing invocation.
 * @returns `--pm-path` selector arguments, or none for an implicit selection.
 */
export function repairScopeArgs(typedPath: string | undefined): string[] {
  return typedPath?.trim() ? ["--pm-path", typedPath] : [];
}

/** Canonicalize configured aliases using the host's own status input normalizer. */
export function canonicalGithubStatus(value: string | undefined, registry = defaultStatuses): string {
  return normalizeStatusInput(value, registry) ?? value ?? registry.open_status;
}

/** Classify native statuses by configured lifecycle roles for provider transitions. */
export function githubStatusKind(value: string | undefined, registry = defaultStatuses): string {
  const status = canonicalGithubStatus(value, registry);
  if (registry.terminal_done_statuses.has(status)) return "closed";
  if (registry.terminal_canceled_statuses.has(status)) return "canceled";
  if (isTerminalStatus(status, registry)) return "closed";
  if (registry.blocked_statuses.has(status)) return "blocked";
  if (registry.draft_statuses.has(status)) return "draft";
  if (status === registry.in_progress_status) return "in_progress";
  if (status === registry.open_status) return "open";
  return status;
}

/** Include every configured terminal role when mapping native state to a provider. */
export function githubStatusIsTerminal(value: string | undefined, registry = defaultStatuses): boolean {
  return isTerminalStatus(value ?? registry.open_status, registry);
}

/** Public status registry accepted by pure planners and comparison helpers. */
export type GithubStatusRegistry = RuntimeStatusRegistry;
