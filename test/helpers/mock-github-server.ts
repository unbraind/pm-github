// A local HTTP server that stands in for the GitHub REST + GraphQL API.
//
// The pm-github HTTP stack (`requestOnce` → `request` → `fetchJSON` /
// `fetchAllIssues` / `fetchComments` / the GraphQL + sync handlers) builds real
// requests, parses real responses, and runs the real retry/backoff/redirect
// logic. Pointing that stack at this server (via the `PM_GITHUB_API_BASE`
// override the production code now reads) exercises every one of those paths
// without a single packet leaving the machine — and crucially WITHOUT mocking
// the unit under test. A test that swaps the sync function for a fake proves
// nothing about how the real code behaves when GitHub returns a 429 mid-page.
//
// The server records every incoming request (method, path, headers, body) so a
// test can assert on the exact wire shape the client produced — the Authorization
// header, the Link-header pagination cursor, the PATCH payload — exactly as a
// real GitHub would observe them.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One inbound request the server received, captured verbatim for assertions. */
export interface RecordedRequest {
  method: string;
  /** The path + query string the client requested (no origin). */
  url: string;
  /** Raw request headers (Node lowercases header names). */
  headers: Record<string, string | string[] | undefined>;
  /** The decoded UTF-8 request body (empty for GET). */
  body: string;
}

/**
 * Per-request handler. Receives the live request/response pair plus the already
 * buffered body so handlers do not have to manage stream draining. `baseUrl` is
 * the server's own origin, so a handler can emit absolute `Link: rel="next"`
 * URLs exactly the way the real GitHub API does (the client requests those URLs
 * verbatim). Throwing from a handler fails the request with a 500 (and surfaces
 * the error to the test via the server's `error` event) rather than hanging the
 * socket.
 */
export type MockGithubHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  baseUrl: string,
) => void;

/** The handle to a running mock server. */
export interface MockGithubServer {
  /** Origin the client must target, e.g. `http://127.0.0.1:39291`. */
  baseUrl: string;
  /** Every request the server has received, in arrival order. */
  requests: RecordedRequest[];
  /** Stop the server. Safe to call once; resolves once the socket is freed. */
  close(): Promise<void>;
}

/**
 * Start a mock GitHub API server on an ephemeral loopback port.
 *
 * `handler` is invoked for every request with the decoded body. Each request is
 * recorded on {@link MockGithubServer.requests} for assertion. Returns the base
 * URL plus a `close()` for teardown.
 */
export function startMockGithub(handler: MockGithubHandler): Promise<MockGithubServer> {
  const requests: RecordedRequest[] = [];
  // Filled in once `listen` resolves; the request listener closes over it so a
  // handler can build absolute next-page URLs against the server's real origin.
  let baseUrl = "";
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      });
      try {
        handler(req, res, body, baseUrl);
      } catch (err: unknown) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(`mock handler threw: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          res.destroy();
        }
      }
    });
    req.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  return new Promise<MockGithubServer>((resolve) => {
    // listen(0) asks the OS for an ephemeral port so parallel test processes
    // never collide on a fixed one.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        requests,
        close: () =>
          new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

/**
 * Write a JSON response. `headers` (e.g. a `Link` or `Retry-After`) are set
 * before the body so the client sees the full header set on every status.
 */
export function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.statusCode = status;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.setHeader("Content-Type", "application/json");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * Run `fn` against a fresh mock server with `PM_GITHUB_API_BASE` pointed at it.
 *
 * The env override is set before `fn` runs and restored (or deleted) afterwards
 * so one test's override can never leak into another. The server is closed in
 * `finally` even if `fn` rejects. This is the seam every HTTP-boundary test
 * shares: production code reads the env at call time, so flipping it here routes
 * the real request stack at the local server with no internals mocked.
 */
export async function withMockGithub<T>(
  handler: MockGithubHandler,
  fn: (server: MockGithubServer) => Promise<T>,
): Promise<T> {
  const server = await startMockGithub(handler);
  const prev = process.env.PM_GITHUB_API_BASE;
  process.env.PM_GITHUB_API_BASE = server.baseUrl;
  try {
    return await fn(server);
  } finally {
    if (prev === undefined) delete process.env.PM_GITHUB_API_BASE;
    else process.env.PM_GITHUB_API_BASE = prev;
    await server.close();
  }
}

/**
 * Build a GitHub-style `Link` header pointing at the next page. The URL is
 * absolute (against the server's own origin) because that is exactly what the
 * real GitHub API emits and what `parseNextLink` extracts verbatim.
 */
export function nextLinkHeader(baseUrl: string, pathAndQuery: string): string {
  return `<${baseUrl}${pathAndQuery}>; rel="next"`;
}

/**
 * Silence `console.error` for the duration of `fn`, returning the captured
 * lines. The retry/backoff path and several command handlers emit progress to
 * stderr; capturing (not inheriting) keeps the test reporter readable while
 * still letting a test assert on a specific message.
 */
export async function captureStderr<T>(fn: () => Promise<T>): Promise<{ stderr: string[]; result: T }> {
  const stderr: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { stderr, result };
  } finally {
    console.error = original;
  }
}
