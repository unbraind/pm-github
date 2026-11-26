/** Property corpus for the strict source-timestamp parser: every real moment passes, every impossible one is refused. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceTimestamp } from "../source-time.ts";

/** Accept one RFC 3339 timestamp and agree with the engine on its instant. */
const accepted = [
  "2026-11-24T18:15:04Z",
  "2026-01-01t00:00:00z",
  "2026-01-01T00:00:00.123456Z",
  "2026-01-01T00:00:00+01:00",
  "2026-02-28T23:30:00-05:30",
  "2028-02-29T00:00:00Z",
];

/** Refuse everything that is not RFC 3339 or names a moment that never existed. */
const refused = [
  undefined, null, 12345, {},
  "", "not-a-timestamp", "2026-01-01", "2026-01-01T00:00:00", "February 31, 2026", "2/31/2026",
  "2026-02-30T03:04:05Z", "2027-02-29T00:00:00Z", "2026-13-01T10:00:00Z", "2026-12-31T23:59:60Z",
  "2026-01-01T00:00:00.1234567890Z",
  "2026-01-01T00:00:00+25:00", "2026-01-01T00:00:00+01:60", "2026-01-01T00:00:00-99:99",
];

test("parseSourceTimestamp accepts real RFC 3339 moments and agrees with the engine", () => {
  for (const value of accepted) {
    const parsed = parseSourceTimestamp(value);
    assert.ok(Number.isFinite(parsed), `${value} must parse`);
    assert.equal(parsed, Date.parse(value), `${value} must denote the same instant the engine reads`);
  }
});

test("parseSourceTimestamp refuses non-strings, free forms and impossible calendar moments", () => {
  for (const value of refused) {
    assert.ok(Number.isNaN(parseSourceTimestamp(value)), `${String(value)} must be refused`);
  }
});

test("leap days parse only in actual leap years", () => {
  for (const year of [2000, 2024, 2028]) {
    assert.ok(Number.isFinite(parseSourceTimestamp(`${year}-02-29T00:00:00Z`)), `${year}-02-29 is a real day`);
  }
  for (const year of [1900, 2023, 2027]) {
    assert.ok(Number.isNaN(parseSourceTimestamp(`${year}-02-29T00:00:00Z`)), `${year} has no February 29`);
  }
});
