/** Import-owned label conversion shared by writers, previews and read-back comparisons. */
import { toImportTags } from "@unbrained/pm-cli/sdk";
import type { PreparedGithubImport } from "./index.ts";

/** Use the importer's CSV representation and SDK parser, including embedded commas and native tag rules. */
export function githubLabelsToTags(names: readonly string[]): string[] {
  return toImportTags(names.join(","));
}

/** Select genuinely new native tag atoms without converting retained tracker state into command CSV. */
export function nativeTagAdditions(current: readonly string[] | undefined, desired: readonly string[]): string[] {
  const stored = new Set(toImportTags(current));
  return toImportTags(desired).filter(tag => !stored.has(tag));
}

/** Resolve a prepared or replayed import while preserving native tags retained from an existing owner. */
export function importTagValues(entry: PreparedGithubImport): string[] {
  const retained = entry.linkOnly || entry.identity?.via === "citation" ? toImportTags(entry.match?.tags) : [];
  const native = new Set(retained);
  return toImportTags([...retained, ...githubLabelsToTags(entry.tags.filter(tag => !native.has(toImportTags([tag])[0]!)))]);
}

/** Preserve existing owner tags by adding only new provider-derived atoms instead of serializing native state as CSV. */
export function importTagOptions(entry: PreparedGithubImport): { tags?: string; addTags?: string[] } {
  const tags = importTagValues(entry);
  if (entry.match?.id && (entry.linkOnly || entry.identity?.via === "citation")) {
    return { addTags: nativeTagAdditions(entry.match.tags, tags) };
  }
  return { tags: tags.join(",") };
}
