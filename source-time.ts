/**
 * Strict source-timestamp admission shared by every path that persists a
 * provider-supplied time.
 */

/** One RFC 3339 date-time with its declared calendar fields, fraction and offset. */
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parse one source timestamp as a real calendar moment, rejecting normalized
 * rollovers and every non-RFC-3339 spelling.
 *
 * JavaScript date parsing accepts impossible calendar dates (`2026-02-30`
 * becomes March 2) and many free-form strings (`February 31, 2026` rolls
 * over, `2/31/2026` too). Persisting such a value would keep a time that
 * never existed while later readers disagree about it. Every declared field
 * must therefore survive a read-back unchanged, which rejects rolled or
 * out-of-range years, months, days and clock fields while keeping real
 * moments like the leap day `2028-02-29T00:00:00Z` accepted. RFC 3339 `Z`
 * and numeric-offset forms both parse; the caller stores the original
 * spelling, so the instant and the text stay in agreement.
 *
 * @param value - The provider-supplied timestamp to admit.
 * @returns The parsed epoch milliseconds, or `Number.NaN` when the value is
 * absent, not RFC 3339, or names an impossible calendar moment.
 */
export function parseSourceTimestamp(value: unknown): number {
  const match = typeof value === "string" ? RFC3339_TIMESTAMP.exec(value) : null;
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(index => Number(match[index]));
  const sign = match[8] === "-" ? -1 : 1;
  const offsetHours = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinutes = match[10] === undefined ? 0 : Number(match[10]);
  if (offsetHours > 23 || offsetMinutes > 59) return Number.NaN;
  const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs;
  const read = new Date(epoch + offsetMs);
  // Date.UTC rolls impossible dates forward instead of refusing them, so the
  // declared fields must read back exactly; anything else never happened.
  return read.getUTCFullYear() === year && read.getUTCMonth() === month - 1 && read.getUTCDate() === day &&
    read.getUTCHours() === hour && read.getUTCMinutes() === minute && read.getUTCSeconds() === second ? epoch : Number.NaN;
}
