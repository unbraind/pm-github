// HTTP-boundary tests for the GitHub client stack.
//
// The whole point of this file: exercise the REAL request-building,
// response-parsing, retry/backoff, redirect and pagination code by pointing the
// production HTTP stack at a local server (`PM_GITHUB_API_BASE`), NOT by
// swapping the sync function for a fake. A fake proves the fake's contract; the
// real stack is what actually talks to GitHub and is where a sync tool's damage
// lives (mid-batch errors, rate limits, pagination truncation, token leaks).
//
// Coverage targets (the previously-uncovered failure surface of index.ts):
//   - requestOnce: redirect following, same-origin token forwarding vs.
//     cross-origin token dropping, too-many-redirects, transport errors.
//   - request: 429/5xx/403-rate-limit retry honoring Retry-After, bounded
//     retries, non-retryable statuses throw immediately.
//   - computeBackoffMs: Retry-After, rate-limit reset window, exponential
//     fallback, the 60s cap.
//   - fetchAllIssues: Link-header pagination (empty/single/multi page), and the
//     malformed-JSON / non-array response errors.
//   - fetchComments: the no-comments short-circuit, pagination, and graceful
//     handling of a malformed page mid-stream.
//   - runImport: the 404 → NOT_FOUND and unauthenticated-403 → token-hint error
//     mappings (the failure surface the import command exposes to the shell).

import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandError,
  EXIT_CODE,
  computeBackoffMs,
  fetchAllIssues,
  fetchComments,
  fetchJSON,
  parseImportOptions,
  runImport,
} from "../index.ts";

import {
  captureStderr,
  jsonResponse,
  nextLinkHeader,
  startMockGithub,
  withMockGithub,
} from "./helpers/mock-github-server.ts";

// A complete default ImportOptions for the fetch helpers (they only read the
// URL-shaping fields, but the type requires the full object).
const IMPORT_OPTS = parseImportOptions({});

