import {
  EXIT_CODE, locateItem, PmCliError, readAnnotationEntries, readLocatedItem, renderPmCommand, runAnnotationCommand, type AnnotationEntry,
} from "@unbrained/pm-cli/sdk";
import type { GhComment } from "./index.ts";
import { parseSourceTimestamp } from "./source-time.ts";
import { githubInvocationPath, readGithubWorkspace, repairScopeArgs } from "./workspace.ts";

/** Read complete persisted comment text, including markers at the end of long rows. */
export async function readStoredComments(itemId: string, pmPath: string) {
  const { pmRoot, settings, types } = await readGithubWorkspace(pmPath);
  const located = await locateItem(pmRoot, itemId, settings.id_prefix, settings.item_format, types.type_to_folder);
  if (!located) throw new PmCliError(`Item ${itemId} not found`, EXIT_CODE.NOT_FOUND);
  const { document } = await readLocatedItem(located, { schema: settings.schema });
  return readAnnotationEntries<AnnotationEntry>(document.metadata, "comments");
}

/**
 * Validate the source timestamp before appending this comment; a mirror never persists a
 * malformed or impossible source time. A refused comment counts as a failed
 * write and stays retryable, instead of being stored, counted as success, and
 * then skipped by its comment ID on every later sync.
 *
 * @param comment - The GitHub comment whose creation time the mirror stores.
 * @returns The validated source timestamp.
 * @throws {@link PmCliError} When the timestamp is absent, not RFC 3339, or
 * names an impossible calendar moment; the caller counts the comment as not
 * written.
 */
function requireGithubCommentTimestamp(comment: GhComment): string {
  if (!Number.isFinite(parseSourceTimestamp(comment.created_at))) {
    throw new PmCliError(`GitHub comment ${comment.id} has an invalid source timestamp and was refused.`, EXIT_CODE.GENERIC_FAILURE);
  }
  return comment.created_at;
}

/** Append a source annotation through the native item lock and comment history operation. */
export async function appendGithubComment(itemId: string, pmRoot: string, comment: GhComment, text: string): Promise<number> {
  const created_at = requireGithubCommentTimestamp(comment);
  const result = await runAnnotationCommand(itemId, { author: comment.user?.login ?? "github", ifAbsent: true }, { path: pmRoot }, {
    collectionKey: "comments",
    op: "comment_add",
    input: { mode: "add", value: text },
    parseText: raw => raw,
    bypassOwnershipConflict: false,
    conflictGuidance: {
      required: "Ask the current owner to release the item before retrying the comment mirror.",
      examples: [renderPmCommand([...repairScopeArgs(githubInvocationPath()), "release", itemId])],
      nextSteps: ["Retry the GitHub import when the item is available."],
    },
    createEntry: entry => ({ ...entry, created_at }),
  });
  return result.mutation_receipt!.changed_count;
}
