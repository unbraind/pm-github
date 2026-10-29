/** Resolve tracker identity and schema through the same public SDK boundary as host commands. */
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
