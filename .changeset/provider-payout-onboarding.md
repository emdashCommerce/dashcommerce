---
"@dashcommerce/core": minor
---

Provider-managed payout onboarding and richer vendor payout accounts.

- `VendorPaymentAccount` gains `accountName`, `verified`, `bankName`, `bankCode`, `country`, `maskedAccountNumber`, `metadata` and `createdAt`. `verified: false` means the provider created a usable account it has not verified; core still accepts it for splits.
- `PaymentProvider` gains optional `listPayoutBanks`, `resolvePayoutAccount` and `createPayoutAccount`, so a provider can onboard a vendor's payout account without sending the merchant to its dashboard.
- `admin/vendors/payout-banks`, `admin/vendors/payout-account/resolve` and `admin/vendors/payout-account` expose that to the Vendors page, which renders a country/bank/account form for providers that implement it.
- Verification is optional. The form only requires it when the provider implements `resolvePayoutAccount`; otherwise the account is stored unverified. The country starts from the store's default currency, and `listPayoutBanks` may return mobile-money channels (e.g. M-PESA) as well as banks.
- The stored account keeps the resolved account name, bank and a masked account number; the full number is never persisted. Removing it detaches it from the vendor locally; the account at the provider is unchanged.
