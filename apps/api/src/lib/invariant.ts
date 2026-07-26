/**
 * Narrowing helper for values that are `T | undefined` to the type system but
 * guaranteed present by a real invariant (a bounds-checked index, a regex
 * match already tested, a header Fastify always sets). Prefer this over
 * non-null assertions: the invariant is named, and a violation fails loudly
 * at the site instead of surfacing later as an undefined-property error.
 */
export function requireDefined<T>(
  value: T | undefined,
  label: string,
): T {
  if (value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}
