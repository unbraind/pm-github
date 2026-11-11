/** Explicit importer-owned SDK fixtures; a reference tag alone no longer creates a mirror. */
import { create, normalizeItemId, parseTags, readSettings } from "@unbrained/pm-cli/sdk";
import { deriveAtomicItemId, parseProvenanceTag } from "../../index.ts";

/** Seed an importer-generated id for tests exercising full mirroring rather than curated links. */
export async function createImportMirror(options: NonNullable<Parameters<typeof create>[0]>, context: Parameters<typeof create>[1]) {
  const reference = parseTags(options.tags ?? "").flatMap(tag => {
    const parsed = parseProvenanceTag(tag);
    return parsed ? [parsed] : [];
  })[0];
  if (!reference) throw new Error("Mirror fixture requires a source reference");
  const settings = await readSettings(context!.pmRoot!);
  const source = `GH issue #${reference.number}: https://github.com/${reference.repo}/issues/${reference.number}`;
  const description = options.description?.startsWith(source) ? options.description
    : source + (options.description ? ` · ${options.description}` : "");
  return create({ ...options, description, id: options.id ?? deriveAtomicItemId(reference.repo, reference.number, settings.id_prefix, normalizeItemId) }, context);
}
