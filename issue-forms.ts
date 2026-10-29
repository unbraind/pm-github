import { readGithubWorkspace } from "./workspace.ts";
/** Read-only GitHub issue-form contracts; no cached approvals or remote writes. */
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, fstatSync, constants } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import { emptyRecord, ownValue } from "./own-record.ts";
import { uniqueGithubLabelNames } from "./label-names.ts";
import { createPmCliExpectedError, locateItem, readLocatedItem } from "@unbrained/pm-cli/sdk";

/** Stable refusals carry a bounded repair list in the SDK error context. */
export type IssueFormRefusalCode = "invalid_form_input" | "unsupported_form" | "form_unavailable" | "item_unavailable" | "incomplete_answers";
/** A repair identifies the answer without echoing its potentially private contents. */
export interface FormRepair { field: string; reason: string; remedy: string }
/** The repository, revision selector and exact form path must always be explicit. */
export interface IssueFormSelection { repo: string; ref: string; path: string }
/** Answers override bindings; defaults and placeholders never establish completion. */
export interface IssueFormInput extends IssueFormSelection {
  yaml: string;
  answers?: Record<string, string | string[]>;
  bindings?: Record<string, string>;
  item?: string;
}
/** One compiled user-answer requirement, including all supported validators. */
export interface FormField {
  id: string; label: string; type: "input" | "textarea" | "dropdown";
  required: boolean; min_length: number; multiple: boolean; options: string[];
  binding: string | null;
}
/** Semantic digest identifies the parsed form; it is not an export idempotency key. */
export interface IssueFormContract extends IssueFormSelection { digest: string; fields: FormField[]; labels: string[] }
/** Compact completion evidence omits source YAML, item contents and answer values. */
export interface IssueFormReport {
  ok: boolean; contract: IssueFormContract; item: string | null;
  answered: number; checklist: FormRepair[]; omitted: number;
}
/** A successful completion additionally supplies the exact issue body for export. */
export interface IssueFormCompletion { report: IssueFormReport; body: string }

const text = z.string().max(32768);
const short = z.string().min(1).max(200).regex(/^[^\r\n]+$/);
const key = z.string().regex(/^[\p{L}\p{N}_-]{1,100}$/u);
const denseStrings = z.array(text).max(100);
const answer = z.union([text, denseStrings]);
const validators = z.strictObject({ required: z.boolean().optional(), min_length: z.number().int().min(0).max(32768).optional() });
const prose = { description: text.optional(), placeholder: text.optional() };
const fieldBase = { id: key.optional(), validations: validators.optional() };
const fields = z.discriminatedUnion("type", [
  z.strictObject({ ...fieldBase, type: z.literal("input"), attributes: z.strictObject({ label: short, ...prose, value: text.optional() }) }),
  z.strictObject({ ...fieldBase, type: z.literal("textarea"), attributes: z.strictObject({ label: short, ...prose, value: text.optional() }) }),
  z.strictObject({ ...fieldBase, type: z.literal("dropdown"), attributes: z.strictObject({ label: short, description: text.optional(), options: z.array(short).min(1).max(100), multiple: z.boolean().optional() }) }),
  z.strictObject({ type: z.literal("markdown"), attributes: z.strictObject({ value: text }) }),
]);
const form = z.strictObject({ name: short, description: text, title: text.optional(), labels: z.array(short).max(100).optional(), body: z.array(fields).min(1).max(100) });
/** Preserve every own JSON key, including __proto__, before validating named entries. */
function namedEntries(value: unknown): unknown {
  return value !== null && typeof value === "object" && Object.prototype.toString.call(value) === "[object Object]" ? new Map(Object.entries(value)) : value;
}
/** Parse bounded YAML with aliases disabled before the single strict request schema runs. */
function yamlValue(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value) > 131072) return undefined;
  try {
    const document = parseDocument(value, { uniqueKeys: true });
    if (document.errors.length) return undefined;
    return document.toJS({ maxAliasCount: 0 });
  } catch { return undefined; }
}
const requestSchema = z.strictObject({
  repo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/),
  ref: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_./-]+$/),
  path: z.string().regex(/^\.github\/ISSUE_TEMPLATE\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}\.ya?ml$/),
  yaml: z.preprocess(yamlValue, form),
  answers: z.preprocess(namedEntries, z.map(key, answer).refine(value => value.size <= 100)).default(() => new Map()),
  bindings: z.preprocess(namedEntries, z.map(key, key).refine(value => value.size <= 100)).default(() => new Map()),
  item: key.optional(),
});

