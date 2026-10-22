# Webhook inbox example

Receive an `issues` delivery from an adapter that preserves the exact request
body bytes and original headers. Configure a high-entropy webhook secret through
`PM_GITHUB_WEBHOOK_SECRET` using your deployment's secret manager. The secret is
separate from the GitHub API token used for reconciliation. The adapter must
supply an explicit expected repository and respond successfully only after
intake returns `ok: true`.

```sh
pm github webhook receive example/project --payload delivery.json \
  --delivery "$DELIVERY_ID" --event "$EVENT_TYPE" --signature "$SIGNATURE" --json
pm github webhook reconcile example/project --limit 20 --json
# Review a fresh full diff before applying through the existing polling route:
pm github refresh example/project --dry-run
pm github refresh example/project --atomic
```

JSON uses the host's `--json`; its default output is compact TOON. No receiver,
network listener or scheduled worker is installed. Your adapter supplies the
payload file and delivery headers; it owns HTTP transport, body size limits,
rate limits and secret rotation. Signature verification uses HMAC-SHA256 over
the original bytes and a constant-time comparison, before parsing or writing.
The secret must match the webhook configuration. See GitHub's
[signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [delivery guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
GitHub signs the body; the adapter must preserve the associated headers.

```ts
import {
  acceptGithubWebhook, reconcileGithubWebhooks, WebhookRefusal,
  type GithubWebhookDelivery,
} from 'pm-github';

/** Intake receives the exact original body, not JSON.stringify(parsedBody). */
async function receive(pmRoot: string, event: GithubWebhookDelivery) {
  try {
    return await acceptGithubWebhook(pmRoot, event);
  } catch (error) {
    if (error instanceof WebhookRefusal) {
      return { ok: false, code: error.code, remedy: error.remedy };
    }
    throw error;
  }
}

const report = await reconcileGithubWebhooks(pmRoot, 'example/project', 20);
// report.proposals contains item IDs, field names and lifecycle deltas.
// No item is created or changed by receive/reconcile.
```

The durable inbox lives under the tracker's `github-webhooks` directory, with
repository and delivery names hashed. Include it in deployment backups; it is
ignored by git and is not a disposable runtime cache. Intake stores only the
schema version, repository, delivery ID, payload SHA256 and issue number.
It never persists raw payloads, signatures or secrets. The same delivery and
bytes are a duplicate even after reconciliation. Reusing an ID with different
bytes refuses with `delivery_conflict`. Delivery IDs are repository scoped.
Receipts are retained indefinitely for deduplication; deleting them permits
replay and should be an explicit operator retention decision.

Intake writers share a token-owned tracker lock. Reconciliation uses a separate
processor lock so a slow provider read never blocks intake. It reads immutable,
atomically published hints; deliveries arriving during a batch remain for the
next reconciliation. Counts describe the selected snapshot. Intake acknowledges after atomic
publication and file/directory flushes on a local POSIX filesystem. The lock
never reclaims an existing writer lock based on age alone. If a worker crashes,
inspect its lock and confirm the worker has stopped before explicitly recovering
the stale lock through the host. Partial atomic-write temporary files are ignored.
Retrying after lock recovery is safe. This filesystem inbox requires an
initialized local tracker path; remote clients should invoke it at the owning
filesystem service rather than invent a local path for a remote tracker.

Reconciliation defaults to 20 deliveries, capped at 100, coalesces issue numbers,
and queries only already-linked owners. A `closed` event followed by an older
`reopened` event still proposes the current provider state. Actual provider
reopening can produce an open proposal. Events never directly set statuses.
Unknown owners are acknowledged as `unlinked`, without importing anything;
later linking is recovered by polling. Missing/inaccessible provider state and
provider failures retain pending deliveries. An unfinished import refuses
preview until polling refresh recovers it. A durable repository-scoped cursor
rotates through pending deliveries, wrapping at the end. It advances before
provider reads, including failed batches, so retrying hints cannot starve later
deliveries. Retries remain pending and are revisited on subsequent passes.

Each successful hint gets an atomic `.done.json` receipt containing a timestamp
and its compact proposal. A crash after receipt publication but before response
can lose the caller's response, so inspect that receipt or run a fresh polling
preview. Proposals are observations, not reusable apply tokens; always re-read
provider state before applying. The default report bounds rows and excludes
issue bodies, titles and full tag lists. Its `remaining`, `retry` and `unlinked`
counts make incomplete work explicit. Persistent receipts contain only compact
lifecycle changes, not the full provider projection.

Typed refusal codes include `invalid_signature`, `invalid_event`,
`invalid_options`, `delivery_conflict`, `inbox_corrupt`, `inbox_unavailable` and
`provider_unavailable`. Every refusal includes a remedy and exits nonzero in
the CLI. Invalid signatures perform zero inbox or item writes, including when
the inbox does not exist. Unsupported event types, pull request payloads and
repository mismatches also refuse. Polling `github refresh` continues to work
independently of webhook configuration or delivery availability.
