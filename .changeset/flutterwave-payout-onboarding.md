---
"@dashcommerce/flutterwave": minor
---

In-admin vendor payout onboarding and cart discounts.

- Implements `listPayoutBanks`, `resolvePayoutAccount` and `createPayoutAccount`: the Vendors page lists banks, verifies the account name, creates the Flutterwave collection subaccount and stores the masked result. The full account number is never stored.
- Subaccount defaults support `percentage` or `flat`; DashCommerce still overrides each payment with the exact vendor amount, so the shares stay exact.
- Declares `capabilities.coupons: true`. Cart discounts are applied to the amount Flutterwave charges; no provider-side coupon object is created.
- Needs the core release with the payout onboarding seam (`listPayoutBanks`, `resolvePayoutAccount`, `createPayoutAccount`).
