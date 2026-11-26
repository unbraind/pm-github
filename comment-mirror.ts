import {
  EXIT_CODE, locateItem, PmCliError, readAnnotationEntries, readLocatedItem, runAnnotationCommand, type AnnotationEntry,
} from "@unbrained/pm-cli/sdk";
import type { GhComment } from "./index.ts";
import { readGithubWorkspace } from "./workspace.ts";

/** Read complete persisted comment text, including markers at the end of long rows. */
export async function readStoredComments(itemId: string, pmPath: string) {
  const { pmRoot, settings, types } = await readGithubWorkspace(pmPath);
  const located = await locateItem(pmRoot, itemId, settings.id_prefix, settings.item_format, types.type_to_folder);
  if (!located) throw new PmCliError(`Item ${itemId} not found`, EXIT_CODE.NOT_FOUND);
  const { document } = await readLocatedItem(located, { schema: settings.schema });
  return readAnnotationEntries<AnnotationEntry>(document.metadata, "comments");
}

/** Append a source annotation through the native item lock and comment history operation. */
export async function appendGithubComment(itemId: string, pmRoot: string, comment: GhComment, text: string): Promise<number> {
  const result = await runAnnotationCommand(itemId, { author: comment.user?.login ?? "github", ifAbsent: true }, { path: pmRoot }, {
    collectionKey: "comments",
    op: "comment_add",
    input: { mode: "add", value: text },
    parseText: raw => raw,
    bypassOwnershipConflict: false,
    conflictGuidance: {
      required: "Ask the current owner to release the item before retrying the comment mirror.",
      examples: ["pm release <id>"],
      nextSteps: ["Retry the GitHub import when the item is available."],
    },
    createEntry: entry => ({ ...entry, created_at: comment.created_at }),
  });
  return result.mutation_receipt!.changed_count;
}
