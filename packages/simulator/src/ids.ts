import { hashSeed } from './rng.js';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Prefixes that belong to Razorpay's own id namespace.
 *
 * An id of one of these shapes is the kind a Razorpay engineer recognises on
 * sight, so a synthetic one must say so in the id itself -- see `SIMULATED_MARK`.
 * Everything else the generator mints (`ord_`, `pmt_`, `ful_`, `mdt_`, `rfd_`)
 * is the merchant store's own namespace and cannot be mistaken for theirs.
 */
const RAZORPAY_NAMESPACE = new Set(['pay_', 'disp_', 'order_', 'doc_', 'acc_']);

/**
 * The marker that makes a synthetic id self-declaring: `pay_SIMxxxxxxxxxxx`.
 *
 * P0.2 (obtain real test-mode `pay_` ids) was cut, so these ids are synthetic
 * permanently rather than temporarily -- which changes what honesty requires of
 * them. `pay_LkvKHWZCvw7WFk` is indistinguishable from a real Razorpay payment
 * id, and a judge looking at the queue would have no way to know it is invented.
 * Hard rule #6 says a simulated thing is labelled *wherever it is rendered*; the
 * only way to guarantee that for an id is to put the label inside the id, so no
 * renderer has to remember. Same reasoning as `SimulatorClient`'s `doc_SIM...`.
 *
 * The shape stays valid -- prefix plus 14 base62 characters -- so every schema,
 * every `startsWith('pay_')` check and every payment_id match still holds.
 */
export const SIMULATED_MARK = 'SIM';

/**
 * A deterministic, Razorpay-shaped id: prefix plus 14 base62 characters.
 *
 * Every id is a pure function of its label, so a reseed reproduces it exactly.
 * Ids in Razorpay's namespace carry `SIM` immediately after the prefix.
 */
export function razorpayShapedId(prefix: string, label: string): string {
  const mark = RAZORPAY_NAMESPACE.has(prefix) ? SIMULATED_MARK : '';
  let value = hashSeed(label);
  let out = '';
  for (let i = 0; i < 14 - mark.length; i += 1) {
    value = (Math.imul(value, 0x01000193) + 0x9e3779b9) >>> 0;
    out += BASE62[value % BASE62.length];
  }
  return `${prefix}${mark}${out}`;
}

/** Whether an id announces itself as generated rather than issued by Razorpay. */
export function isSimulatedId(id: string): boolean {
  const underscore = id.indexOf('_');
  if (underscore < 0) return false;
  return id.slice(underscore + 1).startsWith(SIMULATED_MARK);
}
