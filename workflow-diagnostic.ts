/** Produce one workflow refusal while keeping raw command output private. */
import { readFileSync } from "node:fs";
import { scanLineForRuleHits } from "./gate.ts";
import { ownValue } from "./own-record.ts";

/** Generic wrappers provide no cause and must not override a specific receipt. */
function genericFailure(reason: string): boolean {
  const value = reason.replace(/(?: No branch was published\.)+$/, "").trim();
  return /^(?:error:\s*)?command failed[.!]?$/i.test(value) || value.startsWith("Command produced no usable failure receipt;");
}

/** Read a cause block without promoting help headings or stack frames to failures. */
function firstCause(lines: readonly string[]): string | undefined {
  let fallback: string | undefined;
  for (const line of lines) {
    if (!line) continue;
    if (/^(?:What is required|What happened|Why|Examples|Recovery(?: bundle)?):|^at\s/.test(line)) break;
    const reason = line.replace(/^(?:Cause|Caused by):\s*/i, "");
    if (!genericFailure(reason)) return reason;
    fallback ??= reason;
  }
  return fallback;
}

/** Select specific text causes while excluding host help sections and stack frames. */
function textFailure(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const heading = lines.indexOf("What happened:");
  const happened = heading >= 0 ? firstCause(lines.slice(heading + 1)) : undefined;
  if (happened && !genericFailure(happened)) return { reason: happened };
  const errors = lines.flatMap((line, index) => {
    const match = /^error:\s*(.+)/i.exec(line);
    return match ? [{ reason: match[1]!, index }] : [];
  });
  const specific = errors.find(error => !genericFailure(error.reason));
  if (specific) return { reason: specific.reason };
  const first = errors[0];
  return first ? { reason: firstCause(lines.slice(first.index + 1)) ?? first.reason } : happened ? { reason: happened } : {};
}

/** Decode a CLI report or the JSON diagnostic following stderr progress messages. */
export function decodeWorkflowDiagnostic(text: string, depth = 0): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text.slice(Math.max(0, text.indexOf("{"))));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const report = value as Record<string, unknown>;
    if (typeof report.detail === "string" && depth < 2) {
      const nested = decodeWorkflowDiagnostic(report.detail, depth + 1);
      return Object.keys(nested).length ? nested : { reason: report.detail };
    }
    return report;
  } catch {
    // Older hosts and subprocess failures can emit human-readable stderr even
    // when --json was requested. Select the actual failure, not help/recovery.
    return textFailure(text);
  }
}

/** Mask complete original-source spans, including encoded and overlapping matches. */
export function redactWorkflowFailure(reason: string): string {
  const hits = scanLineForRuleHits(reason);
  const spans: { start: number; end: number }[] = [];
  for (const hit of hits.sort((left, right) => left.index - right.index)) {
    const previous = spans.at(-1);
    const end = hit.end;
    if (previous && hit.index <= previous.end) previous.end = Math.max(previous.end, end);
    else spans.push({ start: hit.index, end });
  }
  let result = "", offset = 0;
  for (const span of spans) {
    result += reason.slice(offset, span.start) + "[redacted]";
    offset = span.end;
  }
  return result + reason.slice(offset);
}

/** Read an optional receipt; missing or malformed files never expose their paths. */
function receipt(file: string | undefined): string {
  try { return readFileSync(file!, "utf8"); } catch { return ""; }
}

/** Pick one actionable failure; the workflow privacy-scans the resulting text before logging it. */
export function workflowFailure(report: Record<string, unknown>, diff = ""): string {
  if (diff) {
    const item = /\/(?:[^/\s]+\/)*([a-zA-Z0-9_-]+)\.toon\b/.exec(diff)?.[1];
    const field = /^[+-]([a-z][a-z0-9_]*):/m.exec(diff)?.[1];
    return `Repeat import changed ${item ?? "tracker state"}${field ? ` field ${field}` : ""}; retry with the current pm-github release and inspect concurrent source changes. No branch was published.`;
  }
  if (Array.isArray(report.findings) && report.findings.length) {
    const finding = decodeWorkflowDiagnostic(JSON.stringify(report.findings[0]));
    return `Import privacy gate refused item ${finding.item_id}, field ${finding.field}, rule ${finding.rule}; remove the source content or review an explicit gate allowlist entry. No branch was published.`;
  }
  if (Array.isArray(report.plan)) {
    for (const value of report.plan) {
      const row = decodeWorkflowDiagnostic(JSON.stringify(value));
      const missing = Array.isArray(row.missing_evidence) ? row.missing_evidence.map(entry => decodeWorkflowDiagnostic(JSON.stringify(entry))) : [];
      const failed = missing.find(entry => entry.code === "close_failed");
      if (failed || row.action === "skip" && ["head_evidence_unavailable", "required_checks_unverified", "incomplete_merge"].includes(String(row.code))) {
        return `Closeout refused item ${row.item}, PR #${row.pr}: ${failed ? failed.reason : row.reason} No branch was published.`;
      }
    }
  }
  const reason = ownValue(report, "reason");
  return typeof reason === "string" ? `${reason} No branch was published.`
    : "Command produced no usable failure receipt; rerun the failed command with --json using the same tracker and token permissions. No branch was published.";
}

/** Assemble a private candidate diagnostic from stdout, stderr and an optional repeat-import diff. */
export function readWorkflowFailure(reportFile: string | undefined, errorFile: string | undefined, diffFile: string | undefined): { reason: string } {
  const output = decodeWorkflowDiagnostic(receipt(reportFile));
  const error = decodeWorkflowDiagnostic(receipt(errorFile));
  const fullFailure = output.command === "github closeout" && typeof output.failed === "number" && output.failed > 0;
  const diff = receipt(diffFile);
  const outputReason = workflowFailure(output, diff);
  const errorReason = workflowFailure(error, diff);
  const preferOutput = !genericFailure(outputReason) && (fullFailure || genericFailure(errorReason));
  const reason = preferOutput || !Object.keys(error).length ? outputReason : errorReason;
  return { reason: redactWorkflowFailure(reason) };
}
