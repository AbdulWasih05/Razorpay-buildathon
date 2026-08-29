import { hashSeed } from './rng.js';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A deterministic, Razorpay-shaped id: prefix plus 14 base62 characters.
 *
 * Synthetic until P0.2 lands real test-mode ids, at which point the `pay_` ones
 * are replaced one-for-one. The shape is right so nothing downstream changes,
 * and every id is a pure function of its label, so a reseed reproduces it.
 */
export function razorpayShapedId(prefix: string, label: string): string {
  let value = hashSeed(label);
  let out = '';
  for (let i = 0; i < 14; i += 1) {
    value = (Math.imul(value, 0x01000193) + 0x9e3779b9) >>> 0;
    out += BASE62[value % BASE62.length];
  }
  return `${prefix}${out}`;
}
