/** Durable authenticated issue-event hints; provider reads, never event payloads, produce proposals. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { open, mkdir, readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { acquireLock, writeFileAtomic, resolvePmRoot, ensureTrackerInitialized } from "@unbrained/pm-cli/sdk";
import { runRefresh } from "./refresh.ts";

/** Stable refusal discriminators; no secret, payload or storage path is included in diagnostics. */
export type WebhookRefusalCode = "invalid_signature" | "invalid_event" | "invalid_options" | "delivery_conflict" | "inbox_corrupt" | "inbox_unavailable" | "provider_unavailable";
/** A machine-readable refusal with an actionable, public-safe remedy. */
export class WebhookRefusal extends Error {
  /** Recognized by the pm command host as a handled failure, preventing handler replay. */
  readonly exitCode = 1;
  /** Stable discriminator shared by SDK and CLI diagnostics. */
  readonly code: WebhookRefusalCode;
  /** Public-safe instructions for recovering from this refusal. */
  readonly remedy: string;
  /** Construct a typed refusal with a compact JSON diagnostic for CLI callers. */
  constructor(code: WebhookRefusalCode, remedy: string) {
    super(JSON.stringify({ ok: false, code, remedy }));
    this.name = "WebhookRefusal";
    this.code = code;
    this.remedy = remedy;
  }
}
/** Exact bytes and delivery headers supplied by the receiving adapter; secret stays in memory. */
export interface GithubWebhookDelivery {
  repo: string;
  delivery: string;
  event: string;
  signature: string;
  secret: string;
  payload: Uint8Array;
}
/** Minimal durable identity; raw payloads and credentials are never persisted. */
interface InboxRecord {
  version: 1;
  delivery: string;
  digest: string;
  repo: string;
  number: number;
}
/** Compact proposed updates; fetch full values with polling refresh --dry-run before applying. */
export interface WebhookProposal {
  id: string;
  number: number;
  fields: string[];
  lifecycle: Array<{ field: string; old: unknown; new: unknown }>;
}
/** A bounded reconciliation receipt, also persisted for operator inspection. */
export interface WebhookReconciliation {
  ok: true;
  repo: string;
  selected: number;
  remaining: number;
  reconciled: number;
  retry: number;
  unlinked: number;
  proposals: WebhookProposal[];
  recovery: string;
}

