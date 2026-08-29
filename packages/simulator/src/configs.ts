import type { ScenarioClass } from '@praman/core';

/**
 * Generator configurations.
 *
 * There are two, and they are deliberately different along **every** axis, not
 * just in their random seed. This is what makes the held-out set
 * out-of-distribution *by construction* rather than by promise (TASKS.md P1.3):
 *
 *   - different merchant verticals and product catalogues
 *   - different order-value ranges
 *   - different scenario-class mix
 *   - different agent platforms and protocol versions
 *   - different conversation lengths and register
 *   - different language source: the dev corpus uses committed templates,
 *     the held-out corpus has its conversation text written by a *different
 *     model from a different lab* (Groq `openai/gpt-oss-120b`, see D-006)
 *
 * If only the seed differed, the holdout would be a fresh sample from the same
 * distribution, the OOD delta would measure sampling noise, and the headline
 * credibility claim would be false. Stating that plainly here because it is the
 * single easiest thing in this project to get quietly wrong.
 */

export type LanguageSource = 'template' | 'llm';

export interface GeneratorConfig {
  /** Identifier written onto every dispute this config produces. */
  name: string;
  corpus: 'dev' | 'ood_holdout';
  seed: string;
  /** Where conversation-trace wording comes from. */
  languageSource: LanguageSource;
  merchants: { name: string; category: string }[];
  customerNames: string[];
  emailDomain: string;
  /** `category` must match a merchant category: an electronics shop should not
   * be selling a grocery bundle. Realism here is not decoration -- incoherent
   * demo data undermines the "would you trust it" criterion directly. */
  items: { sku: string; name: string; category: string; minAmount: number; maxAmount: number }[];
  agentPlatforms: { platform: string; agentPrefix: string; protocol: string; version: string }[];
  /** Inclusive order-value range, in paise. */
  orderValue: { min: number; max: number };
  /** Conversation turn count range (agentic rail). */
  traceLength: { min: number; max: number };
  /** Relative weight per scenario class. Normalised at generation time. */
  distribution: Record<ScenarioClass, number>;
}

/**
 * Dev corpus. Class weights are grounded in Razorpay's published reason-code
 * documentation and in what the two rails are for; the grounding, and what
 * remains assumption, is written out in EVAL.md rather than buried here.
 */
export const DEV_CONFIG: GeneratorConfig = {
  name: 'dev-v1',
  corpus: 'dev',
  seed: 'praman-dev-2026',
  languageSource: 'template',
  merchants: [
    { name: 'Kirana Direct', category: 'grocery' },
    { name: 'Meridian Electronics', category: 'electronics' },
    { name: 'Saffron Kitchen', category: 'food_delivery' },
    { name: 'Loom & Thread', category: 'apparel' },
    { name: 'Vitalis Pharmacy', category: 'pharmacy' },
  ],
  customerNames: [
    'Ananya Rao',
    'Rohit Menon',
    'Fatima Sheikh',
    'Karthik Iyer',
    'Neha Bhatt',
    'Arjun Pillai',
    'Divya Nair',
    'Imran Qureshi',
  ],
  emailDomain: 'example.com',
  items: [
    { sku: 'GRC-1001', name: 'Monthly grocery bundle', category: 'grocery', minAmount: 120000, maxAmount: 340000 },
    { sku: 'ELC-2044', name: 'Wireless earbuds', category: 'electronics', minAmount: 249900, maxAmount: 799900 },
    { sku: 'FUD-3012', name: 'Family dinner order', category: 'food_delivery', minAmount: 45000, maxAmount: 180000 },
    { sku: 'APP-4501', name: 'Cotton kurta set', category: 'apparel', minAmount: 89900, maxAmount: 269900 },
    { sku: 'PHR-5120', name: 'Prescription refill', category: 'pharmacy', minAmount: 32000, maxAmount: 145000 },
  ],
  agentPlatforms: [
    { platform: 'ShopAgent', agentPrefix: 'agt_shop', protocol: 'upi-reserve-pay', version: '1.0' },
    { platform: 'PantryBot', agentPrefix: 'agt_pantry', protocol: 'upi-reserve-pay', version: '1.0' },
    { platform: 'ConciergeAI', agentPrefix: 'agt_concierge', protocol: 'uap', version: '0.9' },
  ],
  orderValue: { min: 32000, max: 799900 },
  traceLength: { min: 4, max: 7 },
  distribution: {
    // Rail A -- ordinary e-commerce, the volume case today.
    a1: 22, // goods not received: the most common merchant-facing dispute
    a2: 14, // unrecognised charge
    a3: 8, // duplicate processing
    a4: 12, // credit not processed
    // Rail B -- agentic. Over-represented relative to today's real volumes,
    // deliberately and declared: it is the module under test.
    b1: 18,
    b2: 8,
    b3: 6,
    b4: 7,
    b5: 5,
  },
};

/**
 * Held-out corpus. Different verticals, different price band, different agent
 * platforms, different conversation register, different class mix, and its
 * conversation text written by a different model. Generated once, never read
 * during feature development -- enforced by a guard test.
 */
export const OOD_CONFIG: GeneratorConfig = {
  name: 'ood-v1',
  corpus: 'ood_holdout',
  seed: 'praman-holdout-2026',
  languageSource: 'llm',
  merchants: [
    { name: 'Northgate Travel', category: 'travel' },
    { name: 'Cadence Fitness', category: 'subscription_fitness' },
    { name: 'Blueprint Home Services', category: 'home_services' },
    { name: 'Studio Verse', category: 'digital_goods' },
  ],
  customerNames: [
    'Meera Krishnan',
    'Sandeep Ahluwalia',
    'Priyanka Deshmukh',
    'Vikram Sethi',
    'Zoya Ansari',
    'Harish Chandran',
  ],
  emailDomain: 'sample.org',
  items: [
    { sku: 'TRV-8801', name: 'Domestic flight booking', category: 'travel', minAmount: 480000, maxAmount: 1850000 },
    { sku: 'FIT-9002', name: 'Annual studio membership', category: 'subscription_fitness', minAmount: 899000, maxAmount: 2400000 },
    { sku: 'HOM-7310', name: 'Deep cleaning visit', category: 'home_services', minAmount: 149900, maxAmount: 420000 },
    { sku: 'DIG-6205', name: 'Course licence, 12 months', category: 'digital_goods', minAmount: 299900, maxAmount: 990000 },
  ],
  agentPlatforms: [
    { platform: 'Wayfinder', agentPrefix: 'agt_wayfinder', protocol: 'uap', version: '1.1' },
    { platform: 'HouseKeeperAI', agentPrefix: 'agt_housekeeper', protocol: 'upi-reserve-pay', version: '1.2' },
  ],
  // Materially higher order values than dev: the gate's amount-consistency
  // checks meet a price band they were never tuned against.
  orderValue: { min: 149900, max: 2400000 },
  traceLength: { min: 3, max: 10 },
  distribution: {
    a1: 12,
    a2: 18,
    a3: 10,
    a4: 8,
    b1: 14,
    b2: 12,
    b3: 10,
    b4: 8,
    b5: 8,
  },
};