/** Refuse through the host's expected-error contract with no unbounded input echoes. */
export function refuseIssueForm(code: IssueFormRefusalCode, checklist: FormRepair[], omitted = 0): never {
  throw createPmCliExpectedError(`GitHub issue form: ${code}. ${checklist[0]!.remedy}`, {
    exitCode: 2, context: { code, nextSteps: checklist.slice(0, 20).map(repair => `${repair.field}: ${repair.reason}. ${repair.remedy}`),
      why: `${omitted + Math.max(0, checklist.length - 20)} additional repair(s) omitted; retry after repairing this checklist.` },
  });
}
/** Parse once at the public boundary; schema failures never include submitted values. */
function input(value: unknown): z.infer<typeof requestSchema> {
  const result = requestSchema.safeParse(value);
  if (!result.success) {
    const unsupported = result.error.issues.some(issue => issue.path[0] === "yaml");
    refuseIssueForm(unsupported ? "unsupported_form" : "invalid_form_input", [{ field: "request", reason: "schema", remedy: "Supply a bounded selected form with supported input, textarea, dropdown or markdown elements; review the documented schema limits." }]);
  }
  return result.data;
}
/** Compile every answer field, rejecting unsupported dropdown validators and ambiguous keys. */
function compile(request: z.infer<typeof requestSchema>): IssueFormContract {
  const compiled: FormField[] = [];
  for (const [index, field] of request.yaml.body.entries()) {
    if (field.type === "markdown") continue;
    const id = field.id ?? `field-${index + 1}`;
    const options = field.type === "dropdown" ? field.attributes.options : [];
    if (compiled.some(entry => entry.id === id || entry.label === field.attributes.label) || new Set(options).size !== options.length || (field.type === "dropdown" && field.validations?.min_length !== undefined)) {
      refuseIssueForm("unsupported_form", [{ field: id, reason: "ambiguous_or_unsupported", remedy: "Use unique field IDs, labels and dropdown options; min_length is supported only for text." }]);
    }
    compiled.push({ id, label: field.attributes.label, type: field.type, required: field.validations?.required ?? false,
      min_length: field.validations?.min_length ?? 0, multiple: field.type === "dropdown" && (field.attributes.multiple ?? false),
      options, binding: request.bindings.get(id) ?? null });
  }
  for (const id of [...request.answers.keys(), ...request.bindings.keys()]) {
    if (!compiled.some(field => field.id === id)) refuseIssueForm("invalid_form_input", [{ field: id, reason: "unknown_field", remedy: "Use only answer IDs listed by the compiled contract." }]);
  }
  return { repo: request.repo, ref: request.ref, path: request.path,
    digest: createHash("sha256").update(JSON.stringify(request.yaml)).digest("hex"), fields: compiled, labels: uniqueGithubLabelNames(request.yaml.labels ?? []) };
}
/** Compile repository form semantics without reading a tracker or contacting GitHub. */
export function compileIssueForm(value: unknown): IssueFormContract { return compile(input(value)); }