/** Normalize an explicit repository boundary before opening storage. */
function repository(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new WebhookRefusal("invalid_options", "Supply an explicit owner/repo.");
  return value.toLowerCase();
}
/** Narrow untrusted JSON without assuming the provider schema. */
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Hash public identities into fixed-length storage names. */
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Preserve typed refusals while hiding native errors that may include paths or payloads. */
function refusal(error: unknown, code: WebhookRefusalCode, remedy: string): never {
  if (error instanceof WebhookRefusal) throw error;
  throw new WebhookRefusal(code, remedy);
}
/** Flush published records and the containing directory before acknowledging durable intake. */
async function persist(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value) + "\n");
  await flush(file);
}
/** Finish a prior publisher's flush as well as a fresh receipt's durable acknowledgment. */
async function flush(file: string): Promise<void> {
  for (const target of [file, join(file, ".."), join(file, "../.."), join(file, "../../..")]) {
    const handle = await open(target, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
/** Serialize independent writers using the host's token-owned, crash-recoverable tracker lock. */
async function locked<T>(pmRoot: string, repo: string, operation: (directory: string) => Promise<T>, lockId = "github-webhooks"): Promise<T> {
  try {
    pmRoot = resolvePmRoot(process.cwd(), pmRoot);
    await ensureTrackerInitialized(pmRoot);
    // Age alone cannot prove a worker is dead while it awaits provider or disk I/O.
    const release = await acquireLock(pmRoot, lockId, 300, "pm-github", false, true, 5000);
    try {
      const parent = join(pmRoot, "github-webhooks");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const directory = join(parent, hash(repo));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return await operation(directory);
    } finally { await release(); }
  } catch (error) {
    refusal(error, "inbox_unavailable", "Restore initialized writable local tracker storage; inspect stale locks and recover only after confirming their worker has stopped, then retry; retain github-webhooks receipts.");
  }
}
/** Authenticate exact bytes before parsing, locking, initializing storage or performing any write. */
export async function acceptGithubWebhook(pmRoot: string, input: GithubWebhookDelivery): Promise<{ ok: true; repo: string; delivery: string; duplicate: boolean }> {
  if (!input.secret || !/^sha256=[a-f0-9]{64}$/.test(input.signature) ||
    !timingSafeEqual(createHmac("sha256", input.secret).update(input.payload).digest(), Buffer.from(input.signature.slice(7), "hex"))) {
    throw new WebhookRefusal("invalid_signature", "Supply the original unmodified payload bytes, X-Hub-Signature-256 and the matching webhook secret.");
  }
  const repo = repository(input.repo);
  if (input.event !== "issues" || !/^[A-Za-z0-9-]{1,128}$/.test(input.delivery) || input.payload.byteLength > 25 * 1024 * 1024) {
    throw new WebhookRefusal("invalid_event", "Supply an issues event, its original X-GitHub-Delivery identifier and a payload of at most 25 MiB.");
  }
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(Buffer.from(input.payload).toString("utf8"))); }
  catch { throw new WebhookRefusal("invalid_event", "Supply the signed GitHub JSON payload without re-encoding it."); }
  const issue = object(payload.issue);
  const source = object(payload.repository);
  if (typeof payload.action !== "string" || !payload.action.trim() || typeof source.full_name !== "string" || source.full_name.toLowerCase() !== repo ||
    !Number.isSafeInteger(issue.number) || Number(issue.number) < 1 || Object.hasOwn(issue, "pull_request")) {
    throw new WebhookRefusal("invalid_event", "Supply an issue event from the explicitly selected repository; pull requests and ambiguous identities are unsupported.");
  }
  const record: InboxRecord = { version: 1, repo, delivery: input.delivery, digest: hash(input.payload), number: Number(issue.number) };
  pmRoot = resolvePmRoot(process.cwd(), pmRoot);
  return locked(pmRoot, repo, async directory => {
    const file = join(directory, `${hash(record.delivery)}.json`);
    if ((await readdir(directory)).includes(`${hash(record.delivery)}.json`)) {
      const existing = await readRecord(file, repo);
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new WebhookRefusal("delivery_conflict", "The delivery identifier already names different bytes; retain both source receipts and investigate the adapter.");
      // A previous process may have died after rename but before its flush.
      await flush(file);
      return { ok: true, repo, delivery: record.delivery, duplicate: true };
    }
    await persist(file, record);
    return { ok: true, repo, delivery: record.delivery, duplicate: false };
  });
}
/** Refuse malformed durable hints before fetching or acknowledging any selected delivery. */
async function readRecord(file: string, repo: string): Promise<InboxRecord> {
  try {
    const value = object(JSON.parse(await readFile(file, "utf8")));
    if (value.version !== 1 || value.repo !== repo || typeof value.delivery !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value.delivery) ||
      typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.number) || Number(value.number) < 1 ||
      basename(file) !== `${hash(value.delivery)}.json`) throw new Error("invalid record");
    return { version: 1, repo, delivery: value.delivery, digest: value.digest, number: Number(value.number) };
  } catch { throw new WebhookRefusal("inbox_corrupt", "Restore the affected delivery receipt from backup or redelivery; do not delete the inbox. Poll with github refresh meanwhile."); }
}
/** Read current provider state once per linked issue, persist compact proposals, and leave failed hints retryable. */
export async function reconcileGithubWebhooks(pmRoot: string, repoArg: string, limit = 20): Promise<WebhookReconciliation> {
  const repo = repository(repoArg);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WebhookRefusal("invalid_options", "Use a delivery limit from 1 to 100 (default 20).");
  pmRoot = resolvePmRoot(process.cwd(), pmRoot);
  return locked(pmRoot, repo, async directory => {
    const names = new Set(await readdir(directory));
    const files = [...names].filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort();
    const selected = files.filter(file => !names.has(file.replace(".json", ".done.json")));
    let after = "";
    if (names.has("cursor.json")) {
      try {
        const cursor = object(JSON.parse(await readFile(join(directory, "cursor.json"), "utf8")));
        if (typeof cursor.after !== "string" || !/^[a-f0-9]{64}\.json$/.test(cursor.after)) throw new Error("invalid cursor");
        after = cursor.after;
      } catch { throw new WebhookRefusal("inbox_corrupt", "Restore the reconciliation cursor from backup; retain delivery receipts and poll with github refresh meanwhile."); }
    }
    const batch = [...selected.filter(file => file > after), ...selected.filter(file => file <= after)].slice(0, limit);
    const records = await Promise.all(batch.map(file => readRecord(join(directory, file), repo)));
    // Advance even when a provider request throws, so retries cannot starve later hints.
    if (batch.length) await persist(join(directory, "cursor.json"), { after: batch[batch.length - 1] });
    let preview: Awaited<ReturnType<typeof runRefresh>> | undefined;
    try { preview = records.length ? await runRefresh(repo, pmRoot, { "dry-run": true }, { numbers: records.map(record => record.number) }) : undefined; }
    catch (error) { refusal(error, "provider_unavailable", "Retry reconciliation after restoring GitHub access or completing unfinished imports with github refresh; pending deliveries are retained."); }
    const proposals: WebhookProposal[] = [];
    for (const row of preview?.plan ?? []) {
      if (row.changes.length) proposals.push({ id: row.id, number: row.number, fields: row.changes.map(change => change.field),
        lifecycle: row.changes.filter(change => ["status", "github_state", "github_updated_at", "closed_at", "completed_at"].includes(change.field)) });
    }
    let reconciled = 0;
    let unlinked = 0;
    for (const record of records) {
      const row = preview!.plan.find(entry => entry.number === record.number);
      if (row?.reason) continue;
      if (!row) unlinked++;
      await persist(join(directory, `${hash(record.delivery)}.done.json`), { delivery: record.delivery, reconciledAt: new Date().toISOString(),
        outcome: row ? "proposed" : "unlinked", proposals: proposals.filter(proposal => proposal.number === record.number) });
      reconciled++;
    }
    return { ok: true, repo, selected: records.length, remaining: selected.length - reconciled, reconciled, retry: records.length - reconciled, unlinked,
      proposals, recovery: `pm github refresh ${repo} --dry-run` };
  }, "github-webhooks-reconcile");
}
