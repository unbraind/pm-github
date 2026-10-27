/** Import-owned label conversion shared by writers, previews and read-back comparisons. */
import { toImportTags } from "@unbrained/pm-cli/sdk";

/** Use the importer's CSV representation and SDK parser, including embedded commas and native tag rules. */
export function githubLabelsToTags(names: readonly string[]): string[] {
  return toImportTags(names.join(","));
}
