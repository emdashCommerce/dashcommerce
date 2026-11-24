---
"@dashcommerce/flutterwave": minor
---

Split payments across vendor subaccounts.

- Declares `capabilities.splits`. When core sends `allocations`, each becomes a Flutterwave `subaccounts` item with `transaction_charge_type: "flat_subaccount"` and the exact major-unit amount, for hosted checkout and Inline.
- On-page checkout carries the split as JSON in the client payload; the browser client parses it and refuses a malformed split rather than opening an unsplit payment.
- Validates every share before calling Flutterwave: no empty account, no non-positive amount, no total above the checkout amount, no negative platform remainder.
- Needs a core release with the split allocation seam (`capabilities.splits`, `allocations`, `platformRemainderMinor`).
