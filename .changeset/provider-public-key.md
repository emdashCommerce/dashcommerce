---
"@dashcommerce/core": minor
---

Let a payment provider save a browser public key.

- `PaymentProviderCredentials.publicKey` and `credentialFields.publicKey`, saved as `settings:<id>PublicKey` and validated against the prefixes the provider declares. Providers that need it for on-page checkout (Flutterwave Inline) can hand it to their browser client; nothing else changes for providers that do not.
- Settings shows the field only for a provider that declares it, beside the secret key and webhook secret. A provider that does not declare one cannot have a public key saved, and its settings row is unchanged.
- `loadPaymentProviderCredentials` returns `publicKey` when one is set.
