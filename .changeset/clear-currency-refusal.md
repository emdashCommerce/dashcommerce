---
"@dashcommerce/core": patch
"@dashcommerce/paystack": patch
---

When the payment provider refuses the cart's currency, checkout now tells the customer: "This shop can't take payments in USD right now. Choose another currency, or contact the shop." Before, `create-session` answered 500 and the customer saw "Payment couldn't start. Please try again in a moment", which retrying never fixed.

Providers signal it by throwing `CurrencyNotSupportedError` (exported from `@dashcommerce/core/payment-provider`) from `initCheckout`. Paystack does this for a currency it doesn't support and for its `unsupported_currency` refusal (an account not enabled for that currency).
