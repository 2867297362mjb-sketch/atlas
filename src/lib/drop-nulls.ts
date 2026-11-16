/** `T` with `null` taken out of every property's type. Optional stays optional. */
export type NullsDropped<T> = { [K in keyof T]: Exclude<T[K], null> };

/**
 * A copy of `value` without the properties that are `null`.
 *
 * For a payload from Rust, where an empty `Option` arrives as `null`: the
 * stores hold "no value" as an absent key, and an absent key is what serde
 * reads back as `None`, so nothing is lost either way. One level deep.
 */
export function dropNulls<T extends object>(value: T): NullsDropped<T> {
  const out: Partial<Record<keyof T, unknown>> = {};
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== null) out[key] = value[key];
  }
  return out as NullsDropped<T>;
}
