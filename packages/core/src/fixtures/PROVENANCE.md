# Fixture provenance

Every file in this directory is a **verbatim copy** of an example payload
printed in Razorpay's public API documentation. They are the ground truth the
contract tests assert against: if Razorpay's schema and ours ever diverge, a
test fails loudly rather than a field being silently invented.

Do not hand-edit these to make a test pass. If a fixture is wrong, re-copy it
from the source URL and fix the schema instead.

| File | Source URL | Retrieved |
|---|---|---|
| `dispute-fetch-all.json` | https://razorpay.com/docs/api/disputes/fetch-all/ | 2026-08-30 |
| `dispute-contest-draft-response.json` | https://razorpay.com/docs/api/disputes/contest/ | 2026-08-30 |
| `dispute-contest-draft-request.json` | https://razorpay.com/docs/api/disputes/contest/ | 2026-08-30 |
| `webhook-payment-dispute-created.json` | https://razorpay.com/docs/webhooks/disputes/ | 2026-08-30 |

## Notes taken at retrieval time

- The dispute `phase` field documents **five** values -- `fraud`, `retrieval`,
  `chargeback`, `pre_arbitration`, `arbitration` -- not the three named in
  CLAUDE.md §3. The docs win; see DECISIONS.md D-002.
- The evidence object contains `cancellation_proof` and `refund_confirmation`,
  which CLAUDE.md §3 omits. Also in the docs, also implemented.
- The 1000-character limit applies to `summary` (a string). `explanation_letter`
  is a **list of document ids**, not prose. See DECISIONS.md D-003.
- Dispute webhook events are prefixed `payment.` -- e.g. `payment.dispute.created`,
  not `dispute.created`.
- In `webhook-payment-dispute-created.json` the payment's `notes` is `[]`
  (a JSON array) even though `notes` is documented as a key-value object. This
  is a real serialisation quirk, preserved verbatim; the schema accepts both.
