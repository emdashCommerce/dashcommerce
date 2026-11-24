---
"@dashcommerce/core": minor
---

Provider-managed payout onboarding and richer vendor payout accounts.

- `VendorPaymentAccount` gains `accountName`, `bankName`, `bankCode`, `country`, `maskedAccountNumber`, `metadata` and `createdAt`.
- `PaymentProvider` gains optional `listPayoutBanks`, `resolvePayoutAccount` and `createPayoutAccount`, so a provider can onboard a vendor's payout account without sending the merchant to its dashboard.
- `admin/vendors/payout-banks`, `admin/vendors/payout-account/resolve` and `admin/vendors/payout-account` expose that to the Vendors page, which renders a country/bank/account form for providers that implement it.
- The stored account keeps the resolved account name, bank and a masked account number; the full number is never persisted.
