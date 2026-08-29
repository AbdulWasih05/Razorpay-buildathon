/**
 * Canonical serialisation, for proving "same seed -> logically identical store".
 *
 * Two seeded runs can never be byte-identical at the row level: `id` is a
 * server-generated cuid and `createdAt` is server wall-clock. Both are real,
 * both are meaningless to the domain, and both differ every run. So the
 * comparison excludes them by name and compares everything else.
 *
 * Deliberately not a general-purpose deep-equal: it is a *stable string*, so a
 * failing determinism test produces a readable diff instead of "objects differ".
 */

/**
 * Row identity and creation time are assigned by Postgres/Prisma, not by the
 * seed. Excluded from every comparison. See DECISIONS.md D-007.
 */
export const SERVER_GENERATED_KEYS = ['id', 'createdAt'] as const;

export interface CanonicaliseOptions {
  /** Additional keys to drop, e.g. relation ids that point at server cuids. */
  exclude?: readonly string[];
}

/**
 * Foreign keys hold server-generated cuids, so they vary between runs exactly
 * as `id` does. The *relationship* is still checked -- it survives as nesting
 * in the readback shape.
 */
const DEFAULT_RELATION_KEYS = [
  'merchantId',
  'customerId',
  'orderId',
  'mandateId',
  'paymentId',
  'evidencePackId',
  'traceId',
  'disputeId',
] as const;

function normalise(value: unknown, excluded: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) return null;

  // Dates compare as instants, not as whatever the driver handed back.
  if (value instanceof Date) return `date:${value.toISOString()}`;

  // Prisma returns Decimal-like objects and BigInt for some column types.
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;

  if (Array.isArray(value)) return value.map((item) => normalise(item, excluded));

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !excluded.has(key))
      // Key order must not matter: a `select` reorder is not a data change.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, normalise(item, excluded)] as const);
    return Object.fromEntries(entries);
  }

  return value;
}

/**
 * Stable, human-diffable JSON with server-generated fields removed.
 * Feed it two seeded runs; identical strings mean logically identical data.
 */
export function canonicalise(value: unknown, options: CanonicaliseOptions = {}): string {
  const excluded = new Set<string>([
    ...SERVER_GENERATED_KEYS,
    ...DEFAULT_RELATION_KEYS,
    ...(options.exclude ?? []),
  ]);
  return JSON.stringify(normalise(value, excluded), null, 2);
}
