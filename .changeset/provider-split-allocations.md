---
"@dashcommerce/core": minor
---

Let a payment provider split one payment across vendor payout accounts.

- `capabilities.splits` and `InitCheckoutInput.allocations` / `platformRemainderMinor`. Core computes exact per-vendor minor amounts from trusted cart prices and the vendor's platform fee; a provider only routes them to the account reference core supplies.
- `Vendor.paymentAccounts`, keyed by provider id, for providers other than Stripe: `accountReference`, `status`, and an optional settlement currency and label. Stripe Connect keeps its existing fields.
- `Vendor.stripeAccountId` is optional. A vendor paid through another provider omits it, so a shop without Stripe can create more than one vendor; a missing field is NULL, so the unique index does not clash.
- A cart-wide discount comes out of the platform remainder, matching the Connect plan; a discount larger than that remainder is refused with a readable 409 instead of silently reducing a vendor's payout.
- `admin/vendors/item` accepts `POST` to create a vendor without Stripe, and `PATCH` with `paymentAccount` / `paymentAccounts` to add, replace or remove a provider account. Vendor routes open when Connect is on **or** a split-capable provider is registered.
- Settings exposes each provider's `capabilities`. The Vendors page adds a vendor and edits payout accounts when a split-capable provider is active, without requiring Stripe.
- A vendor cart is refused with a readable 409 when the active provider cannot split, or when a vendor has no active account for it, instead of silently charging the platform account.