// Minimal GitHub issue factory for the pagination fixtures. Typed against the
// exported GhIssue so a field rename fails the compile.
function ghIssue(number: number): import("../index.ts").GhIssue {
  return {
    number,
    title: `t${number}`,
    body: "b",
    state: "open",
    labels: [],
    assignee: null,
    milestone: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/a/b/issues/${number}`,
  };
}

function ghComment(id: number): import("../index.ts").GhComment {
  return { id, user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", body: `c${id}` };
}

// ---------------------------------------------------------------------------
// computeBackoffMs — pure (no network). Previously untested.
// ---------------------------------------------------------------------------

test("computeBackoffMs honors Retry-After (seconds → ms), capped at 60s", () => {
  assert.equal(computeBackoffMs({ "retry-after": "5" }, 0), 5000);
  assert.equal(computeBackoffMs({ "retry-after": "0" }, 0), 0, "Retry-After:0 is an instant retry");
  assert.equal(computeBackoffMs({ "retry-after": "120" }, 0), 60_000, "over the cap is clamped to 60s");
  assert.equal(computeBackoffMs({ "retry-after": ["3"] }, 0), 3000, "an array header value is read from index 0");
});

test("computeBackoffMs honors the primary rate-limit reset window when remaining=0", () => {
  // reset 5s in the future → wait (reset - now) + 1s grace = 6000ms.
  assert.equal(
    computeBackoffMs({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1005" }, 0, 1_000_000),
    6000,
  );
  // A far-future reset is clamped to the 60s cap.
  assert.equal(
    computeBackoffMs({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000000" }, 0, 1_000_000),
    60_000,
  );
  // A reset already in the past falls through to exponential backoff.
  assert.equal(
    computeBackoffMs({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }, 0, 1_000_000),
    1000,
    "past reset → exponential fallback, not a negative wait",
  );
  // remaining!=0 never engages the reset window.
  assert.equal(
    computeBackoffMs({ "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1005" }, 0, 1_000_000),
    1000,
  );
});

test("computeBackoffMs exponential fallback: 1s, 2s, 4s … capped at 60s", () => {
  assert.equal(computeBackoffMs({}, 0), 1000);
  assert.equal(computeBackoffMs({}, 1), 2000);
  assert.equal(computeBackoffMs({}, 2), 4000);
  assert.equal(computeBackoffMs({}, 5), 32_000);
  assert.equal(computeBackoffMs({}, 6), 60_000, "1000 * 2**6 = 64000 is clamped to the 60s cap");
});

test("computeBackoffMs falls through on a non-numeric Retry-After", () => {
  assert.equal(computeBackoffMs({ "retry-after": "nope" }, 0), 1000, "garbage is ignored, not NaN");
});

// ---------------------------------------------------------------------------
// fetchJSON / request / requestOnce — real HTTP against a local server.
// ---------------------------------------------------------------------------

test("fetchJSON attaches a Bearer token and returns the parsed FetchResult", async () => {
  await withMockGithub((_req, res) => {
    jsonResponse(res, 200, [{ number: 1, title: "ok" }]);
  }, async (server) => {
    const res = await fetchJSON(`${server.baseUrl}/repos/a/b/issues`, "tok-xyz");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), [{ number: 1, title: "ok" }]);
    assert.equal(server.requests[0]?.headers.authorization, "Bearer tok-xyz");
  });
});

test("fetchJSON omits Authorization when no token is given (unauthenticated read)", async () => {
  await withMockGithub((_req, res) => jsonResponse(res, 200, []), async (server) => {
    await fetchJSON(`${server.baseUrl}/repos/a/b/issues`);
    assert.equal(server.requests[0]?.headers.authorization, undefined);
  });
});

test("fetchJSON retries a 429 honoring Retry-After, then succeeds", async () => {
  let calls = 0;
  await withMockGithub((_req, res) => {
    calls++;
    if (calls === 1) jsonResponse(res, 429, { message: "secondary rate limit" }, { "retry-after": "0" });
    else jsonResponse(res, 200, [ghIssue(1)]);
  }, async (server) => {
    const { stderr } = await captureStderr(() => fetchJSON(`${server.baseUrl}/repos/a/b/issues`, "t"));
    assert.equal(calls, 2, "should have retried exactly once");
    assert.ok(
      stderr.some((l) => /HTTP 429.*retrying/i.test(l)),
      `expected a retry log line, got: ${stderr.join(" | ")}`,
    );
    // Silence unused-var lint on server in case the line is trimmed.
    assert.ok(server.baseUrl);
  });
});

test("fetchJSON retries a 5xx transient error, then succeeds", async () => {
  let calls = 0;
  await withMockGithub((_req, res) => {
    calls++;
    if (calls === 1) jsonResponse(res, 503, "down", { "retry-after": "0" });
    else jsonResponse(res, 200, []);
  }, async (server) => {
    await captureStderr(() => fetchJSON(`${server.baseUrl}/x`, "t"));
    assert.equal(calls, 2, "5xx is retried once then succeeds");
  });
});

test("fetchJSON retries a 403 primary rate limit (remaining=0), then succeeds", async () => {
  let calls = 0;
  await withMockGithub((_req, res) => {
    calls++;
    if (calls === 1) {
      jsonResponse(res, 403, { message: "rate limit" }, {
        "x-ratelimit-remaining": "0",
        "retry-after": "0",
      });
    } else {
      jsonResponse(res, 200, []);
    }
  }, async (server) => {
    await captureStderr(() => fetchJSON(`${server.baseUrl}/x`, "t"));
    assert.equal(calls, 2);
    assert.ok(server.baseUrl);
  });
});

test("fetchJSON gives up after maxRetries on a persistent 429 and throws", async () => {
  let calls = 0;
  await withMockGithub((_req, res) => {
    calls++;
    jsonResponse(res, 429, {}, { "retry-after": "0" });
  }, async (server) => {
    await captureStderr(() =>
      assert.rejects(fetchJSON(`${server.baseUrl}/x`, "t"), /GitHub API returned HTTP 429/),
    );
    assert.equal(calls, 5, "1 initial attempt + 4 retries = 5 requests");
  });
});

test("fetchJSON throws immediately on a non-retryable 404 (no retry)", async () => {
  let calls = 0;
  await withMockGithub((_req, res) => {
    calls++;
    jsonResponse(res, 404, { message: "Not Found" });
  }, async (server) => {
    await assert.rejects(
      fetchJSON(`${server.baseUrl}/repos/a/b`, "t"),
      /GitHub API returned HTTP 404/,
    );
    assert.equal(calls, 1, "a 404 must NOT be retried");
  });
});

test("fetchJSON throws immediately on a non-retryable 422 (validation error)", async () => {
  let calls = 0;
  await withMockGithub((_req, res) => {
    calls++;
    jsonResponse(res, 422, { message: "Validation Failed" });
  }, async (server) => {
    await assert.rejects(fetchJSON(`${server.baseUrl}/x`, "t"), /HTTP 422/);
    assert.equal(calls, 1, "a 422 must NOT be retried");
  });
});

test("requestOnce follows a same-origin redirect and forwards the token", async () => {
  await withMockGithub((req, res, _body, baseUrl) => {
    if (req.url === "/start") {
      res.statusCode = 302;
      res.setHeader("Location", `${baseUrl}/dest`);
      res.end();
    } else {
      jsonResponse(res, 200, { ok: true });
    }
  }, async (server) => {
    const res = await fetchJSON(`${server.baseUrl}/start`, "sekret");
    assert.equal(res.status, 200);
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0]?.url, "/start");
    assert.equal(server.requests[1]?.url, "/dest");
    assert.equal(
      server.requests[1]?.headers.authorization,
      "Bearer sekret",
      "token is forwarded to a same-origin redirect target",
    );
  });
});

test("requestOnce DROPS the token on a cross-origin redirect (no credential leak)", async () => {
  // A second server on a different port = a different origin. The main server
  // 302's to it; the token must NOT cross origins.
  const collector = await startMockGithub((_req, res) => jsonResponse(res, 200, { caught: true }));
  try {
    await withMockGithub((_req, res, _body) => {
      res.statusCode = 302;
      res.setHeader("Location", `${collector.baseUrl}/catch`);
      res.end();
    }, async (server) => {
      const res = await fetchJSON(`${server.baseUrl}/start`, "sekret");
      assert.equal(res.status, 200);
      assert.equal(collector.requests.length, 1, "the cross-origin redirect was followed");
      assert.equal(
        collector.requests[0]?.headers.authorization,
        undefined,
        "the Authorization header must NOT be forwarded to a different origin",
      );
    });
  } finally {
    await collector.close();
  }
});

test("requestOnce rejects after too many redirects instead of looping forever", async () => {
  await withMockGithub((_req, res, _body, baseUrl) => {
    // Every hop redirects again to /loop → an infinite chain absent the cap.
    res.statusCode = 302;
    res.setHeader("Location", `${baseUrl}/loop`);
    res.end();
  }, async (server) => {
    await assert.rejects(fetchJSON(`${server.baseUrl}/loop`, "t"), /too many redirects/);
    assert.ok(
      server.requests.length >= 6,
      `the redirect cap terminates the chain (followed ${server.requests.length})`,
    );
  });
});

test("fetchJSON surfaces a transport error (connection refused) as a rejection", async () => {
  // Loopback port 1 has no listener → ECONNREFUSED, fast and deterministic.
  await assert.rejects(
    fetchJSON("http://127.0.0.1:1/repos/a/b/issues", "t"),
    /ECONNREFUSED/i,
  );
});

// ---------------------------------------------------------------------------
// fetchAllIssues — pagination + response-shape errors (real HTTP).
// ---------------------------------------------------------------------------

test("fetchAllIssues returns [] for an empty single page", async () => {
  await withMockGithub((_req, res) => jsonResponse(res, 200, []), async () => {
    const issues = await fetchAllIssues("a/b", IMPORT_OPTS, "t");
    assert.deepEqual(issues, []);
  });
});

test("fetchAllIssues returns a single page verbatim", async () => {
  await withMockGithub((_req, res) => jsonResponse(res, 200, [ghIssue(1), ghIssue(2)]), async () => {
    const issues = await fetchAllIssues("a/b", IMPORT_OPTS, "t");
    assert.deepEqual(issues.map((i) => i.number), [1, 2]);
  });
});

test("fetchAllIssues pages through the Link header with no silent truncation", async () => {
  await withMockGithub((req, res, _body, baseUrl) => {
    if ((req.url ?? "").includes("page=2")) {
      jsonResponse(res, 200, [ghIssue(3), ghIssue(4)]);
    } else {
      jsonResponse(res, 200, [ghIssue(1), ghIssue(2)], {
        Link: nextLinkHeader(baseUrl, "/repos/a/b/issues?page=2"),
      });
    }
  }, async (server) => {
    const issues = await fetchAllIssues("a/b", IMPORT_OPTS, "page-tok");
    assert.deepEqual(issues.map((i) => i.number), [1, 2, 3, 4]);
    assert.equal(server.requests.length, 2, "both pages were fetched");
    // The token rides on every page request, not just the first.
    for (const r of server.requests) {
      assert.equal(r.headers.authorization, "Bearer page-tok");
    }
  });
});

test("fetchAllIssues throws on a malformed JSON body", async () => {
  await withMockGithub((_req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("not json at all");
  }, async () => {
    await assert.rejects(fetchAllIssues("a/b", IMPORT_OPTS, "t"), /Invalid JSON response from GitHub/);
  });
});

test("fetchAllIssues throws on a non-array (object) response", async () => {
  await withMockGithub((_req, res) => jsonResponse(res, 200, { message: "unexpected shape" }), async () => {
    await assert.rejects(fetchAllIssues("a/b", IMPORT_OPTS, "t"), /Unexpected GitHub API response/);
  });
});

// ---------------------------------------------------------------------------
// fetchComments — the no-comments short-circuit, pagination, malformed page.
// ---------------------------------------------------------------------------

test("fetchComments skips the network entirely when the issue has no comments", async () => {
  await withMockGithub((_req, res) => jsonResponse(res, 200, []), async (server) => {
    const issue: import("../index.ts").GhIssue = {
      number: 1, title: "t", body: null, state: "open", labels: [],
      assignee: null, milestone: null, created_at: "", updated_at: "", html_url: "",
      comments: 0,
    };
    const out = await fetchComments(issue, "a/b", "t");
    assert.deepEqual(out, []);
    assert.equal(server.requests.length, 0, "no HTTP call is made when comments <= 0");
  });
});

test("fetchComments pages through the comments Link header", async () => {
  await withMockGithub((req, res, _body, baseUrl) => {
    if ((req.url ?? "").includes("page=2")) {
      jsonResponse(res, 200, [ghComment(3)]);
    } else {
      jsonResponse(res, 200, [ghComment(1), ghComment(2)], {
        Link: nextLinkHeader(baseUrl, "/repos/a/b/issues/1/comments?page=2"),
      });
    }
  }, async () => {
    const issue: import("../index.ts").GhIssue = {
      number: 1, title: "t", body: null, state: "open", labels: [],
      assignee: null, milestone: null, created_at: "", updated_at: "", html_url: "",
      comments: 3,
    };
    const out = await fetchComments(issue, "a/b", "t");
    assert.deepEqual(out.map((c) => c.id), [1, 2, 3]);
  });
});

test("fetchComments tolerates a malformed page mid-stream (keeps earlier pages)", async () => {
  await withMockGithub((req, res, _body, baseUrl) => {
    if ((req.url ?? "").includes("page=2")) {
      res.setHeader("Content-Type", "text/plain");
      res.end("garbage");
    } else {
      jsonResponse(res, 200, [ghComment(1)], {
        Link: nextLinkHeader(baseUrl, "/repos/a/b/issues/1/comments?page=2"),
      });
    }
  }, async () => {
    const issue: import("../index.ts").GhIssue = {
      number: 1, title: "t", body: null, state: "open", labels: [],
      assignee: null, milestone: null, created_at: "", updated_at: "", html_url: "",
      comments: 1,
    };
    const out = await fetchComments(issue, "a/b", "t");
    assert.deepEqual(out.map((c) => c.id), [1], "page-1 comments are kept; the malformed page breaks the loop");
  });
});

// ---------------------------------------------------------------------------
// runImport — the failure surface it exposes to the shell (real fetch path).
// ---------------------------------------------------------------------------

test("runImport maps a 404 from the issues endpoint to a NOT_FOUND CommandError", async () => {
  await withMockGithub((_req, res) => jsonResponse(res, 404, { message: "Not Found" }), async () => {
    await captureStderr(async () => {
      await assert.rejects(
        runImport("acme/widgets", "/unused", parseImportOptions({}), { resolveToken: () => "tok" }),
        (err: unknown) =>
          err instanceof CommandError &&
          err.exitCode === EXIT_CODE.NOT_FOUND &&
          /Failed to fetch/.test((err as Error).message),
      );
    });
  });
});

test("runImport adds the token hint when an unauthenticated request hits a 403", async () => {
  await withMockGithub((_req, res) => jsonResponse(res, 403, { message: "rate limit exceeded" }), async () => {
    let caught: unknown;
    await captureStderr(async () => {
      try {
        await runImport("acme/widgets", "/unused", parseImportOptions({}), { resolveToken: () => undefined });
      } catch (err) {
        caught = err;
      }
    });
    assert.ok(caught instanceof CommandError, "should throw a CommandError");
    const err = caught as CommandError;
    assert.match(err.message, /HTTP 403/);
    assert.match(err.message, /set GITHUB_TOKEN/, "the actionable token hint must be appended");
    assert.equal(err.exitCode, EXIT_CODE.GENERIC_FAILURE);
  });
});
