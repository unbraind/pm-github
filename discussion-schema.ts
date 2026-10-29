/** Shared bounded contracts for explicit selections, lossless evidence and receipts. */
import { z } from "zod";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nativeName = z.string().min(1).max(512).regex(/^[^\r\n\u0000/\\]+$/);
const nativeStatus = z.string().min(1).max(512).regex(/^[^\r\n\u0000]+$/);
const authorFields = { id: positive, login: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+(?:\[bot\])?$/) };
const repo = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/).transform(value => value.toLowerCase());
const selection = z.strictObject({ comment: positive, start: integer.max(65536), end: positive.max(65536), quote: z.string().min(1).max(4096), marked: z.literal(true) });

/** One strict request schema also validates JSON/TOON-decoded round trips. Offsets count UTF-16 code units. */
export const discussionRequestSchema = z.strictObject({
  repo,
  issue: positive, item: nativeName, selections: z.array(selection).max(10),
});
/** SDK callers supply exactly the same selection document as CLI users. */
export type DiscussionCaptureInput = z.input<typeof discussionRequestSchema>;

/** Project the public comment wire envelope through the same author and numeric domains as evidence. */
export const discussionSourceSchema = z.object({
  id: positive, body: z.string().max(65536), issue_url: z.string().max(512), html_url: z.string().max(512),
  updated_at: z.string().datetime({ offset: true }), user: z.object(authorFields),
});

/** Exact quoted bytes are JSON data, never a template, command or instruction. */
export const discussionEvidenceSchema = z.strictObject({
  type: z.literal("github.discussion-decision.v1"), repo, issue: positive,
  comment: positive, url: z.string().url().max(512), revision: digest,
  author: z.strictObject(authorFields), updatedAt: z.string().datetime({ offset: true }),
  span: z.strictObject({ start: integer.max(65536), end: positive.max(65536), quote: z.string().min(1).max(4096) }).refine(value => value.end > value.start && value.end - value.start === value.quote.length),
});
/** Evidence can be handed to a citation workflow without inventing another citation store. */
export type DiscussionDecisionEvidence = z.infer<typeof discussionEvidenceSchema>;

/** Every producer uses this validator before returning a successful finite, bounded receipt. */
export const discussionReportSchema = z.strictObject({
  ok: z.literal(true), mode: z.enum(["plan", "apply"]), approval: digest, item: nativeName, status: nativeStatus,
  selected: integer.max(10), created: integer.max(10), unchanged: integer.max(10), skipped: integer.max(10), refused: integer.max(10),
  rows: z.array(z.strictObject({
    id: nativeName, state: z.enum(["create", "created", "unchanged", "skipped", "refused"]),
    reason: z.enum(["selected_marked_span", "already_captured", "foreign_or_edited", "duplicate_selection", "source_unavailable", "source_changed", "invalid_selection", "captured", "write_failed", "native_refused"]),
    remedy: z.string().max(300), evidence: discussionEvidenceSchema.nullable(),
  })).max(10),
}).superRefine((value, ctx) => {
  if (value.rows.length !== value.selected || ["created", "unchanged", "skipped", "refused"].some(state => value[state as "created"] !== value.rows.filter(row => row.state === state).length)) ctx.addIssue({ code: "custom", message: "Receipt counters must equal row states" });
});
/** Compact agent receipt includes complete selected quotes, with no unrelated discussion prose. */
export type DiscussionCaptureReport = z.infer<typeof discussionReportSchema>;