/** Validate current SDK state, never saved input, before rendering an export body. */
export async function completeIssueForm(pmPath: string, value: unknown): Promise<IssueFormCompletion> {
  const request = input(value);
  const contract = compile(request);
  let native: Record<string, unknown> = emptyRecord();
  if (request.item !== undefined) {
    try {
      const workspace = await readGithubWorkspace(pmPath);
      const pmRoot = workspace.pmRoot;
      const { settings, types: registry } = workspace;
      const located = await locateItem(pmRoot, request.item, settings.id_prefix, settings.item_format, registry.type_to_folder);
      if (!located) throw new Error("missing item");
      const { document } = await readLocatedItem(located, { schema: settings.schema });
      native = Object.assign(emptyRecord<unknown>(), document.metadata, { body: document.body });
    }
    catch { refuseIssueForm("item_unavailable", [{ field: "item", reason: "sdk_read", remedy: "Select an existing unambiguous item readable through the pm SDK." }]); }
  }
  const checklist: FormRepair[] = [];
  const sections: string[] = [];
  let answered = 0;
  for (const field of contract.fields) {
    const bound = field.binding !== null ? ownValue(native, field.binding) : undefined;
    const value = request.answers.get(field.id) ?? bound;
    let reason = "";
    const parsed = answer.safeParse(value);
    let rendered = "";
    if (value === undefined || value === null) {
      if (field.required) reason = "required";
    } else if (!parsed.success) reason = "answer_type_or_size";
    else if (field.type === "dropdown") {
      const choices = typeof parsed.data === "string" ? [parsed.data] : parsed.data;
      if ((!field.multiple && choices.length > 1) || new Set(choices).size !== choices.length || choices.some(choice => !field.options.includes(choice))) reason = "dropdown_option";
      else if (field.required && choices.length === 0) reason = "required";
      rendered = choices.join(", ");
    } else if (typeof parsed.data !== "string") reason = "text_required";
    else {
      rendered = parsed.data.replace(/\r\n?/g, "\n");
      if (field.type === "input" && rendered.includes("\n")) reason = "single_line";
      else if (field.required && !rendered.trim()) reason = "required";
      else if (Array.from(rendered).length < field.min_length) reason = "min_length";
    }
    if (reason) checklist.push({ field: field.id, reason, remedy: `Provide ${field.id} via answers or its pm binding; satisfy ${field.type} choices and validators.` });
    else if (rendered.trim()) answered++;
    sections.push(`### ${field.label}\n\n${rendered.trim() ? rendered : "_No response_"}`);
  }
  const body = sections.join("\n\n");
  if (Buffer.byteLength(body) > 65536) refuseIssueForm("invalid_form_input", [{ field: "body", reason: "output_size", remedy: "Reduce answers so the rendered issue body is at most 64 KiB." }]);
  return { body, report: { ok: checklist.length === 0, contract, item: request.item ?? null, answered, checklist: checklist.slice(0, 20), omitted: Math.max(0, checklist.length - 20) } };
}

/** Read a bounded JSON answers/bindings file without leaking file locations in refusals. */
function jsonFile(file: string | undefined): unknown {
  if (file === undefined) return {};
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
      const bytes = Buffer.alloc(131073);
      const count = readSync(fd, bytes);
      if (count <= 131072) return JSON.parse(bytes.subarray(0, count).toString("utf8"));
    } finally { closeSync(fd); }
  } catch { /* Expected refusal below includes no local path or input bytes. */ }
  refuseIssueForm("invalid_form_input", [{ field: "file", reason: "json_file", remedy: "Supply a readable JSON answers or bindings file of at most 128 KiB." }]);
}
/** Fetch boundary reuses the package's authenticated, retrying read-only REST transport. */
export type IssueFormReader = (url: string) => Promise<{ body: string }>;
/** Read one explicitly selected Contents API file; non-file responses and oversized files refuse. */
export async function readRepositoryIssueForm(selection: IssueFormSelection, read: IssueFormReader, base: string,
  files: { answers?: string; bindings?: string } = {}): Promise<IssueFormSelection & { yaml: string; answers: unknown; bindings: unknown }> {
  const parsed = requestSchema.pick({ repo: true, ref: true, path: true }).safeParse(selection);
  if (!parsed.success) refuseIssueForm("invalid_form_input", [{ field: "selection", reason: "selection", remedy: "Select --repo owner/repo, --form .github/ISSUE_TEMPLATE/name.yml and --form-ref revision explicitly." }]);
  let yaml: string;
  try {
    const response = await read(`${base}/repos/${parsed.data.repo}/contents/${parsed.data.path}?ref=${encodeURIComponent(parsed.data.ref)}`);
    if (Buffer.byteLength(response.body) > 200000) throw new Error("oversized response");
    const file: unknown = JSON.parse(response.body);
    const contents = z.object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string().max(180000), path: z.literal(parsed.data.path) }).parse(file);
    yaml = Buffer.from(contents.content, "base64").toString("utf8");
  } catch { refuseIssueForm("form_unavailable", [{ field: "form", reason: "repository_read", remedy: "Select an accessible regular repository issue-form file at the intended revision." }]); }
  // The public completion/compile boundary validates file maps and decoded YAML together.
  return { ...parsed.data, yaml, answers: jsonFile(files.answers), bindings: jsonFile(files.bindings) };
}
