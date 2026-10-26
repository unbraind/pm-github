/** Own-property boundaries for externally named dictionary entries. */

/** Read only a dictionary's own entry, including names shared with Object.prototype. */
export function ownValue<Value>(record: Readonly<Record<string, Value>> | null | undefined, key: string): Value | undefined {
  return record !== undefined && record !== null && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Create an accumulator with no inherited entries or legacy prototype setter. */
export function emptyRecord<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}

/** Define an own data entry without invoking an inherited setter for its name. */
export function setOwnValue<Value>(record: Record<string, Value>, key: string, value: Value): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}
