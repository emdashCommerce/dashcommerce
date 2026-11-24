---
"@dashcommerce/flutterwave": minor
---

Record Flutterwave's split settlement on the order.

- `charge.succeeded` parses `meta.split_settlement_info` and `app_fee` into core's `splitSettlement`: per-subaccount earnings, the platform commission and the provider fee, converted to minor units.
- Core stores it on `Order.providerSplits`, mapping each subaccount reference to its vendor; the admin order detail shows a "Split settlement" card.
- The vendor shares DashCommerce computed are never repriced by the settlement; it is recorded for reconciliation only.
