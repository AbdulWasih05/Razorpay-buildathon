import { z } from 'zod';

/**
 * Razorpay ids are prefixed by entity type (`disp_`, `pay_`, `doc_`, `acc_`,
 * `order_`, `card_`). We enforce the prefix rather than accepting any string:
 * mixing a payment id into a dispute id field is exactly the class of bug that
 * schema fidelity is supposed to catch, and it is cheap to catch it here.
 */
export function prefixedId(prefix: string) {
  return z
    .string()
    .startsWith(prefix, `expected an id beginning with "${prefix}"`)
    .min(prefix.length + 1, `expected characters after the "${prefix}" prefix`);
}

export const disputeId = prefixedId('disp_');
export const paymentId = prefixedId('pay_');
export const documentId = prefixedId('doc_');
export const accountId = prefixedId('acc_');
export const orderId = prefixedId('order_');

/** Razorpay expresses every time as a Unix timestamp in seconds. */
export const unixTimestamp = z.number().int().positive();

/** Razorpay expresses every amount in the currency's smallest subunit (paise for INR). */
export const amountInSubunits = z.number().int().nonnegative();
