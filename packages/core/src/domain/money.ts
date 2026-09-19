/**
 * Rendering money for humans and for models.
 *
 * Every amount in this system is an integer number of paise, because that is
 * how Razorpay's API carries amounts and hard rule #1 says the schema wins. That
 * is right for a payload and wrong for anything a person or a model reads: a
 * `165400` handed to a drafter comes back as "INR 165,400" for a dispute worth
 * ₹1,654 (FAILURES.md F-029). So subunits stay in the payload and never leave
 * this repository unformatted anywhere a sentence is being written.
 *
 * The grouping is hand-rolled rather than `toLocaleString('en-IN')`, and that is
 * the whole reason this file exists rather than a one-liner at each call site.
 * `Intl` output depends on the ICU data the runtime was built with, so a
 * small-icu Node would format the same number differently -- and this string
 * goes into an LLM prompt, whose SHA-256 is the replay cache key. A prompt that
 * formats differently on the deploy than on the machine that recorded it is a
 * replay miss in production, which throws. Deterministic in, deterministic out.
 */

/**
 * `165400` -> `₹1,654`. `245635` -> `₹2,456.35`.
 *
 * Indian digit grouping: the last three digits, then pairs. Paise are shown only
 * when they are not zero, which matches how the console renders the same values
 * so a reviewer never sees one amount written two ways on one screen.
 */
export function formatRupees(subunits: number): string {
  const negative = subunits < 0;
  const absolute = Math.abs(Math.round(subunits));
  const rupees = Math.floor(absolute / 100);
  const paise = absolute % 100;

  const digits = String(rupees);
  // The last three digits stand alone; everything above them groups in pairs.
  const tail = digits.slice(-3);
  const head = digits.slice(0, -3);
  const grouped = head === '' ? tail : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;

  const paiseSuffix = paise === 0 ? '' : `.${String(paise).padStart(2, '0')}`;
  return `${negative ? '-' : ''}₹${grouped}${paiseSuffix}`;
}

/**
 * Currencies whose amounts are already whole, with no minor unit.
 *
 * The subset this project handles, not a complete list. Anything absent is
 * treated as two decimals, which is right for every currency Razorpay settles
 * in and is checked against a provider's own documentation before that
 * provider is wired up.
 */
export const ZERO_DECIMAL_CURRENCIES: readonly string[] = [
  'JPY',
  'KRW',
  'VND',
  'CLP',
  'ISK',
  'BIF',
  'DJF',
  'GNF',
  'KMF',
  'PYG',
  'RWF',
  'UGX',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
];

/**
 * An amount in minor units, rendered for a person or a model, in any currency.
 *
 * INR goes through `formatRupees` unchanged, and that is load-bearing rather
 * than tidy: that string reaches prompts, prompts are hashed, and the hash is
 * the replay key (D-007). A different spelling of the same rupee amount would
 * miss every committed recording at once.
 *
 * Everything else gets the ISO code and three-digit grouping. Still no `Intl`:
 * its output depends on the ICU data a runtime was built with, so the same
 * amount could format differently on a deploy than on the machine that
 * recorded the fixtures.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === 'INR') return formatRupees(minorUnits);

  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(code);
  const negative = minorUnits < 0;
  const absolute = Math.abs(Math.round(minorUnits));
  const major = zeroDecimal ? absolute : Math.floor(absolute / 100);
  const minor = zeroDecimal ? 0 : absolute % 100;

  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = minor === 0 ? '' : `.${String(minor).padStart(2, '0')}`;
  return `${negative ? '-' : ''}${code} ${grouped}${fraction}`;
}

/**
 * Field names that carry an amount in subunits, anywhere in a captured evidence
 * detail blob.
 *
 * An explicit list, not a heuristic on the key name. The collector builds these
 * objects (`packages/core/src/domain/collector.ts`) and there are exactly three
 * shapes in play, so guessing from a substring like "amount" would be less
 * accurate and much harder to defend than naming them.
 */
export const MONEY_KEYS: readonly string[] = ['amount', 'orderTotal', 'charged'];

/**
 * Walk a captured detail object and rewrite every money field as rupees.
 *
 * Used on the way into a prompt, never on the way into a payload. The returned
 * object is a copy; the caller's evidence is untouched.
 */
export function withReadableMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withReadableMoney);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      MONEY_KEYS.includes(key) && typeof item === 'number' ? formatRupees(item) : withReadableMoney(item);
  }
  return out;
}
