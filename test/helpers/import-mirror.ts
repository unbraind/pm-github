/** Explicit importer-owned SDK fixtures; a reference tag alone no longer creates a mirror. */
import { create, mutateItem, normalizeItemId, parseTags, readSettings, type ItemDocument } from "@unbrained/pm-cli/sdk";
import { deriveAtomicItemId, parseProvenanceTag } from "../../index.ts";

/** Seed package creation provenance and a stable source id for full-mirroring fixtures. */
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
  return create({ ...options, author: "pm-github", description, id: options.id ?? deriveAtomicItemId(reference.repo, reference.number, settings.id_prefix, normalizeItemId) }, context);
}

/** Seed an already-created fixture through its native lock and append-only history. */
export async function seedExistingItem(pmRoot: string, id: string, replacement: ItemDocument, message: string): Promise<void> {
  await mutateItem({ pmRoot, id, settings: await readSettings(pmRoot), author: "fixture", op: "import", message,
    mutate: document => {
      const changedFields = [...new Set([...Object.keys(document.metadata), ...Object.keys(replacement.metadata), "body"])];
      document.metadata = structuredClone(replacement.metadata);
      document.body = replacement.body;
      return { changedFields };
    },
  });
}
